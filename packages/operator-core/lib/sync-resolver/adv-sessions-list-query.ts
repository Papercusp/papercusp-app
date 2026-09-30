/**
 * Corpus-accurate Sessions history + companion summary (P-010).
 *
 * The legacy resolver fetched the newest 200 `started_at` rows and then the
 * client derived harness options, plan groups, and every displayed count from
 * that slice. `started_at` is mutable on resume, so it was also not a stable
 * cross-request cursor. This read uses the immutable session birth key
 * `(first_seen_at, id)` and compiles the bounded row page, exact totals, and
 * drill-down-aware plan/harness facets from one normalized predicate.
 *
 * OMP transcript summaries remain row decoration. Whether a JSONL file is
 * locally available is not an authoritative property of the session ledger,
 * so it must never decide whether a row participates in the SQL corpus or its
 * exact count.
 */
import type {
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import type { AdvSessionRow } from '../adv-sessions';
import { mapAdvSessionRow } from '../adv-sessions';
import type { OrgSql } from '../work-items';
import type { BoundedListPage } from './bounded-list-read';

export const ADV_SESSIONS_PAGE_LIMIT = 250;
export const ADV_SESSIONS_DEFAULT_PAGE = 100;
export const NO_SESSION_HARNESS = '__no_harness__';
export const NO_SESSION_PLAN = '__no_plan__';

export interface AdvSessionsListWireArgs {
  workspaceId?: string;
  harnessSlugs?: string[];
  planSlugs?: string[];
  cursor?: string | null;
  limit?: number;
}

export interface AdvSessionsCursor {
  firstSeenAt: string;
  id: number;
}

export interface NormalizedAdvSessionsListArgs {
  workspaceId: string | null;
  harnessSlugs: string[];
  planSlugs: string[];
  cursor: AdvSessionsCursor | null;
  limit: number;
}

export interface AdvSessionsCompiledPredicate {
  args: NormalizedAdvSessionsListArgs;
  fingerprint: string;
}

export interface AdvSessionFacetMeta {
  /** Exact never-ended count for a plan group. */
  active?: number;
}

type AdvSessionListRow = AdvSessionRow & { firstSeenAt: string };

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const uniq = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

export function decodeAdvSessionsCursor(
  raw: string | null | undefined,
): AdvSessionsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AdvSessionsCursor>;
    const firstSeenAt =
      typeof parsed.firstSeenAt === 'string' && Number.isFinite(Date.parse(parsed.firstSeenAt))
        ? new Date(parsed.firstSeenAt).toISOString()
        : null;
    return firstSeenAt !== null && Number.isSafeInteger(parsed.id) && parsed.id! > 0
      ? { firstSeenAt, id: parsed.id! }
      : null;
  } catch {
    return null;
  }
}

export const encodeAdvSessionsCursor = (
  row: Pick<AdvSessionListRow, 'firstSeenAt' | 'id'>,
): string => JSON.stringify({ firstSeenAt: row.firstSeenAt, id: row.id });

export function normalizeAdvSessionsListArgs(
  args: AdvSessionsListWireArgs = {},
): NormalizedAdvSessionsListArgs {
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? ADV_SESSIONS_DEFAULT_PAGE), 1),
    ADV_SESSIONS_PAGE_LIMIT,
  );
  return {
    workspaceId: args.workspaceId?.trim() || null,
    harnessSlugs: uniq(args.harnessSlugs),
    planSlugs: uniq(args.planSlugs),
    cursor: decodeAdvSessionsCursor(args.cursor),
    limit,
  };
}

export function buildAdvSessionsPredicate(
  args: NormalizedAdvSessionsListArgs,
): AdvSessionsCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function advSessionsSummarySelection(
  args: NormalizedAdvSessionsListArgs,
): FacetSelection | undefined {
  const entries: Array<[string, ReadonlySet<string>]> = [];
  if (args.harnessSlugs.length > 0) {
    entries.push(['harness', new Set(args.harnessSlugs)]);
  }
  if (args.planSlugs.length > 0) {
    entries.push(['plan', new Set(args.planSlugs)]);
  }
  return entries.length > 0 ? new Map(entries) : undefined;
}

/**
 * Resolve the historical plan→harness fallback once and materialize the exact
 * visible session corpus for both readers.
 *
 * `launch_spec.harnessSlug` is the authoritative launch-time value. Older rows
 * predate that field; only an unambiguous plan mapping may fill the gap. A plan
 * slug present in multiple harnesses deliberately stays in the no-harness
 * bucket instead of being assigned by arbitrary join order.
 */
function sessionCorpusCtes(
  sql: OrgSql,
  args: NormalizedAdvSessionsListArgs,
  materializeCorpus: boolean,
) {
  return sql`
    plan_harness AS MATERIALIZED (
      SELECT hp.plan_slug,
             CASE
               WHEN count(DISTINCT hp.harness_slug) = 1 THEN min(hp.harness_slug)
               ELSE NULL
             END AS harness_slug
        FROM harness_shared.harness_plans hp
       WHERE ${args.workspaceId ? sql`hp.workspace_id = ${args.workspaceId}` : sql`TRUE`}
       GROUP BY hp.plan_slug
    ),
    session_corpus AS ${materializeCorpus ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (
      SELECT a.id,
             a.workspace_id,
             coalesce(
               to_jsonb(a)->'launch_spec'->>'harnessSlug',
               ph.harness_slug
             ) AS harness_slug,
             a.plan_slug,
             a.agent,
             a.role,
             a.feature,
             a.mode,
             a.terminal_bin,
             a.pid,
             a.window_id,
             a.omp_thread_id,
             a.label,
             a.cwd,
             a.coord_owner_id,
             a.session_id,
             a.started_at,
             a.first_seen_at,
             a.ended_at,
             a.exit_code,
             a.ended_by,
             a.ended_signal,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
        LEFT JOIN plan_harness ph ON ph.plan_slug = a.plan_slug
       WHERE ${args.workspaceId ? sql`a.workspace_id = ${args.workspaceId}` : sql`TRUE`}
         AND NOT (
           a.ended_at IS NOT NULL
           AND a.omp_thread_id IS NULL
           AND extract(epoch FROM (a.ended_at - a.started_at)) < 5
         )
    )`;
}

