/**
 * plan-efficiency.ts — the per-plan efficiency read.
 *
 * review-system-rework-reduction-2026-09-23 P-032 (report improvement 26). One read answers, for
 * one plan: where its agents' MCP calls went (by purpose), how many calls went to items that ended
 * dropped, how many calls failed and by which class, how often an item changed hands, and how the
 * agents who worked it split their wall-clock between active, idle and away. Surfaced through
 * `plans:get { efficiency: true }` — an extension of the existing read, not a bespoke tool — so the
 * same numbers the audit hand-derived with SQL (docs/evidence/review-system-time-audit-2026-09-23.md,
 * "Sources") are one call for the next plan's before/after.
 *
 * POPULATION. `harness_shared.tool_invocations` rows with `call_origin = 'agent'` whose `goal_ref`
 * is one of the plan's work items (`work_items.source_plan_slug` = the plan, observation lane
 * excluded). Every count is a FLOOR, and the payload says so: native client tools (Edit / Read /
 * Bash) write no tool_invocations row, and a call made without a goal stamp is attributed to no
 * plan at all.
 *
 * WALL-CLOCK is measured over the agents' transcript parts (`session_turn_parts`, corpus workspace
 * `default`) between the plan's first and last attributed call. An agent working two plans in that
 * window counts toward both, so it is labelled `holders-across-plan-window`, never "time on plan".
 */
import { getOrgPg } from '@papercusp/db-org';

export const PLAN_EFFICIENCY_CATEGORIES = [
  'generic-exec',
  'coordination-carry',
  'read-orient',
  'acceptance-ceremony',
  'gate-pipeline',
  'implementation-test',
  'other',
] as const;
export type PlanEfficiencyCategory = (typeof PLAN_EFFICIENCY_CATEGORIES)[number];

/** Gaps between consecutive transcript parts shorter than this count as active time. */
export const ACTIVE_GAP_SEC = 120;
/** Gaps at least ACTIVE_GAP_SEC and shorter than this are idle; longer gaps are away. */
export const IDLE_GAP_SEC = 3600;

const EXACT_CATEGORY: Readonly<Record<string, PlanEfficiencyCategory>> = {
  'capability:bash': 'generic-exec',
  'capability:bash_output': 'generic-exec',
  'code:run': 'generic-exec',
  'tools:invoke': 'generic-exec',
  'recipes:run': 'generic-exec',
  'capability:edit': 'implementation-test',
  'capability:write': 'implementation-test',
  'plans:set-plan-status': 'acceptance-ceremony',
  'plans:audit': 'acceptance-ceremony',
  'plans:evaluate-spec-test-adequacy': 'acceptance-ceremony',
  'plans:bind-spec-evidence': 'acceptance-ceremony',
  'plans:get-spec-evidence': 'acceptance-ceremony',
  'dev:pipeline_position': 'gate-pipeline',
  'dev:restart': 'gate-pipeline',
  'work_items:checkpoint': 'coordination-carry',
  'work_items:claim': 'coordination-carry',
  'work_items:claim_next': 'coordination-carry',
  'work_items:release': 'coordination-carry',
  'work_items:comment': 'coordination-carry',
  'work_items:complete': 'coordination-carry',
  'work_items:set_state': 'coordination-carry',
  'scheduler:get_next': 'coordination-carry',
  'session:request-compaction': 'coordination-carry',
};

const PREFIX_CATEGORY: ReadonlyArray<readonly [string, PlanEfficiencyCategory]> = [
  ['coord:', 'coordination-carry'],
  ['loop:', 'coordination-carry'],
  ['locks:', 'coordination-carry'],
  ['events:', 'coordination-carry'],
  ['fleet:', 'coordination-carry'],
  ['facts:', 'coordination-carry'],
  ['orders:', 'coordination-carry'],
  ['mode:', 'coordination-carry'],
  ['rubrics:', 'acceptance-ceremony'],
  ['scorecards:', 'acceptance-ceremony'],
  ['release:', 'gate-pipeline'],
  ['git-sync:', 'gate-pipeline'],
  ['testing:', 'implementation-test'],
  ['build:', 'implementation-test'],
  ['lint:', 'implementation-test'],
  ['plans:', 'read-orient'],
  ['work_items:', 'read-orient'],
  ['issues:', 'read-orient'],
  ['dev:', 'read-orient'],
  ['docs:', 'read-orient'],
  ['search:', 'read-orient'],
  ['sessions:', 'read-orient'],
  ['memory:', 'read-orient'],
  ['state:', 'read-orient'],
  ['tools:', 'read-orient'],
  ['lsp:', 'read-orient'],
  ['graph:', 'read-orient'],
  ['gitnexus.', 'read-orient'],
];

