/**
 * Corpus-accurate Work Items list + companion summary (P-004).
 *
 * The mutable newest-first list is keyset-paged over (updated_ts, feature_id).
 * The row page and every aggregate compile from one normalized predicate; the
 * deliberately bounded states/perState picker/HUD branch remains a fair sample
 * and never claims corpus completeness.
 *
 * Cost shape (papercusp-log-performance-remediation P-013). `payload` is the
 * TOASTed polymorphic JSONB (~3 GB across ~250k rows), so every `payload->…`
 * evaluated per in-scope row detoasts and decompresses the whole value. The
 * per-row `scoped` projection carries only heap columns (severity is the STORED
 * `severity_projection`, migration 1308), plus the spine join only when a filter
 * or facet reads it. The page selects its keys first, ordered by
 * the raw `updated_ts` so `hfc_updated_idx` serves it, and hydrates payload
 * fields and the spine for those keys only. Measured on the live corpus
 * (2026-10-01): page statement 277 ms mean → 27.7 ms.
 */
import type {
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import type { BoundedListPage } from './bounded-list-read';
import {
  observationLaneExclusionSql,
  type OrgSql,
} from '../work-items';
import { deriveWorkItemPresentationStage, readImplementationReadiness } from '../harness/improvements/agent-review-policy';
import type { WorkItemPresentation } from '../work-item-presentation-contract';
import { activeWorkItemDependencyRefsSql } from '../dbos/work-item-deps-store';
import { ALL_SUCCESSFUL_STATUSES, ALL_TERMINAL_STATUSES } from '../work-item-blocking';

export const WORK_ITEMS_CURSOR_PAGE_LIMIT = 500;
export const WORK_ITEMS_FAIR_STATE_LIMIT = 200;

export interface WorkItemsListWireFilters {
  id?: string;
  title?: string;
  kinds?: string[];
  states?: string[];
  stages?: string[];
  assignees?: string[];
  severities?: string[];
  plans?: string[];
  priorityMin?: number;
  priorityMax?: number;
  rankMin?: number;
  rankMax?: number;
}

export interface WorkItemsListWireArgs {
  harnessSlug?: string;
  harnessSlugs?: string[];
  /** Backward-compatible singular server filters. */
  kind?: string;
  state?: string;
  /** Global quick search over id/title/state/assignee. */
  q?: string;
  filters?: WorkItemsListWireFilters;
  cursor?: string | null;
  limit?: number;
  /** Legacy fair-slice branch used only by bounded pickers/HUD boards. */
  states?: string[];
  perState?: number;
}

export interface WorkItemsCursor {
  updatedTs: number;
  id: string;
}

export interface NormalizedWorkItemsListArgs {
  harnessSlug: string | null;
  harnessSlugs: string[];
  q: string | null;
  filters: {
    id: string | null;
    title: string | null;
    kinds: string[];
    states: string[];
    stages: string[];
    assignees: string[];
    severities: string[];
    plans: string[];
    priorityMin: number | null;
    priorityMax: number | null;
    rankMin: number | null;
    rankMax: number | null;
  };
  cursor: WorkItemsCursor | null;
  limit: number;
  fairStates: string[];
  perState: number;
}

export interface WorkItemsCompiledPredicate {
  args: NormalizedWorkItemsListArgs;
  fingerprint: string;
}

export interface WorkItemsListRow {
  id: string;
  harness?: string;
  createdAt?: string;
  kind: string;
  family: 'feature' | 'issue';
  title: string;
  summary: string;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedAt: string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  presentation?: WorkItemPresentation;
}

const uniq = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function decodeWorkItemsCursor(raw: string | null | undefined): WorkItemsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkItemsCursor>;
    return Number.isSafeInteger(parsed.updatedTs) && typeof parsed.id === 'string' && parsed.id.length > 0
      ? { updatedTs: parsed.updatedTs!, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

export const encodeWorkItemsCursor = (row: { updatedTs: number; id: string }): string =>
  JSON.stringify({ updatedTs: row.updatedTs, id: row.id });

export function normalizeWorkItemsListArgs(
  args: WorkItemsListWireArgs,
): NormalizedWorkItemsListArgs {
  const filters = args.filters ?? {};
  const harnessSlug = args.harnessSlug?.trim() || null;
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? WORK_ITEMS_CURSOR_PAGE_LIMIT), 1),
    WORK_ITEMS_CURSOR_PAGE_LIMIT,
  );
  const perState = Math.min(
    Math.max(Math.trunc(finite(args.perState) ?? 60), 1),
    WORK_ITEMS_FAIR_STATE_LIMIT,
  );
  return {
    harnessSlug,
    harnessSlugs: harnessSlug ? [] : uniq(args.harnessSlugs),
    q: args.q?.trim() || null,
    filters: {
      id: filters.id?.trim() || null,
      title: filters.title?.trim() || null,
      kinds: uniq([...(filters.kinds ?? []), ...(args.kind ? [args.kind] : [])]),
      states: uniq([...(filters.states ?? []), ...(args.state ? [args.state] : [])]),
      stages: uniq(filters.stages),
      assignees: uniq(filters.assignees),
      severities: uniq(filters.severities),
      plans: uniq(filters.plans),
      priorityMin: finite(filters.priorityMin),
      priorityMax: finite(filters.priorityMax),
      rankMin: finite(filters.rankMin),
      rankMax: finite(filters.rankMax),
    },
    cursor: decodeWorkItemsCursor(args.cursor),
    limit,
    fairStates: uniq(args.states),
    perState,
  };
}

