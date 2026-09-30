/**
 * P-002: Backfill `## Promoted` blocks into plan files.
 *
 * For every plan slug that already has promoted features recorded in
 * `harness_shared.harness_features_consolidated` (via `source_plan_slug`),
 * this script reads the plan file, applies `upsertPromotedBlock`, and
 * writes the result back.  It is idempotent: running it twice produces
 * the same output.
 *
 * When to run:
 *   - Once after deploying migration 084 and Phase A changes
 *   - Safe to re-run at any time (idempotent)
 *
 * SAFETY (R10-C audit): this script writes directly via fs.writeFile
 * WITHOUT acquiring `withPlanLock`. The operator's plans:* tools all
 * coordinate via the plan-lock, but this script does not — running it
 * while agents are actively editing plans can race and overwrite
 * in-flight edits. Use the `--dry-run` flag first to preview, then run
 * with no agents mid-edit.
 *
 *   1. Pause autoloop (or any agent that calls plans:set-content/
 *      set-now/add-item/add-decision/promote).
 *   2. Run `--dry-run` first to confirm the diff is what you expect.
 *   3. Run for real once no agents are active.
 *
 * Usage:
 *   cd apps/operator
 *   npx tsx scripts/migrations/backfill-plan-promoted-blocks.ts --dry-run
 *   npx tsx scripts/migrations/backfill-plan-promoted-blocks.ts
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { listPlanFiles } from '@papercusp/operator-core/lib/agent-tools/plans/source';
import { upsertPromotedBlock } from '@papercusp/operator-core/lib/agent-tools/coordination/tools/promote';
import { bumpUpdatedDate } from '@papercusp/operator-core/lib/agent-tools/plans/with-plan-lock';

const DRY_RUN = process.argv.includes('--dry-run');

interface PromotedRow {
  source_plan_slug: string;
  feature_id: string;
  title: string;
  source_plan_item_ids: string[] | null;
}

async function queryPromotedFeatures(): Promise<PromotedRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<PromotedRow[]>`
    SELECT source_plan_slug,
           feature_id,
           title,
           source_plan_item_ids
      FROM harness_shared.harness_features_consolidated
     WHERE source_plan_slug IS NOT NULL
     ORDER BY source_plan_slug, feature_id
  `;
  return rows;
}

async function main(): Promise<void> {
  console.log(`[backfill] mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  let rows: PromotedRow[];
  try {
    rows = await queryPromotedFeatures();
  } catch (err) {
    console.error('[backfill] PG query failed — is HARNESS_ADMIN_DATABASE_URL set?', err);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('[backfill] no features with source_plan_slug found — nothing to do');
    return;
  }
  console.log(`[backfill] found ${rows.length} promoted feature(s) across PG`);

  // Group by plan slug
  const byPlan = new Map<string, PromotedRow[]>();
  for (const r of rows) {
    const existing = byPlan.get(r.source_plan_slug) ?? [];
    existing.push(r);
    byPlan.set(r.source_plan_slug, existing);
  }

  // Resolve plan files on disk (both live + archived)
  const planEntries = await listPlanFiles({ includeArchived: true });
  const slugToPath = new Map(planEntries.map((e) => [e.slug, e.filePath]));

  let written = 0;
  let skipped = 0;
  let notFound = 0;

  for (const [planSlug, features] of byPlan) {
    const filePath = slugToPath.get(planSlug);
    if (!filePath) {
      console.warn(`[backfill]  SKIP ${planSlug} — plan file not found on disk`);
      notFound++;
      continue;
    }

    const original = await fs.readFile(filePath, 'utf8');

    const newRows = features.map((f) => {
      const itemRef = f.source_plan_item_ids?.[0] ? ` <!-- ${f.source_plan_item_ids[0]} -->` : '';
      return `- [ ] ${f.feature_id} — ${f.title}${itemRef}`;
    });

    const patched = bumpUpdatedDate(upsertPromotedBlock(original, newRows));

    if (patched === original) {
      console.log(`[backfill]  OK   ${planSlug} — already up-to-date`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[backfill]  DRY  ${planSlug} — would add ${newRows.length} row(s) to ## Promoted`);
    } else {
      await fs.writeFile(filePath, patched, 'utf8');
      console.log(`[backfill]  WROTE ${planSlug} — added ${newRows.length} row(s)`);
    }
    written++;
  }

  console.log();
  console.log(`[backfill] done — written: ${written}, already-ok: ${skipped}, not-found: ${notFound}`);

  if (!DRY_RUN && written > 0) {
    console.log('[backfill] next: run `npx tsx scripts/lint-plans.ts` to verify no warnings');
  }
}

void main();
