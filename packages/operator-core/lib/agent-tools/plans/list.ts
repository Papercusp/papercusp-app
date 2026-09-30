/**
 * plans:list — summary of all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns one row per plan: slug, title, status, updated, item counts
 * by effectiveStatus, the `## Now` next-action line.
 *
 * Hides archive/ by default. Legacy plans (no/malformed frontmatter)
 * surface with status: 'draft' (the isLegacy flag marks them) and no
 * item counts.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  listPlanIndexRows,
  listPlanIndexRowsForWorkspace,
  getPlanContentsBySlugs,
  resolveHarnessPlansDir,
  resolvePlanScope,
  isUnknownPlanScopeError,
  type PlanIndexRow,
} from './source';
import { activeWorkspaceId } from '../../workspace-registry';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatusForItems } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';
import {
  IMPORTANCE_LEVELS,
  ITEM_STATUSES,
  PLAN_STATUSES,
  derivePlanLifecycle,
  parsePlan,
  reconcilePlanLifecycle,
  type Importance,
  type ItemStatus,
  type PlanItem,
  type PlanLifecycleDisposition,
  type PlanLifecycleVerdict,
} from './parser';
import { reconcileStartStatus } from './plan-start-state';
import { shapePlansList } from './list-shape';
import { cachedRead, type CachedReadCtx } from '../../cache';
import { planOriginFromBlenderFlag } from './plan-provenance';

/** Cap for the multi-harness arg per P-021 — keeps IN-style fan-out bounded. */
const HARNESS_SLUGS_MAX = 64;

/**
 * SWR backstop for plans:list (cache-expensive-tool-reads-2026-06-22 P-002 / D-002).
 * The plan tables (harness_plans/plan_revisions/plan_runs) are trigger-covered so a
 * plan write auto-invalidates via the cache-ECA — this short soft TTL only bounds
 * staleness for the un-triggered OVERLAY dimensions the read folds in (the open
 * issue-block overlay via coord_links).
 */
const PLANS_LIST_SOFT_TTL_MS = 45_000;

/**
 * Aggregate dimensions (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21
 * P-005). The "how many plans by status / per harness / created per day" question
 * was the last plans read with no arg for it, so agents hand-wrote it as raw SQL
 * against `harness_shared.harness_plans` — the exact shape that trips the
 * workspace+harness scoping footgun (see the raw-sql-plan-slug-needs-workspace-
 * harness-scope insight), because a hand-written predicate omits the tenant keys
 * this tool always applies. Every dimension here is derived from a row the read
 * already builds — no extra query, no new SQL.
 */
const GROUP_BY_KEYS = [
  'status',
  'lifecycleDisposition',
  'harness',
  'template',
  'owner',
  'initiative',
  'origin',
  'startStatus',
  'scheduled',
  'importance',
  'createdDay',
  'updatedDay',
] as const;
type GroupByKey = (typeof GROUP_BY_KEYS)[number];

/** Dimensions that need per-plan item resolution — everything else can run
 *  compact (no itemCounts pass) when the caller wants counts only. */
const GROUP_KEYS_NEEDING_ITEMS = new Set<GroupByKey>(['importance', 'lifecycleDisposition']);

const LIFECYCLE_DISPOSITIONS = [
  'abstained',
  'agreed',
  'contradicted',
  'unrecognized',
] as const satisfies readonly PlanLifecycleDisposition[];