export function buildWorkItemsPredicate(
  args: NormalizedWorkItemsListArgs,
): WorkItemsCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function workItemsSummarySelection(
  args: NormalizedWorkItemsListArgs,
): FacetSelection {
  const entries: Array<[string, ReadonlySet<string>]> = [];
  const add = (key: string, values: string[]) => {
    if (values.length > 0) entries.push([key, new Set(values)]);
  };
  add('kind', args.filters.kinds);
  add('state', args.filters.states);
  add('stage', args.filters.stages);
  add('assignee', args.filters.assignees);
  add('severity', args.filters.severities);
  add('plan', args.filters.plans);
  return new Map(entries);
}

const likeContainsPattern = (query: string): string =>
  `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

type FacetKey = 'kind' | 'state' | 'stage' | 'assignee' | 'severity' | 'plan';

function workItemScopeSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    wi.workspace_id = ${workspaceId}
    AND ${
      args.harnessSlug
        ? sql`wi.harness_slug = ${args.harnessSlug}`
        : args.harnessSlugs.length > 0
          ? sql`wi.harness_slug = ANY(${args.harnessSlugs}::text[])`
          : sql`FALSE`
    }
    AND (wi.parent_id IS NULL OR wi.parent_id = '')
    AND ${observationLaneExclusionSql(sql)}`;
}

function spawnedAgentScopeSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    sa.workspace_id = ${workspaceId}
    AND ${
      args.harnessSlug
        ? sql`sa.harness_slug = ${args.harnessSlug}`
        : args.harnessSlugs.length > 0
          ? sql`sa.harness_slug = ANY(${args.harnessSlugs}::text[])`
          : sql`FALSE`
    }`;
}

function predicateSql(
  sql: OrgSql,
  args: NormalizedWorkItemsListArgs,
  omit?: FacetKey,
) {
  const f = args.filters;
  const q = args.q ? likeContainsPattern(args.q) : null;
  const id = f.id ? likeContainsPattern(f.id) : null;
  const title = f.title ? likeContainsPattern(f.title) : null;
  return sql`
    ${
      q
        ? sql`(
            COALESCE(s.id, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.title, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.state, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.assignee, '') ILIKE ${q} ESCAPE '\\'
          )`
        : sql`TRUE`
    }
    AND ${id ? sql`COALESCE(s.id, '') ILIKE ${id} ESCAPE '\\'` : sql`TRUE`}
    AND ${title ? sql`COALESCE(s.title, '') ILIKE ${title} ESCAPE '\\'` : sql`TRUE`}
    AND ${omit !== 'kind' && f.kinds.length > 0 ? sql`s.kind = ANY(${f.kinds}::text[])` : sql`TRUE`}
    AND ${omit !== 'state' && f.states.length > 0 ? sql`s.state = ANY(${f.states}::text[])` : sql`TRUE`}
    AND ${omit !== 'stage' && f.stages.length > 0 ? sql`s.spine_role = ANY(${f.stages}::text[])` : sql`TRUE`}
    AND ${omit !== 'assignee' && f.assignees.length > 0 ? sql`s.assignee = ANY(${f.assignees}::text[])` : sql`TRUE`}
    AND ${omit !== 'severity' && f.severities.length > 0 ? sql`s.severity = ANY(${f.severities}::text[])` : sql`TRUE`}
    AND ${omit !== 'plan' && f.plans.length > 0 ? sql`s.plan_slug = ANY(${f.plans}::text[])` : sql`TRUE`}
    AND ${f.priorityMin != null ? sql`s.priority >= ${f.priorityMin}` : sql`TRUE`}
    AND ${f.priorityMax != null ? sql`s.priority <= ${f.priorityMax}` : sql`TRUE`}
    AND ${f.rankMin != null ? sql`s.rank >= ${f.rankMin}` : sql`TRUE`}
    AND ${f.rankMax != null ? sql`s.rank <= ${f.rankMax}` : sql`TRUE`}`;
}

/** Issue-family kinds carry `_ei` severity / assigned_by in payload. */
const issueKindSql = (sql: OrgSql) =>
  sql`wi.item_kind = ANY(ARRAY['bug','change','task']::text[])`;

type SqlFragment = ReturnType<typeof issueKindSql>;

/**
 * Heap column, no detoast: migration 1308 (P-013, WI-10004929) stores
 * `CASE WHEN <issue kind> THEN COALESCE(payload->'_ei'->>'severity', 'minor') END`
 * as the generated `severity_projection`, so every in-scope row can carry it.
 */
const severitySql = (sql: OrgSql) => sql`wi.severity_projection`;

/** Detoasts `wi.payload`: evaluate per PAGE row only. */
const assignedBySql = (sql: OrgSql) =>
  sql`CASE WHEN ${issueKindSql(sql)} THEN wi.payload->'_ei'->>'assigned_by' ELSE NULL END`;

function latestSpineCte(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    latest_spine AS MATERIALIZED (
      SELECT DISTINCT ON (sa.workspace_id, sa.harness_slug, sa.feature_id)
             sa.workspace_id,
             sa.harness_slug,
             sa.feature_id,
             sa.child_role,
             sa.status
        FROM harness_shared.spawned_agents sa
       WHERE ${spawnedAgentScopeSql(sql, workspaceId, args)}
         AND sa.feature_id IS NOT NULL
       ORDER BY sa.workspace_id, sa.harness_slug, sa.feature_id,
                sa.started_at DESC NULLS LAST, sa.spawn_id DESC
    )`;
}

interface ScopedNeeds {
  /** Join the latest spine per in-scope row (stage filter or facet). */
  spine: boolean;
  /**
   * The page reads `scoped` twice (non-NULL and NULL `updated_ts` branches) and
   * must stay inlined so each branch keeps its index-ordered LIMIT; the summary
   * reads it once per facet and must be computed once.
   */
  materialization: 'MATERIALIZED' | 'NOT MATERIALIZED';
}

/**
 * One row per in-scope work item carrying ONLY what the predicate, the sort and
 * the facets read. `spine_role` is a NULL placeholder unless `need.spine`;
 * `predicateSql` reads it only when the stage filter is set.
 * Requires `latest_spine` in the same WITH when `need.spine`.
 */
