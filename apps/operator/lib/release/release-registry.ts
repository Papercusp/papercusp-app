/**
 * The release registry — one row per cut, and the window of work it shipped.
 * (WI-4446; table: migration 589 `harness_shared.releases`.)
 *
 * [owner 2026-07-12] "we should also have the agent auto generate a high
 * level changelog. Can we also publish the full list of work items fixed between
 * releases and plans implemented?"
 *
 * TWO CONSUMERS, ONE TABLE — so they can never disagree about what shipped:
 *   1. the beta release-history page (static, on the R2 secret path)   → release-history-page.ts
 *   2. GET /api/updates/history (the in-app Update Center)             → updates-history.ts
 *
 * WHY THE LISTS ARE SNAPSHOTTED AT CUT TIME, NEVER RE-DERIVED ON READ:
 * "what shipped in 0.0.8" is a fact about the past. Re-deriving it from a live
 * work_items query would let a later edit — an item reopened, a plan renamed —
 * silently rewrite an already-published changelog. `snapshotWindow` runs ONCE,
 * at the cut, and the ids are frozen in the row.
 *
 * ⚠ Scope each query by the tenant key of its table. Work-item and plan
 * snapshots are harness-scoped by `(workspace_id, harness_slug)`; release rows
 * are intentionally workspace-level and keyed by `(workspace_id, channel,
 * version)`. Do not add `harness_slug` to release-table predicates: that column
 * does not exist in migration 589. A filter on a harness slug alone silently
 * reads another tenant's snapshot rows and looks like a diverged store when it
 * isn't.
 */

import type { Sql } from 'postgres';
import {
  CompletionVerificationEvidenceSchema,
  type CompletionVerificationEvidence,
} from '@papercusp/operator-core/lib/coord-lifecycle/records';

/** Terminal statuses — an item in one of these SHIPPED. (Issue-family settles to
 *  `resolved`, feature-family to `passed`; `closed` covers both.) */
/**
 * The states that mean "this shipped in the window".
 *
 * ⚠ 'done' MUST be here: it is what `work_items:complete { state:'done' }` writes, i.e. the
 * canonical completion verb the whole fleet uses. It was missing until 2026-08-10 and the
 * omission was invisible because the other states are populated too — measured over the
 * 0.0.14 window, 2,796 completed user-facing items were silently dropped from the release
 * record while 1,138 were counted (EI-20071526453281952).
 *
 * 'dropped'/'deprecated' are deliberately NOT here — those are abandoned, not shipped.
 */
export const TERMINAL_STATUSES = ['done', 'resolved', 'passed', 'closed'] as const;

export interface ReleaseArtifact {
  /**
   * `gui`/`server` are the desktop products (win/mac/linux). `mobile` is the
   * phone apps (Android APK/AAB, iOS IPA) — a distinct product so the page can
   * give them their own "Mobile apps" section AND so they can never collide into
   * the desktop auto-update manifest (`latest.json` is desktop-only; the Tauri
   * updater's `platformKeyFor` accepts only darwin/linux/windows).
   */
  product: 'gui' | 'server' | 'mobile';
  /** e.g. `linux-x86_64`, `darwin-universal`, `windows-x86_64`, `android-universal`, `ios-arm64`. */
  platform: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
}

/** One shipped work item, as frozen into the release row. */
export interface ShippedItem {
  id: string;
  title: string;
  /**
   * The item's full body/summary — shown expanded under its title on the release
   * page (WI-5525). Optional: snapshotWindow (record-time / changelog) does not
   * fetch it; hydrateRelease (render-time) does, so only the rendered page carries
   * it. Scrubbed with the whole page on the way out (shell() → scrubIdentity).
   */
  summary?: string;
  planSlug: string | null;
  /** Public detail-page fields loaded from the canonical work-item row. */
  kind?: string;
  state?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  terminalCompletionRef?: string | null;
  terminalCompletionEvidence?: CompletionVerificationEvidence | null;
  completionAuthority?: string | null;
}

