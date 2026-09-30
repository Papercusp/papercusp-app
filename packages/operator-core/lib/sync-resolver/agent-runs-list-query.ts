/**
 * Corpus-accurate Agent Runs list + companion summary (P-008).
 *
 * The row feed is a bounded keyset page over the immutable `(ts, runId)`
 * ordering of the legacy/live full-outer union. `runningOnly` and `featureId`
 * compile before LIMIT, so an active run older than the newest history page is
 * still discoverable. The companion aggregate returns the exact harness total,
 * the exact selected-population total, and running/finished drill-down counts
 * from the same scoped union.
 */
import type {
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import type { BoundedListPage } from './bounded-list-read';
import type { OrgSql } from '../work-items';

export const AGENT_RUNS_PAGE_LIMIT = 250;

export interface AgentRunsListWireArgs {
  harnessSlug: string;
  workspaceId?: string;
  runningOnly?: boolean;
  featureId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface AgentRunsCursor {
  ts: number;
  runId: string;
}

export interface NormalizedAgentRunsListArgs {
  harnessSlug: string;
  workspaceId: string | null;
  runningOnly: boolean;
  featureId: string | null;
  cursor: AgentRunsCursor | null;
  limit: number;
}

export interface AgentRunsCompiledPredicate {
  args: NormalizedAgentRunsListArgs;
  fingerprint: string;
}

export interface AgentRunListRow {
  runId: string;
  role: string;
  featureId: string | null;
  ts: number;
  sizeBytes: number;
  costUsd: number | null;
  running: boolean;
  lastEventTs: number | null;
  spawnStatus: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  sessionId: string | null;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function decodeAgentRunsCursor(raw: string | null | undefined): AgentRunsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRunsCursor>;
    return Number.isSafeInteger(parsed.ts) && typeof parsed.runId === 'string' && parsed.runId.length > 0
      ? { ts: parsed.ts!, runId: parsed.runId }
      : null;
  } catch {
    return null;
  }
}

export const encodeAgentRunsCursor = (row: { ts: number; runId: string }): string =>
  JSON.stringify({ ts: row.ts, runId: row.runId });

export function normalizeAgentRunsListArgs(
  args: AgentRunsListWireArgs,
): NormalizedAgentRunsListArgs {
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? AGENT_RUNS_PAGE_LIMIT), 1),
    AGENT_RUNS_PAGE_LIMIT,
  );
  return {
    harnessSlug: args.harnessSlug.trim(),
    workspaceId: args.workspaceId?.trim() || null,
    runningOnly: args.runningOnly === true,
    featureId: args.featureId?.trim() || null,
    cursor: decodeAgentRunsCursor(args.cursor),
    limit,
  };
}

export function buildAgentRunsPredicate(
  args: NormalizedAgentRunsListArgs,
): AgentRunsCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function agentRunsSummarySelection(
  args: NormalizedAgentRunsListArgs,
): FacetSelection | undefined {
  return args.runningOnly
    ? new Map([['state', new Set(['running'])]])
    : undefined;
}

/**
 * One canonical union for both the row and summary readers.
 *
 * `workspace_id` is part of the DISTINCT and FULL JOIN keys. The former helper
 * joined only `(harness_slug, run_id)`, so a same-slug/same-run collision in a
 * different workspace could pair with—and then filter out—the intended row.
 */
function scopedRunsCtes(sql: OrgSql, args: NormalizedAgentRunsListArgs) {
  const workspaceSpawn = args.workspaceId
    ? sql`sa.workspace_id = ${args.workspaceId}`
    : sql`TRUE`;
  const workspaceUnion = args.workspaceId
    ? sql`coalesce(ar.workspace_id, sa.workspace_id) = ${args.workspaceId}`
    : sql`TRUE`;
  return sql`
    latest_spawn AS (
      SELECT DISTINCT ON (sa.workspace_id, sa.harness_slug, sa.run_id)
             sa.workspace_id,
             sa.harness_slug,
             sa.run_id,
             sa.child_role,
             sa.feature_id,
             sa.status AS spawn_status,
             sa.exit_code,
             sa.error_message,
             sa.session_id,
             (extract(epoch FROM sa.started_at) * 1000)::bigint AS started_ms,
             (extract(epoch FROM sa.heartbeat_at) * 1000)::bigint AS heartbeat_ms
        FROM harness_shared.spawned_agents sa
       WHERE sa.harness_slug = ${args.harnessSlug}
         AND ${workspaceSpawn}
       ORDER BY sa.workspace_id, sa.harness_slug, sa.run_id,
                sa.started_at DESC, sa.spawn_id DESC
    ),
    scoped AS (
      SELECT coalesce(ar.run_id, sa.run_id) AS run_id,
             coalesce(ar.role, sa.child_role) AS role,
             coalesce(ar.feature_id, sa.feature_id) AS feature_id,
             coalesce(ar.ts, sa.started_ms)::bigint AS ts,
             coalesce(ar.size_bytes, 0)::bigint AS size_bytes,
             ar.cost_usd,
             CASE
               WHEN sa.run_id IS NOT NULL
                 THEN sa.spawn_status IN ('running', 'restarting')
               ELSE coalesce(ar.running, false)
             END AS running,
             coalesce(sa.heartbeat_ms, ar.last_event_ts)::bigint AS last_event_ts,
             sa.spawn_status,
             sa.exit_code,
             CASE
               WHEN coalesce(ar.feature_id, sa.feature_id) IS NULL THEN NULL
               ELSE left(sa.error_message, 1000)
             END AS error_message,
             sa.session_id
        FROM harness_shared.agent_runs_consolidated ar
        FULL JOIN latest_spawn sa
          ON sa.workspace_id = ar.workspace_id
         AND sa.harness_slug = ar.harness_slug
         AND sa.run_id = ar.run_id
       WHERE coalesce(ar.harness_slug, sa.harness_slug) = ${args.harnessSlug}
         AND ${workspaceUnion}
    )`;
}

