/**
 * Backfill filesystem plans → harness_shared.harness_plans (PG-canonical).
 *
 * Plan: plans-pg-canonical-migration-2026-06-03.
 *   - Stage 0: run once as a SHADOW (FS still canonical, PG mirrors it).
 *   - Stage 1: re-run IMMEDIATELY BEFORE the FS→PG read/write flip to close
 *     the read-before-write data-loss window.
 *
 * For every registered harness, resolve its plans dir, parse each `.md`
 * (live + archive/), and upsert one harness_plans row carrying the canonical
 * markdown blob + the frontmatter derived index + the folded op_* status
 * (from harness_plan_status). FS is the source of truth here — this overwrites
 * the PG shadow. Idempotent: a no-op re-run changes nothing (the DO UPDATE is
 * guarded so unchanged rows neither bump `version` nor touch `updated_at`).
 *
 * Runs as harness_admin (BYPASSRLS) so it writes rows for every workspace_id.
 *
 * Usage:
 *   cd apps/operator
 *   npx tsx scripts/migrations/backfill-fs-plans-to-pg.ts --dry-run
 *   npx tsx scripts/migrations/backfill-fs-plans-to-pg.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOrgPg } from "@papercusp/db-org";
import { parsePlan } from "@papercusp/plan-parser";
import { hashPlanContent } from "@papercusp/plan-parser/content-hash";
import { resolveHarnessPlansDir } from "@papercusp/operator-core/lib/agent-tools/plans/source";
import { loadHarnessRegistry } from "@papercusp/operator-core/lib/harness-registry";
import { DEFAULT_WORKSPACE_ID } from "@papercusp/operator-core/lib/workspace-registry";

/**
 * Read plan `.md` files straight off disk (live + archive). The backfill is
 * the ONE place that must read the filesystem — the source.ts helpers now read
 * PG (Stage 1), so we cannot route through them here.
 */
async function collectFsPlans(
  plansDir: string,
  archiveDir: string,
): Promise<
  Array<{ slug: string; filePath: string; archived: boolean; content: string }>
> {
  const out: Array<{
    slug: string;
    filePath: string;
    archived: boolean;
    content: string;
  }> = [];
  for (const [dir, archived] of [
    [plansDir, false],
    [archiveDir, true],
  ] as const) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const name of names) {
      if (
        (!name.endsWith(".md") && !name.endsWith(".mdx")) ||
        name.startsWith(".")
      )
        continue;
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      out.push({
        slug: name.replace(/\.mdx?$/, ""),
        filePath,
        archived,
        content: await fs.readFile(filePath, "utf8"),
      });
    }
  }
  return out;
}

const DRY_RUN = process.argv.includes("--dry-run");

interface PlanStatusRow {
  plan_slug: string;
  status: string;
  started_at: string;
  updated_at: string;
  current_wave: string | null;
  priority: number | null;
}

interface BackfillRow {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  supersedes: string[];
  supersededBy: string | null;
  content: string;
  contentHash: string;
  opStatus: string | null;
  opStartedAt: string | null;
  opUpdatedAt: string | null;
  currentWave: string | null;
  opPriority: number | null;
  archived: boolean;
  isLegacy: boolean;
  // Stage-3 structured derived index.
  items: unknown[];
  decisions: unknown[];
  nowState: string | null;
  nowNext: string | null;
}