/**
 * Collapse an MCP tool name (colon form) into the purpose it served. Exact names win over
 * prefixes, so e.g. `plans:set-plan-status` is acceptance ceremony while other `plans:*` verbs are
 * reads, and `work_items:checkpoint` is carry while `work_items:get` is a read.
 */
export function categorizePlanToolCall(toolName: string): PlanEfficiencyCategory {
  const name = toolName.trim().toLowerCase();
  const exact = EXACT_CATEGORY[name];
  if (exact) return exact;
  for (const [prefix, category] of PREFIX_CATEGORY) {
    if (name.startsWith(prefix)) return category;
  }
  return 'other';
}

/** Statuses that are NOT a failed call: a success, or an idempotent replay of one. */
const NON_FAILED_STATUSES = new Set(['ok', 'replayed']);

export interface PlanEfficiencyInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** postgres-js client; defaults to the org pool. Injected by the integration test. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
  /** How many most-contested items to name. */
  topItems?: number;
}

export interface PlanEfficiency {
  planSlug: string;
  harnessSlug: string;
  workspaceId: string;
  population: {
    source: 'harness_shared.tool_invocations';
    callOrigin: 'agent';
    attribution: 'goal_ref in the plan work items (source_plan_slug; observation lane excluded)';
    floor: true;
    note: string;
  };
  items: { total: number; byStatus: Record<string, number> };
  calls: {
    total: number;
    agents: number;
    activeHours: number;
    firstAt: string | null;
    lastAt: string | null;
    byCategory: Record<PlanEfficiencyCategory, number>;
  };
  failed: { total: number; share: number; byClass: Record<string, number> };
  droppedEffort: { calls: number; items: number; itemIds: string[] };
  holders: {
    itemsWorked: number;
    itemsWithHolderChange: number;
    holderChanges: number;
    mostHandled: Array<{ itemId: string; holders: number }>;
  };
  wallClock: {
    scope: 'holders-across-plan-window';
    activeGapSec: number;
    idleGapSec: number;
    owners: number;
    activeSec: number;
    idleSec: number;
    awaySec: number;
    idleGaps: number;
  };
}

interface CallGroupRow {
  tool_name: string;
  status: string | null;
  error_code: string | null;
  on_dropped: boolean;
  n: number | string;
}

const toNumber = (value: number | string | null | undefined): number => (value == null ? 0 : Number(value));
const toIso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

function emptyCategories(): Record<PlanEfficiencyCategory, number> {
  return Object.fromEntries(PLAN_EFFICIENCY_CATEGORIES.map((category) => [category, 0])) as Record<
    PlanEfficiencyCategory,
    number
  >;
}

/** Fold the grouped call rows into category, failure and dropped-effort tallies. */
export function foldPlanCallGroups(rows: readonly CallGroupRow[]): {
  total: number;
  byCategory: Record<PlanEfficiencyCategory, number>;
  failedTotal: number;
  failedByClass: Record<string, number>;
  droppedCalls: number;
} {
  const byCategory = emptyCategories();
  const failedByClass: Record<string, number> = {};
  let total = 0;
  let failedTotal = 0;
  let droppedCalls = 0;
  for (const row of rows) {
    const n = toNumber(row.n);
    total += n;
    byCategory[categorizePlanToolCall(row.tool_name)] += n;
    if (row.on_dropped) droppedCalls += n;
    const status = row.status ?? 'unknown';
    if (!NON_FAILED_STATUSES.has(status)) {
      failedTotal += n;
      const cls = row.error_code?.trim() || status;
      failedByClass[cls] = (failedByClass[cls] ?? 0) + n;
    }
  }
  return { total, byCategory, failedTotal, failedByClass, droppedCalls };
}

