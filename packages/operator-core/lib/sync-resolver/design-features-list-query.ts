/**
 * Corpus-accurate Design feature queue + companion summary (P-011).
 *
 * The legacy resolver ordered a mutable `updated_ts` feed and cut it at 500;
 * the dashboard then derived every bucket count and filter from that slice.
 * This read instead pages by the immutable work-item birth key
 * `(created_ts, feature_id)`, applies search/status before LIMIT, and compiles
 * rows plus exact status buckets from one normalized predicate.
 *
 * `design_status IS NULL` is the historical spelling of pending. Normalize it
 * once in the corpus CTE so the row query, selected total, and facet counts can
 * never disagree about that bucket.
 */
import type { CompanionSummaryAggregateRow, FacetSelection } from '@papercusp/facets';
import type { OrgSql } from '../work-items';
import type { BoundedListPage } from './bounded-list-read';

export const DESIGN_FEATURES_PAGE_LIMIT = 250;
export const DESIGN_FEATURES_DEFAULT_PAGE = 100;
export const DESIGN_FEATURE_STATUSES = ['pending', 'accepted', 'ignored'] as const;

export type DesignFeatureStatus = (typeof DESIGN_FEATURE_STATUSES)[number];

export interface DesignFeaturesListWireArgs {
  harnessSlug: string;
  workspaceId?: string;
  q?: string;
  statuses?: string[];
  cursor?: string | null;
  limit?: number;
}

export interface DesignFeaturesCursor {
  createdTs: number;
  featureId: string;
}

export interface NormalizedDesignFeaturesListArgs {
  harnessSlug: string;
  workspaceId: string;
  q: string;
  statuses: DesignFeatureStatus[];
  cursor: DesignFeaturesCursor | null;
  limit: number;
}

export interface DesignFeaturesCompiledPredicate {
  args: NormalizedDesignFeaturesListArgs;
  fingerprint: string;
}

export interface DesignFeatureListRow {
  featureId: string;
  title: string | null;
  designStatus: DesignFeatureStatus;
}

interface DesignFeatureDbRow {
  feature_id: string;
  title: string | null;
  design_status: DesignFeatureStatus;
  created_ts: number | string;
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const isDesignFeatureStatus = (value: string): value is DesignFeatureStatus =>
  (DESIGN_FEATURE_STATUSES as readonly string[]).includes(value);

export function decodeDesignFeaturesCursor(raw: string | null | undefined): DesignFeaturesCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DesignFeaturesCursor>;
    return Number.isSafeInteger(parsed.createdTs) &&
      parsed.createdTs! >= 0 &&
      typeof parsed.featureId === 'string' &&
      parsed.featureId.length > 0
      ? { createdTs: parsed.createdTs!, featureId: parsed.featureId }
      : null;
  } catch {
    return null;
  }
}

export const encodeDesignFeaturesCursor = (row: Pick<DesignFeaturesCursor, 'createdTs' | 'featureId'>): string =>
  JSON.stringify({ createdTs: row.createdTs, featureId: row.featureId });

export function normalizeDesignFeaturesListArgs(args: DesignFeaturesListWireArgs): NormalizedDesignFeaturesListArgs {
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? DESIGN_FEATURES_DEFAULT_PAGE), 1),
    DESIGN_FEATURES_PAGE_LIMIT,
  );
  const statuses = [
    ...new Set((args.statuses ?? []).map((value) => value.trim()).filter(isDesignFeatureStatus)),
  ].sort();
  return {
    harnessSlug: args.harnessSlug.trim(),
    workspaceId: args.workspaceId?.trim() || 'default',
    q: args.q?.trim() || '',
    statuses,
    cursor: decodeDesignFeaturesCursor(args.cursor),
    limit,
  };
}

export function buildDesignFeaturesPredicate(args: NormalizedDesignFeaturesListArgs): DesignFeaturesCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function designFeaturesSummarySelection(args: NormalizedDesignFeaturesListArgs): FacetSelection | undefined {
  return args.statuses.length > 0 ? new Map([['status', new Set(args.statuses)]]) : undefined;
}

