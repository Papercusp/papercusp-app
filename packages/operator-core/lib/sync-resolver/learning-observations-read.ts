/**
 * The compute behind the `learning.observations` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer; see
 * derived-reads/producers.ts) and the resolver's live inline path for NON-default
 * variants (a state filter / custom limit) run the EXACT same code and can never
 * drift (whole-app-sync-payload-audit phase2 P-005).
 *
 * The Observations pane is a BROWSE feed of pre-idea sensor readings from the
 * turn-end reflection step (OBSERVATION_TOPIC lane) — no ranking/triage. The
 * measured 0.22s / 152KB read was listIssues + countIssues + a per-row map/sort
 * over the whole lane on every mount; the 152KB is the per-observation `body`.
 *
 * WI-7303 — two fixes that live together because both are in this mapper:
 *
 * 1. NULL KEYS ARE OMITTED (D-025). Measured live 2026-08-03 at 249,529 B / 200
 *    rows against a 250,000 B budget — 99.8% of ceiling — of which 9,600 B was
 *    literal `"k":null`: `kind`, `confidence` and `sourceRole` were null on
 *    200/200 rows. They are NOT structurally dead (corpus-wide, 14,613 rows:
 *    `observation.kind` on 1,637 and `.confidence` on 1,549, ~11% each), so
 *    omitting rather than dropping is the right shape — the key reappears the
 *    moment the data carries it. Every consumer read site is `??`/truthiness
 *    (ObservationsPanel.tsx), so ABSENT is indistinguishable from null there.
 *
 * 2. `sourceRole` READ THE WRONG KEY. This mapper took `payload.sourceRole`,
 *    which `capture-core.ts` writes — but the DOMINANT observation filer is
 *    turn-end reflection (loop:checkpoint / work_items:complete) routing through
 *    `checkpoint-harvest.ts`, which stamps `payload.filedByRole` and never
 *    `sourceRole`. Measured: `sourceRole` present on 82 of 14,613 observation
 *    rows (0.6%) and 0 of the newest 200; `filedByRole` on 200/200. So the
 *    pane's "Source role" column filter rendered '—' for every row while the
 *    attribution sat one key away — exactly the gap `filedByRole` was added to
 *    close (close-observation-attribution-gap 2026-06-21). Falls back, so the
 *    82 rows that DO carry `sourceRole` keep winning.
 *
 * `body` is 75.46% of the payload and is rendered for at most ONE row (the
 * expanded one) — but it backs the pane's client-side search across all 200, so
 * clipping it is a correctness regression, not a UI tweak. The next breach is
 * WI-7304 (on-demand body + server-side search), NOT a ceiling raise.
 */