function scopedCte(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
  need: ScopedNeeds,
) {
  return sql`
    scoped AS ${need.materialization === 'MATERIALIZED' ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (
      SELECT wi.feature_id AS id,
             wi.harness_slug,
             wi.item_kind AS kind,
             CASE WHEN ${issueKindSql(sql)} THEN 'issue' ELSE 'feature' END AS family,
             COALESCE(wi.title, '') AS title,
             COALESCE(wi.status, 'open') AS state,
             NULLIF(wi.taken_by, 'unassigned') AS assignee,
             ${severitySql(sql)} AS severity,
             wi.feature_order AS priority,
             wi.assignee_rank AS rank,
             wi.source_plan_slug AS plan_slug,
             ${need.spine ? sql`spine.child_role` : sql`NULL::text`} AS spine_role,
             wi.updated_ts AS raw_updated_ts,
             COALESCE(wi.updated_ts, 0)::bigint AS updated_ts
        FROM harness_shared.work_items wi
        ${
          need.spine
            ? sql`LEFT JOIN latest_spine spine
                    ON spine.workspace_id = wi.workspace_id
                   AND spine.harness_slug = wi.harness_slug
                   AND spine.feature_id = wi.feature_id`
            : sql``
        }
       WHERE ${workItemScopeSql(sql, workspaceId, args)}
    )`;
}

/**
 * Attach the latest spine to the bounded key set `keys` (≤ page size). Joined
 * here, against two small inputs, rather than in the final hydration: there
 * the row estimate after the primary-key join collapses to ~1, and the planner
 * chose a nested loop that rescanned the whole `latest_spine` CTE per page row
 * (measured: 501 loops × 492 rows ≈ 85 ms of a 100 ms statement).
 */
function pageWithSpineSql(sql: OrgSql, keys: SqlFragment) {
  return sql`
    page AS MATERIALIZED (
      SELECT k.*,
             spine.child_role AS spine_role,
             spine.status AS spine_status
        FROM (${keys}) k
        LEFT JOIN latest_spine spine
          ON spine.harness_slug = k.harness_slug
         AND spine.feature_id = k.id
    )`;
}

/**
 * Hydrate the bounded key set in CTE `page` (cheap scoped columns + spine) with
 * the payload-derived columns. Only page rows are detoasted.
 */
function hydratePageSql(sql: OrgSql, workspaceId: string, includeDetails = false) {
  return sql`
    SELECT p.id,
           p.harness_slug AS "harnessSlug",
           p.kind,
           p.family,
           p.title,
           ${includeDetails ? sql`COALESCE(wi.summary, '')` : sql`''::text`} AS summary,
           ${includeDetails ? sql`wi.created_ts` : sql`NULL::bigint`} AS "createdTs",
           p.state,
           p.assignee,
           ${assignedBySql(sql)} AS "assignedBy",
           ${severitySql(sql)} AS severity,
           p.priority,
           p.rank,
           p.plan_slug AS "planSlug",
           p.spine_role AS "spineRole",
           p.spine_status AS "spineStatus",
           p.updated_ts AS "updatedTs",
           wi.origin,
           wi.audit_verdict AS "auditVerdict",
           wi.verified_author_github_user_id AS "verifiedAuthorGithubUserId"
      FROM page p
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = ${workspaceId}
       AND wi.harness_slug = p.harness_slug
       AND wi.feature_id = p.id
     ORDER BY p.updated_ts DESC, p.id DESC`;
}

const pageNeeds = (args: NormalizedWorkItemsListArgs): ScopedNeeds => ({
  spine: args.filters.stages.length > 0,
  materialization: 'NOT MATERIALIZED',
});

/**
 * The newest-first cursor page. Order and keyset are on
 * `COALESCE(updated_ts, 0)` (a NULL sorts as 0); the key scan is split so the
 * non-NULL branch orders by the RAW column and `hfc_updated_idx` serves it,
 * while the NULL branch (normally empty) uses the same index's NULL entries.
 * Exported so the integration suite can EXPLAIN the production statement.
 */