function selectedPredicateSql(
  sql: OrgSql,
  args: NormalizedAgentRunsListArgs,
  omitRunning = false,
) {
  return sql`
    ${args.featureId ? sql`r.feature_id = ${args.featureId}` : sql`TRUE`}
    AND ${!omitRunning && args.runningOnly ? sql`r.running = TRUE` : sql`TRUE`}`;
}

interface AgentRunDbRow {
  run_id: string;
  role: string;
  feature_id: string | null;
  ts: number;
  size_bytes: number;
  cost_usd: number | null;
  running: boolean;
  last_event_ts: number | null;
  spawn_status: string | null;
  exit_code: number | null;
  error_message: string | null;
  session_id: string | null;
}

const mapRow = (row: AgentRunDbRow): AgentRunListRow => ({
  runId: row.run_id,
  role: row.role,
  featureId: row.feature_id,
  ts: Number(row.ts),
  sizeBytes: Number(row.size_bytes),
  costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
  running: row.running,
  lastEventTs: row.last_event_ts == null ? null : Number(row.last_event_ts),
  spawnStatus: row.spawn_status,
  exitCode: row.exit_code,
  errorMessage: row.error_message,
  sessionId: row.session_id,
});

export async function readAgentRunsPageFromStore(
  sql: OrgSql,
  predicate: AgentRunsCompiledPredicate,
): Promise<BoundedListPage<AgentRunListRow>> {
  const args = predicate.args;
  const cursor = args.cursor;
  const rows = await sql<AgentRunDbRow[]>`
    WITH ${scopedRunsCtes(sql, args)}
    SELECT r.run_id,
           r.role,
           r.feature_id,
           r.ts,
           r.size_bytes,
           r.cost_usd,
           r.running,
           r.last_event_ts,
           r.spawn_status,
           r.exit_code,
           r.error_message,
           r.session_id
      FROM scoped r
     WHERE ${selectedPredicateSql(sql, args)}
       AND ${cursor ? sql`(r.ts, r.run_id) < (${cursor.ts}::bigint, ${cursor.runId}::text)` : sql`TRUE`}
     ORDER BY r.ts DESC, r.run_id DESC
     LIMIT ${args.limit + 1}`;

  const hasMore = rows.length > args.limit;
  const page = rows.slice(0, args.limit).map(mapRow);
  const tail = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && tail ? encodeAgentRunsCursor(tail) : null,
    hasMore,
    previousCursor: args.cursor ? encodeAgentRunsCursor(args.cursor) : null,
  };
}

interface AgentRunsAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

export async function readAgentRunsSummaryFromStore(
  sql: OrgSql,
  predicate: AgentRunsCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const args = predicate.args;
  const rows = await sql<AgentRunsAggregateDbRow[]>`
    WITH ${scopedRunsCtes(sql, args)},
    totals AS (
      SELECT count(*)::int AS n FROM scoped
    ),
    matched AS (
      SELECT count(*)::int AS n
        FROM scoped r
       WHERE ${selectedPredicateSql(sql, args)}
    ),
    state_facets AS (
      SELECT CASE WHEN r.running THEN 'running' ELSE 'finished' END AS value,
             count(*)::int AS n
        FROM scoped r
       WHERE ${selectedPredicateSql(sql, args, true)}
       GROUP BY CASE WHEN r.running THEN 'running' ELSE 'finished' END
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched
      FROM totals CROSS JOIN matched
    UNION ALL
    SELECT 'facet', 'state', 'State', value, n, NULL, NULL
      FROM state_facets`;

  return rows.map((row): CompanionSummaryAggregateRow =>
    row.kind === 'totals'
      ? { kind: 'totals', total: row.total ?? 0, matched: row.matched ?? 0 }
      : {
          kind: 'facet',
          facet: row.facet ?? '',
          label: row.label ?? undefined,
          value: row.value ?? '',
          count: row.count ?? 0,
        },
  );
}