const argsSchema = z.object({
  status: z
    .enum([...PLAN_STATUSES] as [string, ...string[]])
    .optional()
    .describe(
      'Filter by plan-level status. Legacy plans (no frontmatter) report status "draft"; use includeLegacy + the isLegacy flag to find them.',
    ),
  lifecycleDisposition: z
    .enum([...LIFECYCLE_DISPOSITIONS])
    .optional()
    .describe(
      'Filter by the read-time reconciliation between stored plan status and the item graph. `contradicted` is the terminal-debt queue (for example shipped with live items). Forces item resolution even with compact:true.',
    ),
  includeArchived: z.boolean().optional().describe('Include plans under docs/plans/archive/. Default false.'),
  includeLegacy: z.boolean().optional().describe('Include plans without valid frontmatter. Default true.'),
  includeFinished: z
    .boolean()
    .optional()
    .describe(
      'Include terminal shipped/superseded plans. Default true for API compatibility; large interactive directories pass false and fetch a selected terminal status lazily.',
    ),
  includeInstances: z
    .boolean()
    .optional()
    .describe(
      'Include per-run instance plans of scheduled templates (Option C). Hidden by default — they are reached via the template Runs history, not the main directory.',
    ),
  template: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filter to plans of a given template TYPE (e.g. "rubric") — plan-templates-and-rubric-v2 P-005. Rides the harness_plans_template_idx filter index.',
    ),
  templateSlug: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filter to per-run instances of a given template plan (the template_slug back-pointer). Implies including instances (they are otherwise hidden).',
    ),
  /**
   * P-029: explicit multi-harness fan-out. When set, ignore the ctx
   * harness and walk each named harness's `docs/plans/` dir, returning
   * the union. Use for sub-harness scope (e.g. `papercup` + its
   * registered submodules). De-dupes by `slug:harness` since plan
   * slugs are unique within a harness but can repeat across them.
   * Capped at 64 entries.
   *
   * Accepts a single string OR an array of strings so HTTP callers
   * can pass either `?harness_slugs=foo` or
   * `?harness_slugs=foo&harness_slugs=bar` without a 400. The
   * dispatcher's bodyFromSearchParams only collapses repeated keys
   * into arrays; a single occurrence arrives as a bare string.
   */
  harness_slugs: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(
      z.array(z.string().min(1)).max(HARNESS_SLUGS_MAX, {
        message: `harness_slugs capped at ${HARNESS_SLUGS_MAX}`,
      }),
    )
    .optional()
    .describe('Optional explicit fan-out across multiple harnesses (overrides ctx harness).'),
  workspaceWide: z
    .boolean()
    .optional()
    .describe(
      'List EVERY plan in the active workspace, regardless of harness (workspace-data-isolation-leaks F-A1). The UI "all plans" view uses this instead of the harness:"all" wildcard (which is the SU shortcut for Papercusp\'s own plans). Overrides harness / harness_slugs.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      'Max plans returned (after ordering). Combine with order:"updated" for "the N most-recent plans" instead of fetching every plan.',
    ),
  createdSince: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only plans created at/after this — an ISO date/timestamp ("2026-06-17") OR a relative window ("4d", "12h", "30m"). Filtered server-side (PG), not after fetch.',
    ),
  updatedSince: z
    .string()
    .min(1)
    .optional()
    .describe('Only plans with last real activity at/after this — ISO or relative ("4d"). Filtered server-side.'),
  order: z
    .enum(['updated', 'created', 'slug'])
    .optional()
    .describe('Order: "updated"/"created" = most-recent first; "slug" (default) = alphabetical.'),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Skip per-plan item-state resolution — omit itemCounts + maxImportance + lifecycle for a smaller, cheaper result (keeps slug/title/status/updated/created/owner/template/nextAction/harness). Use for a fast directory scan; lifecycleDisposition filters/groups override compact because they need the item graph.',
    ),
  groupBy: z
    .enum([...GROUP_BY_KEYS] as [GroupByKey, ...GroupByKey[]])
    .optional()
    .describe(
      'Aggregate the matched plans into { key, count } groups (returned as `groups`, alongside the rows) — the counts/group-by read that otherwise gets hand-written as raw SQL. Dimensions: status, lifecycleDisposition (stored status vs item graph), harness, template, owner, initiative, origin, startStatus, scheduled, importance (hottest OPEN item), createdDay/updatedDay (UTC day buckets). Aggregates over EVERY row the other filters matched; `limit` then bounds only the returned rows, never the counts.',
    ),
  aggregateOnly: z
    .boolean()
    .optional()
    .describe(
      "With groupBy: return the `groups` only (plans: []), and skip per-plan item resolution where the dimension doesn't need it — the cheap shape for a pure counts question. Ignored without groupBy.",
    ),
  harness: harnessArg,
});

/** Resolve a createdSince/updatedSince arg: a relative window ("4d"/"12h"/"30m")
 *  → an absolute ISO timestamp; otherwise pass the (assumed-ISO) string through
 *  for PG to parse. */
function resolveSince(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d+)\s*([dhm])$/i.exec(v.trim());
  if (!m) return v;
  const n = Number.parseInt(m[1], 10);
  const unitMs = m[2].toLowerCase() === 'd' ? 86_400_000 : m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000;
  return new Date(Date.now() - n * unitMs).toISOString();
}