export function workItemsPageSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
  includeDetails = false,
) {
  const take = args.limit + 1;
  const cursor = args.cursor;
  const nonNullKeyset = cursor
    ? sql`s.raw_updated_ts <= ${cursor.updatedTs}::bigint
          AND (s.raw_updated_ts, s.id) < (${cursor.updatedTs}::bigint, ${cursor.id}::text)`
    : sql`TRUE`;
  const nullKeyset = cursor
    ? sql`(0::bigint, s.id) < (${cursor.updatedTs}::bigint, ${cursor.id}::text)`
    : sql`TRUE`;
  const keys = sql`
    SELECT u.*
      FROM (
        (SELECT s.id, s.harness_slug, s.kind, s.family, s.title, s.state, s.assignee,
                s.priority, s.rank, s.plan_slug, s.updated_ts
           FROM scoped s
          WHERE ${predicateSql(sql, args)}
            AND s.raw_updated_ts IS NOT NULL
            AND ${nonNullKeyset}
          ORDER BY s.raw_updated_ts DESC, s.id DESC
          LIMIT ${take})
        UNION ALL
        (SELECT s.id, s.harness_slug, s.kind, s.family, s.title, s.state, s.assignee,
                s.priority, s.rank, s.plan_slug, s.updated_ts
           FROM scoped s
          WHERE ${predicateSql(sql, args)}
            AND s.raw_updated_ts IS NULL
            AND ${nullKeyset}
          ORDER BY s.id DESC
          LIMIT ${take})
      ) u
     ORDER BY u.updated_ts DESC, u.id DESC
     LIMIT ${take}`;
  return sql`
    WITH ${latestSpineCte(sql, workspaceId, args)},
    ${scopedCte(sql, workspaceId, args, pageNeeds(args))},
    ${pageWithSpineSql(sql, keys)}
    ${hydratePageSql(sql, workspaceId, includeDetails)}`;
}

/** Bounded per-state fair sample for pickers/HUD boards (never corpus-complete). */
function workItemsFairStatesSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  const keys = sql`
    SELECT r.id, r.harness_slug, r.kind, r.family, r.title, r.state, r.assignee,
           r.priority, r.rank, r.plan_slug, r.updated_ts
      FROM (
        SELECT s.*,
               row_number() OVER (
                 PARTITION BY s.state
                 ORDER BY s.updated_ts DESC, s.id DESC
               ) AS state_rank
          FROM scoped s
         WHERE ${predicateSql(sql, args)}
           AND s.state = ANY(${args.fairStates}::text[])
      ) r
     WHERE r.state_rank <= ${args.perState}`;
  return sql`
    WITH ${latestSpineCte(sql, workspaceId, args)},
    ${scopedCte(sql, workspaceId, args, pageNeeds(args))},
    ${pageWithSpineSql(sql, keys)}
    ${hydratePageSql(sql, workspaceId)}`;
}

interface WorkItemsDbRow {
  id: string;
  harnessSlug: string;
  summary?: string;
  createdTs?: number | string | null;
  kind: string;
  family: 'feature' | 'issue';
  title: string;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedTs: number | string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | string | null;
}

const numberOrNull = (value: number | string | null | undefined): number | null => {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};

function mapWorkItemsRow(row: WorkItemsDbRow): WorkItemsListRow & { updatedTs: number } {
  const updatedTs = numberOrNull(row.updatedTs) ?? 0;
  return {
    id: row.id,
    harness: row.harnessSlug,
    ...(row.createdTs != null ? { createdAt: new Date(numberOrNull(row.createdTs) ?? 0).toISOString() } : {}),
    kind: row.kind,
    family: row.family,
    title: row.title,
    summary: row.summary ?? '',
    state: row.state,
    assignee: row.assignee,
    assignedBy: row.assignedBy,
    severity: row.severity,
    priority: numberOrNull(row.priority),
    rank: numberOrNull(row.rank),
    planSlug: row.planSlug,
    spineRole: row.spineRole,
    spineStatus: row.spineStatus,
    updatedAt: new Date(updatedTs).toISOString(),
    updatedTs,
    origin: row.origin,
    auditVerdict: row.auditVerdict,
    verifiedAuthorGithubUserId: numberOrNull(row.verifiedAuthorGithubUserId),
  };
}