/** One plan whose work landed in this window. */
export interface ShippedPlan {
  slug: string;
  title: string;
  status: string;
  /** The plan's markdown body — rendered onto its own page. */
  content: string;
  /** How many of this release's work items came from this plan. */
  itemCount: number;
}

export interface ReleaseRow {
  version: string;
  channel: string;
  cutAt: Date;
  publishedAt: Date | null;
  changelogMd: string | null;
  workItemIds: string[];
  planSlugs: string[];
  artifacts: ReleaseArtifact[];
  gitSha: string | null;
  cutBy: string | null;
  notes: string | null;
}

export interface Snapshot {
  items: ShippedItem[];
  plans: ShippedPlan[];
  /** Internal engineer-issue ids (EI-*) in the window. These ARE recorded in the
   *  release row — the row states the fact ("everything that went terminal"), and
   *  the VIEW decides what to show. The page counts them rather than listing them
   *  (see `isUserFacing`), but nothing is silently dropped from the record. */
  internalIds: string[];
}

/**
 * Is this work item user-facing release-notes material?
 *
 * `EI-*` are engineer-issues: the fleet's OWN self-improvement observations
 * ("this gate has no callers", "this tool's guidance is over budget"). They are
 * real work, but they are the agents fixing their own tooling — a beta tester
 * reading release notes has no use for them, and in a 4-day window there are
 * hundreds. Counted, not listed.
 */
export function isUserFacing(id: string): boolean {
  return !id.startsWith('EI-');
}

/**
 * Group a release's items by the plan that produced them, largest plan first,
 * with the unplanned items last.
 *
 * WHY GROUPING IS NOT COSMETIC: a real release window here is ~1,000 work items
 * (measured: 1,038 terminal in 4 days). A flat list of 1,000 titles is not "the
 * full list the owner asked for" — it is a wall no one reads. Grouped under the
 * plan each item came from, the same 1,000 items become ~44 readable stories.
 */