type ListRow = {
  slug: string;
  title: string | null;
  status: string;
  /** Last REAL activity — the PG `updated_at` write timestamp (ISO; the
   *  trigger skips no-op bumps, mig 211). Falls back to the authored
   *  frontmatter date if the timestamp is ever absent. */
  updated: string | null;
  created: string | null;
  owner: string | null;
  /** P-015 free-text initiative grouping label (frontmatter-derived), or null. */
  initiative: string | null;
  /** Template TYPE this plan conforms to (frontmatter-derived), or null — P-005. */
  template: string | null;
  /** Permanent acceptance-waiver marker; null when the plan has never been forced. */
  forcedPast: PlanIndexRow['forcedPast'];
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Partial<Record<(typeof ITEM_STATUSES)[number] | 'unknown', number>> | null;
  /** Compact read-time reconciliation. Null only for compact or legacy rows. */
  lifecycle: {
    verdict: PlanLifecycleVerdict;
    disposition: PlanLifecycleDisposition;
    contradiction: { claim: string; evidence: string } | null;
  } | null;
  nextAction: string | null;
  /**
   * Resolved harness slug per
   * `plans-newbutton-and-subharness-scope-2026-05-25` P-022 / D-009.
   * Populated from `resolveHarnessPlansDir`'s output so callers don't
   * re-walk the registry. Always present (the resolver always picks
   * SOME harness, falling back to the workspace primary).
   */
  harness: string;
  /** Importance of the hottest OPEN item (done/dropped excluded), null
   *  when nothing is open. Missing `importance:` keyword = 'normal'. */
  maxImportance: Importance | null;
  /**
   * Schedule glance (scheduled-recurring-plans-2026-06-16 P-021). Derived from
   * the already-fetched harness_plans schedule columns (zero extra cost — the
   * index read already selects them). `scheduled` is the authoritative
   * "is this plan scheduled at all" signal; `scheduleActive` = armed/firing
   * (false = paused/disarmed); `scheduleKind` distinguishes a recurrence set
   * (`recurring`) from a one-shot `scheduled_at` (`one-shot`).
   */
  scheduled: boolean;
  scheduleActive: boolean;
  scheduleKind: 'recurring' | 'one-shot' | null;
  /** Derived from trigger presence on every read — never persisted as a plan kind. */
  triggered: boolean;
  /** Stable source order keeps UI badges and agent payloads deterministic. */
  triggerSources: PlanTriggerSource[];
};

export const PLAN_TRIGGER_SOURCES = ['schedule', 'external', 'manual'] as const;
export type PlanTriggerSource = (typeof PLAN_TRIGGER_SOURCES)[number];

/** One-time vs triggered is derived truth. A saved/disarmed schedule or external
 * binding still makes the plan triggered; arming controls execution, not type.
 * A template-backed plan counts as manual because templates and input_schema are
 * the two mutually-exclusive schema sources accepted by the plan-inputs gate. */
export function derivePlanTriggerSources(
  row: Pick<PlanIndexRow, 'schedule' | 'scheduledAt' | 'template' | 'hasInputSchema' | 'hasExternalTrigger'>,
): PlanTriggerSource[] {
  const sources: PlanTriggerSource[] = [];
  if (row.schedule != null || row.scheduledAt != null) sources.push('schedule');
  if (row.hasExternalTrigger === true) sources.push('external');
  if (row.hasInputSchema === true || row.template != null) sources.push('manual');
  return sources;
}

/** Most → least urgent rank, per IMPORTANCE_LEVELS order. */
const IMPORTANCE_RANK = Object.fromEntries(IMPORTANCE_LEVELS.map((level, i) => [level, i])) as Record<
  Importance,
  number
>;

/** One aggregate bucket: the dimension value (stringified; `null` when the row
 *  has no value for it) and how many plans fell in it. */
export type PlanGroup = { key: string | null; count: number };

/** The dimension value for one row — the single place a groupBy key maps onto a
 *  plan row, so a new dimension is one case, not a new query. */
function groupValue(
  row: {
    status: string;
    lifecycle: ListRow['lifecycle'];
    harness: string;
    template: string | null;
    owner: string | null;
    initiative: string | null;
    origin: 'scout' | null;
    startStatus: string | null;
    scheduled: boolean;
    maxImportance: Importance | null;
    created: string | null;
    updated: string | null;
  },
  key: GroupByKey,
): string | null {
  switch (key) {
    case 'status':
      return row.status;
    case 'lifecycleDisposition':
      return row.lifecycle?.disposition ?? null;
    case 'harness':
      return row.harness;
    case 'template':
      return row.template;
    case 'owner':
      return row.owner;
    case 'initiative':
      return row.initiative;
    case 'origin':
      return row.origin;
    case 'startStatus':
      return row.startStatus;
    case 'scheduled':
      return row.scheduled ? 'true' : 'false';
    case 'importance':
      return row.maxImportance;
    // UTC day bucket — `created` is a date-ish string, `updated` a full ISO
    // timestamp; both slice to YYYY-MM-DD. Unparseable/absent ⇒ null bucket.
    case 'createdDay':
      return isoOrNull(row.created)?.slice(0, 10) ?? null;
    case 'updatedDay':
      return isoOrNull(row.updated)?.slice(0, 10) ?? null;
  }
}

/** Count rows per dimension value, most-populous first (ties alphabetical, the
 *  null bucket last) — a stable order so a repeated call reads the same. */
function buildGroups(rows: readonly Parameters<typeof groupValue>[0][], key: GroupByKey): PlanGroup[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const v = groupValue(row, key);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return a.key.localeCompare(b.key);
    });
}

/** PG timestamps arrive as Date (node-postgres) or string depending on
 *  pool config — normalize to ISO; null when absent/unparseable. */