/** Reuse the acceptance classifier only for the bounded page (or one detail row).
 * Full payloads and source bodies never enter the list wire or summary census.
 */
export async function readWorkItemPresentations(
  sql: OrgSql,
  workspaceId: string,
  selected: readonly { id: string; harnessSlug: string }[],
): Promise<Map<string, WorkItemPresentation>> {
  if (selected.length === 0) return new Map();
  const rows = await sql<{
    id: string; harnessSlug: string; kind: string; status: string;
    title: string; summary: string | null; payload: unknown;
    assignee: string | null; terminalOwner: string | null;
    terminalCompletionRef: string | null; completionAuthority: string | null; blocked: boolean;
  }[]>`
    WITH active_dependencies AS (${activeWorkItemDependencyRefsSql(sql, {
      itemWorkspaceId: workspaceId,
      successfulStates: [...ALL_SUCCESSFUL_STATUSES], terminalStates: [...ALL_TERMINAL_STATUSES],
    })})
    SELECT wi.feature_id AS id, wi.harness_slug AS "harnessSlug",
           wi.item_kind AS kind, wi.status, wi.title, wi.summary,
           -- Preserve absent versus enrolled-null readiness. Only narrow fields
           -- needed by the shared classifier leave this bounded SQL read.
           (CASE WHEN wi.payload ? 'implementationReadiness'
             THEN jsonb_build_object('implementationReadiness', wi.payload->'implementationReadiness')
             ELSE '{}'::jsonb END) || jsonb_build_object(
             'lane', wi.payload->'lane', '_claimHold', wi.payload->'_claimHold',
             'needsOwnerAction', wi.payload->'needsOwnerAction',
             'humanCapability', wi.payload->'humanCapability',
             'externalBlockers', wi.payload->'externalBlockers') AS payload,
           wi.taken_by AS assignee, wi.terminal_owner AS "terminalOwner",
           wi.terminal_completion_ref AS "terminalCompletionRef", wi.authority AS "completionAuthority",
           EXISTS (SELECT 1 FROM active_dependencies d
             WHERE d.blocked_ref IN (wi.feature_id, wi.harness_slug || '#' || wi.feature_id)) AS blocked
      FROM harness_shared.work_items wi
      JOIN unnest(${selected.map(r => r.id)}::text[], ${selected.map(r => r.harnessSlug)}::text[])
        AS requested(id, harness) ON wi.feature_id = requested.id AND wi.harness_slug = requested.harness
     WHERE wi.workspace_id = ${workspaceId} AND wi.item_kind = ANY(ARRAY['bug','change','task']::text[])`;
  return new Map(rows.map((row): [string, WorkItemPresentation] => {
    const decision = deriveWorkItemPresentationStage(row);
    const readiness = readImplementationReadiness(row.payload);
    const refs = readiness?.evidence?.acceptance?.evidence;
    const evidenceRefs = Array.isArray(refs) ? refs : [];
    return [`${row.harnessSlug}#${row.id}`, {
      stage: decision.stage,
      reason: decision.reason + (readiness?.reason ? `: ${readiness.reason.slice(0, 500)}` : ''),
      evidenceRefs: evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 8).map(ref => ref.slice(0, 500)),
      completionRef: row.terminalCompletionRef?.slice(0, 500) ?? null,
    }];
  }));
}