export async function readPlanEfficiency(input: PlanEfficiencyInput): Promise<PlanEfficiency> {
  const sql = input.sql ?? getOrgPg().sql;
  const { workspaceId, harnessSlug, planSlug } = input;
  const topItems = input.topItems ?? 5;

  const itemRows = await sql<Array<{ feature_id: string; status: string }>>`
    SELECT feature_id, status
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND source_plan_slug = ${planSlug}
       AND lane IS DISTINCT FROM 'observation'`;
  const itemIds = itemRows.map((row) => row.feature_id);
  const droppedIds = itemRows.filter((row) => row.status === 'dropped').map((row) => row.feature_id);
  const byStatus: Record<string, number> = {};
  for (const row of itemRows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  const groups = itemIds.length
    ? await sql<CallGroupRow[]>`
        SELECT tool_name, status, error_code,
               (goal_ref = ANY(${droppedIds}::text[])) AS on_dropped,
               count(*) AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND goal_ref = ANY(${itemIds}::text[])
         GROUP BY 1, 2, 3, 4`
    : [];
  const folded = foldPlanCallGroups(groups);

  const [span] = itemIds.length
    ? await sql<Array<{ agents: number | string; hours: number | string; first_at: Date | null; last_at: Date | null }>>`
        SELECT count(DISTINCT coord_owner_id) AS agents,
               count(DISTINCT date_trunc('hour', invoked_at)) AS hours,
               min(invoked_at) AS first_at,
               max(invoked_at) AS last_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND goal_ref = ANY(${itemIds}::text[])`
    : [{ agents: 0, hours: 0, first_at: null, last_at: null }];

  const perItem = itemIds.length
    ? await sql<Array<{ goal_ref: string; holders: number | string }>>`
        SELECT goal_ref, count(DISTINCT coord_owner_id) AS holders
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND coord_owner_id IS NOT NULL
           AND goal_ref = ANY(${itemIds}::text[])
         GROUP BY goal_ref`
    : [];
  const handled = perItem
    .map((row) => ({ itemId: row.goal_ref, holders: toNumber(row.holders) }))
    .sort((a, b) => b.holders - a.holders || a.itemId.localeCompare(b.itemId));
  const droppedWorked = new Set(perItem.map((row) => row.goal_ref).filter((id) => droppedIds.includes(id)));

  const owners = itemIds.length
    ? (
        await sql<Array<{ coord_owner_id: string }>>`
          SELECT DISTINCT coord_owner_id
            FROM harness_shared.tool_invocations
           WHERE workspace_id = ${workspaceId}
             AND call_origin = 'agent'
             AND coord_owner_id IS NOT NULL
             AND goal_ref = ANY(${itemIds}::text[])`
      ).map((row) => row.coord_owner_id)
    : [];
  const firstAt = toIso(span?.first_at);
  const lastAt = toIso(span?.last_at);
  const [clock] =
    owners.length && firstAt && lastAt
      ? await sql<
          Array<{ owners: number | string; active: number | string; idle: number | string; away: number | string; idle_gaps: number | string }>
        >`
          SELECT count(DISTINCT owner) AS owners,
                 coalesce(sum(gap) FILTER (WHERE gap < ${ACTIVE_GAP_SEC}), 0) AS active,
                 coalesce(sum(gap) FILTER (WHERE gap >= ${ACTIVE_GAP_SEC} AND gap < ${IDLE_GAP_SEC}), 0) AS idle,
                 coalesce(sum(gap) FILTER (WHERE gap >= ${IDLE_GAP_SEC}), 0) AS away,
                 count(*) FILTER (WHERE gap >= ${ACTIVE_GAP_SEC} AND gap < ${IDLE_GAP_SEC}) AS idle_gaps
            FROM (
              SELECT owner,
                     extract(epoch FROM ts - lag(ts) OVER (PARTITION BY owner ORDER BY ts)) AS gap
                FROM harness_shared.session_turn_parts
               WHERE workspace_id = 'default'
                 AND owner = ANY(${owners}::text[])
                 AND ts BETWEEN ${firstAt}::timestamptz AND ${lastAt}::timestamptz
            ) gaps
           WHERE gap IS NOT NULL`
      : [{ owners: 0, active: 0, idle: 0, away: 0, idle_gaps: 0 }];

  return {
    planSlug,
    harnessSlug,
    workspaceId,
    population: {
      source: 'harness_shared.tool_invocations',
      callOrigin: 'agent',
      attribution: 'goal_ref in the plan work items (source_plan_slug; observation lane excluded)',
      floor: true,
      note: 'Floors: native client tools (Edit/Read/Bash) write no tool_invocations row, and a call without a goal stamp is attributed to no plan. Categories are by tool name, not by intent.',
    },
    items: { total: itemRows.length, byStatus },
    calls: {
      total: folded.total,
      agents: toNumber(span?.agents),
      activeHours: toNumber(span?.hours),
      firstAt,
      lastAt,
      byCategory: folded.byCategory,
    },
    failed: {
      total: folded.failedTotal,
      share: folded.total > 0 ? Math.round((folded.failedTotal / folded.total) * 1000) / 1000 : 0,
      byClass: folded.failedByClass,
    },
    droppedEffort: { calls: folded.droppedCalls, items: droppedWorked.size, itemIds: [...droppedWorked].sort() },
    holders: {
      itemsWorked: handled.length,
      itemsWithHolderChange: handled.filter((row) => row.holders > 1).length,
      holderChanges: handled.reduce((sum, row) => sum + Math.max(0, row.holders - 1), 0),
      mostHandled: handled.filter((row) => row.holders > 1).slice(0, topItems),
    },
    wallClock: {
      scope: 'holders-across-plan-window',
      activeGapSec: ACTIVE_GAP_SEC,
      idleGapSec: IDLE_GAP_SEC,
      owners: toNumber(clock?.owners),
      activeSec: Math.round(toNumber(clock?.active)),
      idleSec: Math.round(toNumber(clock?.idle)),
      awaySec: Math.round(toNumber(clock?.away)),
      idleGaps: toNumber(clock?.idle_gaps),
    },
  };
}