function selectedPredicateSql(
  sql: OrgSql,
  args: NormalizedAdvSessionsListArgs,
  omit: 'harness' | 'plan' | null = null,
) {
  return sql`
    ${
      omit === 'harness' || args.harnessSlugs.length === 0
        ? sql`TRUE`
        : sql`coalesce(s.harness_slug, ${NO_SESSION_HARNESS}) = ANY(${args.harnessSlugs}::text[])`
    }
    AND ${
      omit === 'plan' || args.planSlugs.length === 0
        ? sql`TRUE`
        : sql`coalesce(s.plan_slug, ${NO_SESSION_PLAN}) = ANY(${args.planSlugs}::text[])`
    }`;
}

interface AdvSessionDbRow {
  id: number;
  workspace_id: string;
  harness_slug: string | null;
  plan_slug: string | null;
  agent: string | null;
  role: string | null;
  feature: string | null;
  mode: 'omp' | 'console';
  terminal_bin: string | null;
  pid: number | null;
  window_id: string | null;
  omp_thread_id: string | null;
  label: string | null;
  cwd: string | null;
  coord_owner_id: string | null;
  session_id: string | null;
  started_at: string | Date;
  first_seen_at: string | Date;
  ended_at: string | Date | null;
  exit_code: number | null;
  ended_by: string | null;
  ended_signal: string | null;
  port_id: string | null;
  port_source_adv_session_id: number | string | null;
  port_status: string | null;
  port_metadata: Record<string, unknown> | null;
}

const mapRow = (row: AdvSessionDbRow): AdvSessionListRow => ({
  ...mapAdvSessionRow(row),
  firstSeenAt: new Date(row.first_seen_at).toISOString(),
});

export async function readAdvSessionsPageFromStore(
  sql: OrgSql,
  predicate: AdvSessionsCompiledPredicate,
): Promise<BoundedListPage<AdvSessionListRow>> {
  const args = predicate.args;
  const cursor = args.cursor;
  const rows = await sql<AdvSessionDbRow[]>`
    WITH ${sessionCorpusCtes(sql, args, false)}
    SELECT s.*
      FROM session_corpus s
     WHERE ${selectedPredicateSql(sql, args)}
       AND ${
         cursor
           ? sql`(s.first_seen_at, s.id) < (${cursor.firstSeenAt}::timestamptz, ${cursor.id}::bigint)`
           : sql`TRUE`
       }
     ORDER BY s.first_seen_at DESC, s.id DESC
     LIMIT ${args.limit + 1}`;

  const hasMore = rows.length > args.limit;
  const page = rows.slice(0, args.limit).map(mapRow);
  const tail = page[page.length - 1];
  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && tail ? encodeAdvSessionsCursor(tail) : null,
    previousCursor: args.cursor ? JSON.stringify(args.cursor) : null,
  };
}

interface AdvSessionsAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
  meta: AdvSessionFacetMeta | null;
}

/** One aggregate statement for exact totals and plan/harness group facets. */
export async function readAdvSessionsSummaryFromStore(
  sql: OrgSql,
  predicate: AdvSessionsCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow<AdvSessionFacetMeta>[]> {
  const args = predicate.args;
  const rows = await sql<AdvSessionsAggregateDbRow[]>`
    WITH ${sessionCorpusCtes(sql, args, true)},
    totals AS (
      SELECT count(*)::int AS n FROM session_corpus
    ),
    matched AS (
      SELECT count(*)::int AS n
        FROM session_corpus s
       WHERE ${selectedPredicateSql(sql, args)}
    ),
    plan_facets AS (
      SELECT coalesce(s.plan_slug, ${NO_SESSION_PLAN}) AS value,
             count(*)::int AS n,
             (count(*) FILTER (WHERE s.ended_at IS NULL))::int AS active_n
        FROM session_corpus s
       WHERE ${selectedPredicateSql(sql, args, 'plan')}
       GROUP BY 1
    ),
    harness_facets AS (
      SELECT coalesce(s.harness_slug, ${NO_SESSION_HARNESS}) AS value,
             count(*)::int AS n
        FROM session_corpus s
       WHERE ${selectedPredicateSql(sql, args, 'harness')}
       GROUP BY 1
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched,
           NULL::jsonb AS meta
      FROM totals CROSS JOIN matched
    UNION ALL
    SELECT 'facet', 'plan', 'Plan', value, n, NULL, NULL,
           jsonb_build_object('active', active_n)
      FROM plan_facets
    UNION ALL
    SELECT 'facet', 'harness', 'Harness', value, n, NULL, NULL, NULL::jsonb
      FROM harness_facets`;

  return rows.map((row): CompanionSummaryAggregateRow<AdvSessionFacetMeta> =>
    row.kind === 'totals'
      ? { kind: 'totals', total: row.total ?? 0, matched: row.matched ?? 0 }
      : {
          kind: 'facet',
          facet: row.facet ?? '',
          label: row.label ?? undefined,
          value: row.value ?? '',
          count: row.count ?? 0,
          meta: row.meta ?? undefined,
        },
  );
}