function isoOrNull(ts: unknown): string | null {
  if (!ts) return null;
  const d = new Date(ts as string | number | Date);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Injectable seam for {@link resolveFanOutPlanScopes} — the two real resolvers. */
export interface FanOutResolvers {
  /** Validates the slug is registered; throws otherwise. */
  validate: (slug: string) => Promise<{ harnessSlug: string }>;
  /** Collapses a harness onto the PLAN SCOPE it actually reads (its Hive home). */
  scope: (slug: string) => Promise<{ harnessSlug: string }>;
}

/**
 * Resolve the `harness_slugs` fan-out to the DISTINCT plan scopes to read.
 *
 * Plans are HIVE-scoped: `resolvePlanScope` collapses a member harness onto its Hive
 * HOME, and `listPlanIndexRows` performs that same collapse internally. So deduping on
 * the REQUESTED slug is not enough — every member of one hive resolves to the same home
 * and would get its own batch reading the SAME plan set. The rows come back N times,
 * distinguishable only by the `harness` stamp the caller puts on each batch, which the
 * downstream `${harnessSlug}:${slug}` row-dedupe key cannot see by construction.
 *
 * Measured on `plans.byHive` before this collapse (papercusp hive, members [papercusp,
 * hive-canary]): 1,820 rows / 1,249,676 B, of which 910 rows / ~50% were a fabricated
 * second copy stamped `harness: 'hive-canary'` — a harness with ZERO rows of its own in
 * `harness_plans`. It also made the rollup UI render every plan twice and drill into a
 * member that does not own it, and it left no unique field to key the rows-delta on
 * (WI-7083).
 *
 * An unresolvable slug is a WARNING entry, never a throw — the caller may be holding a
 * stale registry snapshot, and `resolvePlanScope`'s "not a Hive home" refusal means the
 * same thing the batch loop means by it: no plan scope, so no rows.
 */
export async function resolveFanOutPlanScopes(
  slugs: readonly string[],
  resolvers: FanOutResolvers = {
    validate: (s) => resolveHarnessPlansDir(s),
    scope: (s) => resolvePlanScope({ harnessSlug: s }),
  },
): Promise<{ scopes: string[]; unknown: string[] }> {
  const scopes: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    const trimmed = slug.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    try {
      const validated = await resolvers.validate(trimmed);
      const scope = await resolvers.scope(validated.harnessSlug);
      if (!scopes.includes(scope.harnessSlug)) scopes.push(scope.harnessSlug);
    } catch {
      unknown.push(trimmed);
    }
  }
  return { scopes, unknown };
}