export function groupItemsByPlan(
  items: ShippedItem[],
  plans: ShippedPlan[],
): Array<{ plan: ShippedPlan | null; items: ShippedItem[] }> {
  const byPlan = new Map<string, ShippedItem[]>();
  const unplanned: ShippedItem[] = [];
  for (const item of items) {
    if (!item.planSlug) {
      unplanned.push(item);
      continue;
    }
    const bucket = byPlan.get(item.planSlug);
    if (bucket) bucket.push(item);
    else byPlan.set(item.planSlug, [item]);
  }

  const planBySlug = new Map(plans.map((p) => [p.slug, p]));
  const groups = [...byPlan.entries()]
    .map(([slug, groupItems]) => ({
      plan: planBySlug.get(slug) ?? null,
      items: groupItems,
      slug,
    }))
    // A plan we have no row for still gets its items shown (under its slug) —
    // dropping them would silently shrink "the full list".
    .filter((g) => g.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length || a.slug.localeCompare(b.slug))
    .map(({ plan, items: groupItems }) => ({ plan, items: groupItems }));

  if (unplanned.length > 0) groups.push({ plan: null, items: unplanned });
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// Postgres store. Thin by design: every non-trivial decision above is pure and
// unit-tested; these functions only fetch and shape.
// ────────────────────────────────────────────────────────────────────────────

export interface Scope {
  workspaceId: string;
  harnessSlug: string;
}

/**
 * Everything that went terminal in [fromMs, toMs) — the work this release shipped.
 * Bounds are EPOCH MILLIS because `work_items.updated_ts` is a BIGINT, not a
 * timestamptz: comparing it to `now() - interval '3 days'` fails outright with
 * `operator does not exist: bigint > timestamp with time zone`.
 */
export async function snapshotWindow(
  sql: Sql,
  scope: Scope,
  fromMs: number,
  toMs: number,
): Promise<Snapshot> {
  const rows = await sql<
    Array<{ feature_id: string; title: string; source_plan_slug: string | null }>
  >`
    SELECT feature_id, title, source_plan_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND status = ANY(${sql.array([...TERMINAL_STATUSES])})
       AND updated_ts >= ${fromMs}
       AND updated_ts <  ${toMs}
     ORDER BY updated_ts ASC
  `;

  const items: ShippedItem[] = rows
    .filter((r) => isUserFacing(r.feature_id))
    .map((r) => ({ id: r.feature_id, title: r.title ?? '', planSlug: r.source_plan_slug }));
  const internalIds = rows.map((r) => r.feature_id).filter((id) => !isUserFacing(id));

  // ⚠ Plans come from TWO independent signals, UNIONed, because neither is trustworthy alone.
  //
  //  (a) plans that reached 'shipped' in the window — asks the plans table directly.
  //  (b) plan slugs reverse-derived from the items — work_items.source_plan_slug.
  //
  // (b) WAS THE SOLE SOURCE until 2026-08-10 and it collapses: source_plan_slug is populated
  // on only ~10% of items, and on ~0% of the statuses that were then considered terminal
  // (resolved 0/1085, closed 0/52). For 0.0.14 that produced "plans: 1" — a single 'passed'
  // row — against 26 plans actually shipped in the window (EI-20071526453281952).
  // (a) alone is not sufficient either: plan status is a free-text flag decoupled from the
  // item ledger, so genuinely-complete plans routinely still read draft/active/ready
  // (EI-18694793291190625). Union both and let fetchPlans dedupe by slug.
  const itemSlugs = items.map((i) => i.planSlug).filter((s): s is string => !!s);
  const shippedRows = await sql<Array<{ plan_slug: string }>>`
    SELECT plan_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND status = 'shipped'
       AND updated_at >= to_timestamp(${fromMs}::bigint / 1000.0)
       AND updated_at <  to_timestamp(${toMs}::bigint / 1000.0)
  `;
  const slugs = [...new Set([...shippedRows.map((r) => r.plan_slug), ...itemSlugs])];
  const plans = slugs.length > 0 ? await fetchPlans(sql, scope, slugs, items) : [];

  return { items, plans, internalIds };
}

/**
 * Look up the display data for a release's FROZEN id lists.
 *
 * The row stores ids, not titles — deliberately. The SET of items is the fact we
 * freeze at cut time; a title someone later clarifies should show its improved
 * wording, but must never change WHICH items shipped. So: frozen ids in, current
 * titles out.
 */
export async function hydrateRelease(
  sql: Sql,
  scope: Scope,
  row: ReleaseRow,
): Promise<{ items: ShippedItem[]; plans: ShippedPlan[]; internalCount: number }> {
  const userFacingIds = row.workItemIds.filter(isUserFacing);
  const internalCount = row.workItemIds.length - userFacingIds.length;
  if (userFacingIds.length === 0) return { items: [], plans: [], internalCount };

  const rows = await sql<
    Array<{
      feature_id: string;
      title: string;
      summary: string | null;
      source_plan_slug: string | null;
      item_kind: string | null;
      status: string | null;
      created_ts: number | string | null;
      updated_ts: number | string | null;
      closed_ts: number | string | null;
      terminal_completion_ref: string | null;
      completion_evidence: unknown;
      authority: string | null;
    }>
  >`
    SELECT feature_id, title, summary, source_plan_slug, item_kind, status,
           created_ts, updated_ts, closed_ts, terminal_completion_ref,
           payload -> '_completionEvidence' AS completion_evidence,
           authority
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ANY(${sql.array(userFacingIds)})
     ORDER BY updated_ts ASC
  `;
  const items: ShippedItem[] = rows.map((r) => ({
    id: r.feature_id,
    title: r.title ?? '',
    summary: r.summary ?? '',
    planSlug: r.source_plan_slug,
    kind: r.item_kind ?? 'work item',
    state: r.status ?? 'unknown',
    createdAt: epochMillisIso(r.created_ts),
    updatedAt: epochMillisIso(r.updated_ts),
    closedAt: epochMillisIso(r.closed_ts),
    terminalCompletionRef: r.terminal_completion_ref,
    terminalCompletionEvidence: normalizeCompletionEvidence(r.completion_evidence),
    completionAuthority: r.authority,
  }));
  const plans =
    row.planSlugs.length > 0 ? await fetchPlans(sql, scope, row.planSlugs, items) : [];
  return { items, plans, internalCount };
}

/**
 * Treat Postgres JSON as untrusted at the projection boundary.
 *
 * Three legacy rows predate the typed completion writer and carry
 * `filesChanged` as a string instead of string[]. The current Zod writer rejects
 * that shape, but a static-history regeneration reads old and new rows together.
 * Drop only that malformed optional field, retain the rest when it validates,
 * and discard any otherwise-invalid evidence object rather than crashing (or
 * stringifying raw payload data onto a public page).
 */
function normalizeCompletionEvidence(value: unknown): CompletionVerificationEvidence | null {
  const parsed = CompletionVerificationEvidenceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = { ...(value as Record<string, unknown>) };
  if ('filesChanged' in candidate && !Array.isArray(candidate.filesChanged)) {
    delete candidate.filesChanged;
  }
  const legacy = CompletionVerificationEvidenceSchema.safeParse(candidate);
  return legacy.success ? legacy.data : null;
}

/** Work-item timestamps are epoch millis (bigint, returned as string by postgres-js). */
function epochMillisIso(value: number | string | null): string | null {
  if (value == null) return null;
  const millis = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function fetchPlans(
  sql: Sql,
  scope: Scope,
  slugs: string[],
  items: ShippedItem[],
): Promise<ShippedPlan[]> {
  const rows = await sql<
    Array<{ plan_slug: string; title: string; status: string; content: string | null }>
  >`
    SELECT plan_slug, title, status, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ANY(${sql.array(slugs)})
  `;
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.planSlug) counts.set(i.planSlug, (counts.get(i.planSlug) ?? 0) + 1);
  }
  return rows
    .map((r) => ({
      slug: r.plan_slug,
      title: r.title ?? r.plan_slug,
      status: r.status ?? 'unknown',
      content: r.content ?? '',
      itemCount: counts.get(r.plan_slug) ?? 0,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || a.slug.localeCompare(b.slug));
}

/** Every recorded release for a channel, newest cut first. */
export async function listReleases(
  sql: Sql,
  workspaceId: string,
  channel?: string,
): Promise<ReleaseRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT version, channel, cut_at, published_at, changelog_md,
           work_item_ids, plan_slugs, artifacts, git_sha, cut_by, notes
      FROM harness_shared.releases
     WHERE workspace_id = ${workspaceId}
       ${channel ? sql`AND channel = ${channel}` : sql``}
     ORDER BY cut_at DESC
  `;
  return rows.map(toReleaseRow);
}

function toReleaseRow(r: Record<string, unknown>): ReleaseRow {
  return {
    version: String(r.version),
    channel: String(r.channel),
    cutAt: r.cut_at as Date,
    publishedAt: (r.published_at as Date | null) ?? null,
    changelogMd: (r.changelog_md as string | null) ?? null,
    workItemIds: (r.work_item_ids as string[] | null) ?? [],
    planSlugs: (r.plan_slugs as string[] | null) ?? [],
    artifacts: (r.artifacts as ReleaseArtifact[] | null) ?? [],
    gitSha: (r.git_sha as string | null) ?? null,
    cutBy: (r.cut_by as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}

/** The cut_at of the release immediately BEFORE `cutAt` in the same channel — the
 *  lower bound of this release's changelog window. Null when this is the first.
 *
 *  `excludeVersion` is the version being (re-)recorded, and it is EXCLUDED from the
 *  lookup ON PURPOSE. The release row is idempotent on (workspace, channel, version),
 *  so re-recording the same version to add a late platform (e.g. mac landing after
 *  linux + windows) UPDATEs the existing row. Without this exclusion, `previousCutAt`
 *  for that re-record returns the version's OWN earlier cut — now the most-recent cut
 *  before "now" — collapsing the window to the tiny gap between the two records (which
 *  holds ~no terminal work), and the `ON CONFLICT DO UPDATE` then overwrites the first
 *  record's work-item / plan associations with the empty set. That is exactly what
 *  wiped 0.0.11's changelog: 319 work items went terminal since 0.0.10, yet the row
 *  stored 0 (fixed 2026-07-16). Excluding the same version bounds the window at the
 *  last DIFFERENT release, so a re-record recomputes the same [prev-real-release → now]
 *  window and re-associates the same work every time — idempotent, as intended. */
export async function previousCutAt(
  sql: Sql,
  workspaceId: string,
  channel: string,
  cutAt: Date,
  excludeVersion: string,
): Promise<Date | null> {
  const rows = await sql<Array<{ cut_at: Date }>>`
    SELECT cut_at
      FROM harness_shared.releases
     WHERE workspace_id = ${workspaceId}
       AND channel = ${channel}
       AND version <> ${excludeVersion}
       AND cut_at < ${cutAt}
     ORDER BY cut_at DESC
     LIMIT 1
  `;
  return rows[0]?.cut_at ?? null;
}

/** Insert (or update) the release row. Idempotent on (workspace, channel, version)
 *  so a re-run of the recorder after a fixed changelog is safe. */
export async function recordRelease(
  sql: Sql,
  workspaceId: string,
  row: ReleaseRow,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.releases
      (workspace_id, version, channel, cut_at, published_at, changelog_md,
       work_item_ids, plan_slugs, artifacts, git_sha, cut_by, notes)
    VALUES
      (${workspaceId}, ${row.version}, ${row.channel}, ${row.cutAt},
       ${row.publishedAt}, ${row.changelogMd},
       ${sql.array(row.workItemIds)}, ${sql.array(row.planSlugs)},
       ${sql.json(row.artifacts as unknown as object)},
       ${row.gitSha}, ${row.cutBy}, ${row.notes})
    ON CONFLICT (workspace_id, channel, version) DO UPDATE SET
      cut_at        = EXCLUDED.cut_at,
      -- Publication is a monotonic fact: a later re-record (for example, when
      -- a late platform lands) must not turn a live release back into a draft
      -- merely because record-release-cli constructs its cut row with NULL.
      published_at  = COALESCE(harness_shared.releases.published_at, EXCLUDED.published_at),
      changelog_md  = EXCLUDED.changelog_md,
      work_item_ids = EXCLUDED.work_item_ids,
      plan_slugs    = EXCLUDED.plan_slugs,
      artifacts     = EXCLUDED.artifacts,
      git_sha       = EXCLUDED.git_sha,
      cut_by        = EXCLUDED.cut_by,
    notes         = EXCLUDED.notes
  `;
}

/**
 * Mark a release live only after its manifest and every recorded artifact have
 * passed the public reachability checks.
 *
 * Publication is intentionally separate from recordRelease: a cut is a
 * database fact, while `published_at` is an externally verified fact. The
 * COALESCE makes retries idempotent and preserves the first successful proof.
 * A missing row is an invariant violation, not a successful no-op — otherwise
 * a broken workspace/version argument would report a release as published
 * without changing the registry at all.
 */
export async function markReleasePublished(
  sql: Sql,
  workspaceId: string,
  channel: string,
  version: string,
  publishedAt: Date = new Date(),
): Promise<Date> {
  const rows = await sql<Array<{ published_at: Date | null }>>`
    UPDATE harness_shared.releases
       SET published_at = COALESCE(published_at, ${publishedAt})
     WHERE workspace_id = ${workspaceId}
       AND channel = ${channel}
       AND version = ${version}
     RETURNING published_at
  `;
  const stored = rows[0]?.published_at;
  if (!stored) {
    throw new Error(
      `cannot mark release published: no registry row for ${workspaceId}/${channel}/${version}`,
    );
  }
  return stored;
}