/**
 * One canonical Design corpus for both row and aggregate readers.
 *
 * `created_ts` is stamped by the create writer and never touched by mutation
 * paths. Legacy null births sort at zero and remain pageable; unlike a mutable
 * `updated_ts` cursor they cannot jump across an already-issued boundary.
 */
function designCorpusCte(sql: OrgSql, args: NormalizedDesignFeaturesListArgs, materialized: boolean) {
  return sql`
    design_corpus AS ${materialized ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (
      SELECT f.feature_id,
             f.title,
             coalesce(f.design_status, 'pending')::text AS design_status,
             coalesce(f.created_ts, 0)::bigint AS created_ts,
             f._search
        FROM harness_shared.harness_features_consolidated f
       WHERE f.workspace_id = ${args.workspaceId}
         AND f.harness_slug = ${args.harnessSlug}
         AND f.needs_design = TRUE
    )`;
}

/** Shared selected predicate; omit status for drill-down-aware status facets. */
function selectedPredicateSql(sql: OrgSql, args: NormalizedDesignFeaturesListArgs, omitStatus = false) {
  return sql`
    ${omitStatus || args.statuses.length === 0 ? sql`TRUE` : sql`d.design_status = ANY(${args.statuses}::text[])`}
    AND ${
      args.q
        ? sql`(
            coalesce(d._search, ''::tsvector) @@ websearch_to_tsquery('english', ${args.q})
            OR position(lower(${args.q}) in lower(d.feature_id)) > 0
          )`
        : sql`TRUE`
    }`;
}

const mapRow = (row: DesignFeatureDbRow): DesignFeatureListRow => ({
  featureId: row.feature_id,
  title: row.title,
  designStatus: row.design_status,
});

export async function readDesignFeaturesPageFromStore(
  sql: OrgSql,
  predicate: DesignFeaturesCompiledPredicate,
): Promise<BoundedListPage<DesignFeatureListRow>> {
  const args = predicate.args;
  const cursor = args.cursor;
  const rows = await sql<DesignFeatureDbRow[]>`
    WITH ${designCorpusCte(sql, args, false)}
    SELECT d.feature_id, d.title, d.design_status, d.created_ts
      FROM design_corpus d
     WHERE ${selectedPredicateSql(sql, args)}
       AND ${
         cursor
           ? sql`(d.created_ts, d.feature_id) < (${cursor.createdTs}::bigint, ${cursor.featureId}::text)`
           : sql`TRUE`
       }
     ORDER BY d.created_ts DESC, d.feature_id DESC
     LIMIT ${args.limit + 1}`;

  const hasMore = rows.length > args.limit;
  const rawPage = rows.slice(0, args.limit);
  const tail = rawPage[rawPage.length - 1];
  return {
    rows: rawPage.map(mapRow),
    hasMore,
    nextCursor:
      hasMore && tail
        ? encodeDesignFeaturesCursor({
            createdTs: Number(tail.created_ts),
            featureId: tail.feature_id,
          })
        : null,
    previousCursor: args.cursor ? encodeDesignFeaturesCursor(args.cursor) : null,
  };
}

interface DesignFeaturesAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

/** One aggregate statement for exact corpus/matched totals and all three buckets. */
export async function readDesignFeaturesSummaryFromStore(
  sql: OrgSql,
  predicate: DesignFeaturesCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const args = predicate.args;
  const rows = await sql<DesignFeaturesAggregateDbRow[]>`
    WITH ${designCorpusCte(sql, args, true)},
    totals AS (
      SELECT count(*)::int AS n FROM design_corpus
    ),
    matched AS (
      SELECT count(*)::int AS n
        FROM design_corpus d
       WHERE ${selectedPredicateSql(sql, args)}
    ),
    status_facets AS (
      SELECT values.value, count(d.feature_id)::int AS n
        FROM (VALUES ('pending'::text), ('accepted'::text), ('ignored'::text)) AS values(value)
        LEFT JOIN design_corpus d
          ON d.design_status = values.value
         AND ${selectedPredicateSql(sql, args, true)}
       GROUP BY values.value
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
    SELECT 'facet', 'status', 'Design status', value, n, NULL, NULL
      FROM status_facets`;

  return rows.map(
    (row): CompanionSummaryAggregateRow =>
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