export default defineTool({
  name: 'plans:list',
  description:
    'List SU plans from the PG-canonical plan store. One row per plan with title, stored status, read-time lifecycle reconciliation, item counts by effectiveStatus, and the ## Now next-action line; groupBy returns { key, count } aggregates. Legacy plans (no frontmatter) surface as status="draft" (flagged via isLegacy).',
  guidance: {
    when: 'A directory of plans — "what plans exist / are active", the terminal-debt queue (`lifecycleDisposition:"contradicted"`), or the entry point before plans:get. For RECENT plans, pass updatedSince/createdSince (ISO or "4d") + order:"updated" + limit — these filter SERVER-SIDE (PG), so do NOT fetch every plan and post-filter (that returns a huge result). For COUNTS ("how many plans by status / lifecycle disposition / harness / created per day"), pass groupBy (+ aggregateOnly for counts only) rather than hand-writing SQL over harness_plans — this read always applies the workspace+harness scope a raw predicate silently omits. For a fast scan that skips item-count and lifecycle resolution, add compact:true.',
    notWhen:
      'You already know the plan slug and want full contents — call plans:get directly. For a plan-shaped aggregate use groupBy here; drop to dev:pg_query only for a genuinely ad-hoc read this tool exposes no arg for (a join across other tables, an item-level roll-up). No free-text `q`/`query` filter here — use plans:search { query } for keyword search.',
    chaining:
      'plans:list → plans:get { slug } (full plan) or plans:items { actionable: true } (pickable items across plans).',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (overwatch-role-2026-06-15 B-01): the supervisor grounds nudges against
  // active plans / stalled items / aging escalations (read-only — plans:read cap).
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-015 — Lane F rollout,
  // pairs with the P-013 plans:attention exemplar). The diffable unit is the `plans` row
  // set, keyed by the stable `slug`; a plan row carries `updated`, so the framework's
  // content-hash revision flags a changed plan as `updated` and add/remove tracks plans
  // entering/leaving the listed set. The framework folds the filter args (harness/order/
  // limit/includeArchived/includeLegacy/compact) into the view fingerprint, so a compact
  // or differently-filtered call gets its own cursor; `scope` adds the workspace dimension.
  // Dormant until the papercusp-tool-delta-protocol flag flips.
  delta: {
    rows: (data) => {
      const plans = (data as { plans?: unknown[] } | null | undefined)?.plans;
      return Array.isArray(plans) ? plans : null;
    },
    itemKey: (row) => (row as { slug: string }).slug,
    itemKeyField: 'slug',
    orderKey: 'updated',
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? '',
    schemaVersion: 'plans-list-v2',
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-021: trimmed/standard sessions get projected rows
  // (recency-kept caps + flattened counts — see list-shape.ts). The cache stores
  // the UNSHAPED rows (shaping runs post-handler in defineTool dispatch), so one
  // cached read serves every tier; the UI (HTTP/sync path, no ctx_tier) reads full.
  shape: {
    standard: (data, sctx) => shapePlansList(data, 'standard', sctx.args),
    trimmed: (data, sctx) => shapePlansList(data, 'trimmed', sctx.args),
    // WI-2145871. `shapePlansList` REBUILDS every row from the `base` object
    // literal (list-shape.ts), so a field dropped from that literal vanishes
    // from the tier agents get BY DEFAULT while the result still reads ok:true
    // — the field looks absent from the data rather than removed by the shaper.
    //
    // WHY THESE TWELVE, AND ONLY THESE. `project()` has two emission paths:
    // `base` (trimmed) and `{ ...base, done, owner, … }` (standard). The keys
    // emitted UNCONDITIONALLY by both are exactly `base`'s, and each is an
    // explicit key in that literal (`r.x ?? null` / `clip(...)`), never a
    // conditional spread — so none can disappear merely by being falsy. The
    // standard-only extras are deliberately NOT pinned: this check runs the
    // TRIMMED shaper, so pinning them would assert nothing.
    //
    // `slug` and `title` are also the truncation guard — the over-cap sentinel
    // row is `{ ...project({}), slug: '(truncated)', title: 'showing N of M' }`
    // — so losing either leaves a capped list looking complete.
    //
    // No `preserve`: the shaper returns `{ ...data, plans: rows }`, so every
    // top-level key survives unconditionally and a preserve pin would be
    // decoration — green forever, guarding nothing, and counted as guarded by
    // the next reader.
    contract: {
      rows: 'plans',
      fields: [
        'slug',
        'title',
        'status',
        'lifecycleVerdict',
        'lifecycleDisposition',
        'lifecycleContradiction',
        'harness',
        'updated',
        'next',
        'open',
        'maxImportance',
        'triggered',
      ],
    },
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const includeArchived = args.includeArchived === true;
    const includeLegacy = args.includeLegacy !== false;
    const includeFinished = args.includeFinished !== false;
    const includeInstances = args.includeInstances === true;
    // P-005 aggregate path: `aggregateOnly` is only meaningful with a dimension.
    const groupBy = args.groupBy;
    const aggregateOnly = args.aggregateOnly === true && !!groupBy;
    const needsLifecycle = Boolean(args.lifecycleDisposition || groupBy === 'lifecycleDisposition');
    // A counts-only read skips the (expensive) per-plan item-state pass unless the
    // dimension/filter itself is item-derived. A lifecycle request wins over an
    // explicit compact:true because filtering without deriving would fabricate
    // an empty result.
    const compact = needsLifecycle
      ? false
      : args.compact === true || (aggregateOnly && !(groupBy && GROUP_KEYS_NEEDING_ITEMS.has(groupBy)));
    // EI-19932192274787948: `status` (and `includeLegacy:false`) are filtered
    // in JS AFTER the SQL fetch (below — the `draft` status must also match a
    // NULL column for legacy plans, which the SQL `status = $1` filter used by
    // listPlanIndexRows cannot express). Pushing `limit` into the SQL fetch
    // while a JS-side post-filter is active bounds the PRE-filter row window
    // (all statuses), so the post-filter can silently whittle a full `limit`
    // window down to far fewer rows than actually match — a caller reads a
    // well-formed, plausible, WRONG "complete" answer. Skip the limit pushdown
    // whenever a JS-side post-filter could still drop rows; `limited` below
    // (computed AFTER the JS filters run) re-applies the cap correctly.
    const hasJsPostFilter = Boolean(args.status || args.lifecycleDisposition) || !includeLegacy || !includeFinished;
    // Server-side recency/order/limit (pushed into the SQL, not post-filtered).
    // With `groupBy`, `limit` is NOT pushed down: the aggregate must see every
    // matched row, so the cap applies to the returned rows only (below).
    const sourceFilters = {
      ...(resolveSince(args.createdSince) ? { createdSince: resolveSince(args.createdSince) } : {}),
      ...(resolveSince(args.updatedSince) ? { updatedSince: resolveSince(args.updatedSince) } : {}),
      ...(args.order ? { order: args.order } : {}),
      ...(args.limit && args.limit > 0 && !groupBy && !hasJsPostFilter ? { limit: args.limit } : {}),
    };

    // P-029: build the list of harness slugs to read.
    // When `harness_slugs` is supplied, fan out across each (validated via
    // resolveHarnessPlansDir); otherwise fall through to the ctx-resolver's
    // single harness. Unknown slugs produce a warning entry instead of
    // throwing — caller may pass a stale registry snapshot from the client.
    // F-A1: the workspace-wide path lists every plan in the active workspace by
    // workspace_id (RLS-scoped), regardless of harness — the UI "all plans" view.
    // Otherwise resolve the harness set as before (explicit fan-out, or the ctx
    // harness / the SU 'all' wildcard → papercup).
    const perHarness: string[] = [];
    const unknownHarnesses: string[] = [];
    if (!args.workspaceWide) {
      if (args.harness_slugs && args.harness_slugs.length > 0) {
        const fanOut = await resolveFanOutPlanScopes(args.harness_slugs);
        perHarness.push(...fanOut.scopes);
        unknownHarnesses.push(...fanOut.unknown);
      } else {
        const one = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
        perHarness.push(one.harnessSlug);
      }
    }

    // Cache the expensive fetch + augmentation (cache-expensive-tool-reads-2026-06-22
    // P-002). plans:list is the #1 read-byte tool by 48h telemetry; its read is PURE
    // and non-principal-scoped (depends only on workspace + harness-set + args — D-001).
    // Tags are the trigger-covered plan tables, so any plan write auto-invalidates via
    // the cache-ECA; the short SWR softTtl backstops the un-triggered OVERLAY dims
    // (issue-block via coord_links, scout via scout_routed_ideas). The key folds EVERY
    // output-determining dimension — the resolved harness set + workspaceWide + the RAW
    // args (RAW createdSince/updatedSince, NOT the Date.now()-resolved absolute time, so
    // two `4d` calls share one entry within the TTL window).
    const cacheKey = {
      status: args.status ?? null,
      lifecycleDisposition: args.lifecycleDisposition ?? null,
      includeArchived,
      includeLegacy,
      includeFinished,
      includeInstances,
      template: args.template ?? null,
      templateSlug: args.templateSlug ?? null,
      order: args.order ?? null,
      limit: args.limit ?? null,
      createdSince: args.createdSince ?? null,
      updatedSince: args.updatedSince ?? null,
      compact,
      groupBy: groupBy ?? null,
      aggregateOnly,
      workspaceWide: args.workspaceWide === true,
      harnesses: [...perHarness].sort(),
    };

    const { plans, groups, harnessCount, batchUnknown, truncated } = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: 'plans:list',
        key: cacheKey,
        tags: ['harness_plans', 'plan_revisions', 'plan_runs', 'trigger_bindings'],
        softTtlMs: PLANS_LIST_SOFT_TTL_MS,
        // P-007/D-082: D-073 measured this read hitting the ~10s cachedRead deadline
        // under a 16-way herd (6 of 16 calls at 10037-10186ms) — the per-worker cold
        // build the durable tier exists to share. Value is plain JSON.
        l2: true,
      },
      async () => {
        // Per-build collector for the not-registered slugs the batch loop swallows
        // (merged into the response metadata below). Local so a cache HIT doesn't lose it.
        const batchUnknown: string[] = [];
        // Fetch the index rows as per-harness batches. Workspace-wide reads them all
        // at once (one query by workspace_id) and groups by harness so the per-harness
        // gap-fill + row processing below is unchanged.
        const batches: Array<{ harnessSlug: string; rows: PlanIndexRow[] }> = [];
        if (args.workspaceWide) {
          const allRows = await listPlanIndexRowsForWorkspace({
            workspaceId: activeWorkspaceId(),
            includeArchived,
            includeInstances,
            ...(args.template ? { template: args.template } : {}),
            ...(args.templateSlug ? { templateSlug: args.templateSlug } : {}),
            ...sourceFilters,
          });
          const byHarness = new Map<string, PlanIndexRow[]>();
          for (const r of allRows) {
            const arr = byHarness.get(r.harnessSlug) ?? [];
            arr.push(r);
            byHarness.set(r.harnessSlug, arr);
          }
          for (const [harnessSlug, rows] of byHarness) batches.push({ harnessSlug, rows });
        } else {
          for (const harnessSlug of perHarness) {
            try {
              const rows = await listPlanIndexRows({
                harnessSlug,
                includeArchived,
                includeInstances,
                ...(args.template ? { template: args.template } : {}),
                ...(args.templateSlug ? { templateSlug: args.templateSlug } : {}),
                ...sourceFilters,
              });
              batches.push({ harnessSlug, rows });
            } catch (err) {
              // infra round-3 F5 (+ EI-7864 follow-up): a stale/unregistered OR
              // non-Hive-scoped slug must not spike the error-rate on plans:list
              // (the highest-volume tool — ~2% of calls were `resolvePlanScope:
              // harness '…' is not registered`, from callers querying a
              // deregistered/stale hive slug). A LIST read of a harness that
              // resolvePlanScope refuses is empty, not an error — match the
              // harness_slugs fan-out path above (which already catches →
              // unknownHarnesses). EI-7864: a standalone/scratch harness that is
              // registered in `projects` but is NOT a Hive home (e.g. pot-verify,
              // used for manual UI verification — WI-1992 plans are Hive-scoped)
              // hit the SAME "list against a harness with no plans" shape but the
              // narrower `/not registered/i` regex didn't cover its distinct
              // "is not a Hive home" message, so it fell through to `throw err`
              // uncaught. Both resolvePlanScope failure messages are swallowed
              // here; any OTHER error (a real DB/query fault) still throws so
              // genuine failures stay loud.
              //
              // P-014 / EI-19286551248996972: this used to test the message inline
              // with a bare /not registered|not a Hive home/i — no `resolvePlanScope:`
              // anchor, so it matched those words ANYWHERE in the string. That made a
              // registry READ FAULT swallowable as an absence: RegistryReadUnavailableError
              // appends `Underlying: <cause.message>`, and a DB/pool fault whose text
              // happens to contain "not registered" would then be reported as ok:true + []
              // for a harness that actually holds rows — the precise incident that filed
              // this. Classification now goes through the shared, TYPE-first predicate in
              // ./source (which rejects the fault by `instanceof` before reading any text),
              // so a fault cannot be spelled into an absence. It is also the same predicate
              // plans:items uses, so the two read tools can no longer disagree about what
              // "unknown harness" means.
              if (isUnknownPlanScopeError(err)) {
                batchUnknown.push(harnessSlug);
              } else {
                throw err;
              }
            }
          }
        }

        type AugmentedRow = ListRow & {
          startStatus: 'started' | 'paused' | 'done' | null;
          priority: number | null;
          /** 'scout' when canonical plan content declares the shared Blender marker. */
          origin: 'scout' | null;
        };
        const augmentedRows: AugmentedRow[] = [];
        const seenRowKeys = new Set<string>();

        // engineer-issues D-005: one batch read of every open issue-block across all
        // plans, so the per-plan itemCounts histogram below reflects items flipped to
        // `blocked` by an open engineer-issue. Hoisted out of the harness×plan loops.
        // Non-fatal — degrades to resolver-only counts on error.
        let allBlocked = new Map<string, string[]>();
        if (!compact) {
          // Only needed for the itemCounts overlay — skipped in compact mode.
          try {
            allBlocked = await getAllBlockedPlanItems();
          } catch {
            // Non-fatal — no issue-block overlay.
          }
        }

        for (const { harnessSlug, rows } of batches) {
          // Index-only rows (audit P-042 — EI-98/EI-174/EI-175): every field this
          // row needs lives in the harness_plans projection columns, so the
          // content blobs never leave PG and nothing is parsed per request. The
          // archived filter ran in SQL during the fetch above.

          // Targeted fallback for projection-gap rows (non-legacy with an empty
          // Stage-3 items index — e.g. a federated remote row whose projection
          // didn't fill): ONE batched content fetch for just those slugs, parsed
          // below. Best-effort — on failure their counts degrade to {}.
          const gapSlugs = compact
            ? []
            : rows.filter((r) => !r.isLegacy && r.items.length === 0).map((r) => r.planSlug);
          let gapContents = new Map<string, string>();
          if (gapSlugs.length > 0) {
            try {
              gapContents = await getPlanContentsBySlugs(gapSlugs, {
                harnessSlug,
              });
            } catch {
              /* counts for gap rows degrade to {} */
            }
          }

          const itemsForRow = (row: PlanIndexRow): PlanItem[] => {
            if (row.items.length > 0) {
              return row.items.map((i) => ({
                id: i.id,
                text: i.text,
                storedStatus: i.status as ItemStatus,
                importance: i.importance as Importance,
                blockedBy: i.blockedBy,
                decisionRefs: i.decisionRefs,
                phase: i.phase,
                lineNumber: 0,
                rawLine: '',
              }));
            }
            const content = gapContents.get(row.planSlug);
            return content ? parsePlan(content).items : [];
          };

          for (const row of rows) {
            if (row.isLegacy && !includeLegacy) continue;

            const slug = row.planSlug;
            const triggerSources = derivePlanTriggerSources(row);
            // No projected status (incl. legacy/unparseable plans) → 'draft'.
            const status = row.status ?? 'draft';

            let itemCounts: ListRow['itemCounts'] = null;
            let maxImportance: Importance | null = null;
            let lifecycle: ListRow['lifecycle'] = null;
            if (!compact && !row.isLegacy) {
              const planItems = itemsForRow(row);
              const { items } = applyPlanItemBlocks(resolveEffectiveStatusForItems(planItems).items, (id) =>
                allBlocked.get(planItemRef(slug, id)),
              );
              const counts: Record<string, number> = {};
              for (const it of items) {
                counts[it.effectiveStatus] = (counts[it.effectiveStatus] ?? 0) + 1;
                // Hottest open item — a done/dropped urgent item shouldn't keep
                // the plan ranked "most urgent".
                if (it.effectiveStatus !== 'done' && it.effectiveStatus !== 'dropped') {
                  const imp = it.importance ?? 'normal';
                  if (maxImportance === null || IMPORTANCE_RANK[imp] < IMPORTANCE_RANK[maxImportance]) {
                    maxImportance = imp;
                  }
                }
              }
              itemCounts = counts;

              // The directory now exposes the same pure item-graph/status
              // reconciliation as plans:get. Keep this list payload compact:
              // counts already ride in itemCounts, while the full explanatory
              // text and signal provenance remain available from plans:get.
              const reconciled = reconcilePlanLifecycle(status, derivePlanLifecycle(planItems));
              lifecycle = {
                verdict: reconciled.derived.verdict,
                disposition: reconciled.disposition,
                contradiction: reconciled.contradiction,
              };
            }

            if (args.status && status !== args.status) continue;
            if (!includeFinished && (status === 'shipped' || status === 'superseded')) continue;
            if (args.lifecycleDisposition && lifecycle?.disposition !== args.lifecycleDisposition) continue;

            const dedupKey = `${harnessSlug}:${slug}`;
            if (seenRowKeys.has(dedupKey)) continue;
            seenRowKeys.add(dedupKey);

            augmentedRows.push({
              slug,
              title: row.title,
              status,
              updated: isoOrNull(row.updatedAt) ?? row.updated ?? null,
              created: row.created,
              owner: row.owner,
              initiative: row.initiative,
              template: row.template,
              forcedPast: row.forcedPast,
              archived: row.archived,
              isLegacy: row.isLegacy,
              itemCounts,
              lifecycle,
              nextAction: row.nowNext,
              harness: harnessSlug,
              // Self-heal the started/terminal invariant on read: a terminal plan
              // (shipped/superseded) can never be operationally started/paused.
              startStatus: reconcileStartStatus(row.opStatus, status),
              priority: row.opPriority,
              maxImportance,
              origin: planOriginFromBlenderFlag(row.isBlenderOrigin),
              // P-021 schedule glance — already-loaded columns, no extra read.
              // A recurrence set ⇒ recurring; else a bare one-shot fire time ⇒ one-shot.
              scheduled: row.schedule != null || row.scheduledAt != null,
              scheduleActive: row.scheduleActive === true,
              scheduleKind: row.schedule != null ? 'recurring' : row.scheduledAt != null ? 'one-shot' : null,
              triggered: triggerSources.length > 0,
              triggerSources,
            });
          }
        }

        // Re-apply order + limit ACROSS harness batches (SQL ordered/limited each
        // batch; this makes a multi-harness fan-out yield the correct global top-N).
        if (args.order === 'updated') {
          augmentedRows.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
        } else if (args.order === 'created') {
          augmentedRows.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
        } else if (args.order === 'slug') {
          augmentedRows.sort((a, b) => a.slug.localeCompare(b.slug));
        }
        // P-005: aggregate over EVERY matched row — before `limit`, which bounds
        // only what comes back. (With groupBy the SQL-side limit is skipped too,
        // so `augmentedRows` really is the full matched set.)
        const groups = groupBy ? buildGroups(augmentedRows, groupBy) : null;

        // EI-19932192274787948 fix option 3: `augmentedRows` here is always the FULL
        // matched-and-JS-filtered set (limit is never pushed into the SQL fetch when a
        // JS post-filter is active — see hasJsPostFilter above — and the multi-harness
        // fan-out re-slices globally after combining every harness's own capped batch).
        // So comparing its length against `args.limit` reliably tells a caller whether
        // the returned window is a true cap, rather than leaving that silently implicit.
        const truncated = Boolean(args.limit && args.limit > 0 && augmentedRows.length > args.limit);
        const limited = args.limit && args.limit > 0 ? augmentedRows.slice(0, args.limit) : augmentedRows;
        const plans = aggregateOnly ? [] : limited;
        return { plans, groups, harnessCount: batches.length, batchUnknown, truncated };
      },
    );

    // unknownHarnesses from the explicit harness_slugs fan-out (resolved BEFORE the
    // cache, cheap) + batchUnknown from the cached fetch (the not-registered swallows).
    const allUnknown = [...unknownHarnesses, ...batchUnknown];
    ctxAny.metadata?.({
      count: plans.length,
      includeArchived,
      includeLegacy,
      compact,
      harnessCount,
      ...(groupBy && { groupBy, groupCount: groups?.length ?? 0 }),
      ...(allUnknown.length > 0 && { unknownHarnesses: allUnknown }),
      ...(truncated && { truncated }),
    });

    // {data} envelope (not a hand-rolled ToolResult) so the payload-tier shapers
    // apply; HTTP/sync consumers still read identical `{"plans":[...]}` JSON text.
    // `groups` rides alongside only when asked for — the shapers spread the data
    // object, so the aggregate survives every payload tier untrimmed (it is small
    // and IS the answer when groupBy was passed).
    // EI-19932192274787948: `truncated:true` means MORE plans matched than were
    // returned (limit capped the window) — never silently omitted, so a caller
    // that relied on a bare `limit` to mean "no more than N, but I got them all"
    // can tell the two apart instead of mistaking a capped window for complete.
    return { data: { plans, ...(groups ? { groups } : {}), ...(truncated ? { truncated } : {}) } };
  },
});