export async function readWorkItemsPageFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: WorkItemsCompiledPredicate,
  // Mobile retains the existing WorkItem summary/date contract; hydrate these
  // fields only for bounded page keys, leaving the desktop's lean default intact.
  options: { includeDetails?: boolean } = {},
): Promise<BoundedListPage<WorkItemsListRow>> {
  const args = predicate.args;
  if (args.fairStates.length > 0) {
    const rows = await sql<WorkItemsDbRow[]>`${workItemsFairStatesSql(sql, workspaceId, args)}`;
    const presentations = await readWorkItemPresentations(sql, workspaceId, rows);
    return { rows: rows.map(row => ({ ...mapWorkItemsRow(row), presentation: presentations.get(`${row.harnessSlug}#${row.id}`) })), nextCursor: null, hasMore: false };
  }

  const rows = await sql<WorkItemsDbRow[]>`${workItemsPageSql(sql, workspaceId, args, options.includeDetails)}`;
  const hasMore = rows.length > args.limit;
  const pageRows = hasMore ? rows.slice(0, args.limit) : rows;
  const presentations = await readWorkItemPresentations(sql, workspaceId, pageRows);
  const mapped = pageRows.map(row => ({ ...mapWorkItemsRow(row), presentation: presentations.get(`${row.harnessSlug}#${row.id}`) }));
  const tail = mapped[mapped.length - 1];
  return {
    rows: mapped.map(({ updatedTs: _updatedTs, ...row }) => row),
    previousCursor: args.cursor ? encodeWorkItemsCursor(args.cursor) : null,
    nextCursor: hasMore && tail ? encodeWorkItemsCursor({ updatedTs: tail.updatedTs, id: tail.id }) : null,
    hasMore,
  };
}

interface WorkItemsAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

export async function readWorkItemsSummaryFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: WorkItemsCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const args = predicate.args;
  // Every facet reads `scoped`, so it is computed once; stage is a facet, so the
  // spine is joined per row. Severity is the stored heap column (migration 1308);
  // no payload field is read here.
  const rows = await sql<WorkItemsAggregateDbRow[]>`
    WITH ${latestSpineCte(sql, workspaceId, args)},
    ${scopedCte(sql, workspaceId, args, { spine: true, materialization: 'MATERIALIZED' })},
    totals AS (
      SELECT count(*)::int AS n FROM scoped
    ),
    matched AS (
      SELECT count(*)::int AS n FROM scoped s WHERE ${predicateSql(sql, args)}
    ),
    kind_facets AS (
      SELECT s.kind AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'kind')} AND s.kind IS NOT NULL AND s.kind <> ''
       GROUP BY s.kind
    ),
    state_facets AS (
      SELECT s.state AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'state')} AND s.state IS NOT NULL AND s.state <> ''
       GROUP BY s.state
    ),
    stage_facets AS (
      SELECT s.spine_role AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'stage')} AND s.spine_role IS NOT NULL AND s.spine_role <> ''
       GROUP BY s.spine_role
    ),
    assignee_facets AS (
      SELECT s.assignee AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'assignee')} AND s.assignee IS NOT NULL AND s.assignee <> ''
       GROUP BY s.assignee
    ),
    severity_facets AS (
      SELECT s.severity AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'severity')} AND s.severity IS NOT NULL AND s.severity <> ''
       GROUP BY s.severity
    ),
    plan_facets AS (
      SELECT s.plan_slug AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'plan')} AND s.plan_slug IS NOT NULL AND s.plan_slug <> ''
       GROUP BY s.plan_slug
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched
      FROM totals CROSS JOIN matched
    UNION ALL SELECT 'facet', 'kind', 'Kind', value, n, NULL, NULL FROM kind_facets
    UNION ALL SELECT 'facet', 'state', 'State', value, n, NULL, NULL FROM state_facets
    UNION ALL SELECT 'facet', 'stage', 'Stage', value, n, NULL, NULL FROM stage_facets
    UNION ALL SELECT 'facet', 'assignee', 'Assignee', value, n, NULL, NULL FROM assignee_facets
    UNION ALL SELECT 'facet', 'severity', 'Severity', value, n, NULL, NULL FROM severity_facets
    UNION ALL SELECT 'facet', 'plan', 'Plan', value, n, NULL, NULL FROM plan_facets`;

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