async function main(): Promise<void> {
  console.log(`[backfill-plans] mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  const { sql } = getOrgPg();
  try {
    await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function run(sql: ReturnType<typeof getOrgPg>["sql"]): Promise<void> {
  // Enumerate every registered harness in the active workspace; each may have
  // its own docs/plans dir (papercup's is apps/operator/docs/plans/).
  const reg = await loadHarnessRegistry();
  const slugs = Array.from(new Set(reg.projects.map((p) => p.slug)));
  console.log(
    `[backfill-plans] registered harnesses: ${slugs.join(", ") || "(none)"}`,
  );

  const rows: BackfillRow[] = [];

  for (const slug of slugs) {
    let dirs: { harnessSlug: string; plans: string; archive: string };
    try {
      dirs = await resolveHarnessPlansDir(slug);
    } catch (err) {
      console.warn(
        `[backfill-plans]  SKIP harness '${slug}' — ${(err as Error).message}`,
      );
      continue;
    }

    const fsPlans = await collectFsPlans(dirs.plans, dirs.archive);
    if (fsPlans.length === 0) continue;

    // Fold existing operational status for this harness (one query).
    const statusRows = await sql<PlanStatusRow[]>`
      SELECT plan_slug, status, started_at, updated_at, current_wave, priority
        FROM harness_shared.harness_plan_status
       WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
         AND harness_slug  = ${dirs.harnessSlug}
    `;
    const statusByslug = new Map(statusRows.map((r) => [r.plan_slug, r]));

    for (const fp of fsPlans) {
      const parsed = parsePlan(fp.content, { filePath: fp.filePath });
      const fm = parsed.frontmatter;
      const st = statusByslug.get(fm.slug ?? parsed.slug);
      rows.push({
        workspaceId: DEFAULT_WORKSPACE_ID,
        harnessSlug: dirs.harnessSlug,
        planSlug: fm.slug ?? parsed.slug,
        title: fm.title ?? null,
        status: fm.status ?? null,
        created: fm.created ?? null,
        updated: fm.updated ?? null,
        owner: fm.owner ?? null,
        supersedes: fm.supersedes ?? [],
        supersededBy: fm.supersededBy ?? null,
        content: parsed.raw,
        contentHash: hashPlanContent(parsed.raw),
        opStatus: st?.status ?? null,
        opStartedAt: st?.started_at ?? null,
        opUpdatedAt: st?.updated_at ?? null,
        currentWave: st?.current_wave ?? null,
        opPriority: st?.priority ?? null,
        archived: fp.archived,
        isLegacy: parsed.isLegacy,
        items: parsed.items.map((i) => ({
          id: i.id,
          status: i.storedStatus,
          text: i.text,
          importance: i.importance,
          blockedBy: i.blockedBy,
          decisionRefs: i.decisionRefs,
          phase: i.phase,
        })),
        decisions: parsed.decisions.map((d) => ({
          id: d.id,
          title: d.title,
          body: d.body,
          date: d.date,
          itemRefs: d.itemRefs,
        })),
        nowState: parsed.now?.state ?? null,
        nowNext: parsed.now?.next ?? null,
      });
    }
  }

  console.log(`[backfill-plans] parsed ${rows.length} plan(s) from disk`);
  if (DRY_RUN) {
    const sample = rows
      .slice(0, 5)
      .map(
        (r) =>
          `${r.harnessSlug}/${r.planSlug} (${r.content.length}b${r.isLegacy ? ", legacy" : ""}${r.archived ? ", archived" : ""})`,
      );
    console.log(
      `[backfill-plans] DRY — would upsert ${rows.length} rows. sample:\n  ${sample.join("\n  ")}`,
    );
    return;
  }

  let upserted = 0;
  for (const r of rows) {
    // Guarded DO UPDATE: only touch the row when content/index actually
    // changed, so a no-op re-run neither bumps version nor updated_at.
    const res = await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
         supersedes, superseded_by, content, content_hash, version,
         op_status, op_started_at, op_updated_at, current_wave, op_priority,
         archived, is_legacy, items, decisions, now_state, now_next, origin)
      VALUES
        (${r.workspaceId}, ${r.harnessSlug}, ${r.planSlug}, ${r.title}, ${r.status},
         ${r.created}, ${r.updated}, ${r.owner}, ${r.supersedes}, ${r.supersededBy},
         ${r.content}, ${r.contentHash}, 0,
         ${r.opStatus}, ${r.opStartedAt}, ${r.opUpdatedAt}, ${r.currentWave}, ${r.opPriority},
         ${r.archived}, ${r.isLegacy},
         ${JSON.stringify(r.items)}::jsonb, ${JSON.stringify(r.decisions)}::jsonb, ${r.nowState}, ${r.nowNext}, 'local')
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
        title         = EXCLUDED.title,
        status        = EXCLUDED.status,
        created       = EXCLUDED.created,
        updated       = EXCLUDED.updated,
        owner         = EXCLUDED.owner,
        supersedes    = EXCLUDED.supersedes,
        superseded_by = EXCLUDED.superseded_by,
        content       = EXCLUDED.content,
        content_hash  = EXCLUDED.content_hash,
        version       = harness_shared.harness_plans.version + 1,
        op_status     = EXCLUDED.op_status,
        op_started_at = EXCLUDED.op_started_at,
        op_updated_at = EXCLUDED.op_updated_at,
        current_wave  = EXCLUDED.current_wave,
        op_priority   = EXCLUDED.op_priority,
        archived      = EXCLUDED.archived,
        is_legacy     = EXCLUDED.is_legacy,
        items         = EXCLUDED.items,
        decisions     = EXCLUDED.decisions,
        now_state     = EXCLUDED.now_state,
        now_next      = EXCLUDED.now_next
      WHERE harness_shared.harness_plans.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         OR harness_shared.harness_plans.op_status     IS DISTINCT FROM EXCLUDED.op_status
         OR harness_shared.harness_plans.op_priority   IS DISTINCT FROM EXCLUDED.op_priority
         OR harness_shared.harness_plans.current_wave  IS DISTINCT FROM EXCLUDED.current_wave
         OR harness_shared.harness_plans.archived      IS DISTINCT FROM EXCLUDED.archived
         OR harness_shared.harness_plans.items         IS NULL
      RETURNING plan_slug
    `;
    if (res.length > 0) upserted++;
  }

  console.log(
    `[backfill-plans] done — ${upserted} row(s) inserted/updated, ${rows.length - upserted} unchanged`,
  );
  await sql.end({ timeout: 5 });
}

function statusByslugGet(
  m: Map<string, PlanStatusRow>,
  slug: string,
): PlanStatusRow | undefined {
  return m.get(slug);
}

void main();