import type {
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import type { OrgSql } from '../work-items';
import type { BoundedListPage } from './bounded-list-read';
import { attachListMeta, readListMeta } from './list-meta';
import { createReadDeadline } from './read-deadline';
import { intakeTriageStateSql } from '../attention/intake-promotion';

/**
 * Whole-read deadline for this compute (WI-39823). 6s, the same budget the three
 * bounded learning.* reads carry and for the same measured reason: :3170 served
 * this family at p50 385ms / p90 599ms / max 1.24s (n=10), so 6s is ~10x headroom
 * at p90 while still firing well under both the sync layer's ~10s resolver timeout
 * and the memory backend's degraded p50 of ~10.9s (WI-39554).
 */
const OBSERVATIONS_READ_BUDGET_MS = 6_000;

/** One immutable keyset page. The historical 2,000-row growing window is gone. */
export const LEARNING_OBSERVATIONS_PAGE_LIMIT = 200;

export interface LearningObservationsWireFilters {
  triageStates?: string[];
  scopes?: string[];
  sourceRoles?: string[];
  confidences?: string[];
  kinds?: string[];
  /** Selected-plan slugs matched against observation.refs. */
  plans?: string[];
}

export interface LearningObservationsWireArgs {
  state?: 'open' | 'resolved' | 'closed';
  q?: string;
  filters?: LearningObservationsWireFilters;
  cursor?: string | null;
  limit?: number;
}

export interface LearningObservationsCursor {
  createdAt: string;
  id: string;
}

export interface NormalizedLearningObservationsArgs {
  state: 'open' | 'resolved' | 'closed' | null;
  q: string | null;
  filters: {
    triageStates: string[];
    scopes: string[];
    sourceRoles: string[];
    confidences: string[];
    kinds: string[];
    plans: string[];
  };
  /** Exact and token-boundary forms compiled once for the refs predicate. */
  planExactRefs: string[];
  planRefPatterns: string[];
  cursor: LearningObservationsCursor | null;
  limit: number;
}

export interface LearningObservationsCompiledPredicate {
  args: NormalizedLearningObservationsArgs;
  fingerprint: string;
}

const uniq = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

const escapePgRegex = (value: string): string =>
  value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

export function decodeLearningObservationsCursor(
  raw: string | null | undefined,
): LearningObservationsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LearningObservationsCursor>;
    return typeof parsed.createdAt === 'string' &&
      Number.isFinite(Date.parse(parsed.createdAt)) &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

export const encodeLearningObservationsCursor = (
  row: Pick<LearningObservationRow, 'createdAt' | 'id'>,
): string => JSON.stringify({ createdAt: row.createdAt, id: row.id });

export function normalizeLearningObservationsArgs(
  args: LearningObservationsWireArgs,
): NormalizedLearningObservationsArgs {
  const filters = args.filters ?? {};
  const plans = uniq(filters.plans).map((value) => value.toLowerCase());
  const limit = Math.min(
    Math.max(Math.trunc(Number.isFinite(args.limit) ? args.limit! : LEARNING_OBSERVATIONS_PAGE_LIMIT), 1),
    LEARNING_OBSERVATIONS_PAGE_LIMIT,
  );
  return {
    state: args.state ?? null,
    q: args.q?.trim() || null,
    filters: {
      triageStates: uniq(filters.triageStates),
      scopes: uniq(filters.scopes),
      sourceRoles: uniq(filters.sourceRoles),
      confidences: uniq(filters.confidences),
      kinds: uniq(filters.kinds),
      plans,
    },
    planExactRefs: [...new Set(plans.flatMap((slug) => [slug, `plan:${slug}`]))].sort(),
    planRefPatterns: plans.map(
      (slug) => `(^|[^a-z0-9_-])${escapePgRegex(slug)}($|[^a-z0-9_-])`,
    ),
    cursor: decodeLearningObservationsCursor(args.cursor),
    limit,
  };
}

export function buildLearningObservationsPredicate(
  args: NormalizedLearningObservationsArgs,
): LearningObservationsCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function learningObservationsSummarySelection(
  args: NormalizedLearningObservationsArgs,
): FacetSelection {
  const entries: Array<[string, ReadonlySet<string>]> = [];
  const add = (key: string, values: string[]) => {
    if (values.length > 0) entries.push([key, new Set(values)]);
  };
  add('scope', args.filters.scopes);
  add('sourceRole', args.filters.sourceRoles);
  add('confidence', args.filters.confidences);
  add('kind', args.filters.kinds);
  add('triageState', args.filters.triageStates);
  return new Map(entries);
}

/** True only for the historical derived-snapshot variant. */
export function isDefaultLearningObservationsPage(
  args: NormalizedLearningObservationsArgs,
): boolean {
  return args.state === null &&
    args.q === null &&
    args.cursor === null &&
    args.limit === LEARNING_OBSERVATIONS_PAGE_LIMIT &&
    Object.values(args.filters).every((values) => values.length === 0);
}

export interface LearningObservationsArgs {
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
}

/** Options for {@link computeLearningObservations}. */
export interface LearningObservationsOpts {
  /** Whole-read deadline override in ms (default {@link OBSERVATIONS_READ_BUDGET_MS}). */
  budgetMs?: number;
}

/**
 * The wire row. The optional fields are OMITTED when null (D-025, WI-7303) —
 * `?: string` rather than `: string | null` so the type states what the wire
 * actually carries and a consumer cannot read absence as a bug.
 */
export interface LearningObservationRow {
  triageState?: 'awaiting' | 'handled';
  id: string;
  title: string;
  body?: string;
  kind?: string;
  scope?: string;
  confidence?: string;
  refs: string[];
  sourceRole?: string;
  createdAt: string;
}

type ObservationFacetKey = 'kind' | 'scope' | 'sourceRole' | 'confidence' | 'triageState';

interface LearningObservationDbRow {
  triageState: 'awaiting' | 'handled';
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[] | null;
  sourceRole: string | null;
  createdAt: string | Date;
}

interface LearningObservationAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

const likeContainsPattern = (query: string): string =>
  `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

function observationScopedCte(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedLearningObservationsArgs,
  summary = false,
) {
  // The summary materializes this CTE for reuse by every facet. Project search
  // text and reference arrays only when the summary predicate consumes them;
  // otherwise a counts-only read detoasts bodies and expands refs for the
  // entire corpus. Single-use page reads inline the CTE so PostgreSQL can push
  // down the cursor/filter and defer display projection until after LIMIT.
  return sql`
    scoped AS ${summary ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (
      SELECT ${summary ? sql`` : sql`feature_id AS id, to_timestamp(created_ts / 1000.0) AS created_at,`}
             ${intakeTriageStateSql(sql, {
               payload: 'ei.payload',
               latestOccurrenceId: `(SELECT max(occurrence_id) FROM harness_shared.work_item_occurrences o
                 WHERE o.workspace_id = ei.workspace_id AND o.canonical_harness_slug = ei.harness_slug
                   AND o.canonical_work_item_id = ei.feature_id)`,
             })} AS triage_state,
             ${!summary || args.q ? sql`COALESCE(title, '') AS title, summary AS body,` : sql``}
             ${!summary || args.q || args.filters.plans.length > 0 ? sql`
               ARRAY(
                 SELECT jsonb_array_elements_text(
                   CASE
                     WHEN jsonb_typeof(payload->'observation'->'refs') = 'array'
                     THEN payload->'observation'->'refs'
                     ELSE '[]'::jsonb
                   END
                 )
               ) AS refs,` : sql``}
             NULLIF(payload->'observation'->>'kind', '') AS observation_kind,
             COALESCE(
               NULLIF(payload->'observation'->>'scope', ''),
               CASE WHEN ei.harness_slug LIKE 'operator:%' OR ei.harness_slug = ''
                    THEN 'operator' ELSE 'harness:' || ei.harness_slug END
             ) AS observation_scope,
             COALESCE(
               NULLIF(payload->>'sourceRole', ''),
               NULLIF(payload->>'filedByRole', '')
             ) AS source_role,
             NULLIF(payload->'observation'->>'confidence', '') AS confidence
        FROM harness_shared.work_items ei
       WHERE workspace_id = ${workspaceId}
         AND item_kind = ANY(${['bug', 'change']}::text[])
         AND payload->>'lane' = 'observation'
         AND (payload->'observation'->>'rubricRef') IS NULL
         AND ${args.state ? sql`status = ${args.state}` : sql`TRUE`}
    )`;
}

function observationPredicateSql(
  sql: OrgSql,
  args: NormalizedLearningObservationsArgs,
  omit?: ObservationFacetKey,
) {
  const f = args.filters;
  const q = args.q ? likeContainsPattern(args.q) : null;
  return sql`
    ${omit !== 'triageState' && f.triageStates.length > 0
      ? sql`s.triage_state = ANY(${f.triageStates}::text[])` : sql`TRUE`}
    AND
    ${
      q
        ? sql`(
            COALESCE(s.title, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.body, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.observation_kind, '') ILIKE ${q} ESCAPE '\\'
            OR array_to_string(s.refs, ' ') ILIKE ${q} ESCAPE '\\'
          )`
        : sql`TRUE`
    }
    AND ${
      omit !== 'scope' && f.scopes.length > 0
        ? sql`s.observation_scope = ANY(${f.scopes}::text[])`
        : sql`TRUE`
    }
    AND ${
      omit !== 'sourceRole' && f.sourceRoles.length > 0
        ? sql`s.source_role = ANY(${f.sourceRoles}::text[])`
        : sql`TRUE`
    }
    AND ${
      omit !== 'confidence' && f.confidences.length > 0
        ? sql`s.confidence = ANY(${f.confidences}::text[])`
        : sql`TRUE`
    }
    AND ${
      omit !== 'kind' && f.kinds.length > 0
        ? sql`COALESCE(s.observation_kind, 'other') = ANY(${f.kinds}::text[])`
        : sql`TRUE`
    }
    AND ${
      f.plans.length > 0
        ? sql`EXISTS (
            SELECT 1
              FROM unnest(s.refs) AS observation_ref(value)
             WHERE lower(observation_ref.value) = ANY(${args.planExactRefs}::text[])
                OR lower(observation_ref.value) ~ ANY(${args.planRefPatterns}::text[])
          )`
        : sql`TRUE`
    }`;
}

function mapLearningObservationDbRow(
  row: LearningObservationDbRow,
): LearningObservationRow {
  const createdAt = row.createdAt instanceof Date
    ? row.createdAt.toISOString()
    : new Date(row.createdAt).toISOString();
  const out: LearningObservationRow = {
    triageState: row.triageState,
    id: row.id,
    title: row.title,
    refs: Array.isArray(row.refs) ? row.refs : [],
    createdAt,
  };
  if (row.body != null) out.body = row.body;
  if (row.kind != null) out.kind = row.kind;
  if (row.scope != null) out.scope = row.scope;
  if (row.confidence != null) out.confidence = row.confidence;
  if (row.sourceRole != null) out.sourceRole = row.sourceRole;
  return out;
}

/** Convert the existing derived snapshot into page 1 without recomputing it. */
export function pageLearningObservationsSnapshot(
  snapshot: readonly LearningObservationRow[],
  predicate: LearningObservationsCompiledPredicate,
): BoundedListPage<LearningObservationRow> {
  const rows = snapshot.slice(0, predicate.args.limit);
  const total = readListMeta(snapshot)?.total;
  const hasMore = total != null
    ? total > rows.length
    : rows.length === predicate.args.limit;
  const tail = rows[rows.length - 1];
  const nextCursor = hasMore && tail && Number.isFinite(Date.parse(tail.createdAt))
    ? encodeLearningObservationsCursor(tail)
    : null;
  return {
    rows,
    previousCursor: null,
    nextCursor,
    hasMore: nextCursor !== null,
  };
}

/** Read one bounded page from the authoritative observation corpus. */
export async function readLearningObservationsPageFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: LearningObservationsCompiledPredicate,
): Promise<BoundedListPage<LearningObservationRow>> {
  const args = predicate.args;
  const rows = await sql<LearningObservationDbRow[]>`
    WITH ${observationScopedCte(sql, workspaceId, args)}
    SELECT s.id,
           s.triage_state AS "triageState",
           s.title,
           s.body,
           s.observation_kind AS kind,
           s.observation_scope AS scope,
           s.confidence,
           s.refs,
           s.source_role AS "sourceRole",
           s.created_at AS "createdAt"
      FROM scoped s
     WHERE ${observationPredicateSql(sql, args)}
       AND ${
         args.cursor
           ? sql`(s.created_at, s.id) < (${args.cursor.createdAt}::timestamptz, ${args.cursor.id}::text)`
           : sql`TRUE`
       }
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT ${args.limit + 1}`;
  const hasMore = rows.length > args.limit;
  const pageRows = hasMore ? rows.slice(0, args.limit) : rows;
  const mapped = pageRows.map(mapLearningObservationDbRow);
  const tail = mapped[mapped.length - 1];
  return {
    rows: mapped,
    previousCursor: args.cursor ? encodeLearningObservationsCursor(args.cursor) : null,
    nextCursor: hasMore && tail ? encodeLearningObservationsCursor(tail) : null,
    hasMore,
  };
}

/** Exact total + matched total + four drill-down facet groups in one statement. */
export async function readLearningObservationsSummaryFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: LearningObservationsCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const args = predicate.args;
  const rows = await sql<LearningObservationAggregateDbRow[]>`
    WITH ${observationScopedCte(sql, workspaceId, args, true)},
    totals AS (
      SELECT count(*)::int AS n FROM scoped
    ),
    matched AS (
      SELECT count(*)::int AS n FROM scoped s WHERE ${observationPredicateSql(sql, args)}
    ),
    kind_facets AS (
      SELECT COALESCE(s.observation_kind, 'other') AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${observationPredicateSql(sql, args, 'kind')}
       GROUP BY COALESCE(s.observation_kind, 'other')
    ),
    scope_facets AS (
      SELECT s.observation_scope AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${observationPredicateSql(sql, args, 'scope')}
         AND s.observation_scope IS NOT NULL
       GROUP BY s.observation_scope
    ),
    source_role_facets AS (
      SELECT s.source_role AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${observationPredicateSql(sql, args, 'sourceRole')}
         AND s.source_role IS NOT NULL
       GROUP BY s.source_role
    ),
    confidence_facets AS (
      SELECT s.confidence AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${observationPredicateSql(sql, args, 'confidence')}
         AND s.confidence IS NOT NULL
       GROUP BY s.confidence
    ),
    triage_facets AS (
      SELECT s.triage_state AS value, count(*)::int AS n FROM scoped s
       WHERE ${observationPredicateSql(sql, args, 'triageState')}
       GROUP BY s.triage_state
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched
      FROM totals CROSS JOIN matched
    UNION ALL SELECT 'facet', 'kind', 'Signal', value, n, NULL, NULL FROM kind_facets
    UNION ALL SELECT 'facet', 'scope', 'Scope', value, n, NULL, NULL FROM scope_facets
    UNION ALL SELECT 'facet', 'sourceRole', 'Role', value, n, NULL, NULL FROM source_role_facets
    UNION ALL SELECT 'facet', 'confidence', 'Confidence', value, n, NULL, NULL FROM confidence_facets
    UNION ALL SELECT 'facet', 'triageState', 'Intake triage', value, n, NULL, NULL FROM triage_facets`;

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

/** Build the `learning.observations` rows (newest-first) with list `_meta` (total).
 *
 * BOUNDED (WI-39823). Both legs read the same `engineer_issues` store, and until
 * this bound they had neither a deadline NOR a `try`/`catch` — the weakest form of
 * the class fixed in the three sibling learning.* reads. A store that merely
 * HUNG (not threw) therefore held `Promise.all` past the sync layer's ~10s
 * resolver timeout, 500ing the pane; the client sets no `retry`, so TanStack's
 * default 3 attempts each paid that full timeout and the Observations pane sat on
 * a spinner for ~45s before its error branch could render — the same mechanism
 * behind the owner-reported "Loading retained items… forever".
 *
 * The two legs degrade DIFFERENTLY on purpose, because only one of them is data:
 *   • rows (`listIssues`) IS the read — there is no partial to ship, so a lapsed
 *     budget rejects, and it does so at ~6s instead of never. That is deliberately
 *     a faster failure and NOT a rescued render: the honest claim is that the
 *     error branch becomes reachable, not that the pane still fills.
 *   • count (`countIssues`) is only the "N of TOTAL" label — it fails soft, and
 *     `_meta.totalUnavailable` says so rather than letting the client read the
 *     downloaded length as if it were the true total (the exact misread
 *     `attachListMeta` exists to prevent).
 */
export async function computeLearningObservations(
  a: LearningObservationsArgs,
  opts: LearningObservationsOpts = {},
): Promise<LearningObservationRow[]> {
  const withinBudget = createReadDeadline(opts.budgetMs ?? OBSERVATIONS_READ_BUDGET_MS);
  const { listIssues, countIssues } = await import('../issues-engineer');
  // P-006/D-031: the `lane` column is the canonical observation identity; the topic
  // join under-reads (fenced to coordScopeWorkspace(), and 471 rows carry no tag).
  const { OBSERVATION_LANE } = await import('../harness/improvements/read-items');
  const filter = {
    lane: OBSERVATION_LANE,
    // D-003/P-004 (observation-lane-scorecard-classification-2026-08-16): the pane is
    // a RAW-observation browse feed — rubric-graded scorecards are completed verdicts
    // with their own surfaces (scorecards:list / rubrics:trend / plan acceptance) and
    // rendering them here as untriaged observations is the misread that opened the
    // 01a0031d investigation. Same predicate in the list and the count (parity).
    excludeRubricGraded: true,
    ...(a.state ? { state: a.state } : {}),
  };
  const [issues, total] = await Promise.all([
    withinBudget(listIssues({ ...filter, limit: a.limit ?? 200 }), 'observations rows'),
    withinBudget(countIssues(filter), 'observations count').catch(() => null),
  ]);
  const rows: LearningObservationRow[] = issues
    .map((i) => {
      const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
      const obs = p.observation && typeof p.observation === 'object' ? (p.observation as Record<string, unknown>) : {};
      const refs = Array.isArray(obs.refs) ? obs.refs.filter((r): r is string => typeof r === 'string') : [];
      // `filedByRole` is the fallback, not the primary: the 82 rows that carry a
      // real `sourceRole` (capture-core's P-010 tag) still win. See the header.
      const sourceRole =
        typeof p.sourceRole === 'string' ? p.sourceRole : typeof p.filedByRole === 'string' ? p.filedByRole : null;
      const scope = typeof obs.scope === 'string' ? obs.scope : (i.scope ?? null);
      // D-025: build the required keys, then attach the optional ones ONLY when
      // non-null — never `"k":null` on the wire.
      const row: LearningObservationRow = { id: i.id, title: i.title, refs, createdAt: i.createdAt };
      if (i.body != null) row.body = i.body;
      if (typeof obs.kind === 'string') row.kind = obs.kind;
      if (scope != null) row.scope = scope;
      if (typeof obs.confidence === 'string') row.confidence = obs.confidence;
      if (sourceRole != null) row.sourceRole = sourceRole;
      return row;
    })
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  // A degraded count must not be reported as a real one. `total: undefined` would
  // make the client fall back to the downloaded length and render it as the truth;
  // the explicit flag keeps "we don't know" distinguishable from "that is all".
  return attachListMeta(rows, total == null ? { totalUnavailable: true } : { total });
}
