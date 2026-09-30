/**
 * pg-read-query — run an agent-supplied READ-ONLY SQL query against the
 * operator Postgres.
 *
 * WHY: plans, work-items, issues, observations, tool_invocations, scorecards,
 * recipes, … are PG-CANONICAL. The `*:list` tools and the `docs/plans/*.md`
 * files are just PROJECTIONS. Agents already know SQL well; constraining them
 * to per-tool `*:list` arg shapes means they hit "the filter I need isn't
 * exposed" and fall back to dumping a full list + jq-ing a projection. This
 * lets them query the datastore directly — without the footguns:
 *
 *   - READ ONLY transaction  → a write (INSERT/UPDATE/DDL) is rejected by PG,
 *     even though the admin client is write-capable. Documented write verbs
 *     remain the only mutation path (they emit audit + sync invalidation).
 *   - statement_timeout      → a runaway query can't wedge the pool.
 *   - LIMIT-wrap + row cap    → a fat result can't flood the agent's context.
 *   - pooled connection (getOrgPg) → no per-call connection open.
 *   - TimeZone = UTC          → date_trunc/::date bucket on UTC boundaries, so a
 *     rendered `…T00:00:00.000Z` label is TRUE (EI-19397658288924647, below).
 *
 * The single-statement / SELECT|WITH guard is defense-in-depth + a friendlier
 * early error; the READ ONLY transaction is the real enforcement.
 */

import {
  DEFAULT_TX_ACQUIRE_DEADLINE_MS,
  DbCallDeadlineError,
  getOrgPg,
  getOrgPgLosslessBigint,
  pgbouncerEnabled,
  retryOnRetryableDbDeadline,
  withAcquisitionDeadline,
} from '@papercusp/db-org';

/** The postgres-js client type the org handle exposes. */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface PgReadQueryResult {
  /** Rows, capped at `maxRows`. */
  rows: Record<string, unknown>[];
  /** Rows actually returned by the DB (after the internal LIMIT cap). */
  rowCount: number;
  /** True when the DB had more rows than `maxRows` (result was capped). */
  truncated: boolean;
  /** Column names (from the first row). */
  fields: string[];
  elapsedMs: number;
  /**
   * Optional known-positive probe executed on the same connection, in the same
   * read-only transaction and under the same whole-call deadline. A zero-row
   * primary result is evidence of absence only when this probe returned a row.
   */
  positiveControl?: Omit<PgReadQueryResult, 'elapsedMs' | 'positiveControl'>;
}

export class PgReadQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgReadQueryError';
  }
}

/**
 * Distinct from {@link PgReadQueryError}: thrown when the WHOLE call (connect +
 * acquire + execute) failed to settle within its deadline, as opposed to a real
 * PG-side error. See {@link withCallDeadline} for why this must be its own
 * class rather than reusing a generic timeout message — a caller (dev:pg_query)
 * needs to tell "the query ran and PG said no" apart from "we never found out"
 * (EI-19415142351884573).
 */
export class PgReadQueryTimeoutError extends PgReadQueryError {
  constructor(message: string) {
    super(message);
    this.name = 'PgReadQueryTimeoutError';
  }
}

/** The diagnostic fields worth surfacing from a failed query. */
export interface PgErrorInfo {
  /** `err.message` (always present). */
  message: string;
  /**
   * Postgres' `HINT:` — e.g. `Perhaps you meant to reference the column
   * "w.feature_id".` on a "column does not exist" error. The single most
   * useful field for an agent guessing a wrong column/table name.
   */
  hint?: string;
  /** Postgres' `DETAIL:` — extra context on the error. */
  detail?: string;
  /** The SQLSTATE code (e.g. `42703` = undefined_column, `42P01` = undefined_table). */
  code?: string;
  /** 1-based character position in the query text the error points at. */
  position?: string;
}

/**
 * Extract the useful diagnostic fields Postgres attaches to a query error —
 * hint / detail / code / position — which are otherwise dropped when only
 * `err.message` is surfaced. The postgres-js driver exposes these as lowercase
 * properties on the thrown error (`err.hint`, `err.detail`, `err.code`,
 * `err.position`); Postgres already emits, e.g.,
 * `HINT: Perhaps you meant to reference the column "w.feature_id"` on a
 * "column does not exist" error, so passing it through saves agents from
 * repeatedly guessing non-obvious column names (EI-8301). Safe on any thrown
 * value (Error, PgReadQueryError, or a non-Error).
 */
export function extractPgErrorInfo(err: unknown): PgErrorInfo {
  const message =
    err instanceof PgReadQueryError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const info: PgErrorInfo = { message };
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const str = (v: unknown): string | undefined => {
      if (typeof v === 'string') return v.length ? v : undefined;
      if (typeof v === 'number') return String(v);
      return undefined;
    };
    const hint = str(e.hint);
    const detail = str(e.detail);
    const code = str(e.code);
    const position = str(e.position);
    if (hint) info.hint = hint;
    if (detail) info.detail = detail;
    if (code) info.code = code;
    if (position) info.position = position;
  }
  return info;
}

// ── Point-of-use guard helpers (compaction-continuity-hardening-2026-07-07 P-005) ──
//
// Two recurring post-compaction footguns measured on live sessions: (a) 35×
// "column … does not exist" round-trips re-guessing column names a fresh
// context has no memory of, and (b) tenant-scoped tables filtered by a bare
// slug/id silently matching ANOTHER tenant's rows (the "~560 bugs" class —
// agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope). Both guards
// key off the tables a query REFERENCES, resolved against information_schema
// (canonical, never drifts) rather than a hardcoded table list.

/** Max table references considered by the guards (a fatter join list adds noise). */
const GUARD_MAX_TABLES = 4;
/** information_schema lookups are cached this long (schema changes are rare). */
const SCHEMA_HINT_CACHE_TTL_MS = 5 * 60_000;

/**
 * The table names a query references via FROM / JOIN, as written (optionally
 * schema-qualified), deduped case-insensitively, bounded. Regex over the
 * literal/comment-stripped text — best-effort: a quoted identifier or exotic
 * clause simply doesn't match (the guards then stay silent), never throws.
 */
/**
 * `FROM` introduces a COLUMN rather than a relation in two shapes:
 *   - `IS [NOT] DISTINCT FROM col` — the comparison operator; `DISTINCT` sits
 *     immediately before the `FROM`, which in valid SQL happens only here
 *     (`SELECT DISTINCT x FROM t` always has the select-list between them).
 *   - the SQL-standard function forms `EXTRACT(field FROM src)`,
 *     `SUBSTRING(s FROM n)`, `TRIM(... FROM s)`, `OVERLAY(... FROM n)`, where
 *     the `FROM` sits inside that function's still-open parenthesis.
 * The lookback is windowed so this stays linear on long statements; both shapes
 * put their `FROM` within a few dozen characters of the giveaway token.
 */
const FROM_NOT_A_CLAUSE_RE =
  /(?:\bdistinct\s*$)|(?:\b(?:extract|substring|trim|overlay)\s*\([^()]*$)/i;

function fromIsNotAClause(stripped: string, index: number): boolean {
  return FROM_NOT_A_CLAUSE_RE.test(stripped.slice(Math.max(0, index - 200), index));
}

export function extractReferencedTables(rawSql: string): string[] {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  const out: string[] = [];
  const seen = new Set<string>();
  // `update`/`into` cover the DML target tables (UPDATE t …, INSERT INTO t …)
  // so pg-mutate-query's tenant gate sees the table being written, not just
  // FROM/JOIN sources. A `SELECT … FOR UPDATE OF t` capture lands on a keyword
  // (`of`/`nowait`/`skip`) — filtered below rather than mis-read as a table.
  const re = /\b(from|join|update|into)\s+(?:only\s+)?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/gi;
  const notATable = new Set(['of', 'nowait', 'skip', 'set', 'select']);
  for (let m = re.exec(stripped); m && out.length < GUARD_MAX_TABLES; m = re.exec(stripped)) {
    // WI-10002041: `FROM` is not always a clause. `IS [NOT] DISTINCT FROM col`
    // and the SQL-standard function forms — EXTRACT(field FROM src),
    // SUBSTRING(s FROM n), TRIM(... FROM s), OVERLAY(... FROM n) — all put a
    // COLUMN after FROM. Reading it as a relation is wrong for every consumer,
    // and callers that take tables[0] as the relation (planPredicatePartition)
    // then render `FROM <column-name>`, i.e. SQL that cannot run.
    if (m[1].toLowerCase() === 'from' && fromIsNotAClause(stripped, m.index)) continue;
    const name = m[2].toLowerCase();
    if (notATable.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

interface SchemaHintRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
}

/** Prefer the schema an agent almost certainly meant when a BARE table name
 *  matches several (per-harness schema clones make this common). */
function preferSchema(a: string, b: string): number {
  const rank = (s: string): number => (s === 'harness_shared' ? 0 : s === 'public' ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** One information_schema read for the referenced tables' columns, in ordinal
 *  order. Bare names are resolved to a single preferred schema. */
async function readReferencedColumns(
  tables: string[],
  client?: OrgSql,
): Promise<Map<string, { schema: string; columns: string[]; typedColumns: string[] }>> {
  const qualified = tables.filter((t) => t.includes('.'));
  const bare = tables.filter((t) => !t.includes('.'));
  const sql = client ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND (lower(table_schema || '.' || table_name) = ANY(${qualified})
            OR lower(table_name) = ANY(${bare}))
     ORDER BY table_schema, table_name, ordinal_position
  `) as unknown as SchemaHintRow[];

  // Group by schema.table, then pick ONE schema per referenced name.
  const bySchemaTable = new Map<string, { schema: string; table: string; columns: string[]; typedColumns: string[] }>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`.toLowerCase();
    let g = bySchemaTable.get(key);
    if (!g) {
      g = { schema: r.table_schema, table: r.table_name, columns: [], typedColumns: [] };
      bySchemaTable.set(key, g);
    }
    g.columns.push(r.column_name);
    g.typedColumns.push(`${r.column_name}: ${r.data_type || 'unknown'}`);
  }
  const byRef = new Map<string, { schema: string; columns: string[]; typedColumns: string[] }>();
  for (const g of bySchemaTable.values()) {
    const bareName = g.table.toLowerCase();
    const ref = qualified.includes(`${g.schema}.${g.table}`.toLowerCase())
      ? `${g.schema}.${g.table}`.toLowerCase()
      : bare.includes(bareName)
        ? bareName
        : null;
    if (!ref) continue;
    const existing = byRef.get(ref);
    if (!existing || preferSchema(g.schema, existing.schema) < 0) {
      byRef.set(ref, { schema: g.schema, columns: g.columns, typedColumns: g.typedColumns });
    }
  }
  return byRef;
}

/**
 * P-005(a): the canonical column lists of the tables a failed query references —
 * appended to a 42703 (undefined_column) error so the fix takes ONE round trip
 * instead of a guessing loop. Best-effort: returns [] on any miss.
 */
export async function describeReferencedTableColumns(
  rawSql: string,
  opts: { client?: OrgSql } = {},
): Promise<Array<{ table: string; columns: string[] }>> {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return [];
  const byRef = await readReferencedColumns(tables, opts.client);
  const out: Array<{ table: string; columns: string[] }> = [];
  for (const ref of tables) {
    const hit = byRef.get(ref);
    if (!hit) continue;
    const table = ref.includes('.') ? ref : `${hit.schema}.${ref}`;
    out.push({ table, columns: hit.typedColumns });
  }
  return out;
}

interface TenantScopeInfo {
  hasWorkspaceId: boolean;
  hasHarnessSlug: boolean;
  at: number;
}

const tenantScopeCache = new Map<string, TenantScopeInfo>();

/** Test seam — drop the tenant-scope schema cache. */
export function clearTenantScopeSchemaCache(): void {
  tenantScopeCache.clear();
  tenantPopulationCache.clear();
}

/**
 * VERIFY-BEFORE-PRESCRIBE — does the predicate we are about to recommend
 * actually match any rows? (plan false-premise-in-prescriptive-artifacts-2026-08-02
 * P-003; canonical instance EI-19324633485547042.)
 *
 * ## Why this exists
 *
 * The generic advisory below infers a predicate from `information_schema`: the
 * table HAS a `workspace_id` column, therefore scope by `workspace_id = <the
 * session's workspace>`. That is a PREMISE, not an observation, and it has now
 * been measured false on at least three unrelated tables:
 *
 *   - `agent_facts`  — `harness_slug` is NULL for ~99.6% of rows (EI-18669912007336072)
 *   - `event_awaits` / `event_wake_deliveries` / `event_key_fires` — every row is
 *     the literal `'default'` (WI-6847: 0 rows returned against 32,152 and 37,756
 *     real rows; EI-19324633485547042 for the third)
 *   - `test_runs` — CI rows are env-stamped and NULL on both keys (EI-19324633485547042:
 *     25,214 pass + 246 fail rows, all NULL)
 *
 * Each was handled by ADDING THE TABLE TO A HARDCODED LIST, which costs one
 * agent-incident per table discovered and leaves every not-yet-discovered table
 * armed. The failure is also the dangerous direction: the advisory exists to stop
 * you reading ANOTHER tenant's rows (wrong but visible), and applying it here
 * produces an EMPTY result — and a zero is never re-checked, because it reads as
 * "no rows exist" rather than "your predicate is wrong".
 *
 * The code comment above `TENANT_SCOPE_OVERRIDES` already names the exact defect
 * — "a column's PRESENCE in information_schema is not evidence it is POPULATED" —
 * so the knowledge was never missing; only the check was. This probe supplies it:
 * one bounded `EXISTS` per table, asking the question the advisory was assuming
 * the answer to.
 *
 * FAILS OPEN in every direction. A probe error, a timeout, an unparseable
 * relation name, or an unresolved session workspace all yield `null`, which
 * restores exactly the pre-existing behaviour. A guard against false-empty
 * results must never itself become a reason the advisory stops firing.
 */
interface TenantPopulation {
  /** Does the table have ANY rows? An empty table makes the hit-test meaningless. */
  hasRows: boolean;
  /** Does the PRESCRIBED workspace_id predicate match ≥1 row? null = not probed. */
  workspaceIdHit: boolean | null;
  /** Does the PRESCRIBED harness_slug predicate match ≥1 row? null = not probed. */
  harnessSlugHit: boolean | null;
  /** What the rows are ACTUALLY keyed by — so a miss can name the right value. */
  actualWorkspaceIds: string[];
  actualHarnessSlugs: string[];
  at: number;
}

const tenantPopulationCache = new Map<string, TenantPopulation>();

/** Population changes far faster than schema, so it caches for less time. */
const TENANT_POPULATION_CACHE_TTL_MS = 60_000;

/**
 * Relation names are interpolated (PG cannot parameterize an identifier), so they
 * are hard-validated first. Anything that is not a plain `schema.table` of word
 * characters is refused outright rather than escaped — this probe is an optional
 * enrichment, so declining is free, while a clever escape is not.
 */
const SAFE_RELATION_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

interface TenantScopeOverride {
  /**
   * The columns that ACTUALLY scope this table — replaces the generic
   * workspace_id/harness_slug "already scoped" check for this table only.
   */
  requiredColumns: string[];
  /** One-line description of the real key, inserted after the table name. */
  keyDescription: string;
  /** The suggested predicate for this table, given resolved ids (falls back to a placeholder when unresolved). */
  suggest: (opts: { workspaceId?: string | null; harnessSlug?: string | null }) => string;
  /** A tool that already scopes this table correctly, if one exists. */
  preferredTool?: string;
}

/**
 * Tables whose REAL tenancy predicate differs from the generic "has a
 * workspace_id/harness_slug column" heuristic below — a column's PRESENCE in
 * information_schema is not evidence it is POPULATED (EI-18669912007336072).
 *
 * harness_shared.agent_facts is tenanted by `scope` + `scope_ref`;
 * `harness_slug` exists as a column but is NULL for ~99.6% of rows (facts are
 * scoped 'harness'/'workspace'/'owner'/'work_item'/'role' via scope_ref, not
 * harness_slug). The generic advisory's own suggested predicate
 * (`workspace_id = … AND harness_slug = …`) then matches ~0.4% of rows and
 * returns a clean-looking, confidence-inspiring EMPTY result instead of an
 * error — worse than no guardrail, because a trusted zero is never re-checked
 * (see the EI for the concrete audit this produced a false negative on).
 *
 * This is a deliberately HARDCODED semantic override (not schema-derived) —
 * update it if a table's real tenancy key changes.
 */
const TENANT_SCOPE_OVERRIDES: Record<string, TenantScopeOverride> = {
  agent_facts: {
    requiredColumns: ['scope', 'scope_ref'],
    keyDescription: 'scope + scope_ref — harness_slug is NULL for nearly all rows, do not filter on it',
    suggest: (opts) =>
      opts.harnessSlug
        ? `scope = 'harness' AND scope_ref = '${opts.harnessSlug.replaceAll("'", "''")}'`
        : "scope = '<harness|workspace|owner|work_item|role>' AND scope_ref = '<the matching id>'",
    preferredTool: 'facts:list (already scopes by scope + scope_ref)',
  },
  // Operator-scope work-item comments are stored in this workspace-scoped table
  // with harness_slug NULL. Requiring the federation column in the remediation
  // text turns a real post into a false empty (EI-21356613677322316): the guard
  // must suggest the stable workspace predicate that actually finds local posts.
  coord_thread_posts: {
    requiredColumns: ['workspace_id'],
    keyDescription: 'workspace_id — harness_slug is NULL for operator-scope/local posts',
    suggest: (opts) =>
      opts.workspaceId
        ? `workspace_id = '${opts.workspaceId.replaceAll("'", "''")}'`
        : 'workspace_id = \'<workspace>\'',
    preferredTool: 'work_items:get { detail: true } (for work-item comment threads)',
  },
  // The task ledger is workspace-tenanted, but harness_slug is optional task
  // provenance: root/operator tasks and most current rows leave it NULL. Requiring
  // the nullable column turns a valid workspace-scoped lookup into a false empty
  // (EI-21574761320091331), while workspace_id is NOT NULL and is the actual
  // isolation key used by task-manager/store.ts.
  task_ledger: {
    requiredColumns: ['workspace_id'],
    keyDescription: 'workspace_id — harness_slug is nullable task provenance, not a required tenant key',
    suggest: (opts) =>
      opts.workspaceId
        ? `workspace_id = '${opts.workspaceId.replaceAll("'", "''")}'`
        : "workspace_id = '<workspace>'",
    preferredTool: 'processes:list (task-ledger provenance inventory)',
  },
  // EI-21601240974104741: predicate watches are isolated by workspace_id;
  // harness_slug is nullable optional scope, so requiring both keys drops
  // valid workspace-level watches from advisory/reproduction queries.
  predicate_watches: {
    requiredColumns: ['workspace_id'],
    keyDescription: 'workspace_id — harness_slug is nullable optional scope',
    suggest: (opts) =>
      opts.workspaceId
        ? `workspace_id = '${opts.workspaceId.replaceAll("'", "''")}'`
        : "workspace_id = '<workspace>'",
  },
};

/**
 * Tables whose `workspace_id` is a CORPUS NAMESPACE — always the literal
 * `'default'` (for `tool_usage_rollup`/`session_turns`, per
 * `bash-substitution/report.ts`'s `ROLLUP_CORPUS_WORKSPACE`; for
 * `event_awaits`/`event_wake_deliveries` the column simply defaults to
 * `'default'` at the DDL level — libs/papercusp/libs/db/sql/163-await-event-
 * subscriptions.sql — and, per WI-6847, is measurably 100% `'default'` in
 * practice too; `event_key_fires` is the same DDL-default pattern —
 * libs/papercusp/libs/db/sql/632-event-key-fire-latch.sql — confirmed
 * 100% `'default'` across 16,935 rows and no `harness_slug` column at all,
 * per the second confirmed instance in EI-19324633485547042) — NOT a tenant
 * discriminator. The generic workspace_id/harness_slug heuristic below is
 * actively wrong for these tables in two ways at once
 * (EI-18749676091756794, WI-6847, EI-19324633485547042):
 *
 *   1. `harness_slug` does not exist as a column on these tables at all, so
 *      the generic "actionable" suggestion named a column PG then rejects
 *      with "column does not exist".
 *   2. Even after dropping that column, the real tenant workspace id (e.g.
 *      'papercusp-workspace') matches ZERO rows — every row is written under
 *      the literal 'default' — so "correcting" an unscoped query per the
 *      advisory turns a right answer into a silent, confidence-inspiring
 *      empty result. Measured 2026-08-02 (WI-6847): a workspace_id-scoped
 *      read of event_awaits returned 0 rows against 32,152 real rows, and
 *      event_wake_deliveries the same against 37,756 real rows.
 *
 * So for these tables an UNSCOPED read is the correct one; suppress the
 * generic advisory entirely rather than try to "fix" it into a still-wrong
 * predicate.
 *
 * ⚠ Sibling instrument trap on `event_awaits` (WI-41247, 2026-08-24):
 * `fired_at` is stamped ONLY on one-shot rows (`once = true`). A STANDING
 * watch (`once = false`) matches without consuming — `fireAwaitsForKey`'s
 * standing leg never writes `fired_at` — so a healthy standing watch reads
 * `fired_at IS NULL` forever. Measuring delivery/efficacy via `fired_at`
 * manufactured a false "324 armed / 0 fired" verdict against a tier that had
 * 639 real deliveries in the same window. Delivery ground truth for standing
 * rows is `event_wake_deliveries` (join on `await_id`), never `fired_at`.
 *
 * ⚠ Deliberately a hardcoded per-table registry, like TENANT_SCOPE_OVERRIDES
 * above, NOT a runtime-derived check (e.g. "does this column have exactly one
 * distinct value") — that would require a live cardinality probe on every
 * advisory call for every referenced table, on the hot query path. Extend
 * this set when another table is found to have the same defect; verify with
 * a real `count(*) GROUP BY workspace_id` first (per-table, as WI-6847 did),
 * since `work_items`/`harness_plans` and friends ARE genuinely multi-tenant
 * and must keep the advisory.
 */
const CORPUS_NAMESPACED_TABLES = new Set([
  'tool_usage_rollup',
  // EI-21477025296868436: this member is deliberately MIXED, not corpus-only.
  // File-backed claude/omp/codex rows use the host-global 'default' sentinel;
  // agent_chat rows keep their real workspace because they have no owner stamp
  // and must remain tenant-isolated. It stays in this set only to suppress the
  // generic "add workspace_id = <tenant>" advice; buildCorpusNamespaceAdvisory
  // has the bespoke dual-scope warning and correction below.
  'session_turns',
  // EI-20103748074297088. Added after the per-table verification this doc prescribes:
  // measured 2026-08-10, 603,723 rows, ALL under 'default', 21 distinct owners, current to
  // the minute. The writer hardcodes it (search/session-ingest.ts insertParts) and says why
  // — 'default' is the transcript CORPUS namespace, not a tenant.
  //
  // Its absence here was expensive in a way the sibling entries were not: session_turn_parts
  // is the ONLY place native client tools (Edit/Write/Bash) are recorded, so it is exactly
  // where someone lands after tool_invocations gives them a false zero for the same question.
  // The generic advisory fired and suggested the tenant predicate, which returns 0 of 603,723
  // rows — a SECOND false zero that reads as confirmation of the first.
  //
  // Checked at the same time and deliberately NOT added: session_turn_journal is genuinely
  // mixed (10,453 'default' vs 4,706 'papercusp-workspace'), so the advisory is right about
  // it. session_turns is 362,038 vs 15 strays — already here, correctly.
  'session_turn_parts',
  // EI-20105490569127338. The sibling EI-20103748074297088 deliberately did NOT add this on row
  // counts alone and split out the writer read; this is that read. Measured 2026-09-05:
  // 1,071,004 'default' vs 6 'papercusp-workspace' (99.9994%).
  //
  // The writer (search/turn-chunk-sync.ts) does NOT hardcode 'default' the way session_ingest
  // does — and that distinction is the whole reason this entry is justified rather than assumed.
  // Its DELETE+INSERT pair writes `t.workspace_id` copied VERBATIM from its own source query,
  // `SELECT st.workspace_id ... FROM harness_shared.session_turns st`. It never synthesizes or
  // threads a workspace id of its own, so this table is a pure DERIVED projection of
  // session_turns.workspace_id and cannot hold a value its parent does not already hold. It
  // therefore inherits, by construction, exactly the dual-scope shape that put `session_turns`
  // in this set — the 6 strays here are the copied image of that table's own 214.
  'session_turn_chunks',
  'event_awaits',
  'event_wake_deliveries',
  'event_key_fires',
  // EI-20105490569127338. Measured 2026-09-05: 331 rows, ALL 'default', zero non-default.
  // The filing correctly refused to add this on that count alone — "no non-default rows yet" and
  // "cannot have non-default rows by design" are different claims, and only the writer separates
  // them. The writer settles it as the second: events/await/compose-store.ts holds the ONLY two
  // inserts (insertRootNode, insertInteriorNode) and both write `${ws}` from
  // `const eventsWs = (): string => DEFAULT_COORD_WORKSPACE`, which is the literal 'default'
  // (packages/coordination/src/event-log/pg-log.ts). No migration backfills the table, and every
  // read/update filters on that same constant — there is no code path that can write a tenant id.
  // Same constant its three siblings above already use, so this is consistency verified at the
  // writer, not inferred from their membership.
  'event_await_nodes',
]);

/**
 * `harness_shared.test_runs` (EI-19324633485547042) does NOT fit either registry above. Unlike
 * {@link CORPUS_NAMESPACED_TABLES}, its `workspace_id`/`harness_slug` columns are NOT always-wrong
 * — rows ingested through the per-hive Tests-tab route (migration 413) genuinely carry real,
 * multi-tenant values, and local/admin-ui reporters can now stamp those same fields from their
 * scoped environment. But CI / dogfood-admin-ui rows — the population that matters for GATE
 * triage — can still have BOTH columns NULL by construction: the release checkpoint deliberately
 * strips the per-hive environment before spawning its reporter. So the generic heuristic's own
 * signal of "correctly scoped" (the query MENTIONS workspace_id/harness_slug) is backwards for a
 * broad gate read: adding that predicate can silently exclude every CI/gate row and return a
 * clean-looking empty result, indistinguishable from "no failures". `source`/`commit_sha` are the
 * columns that actually discriminate a gate row, so `test_runs` is excluded from the
 * generic/override checks below and gets its own advisory ({@link buildTestRunsAdvisory}). An
 * exact run_group_id, bounded row-id group, or bounded exact file_path read fenced by BOTH
 * explicit tenant predicates is the separate safe case: it is an intentional per-run/local
 * evidence read, so it must not be rejected as an unscoped query. A local evidence lookup may
 * instead carry only `harness_slug` when it also fixes BOTH `run_group_id` and `file_path` exactly;
 * that three-part identity is the narrow local reporter shape filed in EI-22641981769449390.
 * Broad/partial tenant filters retain the CI warning.
 */
const TEST_RUNS_TABLE = 'test_runs';

interface TestRunsReference {
  qualifier: string;
}

function extractTestRunsReferences(strippedSql: string): TestRunsReference[] {
  const sqlKeywords = new Set([
    'as',
    'on',
    'where',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'full',
    'cross',
    'using',
    'group',
    'order',
    'limit',
    'offset',
    'fetch',
    'union',
    'having',
  ]);
  const references: TestRunsReference[] = [];
  const referenceRe =
    /\b(?:from|join)\s+(?:only\s+)?(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?test_runs\b(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*))?/gi;
  for (let match = referenceRe.exec(strippedSql); match; match = referenceRe.exec(strippedSql)) {
    const alias = match[1]?.toLowerCase();
    references.push({ qualifier: alias && !sqlKeywords.has(alias) ? alias : TEST_RUNS_TABLE });
  }
  return references;
}

/**
 * Independent advisory for {@link TEST_RUNS_TABLE} — see its doc comment for why this can't be
 * expressed as a {@link TENANT_SCOPE_OVERRIDES} entry (those suppress on "any required column
 * mentioned"; here workspace_id/harness_slug mentioned is not enough for a broad CI read).
 * Fires whenever `test_runs` is referenced with a WHERE clause and neither `source` nor
 * `commit_sha` is used as a predicate, unless the query has an exact run_group_id, bounded row-id, or
 * bounded exact file_path predicate alongside both workspace_id and harness_slug predicates.
 * The latter are explicit per-run/local-evidence tenant fences and are safe to execute without
 * allowUnscoped; broad/partial tenant filters retain the CI warning.
 */
function buildTestRunsAdvisory(stripped: string, tables: string[]): string | null {
  if (!tables.some((t) => bareTableName(t) === TEST_RUNS_TABLE)) return null;
  // A SELECT-list mention is not an identity fence. The old `mentions` check
  // treated `SELECT source` / `SELECT commit_sha` as if the query filtered on
  // those columns, so adding either column to the projection silently disabled
  // the CI-row warning (EI-22692714335725268). Reuse the predicate matcher,
  // which requires a comparison/membership/null operator rather than mere
  // column presence, for the same distinction used by tenant predicates.
  const hasIdentityPredicate = (column: string): boolean => hasTenantPredicate(stripped, column);
  if (hasIdentityPredicate('source') || hasIdentityPredicate('commit_sha')) return null;
  const explicitTenantFence =
    hasTenantPredicate(stripped, 'workspace_id') &&
    hasTenantPredicate(stripped, 'harness_slug');
  const harnessScopedLocalEvidenceFence =
    tables.length === 1 &&
    hasExactPredicate(stripped, 'harness_slug') &&
    hasExactPredicate(stripped, 'run_group_id') &&
    hasExactPredicate(stripped, 'file_path');
  const testRunsReferences = extractTestRunsReferences(stripped);
  // A bounded reporter id range is the local equivalent of an exact run_group_id
  // fence (EI-22633261796522656). Keep the exception narrow: `id > ...` and other
  // broad predicates must continue to surface the CI-row NULL trap.
  const boundedLocalGroup =
    tables.length === 1 &&
    (hasBoundedPredicate(stripped, 'run_group_id') || hasBoundedPredicate(stripped, 'id'));
  // An exact file path is a local reporter identity fence when the result is
  // explicitly bounded. Without LIMIT/FETCH, the same path can span every
  // historical run and must retain the CI-row warning.
  const boundedLocalFileRead =
    tables.length === 1 &&
    hasBoundedPredicate(stripped, 'file_path') &&
    /\b(?:limit\s+(?!all\b)(?:\d+|\$\d+)|fetch\s+(?:first|next)\s+(?:\d+|\$\d+)\s+rows?\s+only)\b/i.test(
      stripped,
    );
  const joinedTestRunsReference =
    tables.length > 1 && testRunsReferences.length === 1 ? testRunsReferences[0] : null;
  const joinedExplicitTenantFence =
    joinedTestRunsReference !== null &&
    hasPredicateForTestRunsReference(stripped, joinedTestRunsReference, 'workspace_id', false) &&
    hasPredicateForTestRunsReference(stripped, joinedTestRunsReference, 'harness_slug', false);
  const joinedBoundedLocalGroup =
    joinedExplicitTenantFence &&
    (hasPredicateForTestRunsReference(stripped, joinedTestRunsReference!, 'run_group_id', true) ||
      hasPredicateForTestRunsReference(stripped, joinedTestRunsReference!, 'id', true));
  const joinedBoundedLocalFileRead =
    joinedExplicitTenantFence &&
    hasPredicateForTestRunsReference(stripped, joinedTestRunsReference!, 'file_path', true) &&
    /\b(?:limit\s+(?!all\b)(?:\d+|\$\d+)|fetch\s+(?:first|next)\s+(?:\d+|\$\d+)\s+rows?\s+only)\b/i.test(
      stripped,
    );
  if (
    harnessScopedLocalEvidenceFence ||
    (explicitTenantFence && (boundedLocalGroup || boundedLocalFileRead)) ||
    joinedBoundedLocalGroup ||
    joinedBoundedLocalFileRead
  )
    return null;
  return (
    '⚠ harness_shared.test_runs: workspace_id/harness_slug are NULL-by-design for CI/dogfood-reporter ' +
    'rows (env-derived — libs/test-config/src/admin-test-runs-reporter.ts — and stamped ONLY by the ' +
    'per-hive Tests-tab ingestion route, migration 413). A workspace_id/harness_slug predicate therefore ' +
    "silently EXCLUDES every CI/gate row and reads as a clean 'no failures' — for CI/gate triage scope by " +
    "source/commit_sha instead. Also: status values are 'pass'/'fail'/'skip', NOT 'passed'/'failed' — " +
    "status <> 'passed' matches every row (EI-19324633485547042)."
  );
}

/**
 * `harness_shared.scout_routed_ideas` (system-notices-on-its-own-2026-08-16 P-003).
 *
 * The SEMANTIC sibling of the tenancy advisories above. Everything else in this
 * file guards WHICH ROWS BELONG TO YOU; this one guards WHAT A COLUMN MEANS.
 *
 * `human_grade IS NULL` looks like the complete definition of "ungraded" and is
 * not. `packages/operator-core/lib/scout/ungraded-scope.ts` is the sole authority
 * and documents three axes a count must fix before the word means anything:
 * ORIGIN (su-ideate and scout have different producers, graders and deadlines),
 * TERMINALITY (a filing whose artifact already landed cannot be usefully graded),
 * and the PER-ORIGIN EPOCH FLOOR (grading is forward-only; D-014 gives scout and
 * su-ideate different floors). Leaving them implicit is not a rounding error:
 * three surfaces once published 15, 1,103 and 1,082 for the same workspace on
 * the same day, each arithmetically right about a different population, and the
 * D-074 report that said "1,082 su filings" was the SCOUT population wearing the
 * su label — off by ~70x, which made a fifteen-row backlog look like an
 * emergency.
 *
 * WHY THIS BELONGS HERE AND NOT ONLY IN THE BUILD. `ungraded-scope.test.ts`
 * already fails the build if a raw `human_grade IS NULL` predicate appears in
 * COMMITTED code outside that module. That guard is good and it cannot see the
 * failure that actually keeps happening: an agent hand-writing the predicate
 * into an ad-hoc `dev:pg_query` at runtime, which is committed nowhere. Measured
 * again on 2026-08-16: a hand-written query answered 143 where `classifyUngraded`
 * answers 83.
 *
 * THE ANTI-ROT RULE, and the reason this registry stays one entry long. A
 * hand-authored corpus of semantic rules rots, and a stale guard naming a
 * renamed accessor is worse than no guard. So an entry is admissible here ONLY
 * when the same predicate ALREADY carries a build-time guard — then a rename
 * breaks the build, which forces this text to be updated with it, instead of
 * silently stranding a runtime rule that keeps confidently citing a symbol that
 * no longer exists. `ungraded-scope-advisory.test.ts` pins the two together by
 * asserting the symbols named below are real exports. Do not add an entry whose
 * authority has no build-time guard of its own.
 */
const SCOUT_ROUTED_IDEAS_TABLE = 'scout_routed_ideas';

/**
 * The three axes `classifyUngraded` fixes. A query naming all three is doing the
 * work deliberately and is left alone; anything less gets the advisory.
 */
const UNGRADED_SCOPE_AXES = ['origin', 'outcome', 'routed_at'] as const;

/**
 * Independent advisory for {@link SCOUT_ROUTED_IDEAS_TABLE} — fires when a query
 * reaches for `human_grade` without fixing all three population axes.
 *
 * Clears once the query names origin, outcome AND routed_at: at that point the
 * caller has demonstrably chosen a population rather than inherited one by
 * accident, which is the only thing this advisory is trying to force.
 */
export function buildUngradedScopeAdvisory(stripped: string, tables: string[]): string | null {
  if (!tables.some((t) => bareTableName(t) === SCOUT_ROUTED_IDEAS_TABLE)) return null;
  const mentions = (col: string): boolean => new RegExp(`\\b${col}\\b`, 'i').test(stripped);
  if (!mentions('human_grade')) return null;
  const missing = UNGRADED_SCOPE_AXES.filter((axis) => !mentions(axis));
  if (missing.length === 0) return null;
  return (
    `⚠ harness_shared.scout_routed_ideas: "ungraded" is NOT \`human_grade IS NULL\` — that leaves ` +
    `${missing.length === 1 ? 'one axis' : `${missing.length} axes`} implicit (${missing.join(', ')}) and silently picks a population ` +
    `nobody chose. The authority is classifyUngraded() / readUngradedBreakdown() in ` +
    `packages/operator-core/lib/scout/ungraded-scope.ts, which fixes ORIGIN (scout vs su-ideate — ` +
    `different producers, graders and deadlines; summing them answers no question), TERMINALITY ` +
    `(outcome set and not 'pending' ⇒ ungradeable), and the PER-ORIGIN EPOCH FLOOR (grading is ` +
    `forward-only, and D-014 gives scout and su-ideate DIFFERENT floors). Three surfaces once ` +
    `published 15, 1,103 and 1,082 for the same workspace on the same day this way, and a report ` +
    `of "1,082 su filings" was really the scout population — off by ~70x. Prefer the accessor; if ` +
    `you must query raw, name origin, outcome and routed_at explicitly so the population is chosen.`
  );
}

/** The bare (unqualified) table name — `schema.table` → `table`. */
export function bareTableName(ref: string): string {
  const i = ref.lastIndexOf('.');
  return i === -1 ? ref : ref.slice(i + 1);
}

interface DerivedColumnRedirect {
  /** Bare table the column is reached for on. */
  table: string;
  /** Why the column does not exist — and, where it applies, why no view can add it. */
  why: string;
  /** The surfaces that DO return the value, all projecting one derivation. */
  useInstead: string;
  /**
   * The plausible-but-WRONG columns an agent reaches for next when it is handed
   * only `knownColumns`. Naming them is the whole point: this registry exists
   * because the helpful error was steering people onto a documented-wrong signal.
   */
  notThese?: string;
}

/**
 * Columns an agent will reach for BY NAME — because every tool surface, doc and
 * playbook teaches them as the canonical vocabulary — but which are DERIVED at
 * read time and have no column to select (EI-18801042715296007).
 *
 * ⚠ THE FAILURE MODE IS NOT THE ERROR, IT IS THE RECOVERY. A 42703 here is loud
 * and its `knownColumns` list is genuinely accurate. But on `coord_presence` the
 * columns that DO exist are `heartbeat_at` / `last_active_at` — precisely the raw
 * process-keepalive signals the platform documents as NOT the liveness verdict.
 * So the most helpful thing the error could say ("here are the real columns")
 * hands the agent the wrong signal, and the natural next query returns a
 * confident wrong answer instead of an error. A warm-dead session reads
 * `heartbeatFresh: true` with `sessionState: 'ended'`; from SQL alone those are
 * indistinguishable, and nothing tells you they are.
 *
 * ⚠ AND WHY A VIEW IS NOT THE CHEAP FIX. The obvious repair — expose the verdict
 * as a `coord_presence_live` view or generated column so the SQL vocabulary
 * matches the tool vocabulary — CANNOT be done faithfully. `sessionState` is
 * assembled from six legs (see `agent-tools/coordination/liveness-oracle.ts`)
 * and two of them are not data in Postgres at all: a `kill(pid, 0)` syscall
 * against the subject's own host, and the box-local in-process psu-pty host
 * registry. A SQL re-derivation could only cover the other legs, so it would
 * disagree with every tool — reintroducing the "same agent, different verdict
 * per surface" defect that `presence-derivation-unification-2026-07-17` was
 * built to eliminate, and doing it behind something that LOOKS authoritative
 * because it sits in SQL next to the real columns. A wrong answer nobody
 * re-checks is worse than a loud error, which is why this is a redirect and not
 * a view.
 *
 * Keyed `<bare table>.<column>`. Deliberately HARDCODED semantics, like
 * TENANT_SCOPE_OVERRIDES above — update it when a derivation moves.
 */
const DERIVED_COLUMN_REDIRECTS: Record<string, DerivedColumnRedirect> = {
  'coord_presence.session_state': {
    table: 'harness_shared.coord_presence',
    why:
      'it is DERIVED at read time by one shared oracle, not stored, and no view can add it — ' +
      'two of the six legs are not in Postgres at all (a kill(pid,0) probe against the ' +
      "subject's own host, and the box-local psu-pty host registry), so a SQL re-derivation " +
      'would silently disagree with every tool',
    useInstead:
      "coord:presence · fleet:assignments · coord:roster { view:'live' } · fleet:status · " +
      'fleet:leader-brief (all project the SAME derivation)',
    notThese:
      'heartbeat_at / last_active_at — raw process-keepalive freshness, explicitly NOT the ' +
      "liveness verdict: a warm-dead session reads heartbeatFresh:true with sessionState:'ended', " +
      'and from SQL alone you cannot tell it from a live one',
  },
  'coord_presence.wakeable': {
    table: 'harness_shared.coord_presence',
    why: 'it is derived per read from event_awaits + agent_activity, not stored on the presence row',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.live_turn': {
    table: 'harness_shared.coord_presence',
    why: 'it is derived per read from event_awaits + agent_activity, not stored on the presence row',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.confirm_liveness': {
    table: 'harness_shared.coord_presence',
    why: 'it is a function of the derived sessionState (draining/suspect need a fresh required wake), not a stored flag',
    useInstead: "coord:presence · fleet:assignments · coord:roster { view:'live' }",
  },
  'coord_presence.intent_stale': {
    table: 'harness_shared.coord_presence',
    // Especially trap-shaped: the row DOES carry `intent` and `last_active_at`,
    // so a fallback here looks like it works. It just applies a threshold of
    // your own choosing instead of INTENT_STALE_SEC, and diverges quietly.
    why:
      'it is computed per read by computeIntentStale (presence-tier1.ts) from last_active_at ' +
      'against INTENT_STALE_SEC, not stored — the row carries the intent TEXT, never its staleness',
    useInstead: "coord:presence (Tier-1 LIVENESS lane) · coord:roster { view:'live' }",
    notThese:
      'a hand-rolled `now() - last_active_at > <your own interval>` — it will not match ' +
      "INTENT_STALE_SEC, so your idea of a stalled claim silently differs from every tool's",
  },
  'coord_presence.heartbeat_fresh': {
    table: 'harness_shared.coord_presence',
    // Unlike the others this one IS computable in SQL — the redirect exists to
    // stop you computing it and then reading it as liveness, which is the same
    // wrong-signal trap one step further along.
    why:
      'it is computed from heartbeat_at (freshness within the stale window), not stored — but ' +
      'note it is a process-keepalive signal, NOT the liveness verdict',
    useInstead:
      'sessionState via coord:presence / fleet:assignments if you want the VERDICT; compute ' +
      'freshness from heartbeat_at only if you genuinely want raw keepalive',
  },
};

/**
 * P-005(c): turn a 42703 that names a DERIVED column into a redirect rather than
 * a dead end. Returns null unless the failing column is a registered derivation
 * on a table this query actually references. Best-effort and purely textual — it
 * never suppresses the underlying error, it rides alongside it.
 */
export function buildDerivedColumnRedirect(rawSql: string, errorMessage: string): string | null {
  const column = parseMissingColumnName(errorMessage);
  if (!column) return null;

  const referenced = extractReferencedTables(rawSql).map(bareTableName);
  for (const table of referenced) {
    const hit = DERIVED_COLUMN_REDIRECTS[`${table}.${column}`];
    if (!hit) continue;
    return (
      `⚠ \`${column}\` is DERIVED, not stored: ${hit.table} has no such column because ${hit.why}. ` +
      (hit.notThese ? `⛔ Do NOT fall back to ${hit.notThese}. ` : '') +
      `→ Use ${hit.useInstead}. ` +
      '(agent-tools/coordination/liveness-oracle.ts · EI-18801042715296007)'
    );
  }
  return null;
}

/**
 * A small registry for schema/projection names that are routinely confused with
 * the platform vocabulary. Unlike a derived-column redirect, these are
 * schema-shape mismatches: the caller used a name from a different projection,
 * table family, or JSONB path. Keep this separate from `DERIVED_COLUMN_REDIRECTS`
 * so the error does not claim a stored value is computed at read time.
 */
const SCHEMA_COLUMN_REDIRECTS: ReadonlyArray<{
  relation: string;
  missing: string;
  actual?: string;
  scope?: string;
  message?: string;
}> = [
  {
    relation: 'work_items',
    missing: 'id',
    message:
      'the public work-item id maps to the canonical `feature_id` column; include `workspace_id` in the predicate',
  },
  {
    relation: 'work_items',
    missing: 'state',
    message:
      'the canonical work-item lifecycle column is `status`; `state` belongs to the compatibility `engineer_issues` projection. Retry with `status` and include `workspace_id` in the predicate',
  },
  {
    relation: 'work_items',
    missing: 'assignee',
    message:
      'the unified work-items table stores claim ownership in `taken_by`, not `assignee`; retry with `taken_by` and include BOTH `workspace_id` and `harness_slug` in the predicate',
  },
  {
    relation: 'harness_features_consolidated',
    missing: 'assignee',
    message:
      'the feature-compatible work-items view exposes claim ownership as `taken_by`, not `assignee`; retry with `taken_by` and include BOTH `workspace_id` and `harness_slug` in the predicate',
  },
  {
    relation: 'substrate_outbox',
    missing: 'table_tag',
    message:
      'the outbox table records the affected relation in the physical `table_name` column; scope by `workspace_id` and `harness_slug` when those tenant columns are relevant',
  },
  {
    relation: 'work_items',
    missing: 'checkpoint',
    message:
      'checkpoint text is not stored on this work-item relation; it lives in `harness_shared.carry_notes.note` under the `workitem:<harness>:<work-item-id>` scope. Use `work_items:get { id, harness }`, which joins that store and returns the checkpoint, instead of querying a nonexistent work_items column',
  },
  // EI-21827078641119577: dependency edges are a separate polymorphic relation.
  // A reader that guesses these columns on work_items gets a 42703, and the
  // generic knownColumns payload does not tell it where the edge actually lives.
  // Keep this redirect single-relation (buildSchemaColumnRedirect refuses joins)
  // so a missing name on another relation cannot be misrouted.
  ...(['blocked_kind', 'blocked_ref', 'blocker_kind', 'blocker_ref'] as const).map((missing) => ({
    relation: 'work_items',
    missing,
    message:
      'dependency-edge metadata is not stored on this work-item relation; it lives in `harness_shared.work_item_deps` ' +
      'under the requested column. Scope the edge read by `workspace_id`; use `work_items:get { id, harness }` ' +
      'for one item’s dependency view',
  })),
  {
    relation: 'plan_item_claims',
    missing: 'agent_id',
    message:
      'plan-item claim ownership is stored in `owner` (with `owner_name`/`owner_label` for display), not `agent_id`; ' +
      'scope the claim read by `workspace_id` and `harness_slug`, and use `owner` for the claimant identity',
  },
  {
    relation: 'routines',
    missing: 'harness_slug',
    actual: 'install_slug',
    scope: 'workspace_id',
  },
  {
    relation: 'routines',
    missing: 'paused_reason',
    message:
      'pause state is stored in the JSONB `metadata` column under `pause`, not as a physical column; ' +
      'use `metadata->\'pause\'->>\'reason\'` for a raw read or use `routines:list` and its `paused` field',
  },
  {
    relation: 'tool_invocations',
    missing: 'result_json',
    message:
      'this ledger has no inline result JSON. Its output-related columns are `output_ref` (a reference), ' +
      '`output_size` (bytes), and `metadata_json` (transport metadata); select those physical columns or use ' +
      'the covering activity/tool-log read for call output and metadata',
  },
  {
    relation: 'tool_invocations',
    missing: 'created_at',
    message:
      'this invocation ledger records dispatch time as `invoked_at`, not generic `created_at`; use `invoked_at` ' +
      'for recency filters and ordering (the canonical writer is `projected-tool-deps.ts`)',
  },
  {
    relation: 'tool_invocations',
    missing: 'request_origin',
    message:
      'telemetry origin is split across `call_origin` (who chose the call) and ' +
      '`call_origin_source` (declared versus derived); request metadata, when needed, is nested under ' +
      '`metadata_json` at `requestOrigin`',
  },
  {
    relation: 'coord_thread_posts',
    missing: 'created_ts',
    message:
      'the coordination store exposes this timestamp as `created_ts` in API projections, but the physical ' +
      'Postgres column is `created_at` (`timestamptz`); use `created_at` for SQL recency filters and ordering',
  },
  {
    relation: 'migration_reservations',
    missing: 'migration_number',
    message:
      'the allocator stores the migration number in `num`, not `migration_number`; use `filename` for the ' +
      'armed migration filename, and use `db:next-migration` to allocate a number instead of hand-writing ' +
      'reservation SQL',
  },
  {
    relation: 'migration_reservations',
    missing: 'name',
    message:
      'the reservation ledger stores the armed migration filename in `filename`, not `name`; the migration ' +
      'number is `num`, and `db:next-migration` is the typed allocator',
  },
];

/**
 * Turn a 42703 caused by a known cross-table vocabulary mismatch into an
 * actionable retry hint. This deliberately handles only a single referenced
 * relation: with joins, the same missing name can be valid on another table and
 * a false redirect is worse than the generic `knownColumns` payload.
 */
export function buildSchemaColumnRedirect(rawSql: string, errorMessage: string): string | null {
  const column = parseMissingColumnName(errorMessage);
  if (!column) return null;

  const referenced = extractReferencedTables(rawSql);
  if (referenced.length !== 1) return null;

  const relation = bareTableName(referenced[0]);
  const hit = SCHEMA_COLUMN_REDIRECTS.find(
    (entry) => entry.relation === relation && entry.missing === column,
  );
  if (!hit) return null;

  if (hit.message) {
    return `⚠ \`${hit.missing}\` is not a column on ${referenced[0]} — ${hit.message}. ` +
      `(live schema contract; see ${referenced[0]})`;
  }

  return (
    `⚠ \`${hit.missing}\` is not a column on ${referenced[0]} — this relation uses ` +
    `\`${hit.actual}\` as its installation key. Retry with \`${hit.actual}\` and scope ` +
    `by \`${hit.scope}\` as well. ` +
    '(live schema contract; see harness_shared.routines)'
  );
}

/**
 * The failing column name out of a 42703. PG spells it two ways: `column
 * "session_state" does not exist` (bare) and `column p.session_state does not
 * exist` (qualified by alias — unquoted).
 *
 * Shared by every 42703 advisory on purpose. Two advisories with two copies of
 * this regex can disagree about WHICH name failed and then contradict each
 * other in the same error payload, which costs more than either one saves.
 */
export function parseMissingColumnName(errorMessage: string): string | null {
  const m = /column\s+"?(?:([a-z_][a-z0-9_$]*)\.)?([a-z_][a-z0-9_$]*)"?\s+does not exist/i.exec(
    errorMessage,
  );
  return m?.[2]?.toLowerCase() ?? null;
}

/** Rows sampled per jsonb column when probing for a nested key. Bounded because
 *  this runs on an ERROR path — a hint is never worth a table scan. */
const JSONB_PROBE_SAMPLE_ROWS = 200;
/** Most (table, jsonb column) pairs probed for one failed query. */
const JSONB_PROBE_MAX_COLUMNS = 3;

/** Quote an identifier that came from `information_schema` (so it is real, and
 *  the escape is belt-and-braces rather than the only defence). */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * P-015: turn a 42703 whose name actually lives INSIDE a jsonb column into the
 * accessor that reaches it, instead of a column list that cannot contain it.
 *
 * ## Why `knownColumns` alone is not enough here
 *
 * `knownColumns` answers "what columns exist", which is the right answer to a
 * misspelling and the WRONG answer to a nesting mistake — and nesting is the
 * common case on this schema, where the interesting fields are folded into a
 * `payload` jsonb. `harness_shared.work_items` is the canonical instance: it has
 * NO `severity` column (it lives at `payload->'_ei'->>'severity'`, migration
 * 374's fold) and no `_completionEvidence` column either. An agent handed the
 * column list sees `payload` among thirty names with nothing marking it as the
 * place its field went, and the documented outcome is a rewritten query that
 * returns NULL for every row WITHOUT erroring — a well-formed, plausible, wrong
 * answer, which is strictly worse than the loud 42703 it replaced.
 *
 * ## Why this probes DATA and does not carry a registry
 *
 * The sibling advisory above (`DERIVED_COLUMN_REDIRECTS`) is hardcoded because
 * its subject is a derivation that exists only in TypeScript — no query could
 * find it. This one is the opposite: the answer is sitting in the rows. A
 * registry of known nested keys would go stale the moment anyone folds a new
 * field into a payload, and would be silent for exactly the fields nobody has
 * documented yet. Anchoring to the PROPERTY (a jsonb value that has this key)
 * rather than to a curated list of names is what makes it cover the fields we
 * have not thought of — the same widening rule the module-pin lint had to learn.
 *
 * Best-effort throughout: any miss returns null and the underlying 42703 is
 * reported unchanged. It never suppresses the real error, it rides alongside it.
 */
export async function buildJsonbPathRedirect(
  rawSql: string,
  errorMessage: string,
  opts: { client?: OrgSql } = {},
): Promise<string | null> {
  const column = parseMissingColumnName(errorMessage);
  if (!column) return null;

  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;
  const byRef = await readReferencedColumns(tables, opts.client);

  // If the name IS a real column on some referenced table, the query's problem
  // is scope/aliasing, not nesting — say nothing rather than send the reader
  // hunting through a payload for a column they already have.
  for (const hit of byRef.values()) {
    if (hit.columns.some((c) => c.toLowerCase() === column)) return null;
  }

  const candidates: Array<{ schema: string; table: string; column: string }> = [];
  for (const ref of tables) {
    const hit = byRef.get(ref);
    if (!hit) continue;
    const bare = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
    for (const typed of hit.typedColumns) {
      const at = typed.lastIndexOf(':');
      if (at === -1) continue;
      if (!/^\s*(jsonb|json)\s*$/i.test(typed.slice(at + 1))) continue;
      candidates.push({ schema: hit.schema, table: bare, column: typed.slice(0, at).trim() });
    }
  }
  if (!candidates.length) return null;

  const sql = opts.client ?? getOrgPg().sql;
  for (const c of candidates.slice(0, JSONB_PROBE_MAX_COLUMNS)) {
    // Depth 1 (`payload -> key`) and depth 2 (`payload -> parent -> key`) in one
    // statement. Two levels is where the real folds live (`payload._ei.severity`)
    // and each extra level multiplies the sample cost for a sharply thinner
    // return. `jsonb_exists(v, $1)` rather than the `?` operator: `?` is a
    // placeholder character in several drivers, and this string is handed to
    // `unsafe`, so the function form removes the question entirely.
    const rel = `${quoteIdent(c.schema)}.${quoteIdent(c.table)}`;
    const col = quoteIdent(c.column);
    const probe =
      `WITH s AS (SELECT ${col}::jsonb AS v FROM ${rel} ` +
      `WHERE ${col} IS NOT NULL LIMIT ${JSONB_PROBE_SAMPLE_ROWS}) ` +
      `(SELECT 1 AS depth, NULL::text AS parent FROM s ` +
      `WHERE jsonb_typeof(s.v) = 'object' AND jsonb_exists(s.v, $1) LIMIT 1) ` +
      `UNION ALL ` +
      `(SELECT 2 AS depth, e.key AS parent FROM s, LATERAL jsonb_each(s.v) e ` +
      `WHERE jsonb_typeof(s.v) = 'object' AND jsonb_typeof(e.value) = 'object' ` +
      `AND jsonb_exists(e.value, $1) LIMIT 1) ` +
      `ORDER BY depth LIMIT 1`;
    const rows = (await sql.unsafe(probe, [column]).catch(() => [])) as unknown as Array<{
      depth: number;
      parent: string | null;
    }>;
    const found = Array.isArray(rows) ? rows[0] : undefined;
    if (!found) continue;

    const path =
      found.depth === 2 && found.parent
        ? `${c.column}->'${found.parent}'->>'${column}'`
        : `${c.column}->>'${column}'`;
    const existsPred =
      found.depth === 2 && found.parent
        ? `${c.column}->'${found.parent}' ? '${column}'`
        : `${c.column} ? '${column}'`;
    return (
      `⚠ \`${column}\` is NOT a column on ${c.schema}.${c.table} — it is a key INSIDE the ` +
      `\`${c.column}\` jsonb column (found by sampling ${JSONB_PROBE_SAMPLE_ROWS} rows). ` +
      `→ Read it as \`${path}\`; test presence with \`${existsPred}\`. ` +
      `⛔ Do NOT conclude from \`knownColumns\` that the field does not exist — that list is ` +
      `columns only, so a nested key is invisible to it. ⚠ The accessor is bound to THIS ` +
      `relation: the same field on a sibling VIEW may be exploded into a real column, and the ` +
      `wrong accessor for a relation returns NULL for EVERY row without erroring.`
    );
  }
  return null;
}

async function readTenantScopeInfo(
  tables: string[],
  client?: OrgSql,
): Promise<Map<string, TenantScopeInfo>> {
  const now = Date.now();
  const result = new Map<string, TenantScopeInfo>();
  const misses: string[] = [];
  for (const t of tables) {
    const cached = tenantScopeCache.get(t);
    if (cached && now - cached.at < SCHEMA_HINT_CACHE_TTL_MS) result.set(t, cached);
    else misses.push(t);
  }
  if (misses.length) {
    const byRef = await readReferencedColumns(misses, client);
    for (const t of misses) {
      const cols = byRef.get(t)?.columns ?? [];
      const info: TenantScopeInfo = {
        hasWorkspaceId: cols.includes('workspace_id'),
        hasHarnessSlug: cols.includes('harness_slug'),
        at: now,
      };
      tenantScopeCache.set(t, info);
      result.set(t, info);
    }
  }
  return result;
}

/**
 * Probe whether the prescription would actually match rows — see
 * {@link TenantPopulation}. One bounded query per table; `null` = fail open.
 *
 * The DISTINCT sample is taken from a bounded window rather than the whole
 * relation: it only has to be good enough to NAME the real key in a hint, and an
 * unbounded `SELECT DISTINCT` on a hot multi-million-row table would cost far
 * more than the advisory is worth.
 */
async function probeTenantPopulation(
  table: string,
  info: TenantScopeInfo,
  resolved: { workspaceId?: string | null; harnessSlug?: string | null },
  client?: OrgSql,
): Promise<TenantPopulation | null> {
  if (!SAFE_RELATION_RE.test(table)) return null;
  const checkWs = info.hasWorkspaceId && !!resolved.workspaceId;
  const checkHs = info.hasHarnessSlug && !!resolved.harnessSlug;
  if (!checkWs && !checkHs) return null;

  // EI-21338326327553651 — the probed population is SCOPE-RELATIVE: `ws_hit`/`hs_hit`
  // answer "does THIS caller's resolved workspace/harness match at least one row", and
  // `actualWorkspaceIds`/`actualHarnessSlugs` are the values a MISS should name. Keyed by
  // `table` alone, the first caller's scope-specific verdict was served to every other
  // scope for the TTL. That is how the advisory came to prescribe the ACTIVE workspace for
  // rows legitimately pinned elsewhere (loop carry notes pin to DEFAULT_COORD_WORKSPACE),
  // i.e. it recommended a predicate matching nothing. The key must carry the scope the
  // verdict was computed FOR. JSON.stringify keeps it unambiguous and greppable — a
  // delimiter-joined key would collide on any value containing the delimiter.
  const cacheKey = JSON.stringify([
    table,
    checkWs ? resolved.workspaceId : null,
    checkHs ? resolved.harnessSlug : null,
  ]);
  const cached = tenantPopulationCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TENANT_POPULATION_CACHE_TTL_MS) return cached;

  const params: string[] = [];
  const selects: string[] = [`EXISTS (SELECT 1 FROM ${table}) AS has_rows`];
  if (checkWs) {
    params.push(resolved.workspaceId!);
    selects.push(`EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = $${params.length}) AS ws_hit`);
    selects.push(
      `(SELECT array_agg(DISTINCT v) FROM (SELECT workspace_id::text AS v FROM ${table} ` +
        `WHERE workspace_id IS NOT NULL LIMIT 500) s) AS ws_vals`,
    );
  }
  if (checkHs) {
    params.push(resolved.harnessSlug!);
    selects.push(`EXISTS (SELECT 1 FROM ${table} WHERE harness_slug = $${params.length}) AS hs_hit`);
    selects.push(
      `(SELECT array_agg(DISTINCT v) FROM (SELECT harness_slug::text AS v FROM ${table} ` +
        `WHERE harness_slug IS NOT NULL LIMIT 500) s) AS hs_vals`,
    );
  }

  try {
    const sql = client ?? getOrgPg().sql;
    const rows = (await sql.unsafe(`SELECT ${selects.join(', ')}`, params)) as unknown as Array<{
      has_rows: boolean;
      ws_hit?: boolean;
      hs_hit?: boolean;
      ws_vals?: string[] | null;
      hs_vals?: string[] | null;
    }>;
    const r = rows[0];
    if (!r) return null;
    const pop: TenantPopulation = {
      hasRows: !!r.has_rows,
      workspaceIdHit: checkWs ? !!r.ws_hit : null,
      harnessSlugHit: checkHs ? !!r.hs_hit : null,
      actualWorkspaceIds: (r.ws_vals ?? []).slice(0, 3),
      actualHarnessSlugs: (r.hs_vals ?? []).slice(0, 3),
      at: Date.now(),
    };
    tenantPopulationCache.set(cacheKey, pop);
    return pop;
  } catch {
    // Fail OPEN — an unprobed table keeps the pre-existing advisory verbatim.
    return null;
  }
}

/**
 * PURE: turn a probe result into the advisory this table actually warrants.
 *
 * Three outcomes, and the middle one is the whole point:
 *   - `prescribe` — the predicate matches rows; emit the advisory unchanged.
 *   - `refute`    — the table HAS rows and the predicate matches NONE of them.
 *                   Emitting the prescription here manufactures a false empty,
 *                   so it is replaced by a warning naming the real key.
 *   - `silent`    — nothing useful to say (empty table, or unprobed).
 *
 * Exported for unit tests: this decision is the load-bearing one, and it is worth
 * pinning without a database.
 */
export function classifyTenantPrescription(
  pop: TenantPopulation | null,
  opts: { checkedWorkspaceId: boolean; checkedHarnessSlug: boolean },
): { kind: 'prescribe' | 'silent' } | { kind: 'refute'; column: string; actual: string[] } {
  if (!pop || !pop.hasRows) return { kind: 'prescribe' };
  if (opts.checkedWorkspaceId && pop.workspaceIdHit === false) {
    return { kind: 'refute', column: 'workspace_id', actual: pop.actualWorkspaceIds };
  }
  if (opts.checkedHarnessSlug && pop.harnessSlugHit === false) {
    return { kind: 'refute', column: 'harness_slug', actual: pop.actualHarnessSlugs };
  }
  return { kind: 'prescribe' };
}

/** The advisory emitted when the prescription is REFUTED by the table's own rows. */
export function refutedTenantAdvisory(
  table: string,
  column: string,
  prescribed: string,
  actual: string[],
): string {
  const actualNote = actual.length
    ? `its rows are keyed ${actual.map((v) => `'${v}'`).join(' / ')}${actual.length >= 3 ? ' (sampled)' : ''}`
    : `every row has ${column} NULL`;
  return (
    `⚠ tenant scope: ${table} has rows, but NONE match ${column} = '${prescribed}' — ` +
    `${actualNote}. Do NOT add that predicate: it would return an empty result that reads ` +
    'like "no rows exist" rather than "wrong predicate". Scope by the real key above, or ' +
    'query unscoped. (verify-before-prescribe, EI-19324633485547042.)'
  );
}

/**
 * P-005(b): a one-line advisory when a FILTERED query references a multi-tenant
 * table (live-schema-verified: it has a `workspace_id` / `harness_slug` column)
 * without any tenant predicate — the query still runs; the advisory rides the
 * result. Silent for unfiltered aggregates (no WHERE — usually a deliberate
 * cross-tenant count) and whenever the query already mentions a scope column.
 * Best-effort: any schema-read failure returns null.
 */
/**
 * Half-open [from, to) ranges of every string literal and comment in `sql`.
 *
 * The sibling of stripSqlLiteralsAndComments for callers that must match on the
 * literal's CONTENT (a jsonb key) rather than ignore it: same scanning rules,
 * but it reports WHERE the literals are instead of erasing them.
 */
function sqlLiteralAndCommentRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const len = sql.length;
  let i = 0;
  while (i < len) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = len;
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? len : j + 2;
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // '' — an escaped quote, still inside the literal
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      ranges.push([start, i]);
      continue;
    }
    i++;
  }
  return ranges;
}

interface SilentNullPathTrap {
  /** Bare relation the trap applies to. */
  relation: string;
  /** JSON path prefix that is ALWAYS null on this relation, as it appears in SQL. */
  pathRe: RegExp;
  /** Human form of the path, for the message. */
  path: string;
  /** Why it is always null here. */
  why: string;
  /** What to select instead. */
  useInstead: string;
  /** A nullable-predicate trap warns about NULL rows without claiming every row is NULL. */
  warningKind?: 'always-null-accessor' | 'nullable-predicate';
}

/**
 * Accessors that are VALID SQL, run without error, and evaluate to NULL for
 * EVERY row of a specific relation — so the query returns a well-formed,
 * plausible, WRONG answer with no signal that it is wrong (WI-6674).
 *
 * ⚠ THIS IS THE OPPOSITE FAILURE MODE TO DERIVED_COLUMN_REDIRECTS ABOVE. That
 * registry improves the RECOVERY from a loud 42703. This one exists because
 * there is no error at all: `payload->'_ei'->>'lane'` is a legal jsonb
 * traversal, and a missing key yields NULL rather than raising. A
 * `WHERE payload->'_ei'->>'lane' <> 'observation'` filter over work_items
 * therefore silently classifies every observation as real work — measured
 * 2026-08-02 as `payload ? 'lane'` true for 12,694 rows against
 * `payload->'_ei' ? 'lane'` true for ZERO.
 *
 * ⚠ THE engineer_issues `payload->'_ei'` ENTRY WAS RETIRED (2026-09-02), and
 * the reasoning is kept because a future migration could make it true again.
 * That entry fired because the engineer_issues VIEW exploded `_ei` into real
 * columns and then subtracted the blob (`payload - '_ei'`), so the nested path
 * was NULL for every row. This comment used to argue the view should NOT be
 * repaired — that re-adding the blob would carry seven fields twice and "make
 * the wrong accessor silently CORRECT". Plan silent-wrong-answers-2026-08-01
 * (P-003) overrode that and migration 1096 stopped the subtraction, on the
 * ground that an advisory only reaches a reader who came through dev:pg_query
 * while raw psql and code-embedded SQL stayed unguarded.
 *
 * Measured on the live view after 1096: the two accessors agree on 166,795 of
 * 166,802 rows. The 7 exceptions have a NULL payload entirely, where the
 * `severity` COLUMN reports its COALESCE default of 'minor' and the nested path
 * honestly reports NULL — so there is no row on which the nested path is wrong.
 *
 * The entry was therefore removed rather than reworded: an advisory asserting
 * "NULL for EVERY row" against a view where the path resolves is exactly the
 * confidently-wrong answer this registry exists to prevent, and the note below
 * on the `kind` trap is explicit that a FALSE advisory is worse than none
 * because it teaches readers to stop trusting advisories. Its replacement is
 * not another hardcoded claim but a PIN — see
 * pg-read-query-engineer-issues-ei-pin.integration.test.ts, which reads the
 * LIVE view definition and fails in BOTH directions: a view that subtracts
 * `_ei` with no trap registered, and a trap registered while the view projects
 * the full payload.
 *
 * Deliberately HARDCODED semantics, like the two registries above — update it
 * when a projection moves.
 */
const SILENT_NULL_PATH_TRAPS: SilentNullPathTrap[] = [
  // ⚠ NO engineer_issues `payload->'_ei'` ENTRY — deliberately retired by
  // migration 1096 (2026-09-02); see the block comment above for the measured
  // reason and for the live-view PIN that now guards this in both directions.
  // Do not re-add one without first reading pg_get_viewdef: if the view still
  // projects the full payload, the advisory would be false.
  {
    // `kind` vs `item_kind` on the TABLE. Both columns exist, so there is no
    // error — but `kind` is effectively dead: measured 2026-08-02 on
    // harness_shared.work_items, it is non-null on 3 of 28,255 rows (0.01%)
    // while `item_kind` is non-null on all 28,255. So `WHERE kind='bug'`
    // returns ~nothing and reads exactly like "there are no bugs".
    //
    // Scoped to PREDICATE position on purpose (`kind =`, `kind IN`, `kind IS`)
    // rather than any mention. A projection or alias — `coalesce(item_kind,'?')
    // AS kind`, `GROUP BY kind` — is a legitimate and common shape, and this
    // file's own tenant-scope note is explicit that a false advisory is worse
    // than none because it teaches the reader to stop trusting advisories. The
    // predicate is also the shape that actually bit: it silently returns zero.
    relation: 'work_items',
    pathRe: /\bkind\s*(?:=|<>|!=|~|\bin\b|\bis\b)/i,
    path: 'kind',
    why:
      'the `kind` column on this TABLE is effectively unused — non-null on 3 of 28,255 rows ' +
      '(measured 2026-08-02), while `item_kind` is populated on every row. The classifier you ' +
      'want is item_kind (bug / change / task / feature / chunk)',
    useInstead:
      '`item_kind` for the bug/change/task/feature split. Also note that item_kind alone is not ' +
      "the real-work filter: ~84% of open rows are payload->>'lane' = 'observation' (turn-end " +
      'notes that by design never enter the queue), so a backlog count needs BOTH ' +
      "item_kind AND coalesce(payload->>'lane','') <> 'observation'. Or prefer work_items:list / " +
      'work_items:claimable, whose claimableCount already applies every floor',
  },
  {
    // The lane discriminator lives at the TOP level of payload, never under
    // `_ei`. Measured 2026-08-02 on harness_shared.work_items: `payload ? 'lane'`
    // is true for 12,694 rows, `payload->'_ei' ? 'lane'` for ZERO. A backlog
    // query that reads the _ei form silently classifies every observation as
    // real work — the exact inversion that makes an 11,970-row observation lane
    // look like a bug backlog.
    relation: 'work_items',
    pathRe: /payload\s*->\s*['"]_ei['"]\s*->>?\s*['"]lane['"]/i,
    path: "payload->'_ei'->>'lane'",
    why:
      "`lane` is stored at the TOP level of payload, not inside the _ei blob — payload ? 'lane' " +
      "is true for 12,694 rows and payload->'_ei' ? 'lane' for 0 (measured 2026-08-02), so this " +
      'accessor is NULL for every row and every observation silently counts as real work',
    useInstead:
      "`payload->>'lane'` (the `_ei` blob carries severity/source/found_during, not lane)",
  },
  {
    // `attempts` is nullable on the compatibility view. Issue-family rows
    // project it as NULL and the open population measured 17,288/17,318 NULL
    // (99.8%, 2026-08-03), so `attempts = 0` silently drops "never attempted".
    // This is a nullable-predicate trap, not an always-NULL accessor: explicit
    // IS NULL/IS NOT NULL and COALESCE forms remain valid and stay silent.
    relation: 'work_items',
    pathRe: /\battempts\s*(?:<>|!=|>=|<=|=|>|<|\bin\b|\bbetween\b)/i,
    path: 'attempts',
    warningKind: 'nullable-predicate',
    why:
      'this compatibility VIEW projects `attempts` as NULL for issue-family rows, and the observed open population was 17,288 of 17,318 rows (99.8%) with NULL attempts. SQL comparison predicates treat NULL as UNKNOWN, so `attempts = 0` or `attempts > 0` silently excludes those rows',
    useInstead:
      '`COALESCE(attempts, 0)` when NULL means never attempted; use `attempts IS NULL` / `attempts IS NOT NULL` for explicit nullness, or prefer `work_items:list` / `work_items:claimable`',
  },
];

/**
 * Flag a read whose accessor is always-NULL on the relation it targets.
 *
 * Unlike the tenant-scope advisory this does NOT require a WHERE clause: a bare
 * `SELECT payload->'_ei'->>'severity' … ` projection is just as wrong, and an
 * aggregate (`count(*) FILTER (WHERE …)`) is the shape that actually bit — it
 * reports 0 rather than returning none.
 */
export function buildSilentNullPathAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  // ⚠ Deliberately NOT stripSqlLiteralsAndComments here. The jsonb key IS a
  // string literal (`payload->'_ei'`), so the stripper — correct for the
  // tenant-scope advisory, which only looks for bare column names — erases the
  // very token this trap matches on. Instead match the RAW sql and discard any
  // hit that STARTS inside a literal or comment, which keeps the one
  // false-positive that matters (the path quoted inside a WHERE title = '…')
  // out without blinding the check.
  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideLiteral = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to);

  const parts: string[] = [];
  for (const trap of SILENT_NULL_PATH_TRAPS) {
    const hit = tables.find((t) => bareTableName(t) === trap.relation);
    if (!hit) continue;
    const scan = new RegExp(trap.pathRe.source, 'gi');
    let real = false;
    for (let m = scan.exec(rawSql); m; m = scan.exec(rawSql)) {
      if (!startsInsideLiteral(m.index)) {
        real = true;
        break;
      }
    }
    if (!real) continue;
    if (trap.warningKind === 'nullable-predicate') {
      parts.push(
        `⚠ nullable predicate: ${hit} — this query compares \`${trap.path}\`, but ${trap.why}. ` +
          `Use ${trap.useInstead}.`,
      );
    } else {
      parts.push(
        `⚠ always-NULL accessor: ${hit} — this query reads \`${trap.path}\`, but ${trap.why}. ` +
          `Use ${trap.useInstead}. A predicate on this path matches ZERO rows, which reads exactly ` +
          'like "there are none" (WI-6674).',
      );
    }
  }

  return parts.length ? parts.join(' ') : null;
}

/**
 * Parse the top-level CTE list of a `WITH …` statement.
 *
 * Best-effort and deliberately CONSERVATIVE: anything it cannot parse with
 * certainty (a quoted CTE name, an unbalanced paren, a missing `AS`) returns
 * null so the caller stays silent rather than guessing. Operates on stripped
 * SQL, so a `WITH` inside a string literal or comment cannot start a parse.
 *
 * Returns each CTE's name plus the character range of its own body, which is
 * what lets the caller distinguish a real reference from the definition itself
 * and from a recursive self-reference.
 */
function parseTopLevelCtes(
  stripped: string,
): Array<{ name: string; nameStart: number; bodyStart: number; bodyEnd: number }> | null {
  const head = /^\s*WITH\s+(?:RECURSIVE\s+)?/i.exec(stripped);
  if (!head) return null;

  const len = stripped.length;
  const out: Array<{ name: string; nameStart: number; bodyStart: number; bodyEnd: number }> = [];
  let i = head[0].length;

  // Consume a balanced `(`…`)` starting at i; returns the index just past the
  // closing paren, or -1 when unbalanced.
  const skipBalanced = (from: number): number => {
    let depth = 0;
    for (let k = from; k < len; k++) {
      if (stripped[k] === '(') depth++;
      else if (stripped[k] === ')') {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    return -1;
  };
  const skipWs = (from: number): number => {
    let k = from;
    while (k < len && /\s/.test(stripped[k]!)) k++;
    return k;
  };

  for (;;) {
    i = skipWs(i);
    const nameStart = i;
    const ident = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(stripped.slice(i));
    if (!ident) return null;
    const name = ident[0];
    i = skipWs(i + name.length);

    // Optional column alias list — `WITH t(a, b) AS (…)`.
    if (stripped[i] === '(') {
      const past = skipBalanced(i);
      if (past === -1) return null;
      i = skipWs(past);
    }

    // `AS`, optionally followed by `[NOT] MATERIALIZED`. `\b` (not `\s`) so
    // the legal `AS(SELECT …)` parses.
    const as = /^AS\b\s*/i.exec(stripped.slice(i));
    if (!as) return null;
    i += as[0].length;
    const materialized = /^(?:NOT\s+)?MATERIALIZED\b\s*/i.exec(stripped.slice(i));
    if (materialized) i += materialized[0].length;
    i = skipWs(i);

    if (stripped[i] !== '(') return null;
    const bodyStart = i;
    const bodyEnd = skipBalanced(i);
    if (bodyEnd === -1) return null;
    out.push({ name, nameStart, bodyStart, bodyEnd });

    i = skipWs(bodyEnd);
    if (stripped[i] === ',') {
      i++;
      continue;
    }
    return out;
  }
}

/**
 * Flag a CTE that is DEFINED but never REFERENCED.
 *
 * The failure this catches is silent by construction (EI-20261038811991822): a
 * forensic query defines `WITH targets AS (…29 owner ids…)` and then forgets to
 * join it, so PostgreSQL runs the main statement against the FULL relation.
 * There is no error and no empty result — it returns valid, well-formed,
 * unrelated rows that read exactly like a correctly-scoped answer, and the
 * reader only discovers the scope was lost if they happen to check the ids
 * against the set they meant to ask about. The measured instance was caught
 * that way and discarded; nothing structural would have caught it.
 *
 * It fires unconditionally because the one legitimate reason to leave a CTE
 * unreferenced — a data-modifying CTE (`WITH x AS (INSERT … RETURNING …)`),
 * which executes for its side effect — cannot run on this surface at all: the
 * query executes inside a `SET TRANSACTION READ ONLY` transaction, so PG
 * rejects it (25006) before it could ever be a false positive here.
 *
 * A reference from a LATER CTE counts as a use (`WITH a AS (…), b AS (SELECT *
 * FROM a) SELECT * FROM b` is fully wired); a RECURSIVE self-reference inside
 * the CTE's own body does not, since that alone never makes the result depend
 * on it.
 */
export function buildUnusedCteAdvisory(rawSql: string): string | null {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  const ctes = parseTopLevelCtes(stripped);
  if (!ctes || !ctes.length) return null;

  // One tokenizer pass over the whole statement; a hit is a real reference
  // unless it is the definition's own name, sits inside that CTE's own body,
  // or is qualified (`public.targets` is a TABLE, not this CTE).
  const tokens: Array<{ text: string; index: number }> = [];
  const tokenRe = /[A-Za-z_][A-Za-z0-9_$]*/g;
  for (let m = tokenRe.exec(stripped); m; m = tokenRe.exec(stripped)) {
    tokens.push({ text: m[0], index: m.index });
  }
  const qualified = (index: number): boolean => {
    let k = index - 1;
    while (k >= 0 && /\s/.test(stripped[k]!)) k--;
    return k >= 0 && stripped[k] === '.';
  };

  const unused = ctes
    .filter((cte) => {
      const lowered = cte.name.toLowerCase();
      return !tokens.some(
        (t) =>
          t.text.toLowerCase() === lowered &&
          t.index !== cte.nameStart &&
          !(t.index >= cte.bodyStart && t.index < cte.bodyEnd) &&
          !qualified(t.index),
      );
    })
    .map((cte) => cte.name);

  if (!unused.length) return null;

  const names = unused.map((n) => `\`${n}\``).join(', ');
  const subject = unused.length === 1 ? 'is' : 'are';
  return (
    `⚠ unused CTE: ${names} ${subject} defined but never referenced, so this query is NOT scoped by it — ` +
    'PostgreSQL runs the main statement against the full relation and returns valid, unrelated rows that ' +
    'read exactly like a correctly-scoped result (EI-20261038811991822). Join or filter by the CTE ' +
    '(`JOIN <cte> USING (…)`, `WHERE <col> IN (SELECT … FROM <cte>)`), or drop it if the scope is not ' +
    'wanted. Before treating this result as evidence, check that every returned row belongs to the set ' +
    'you meant to ask about.'
  );
}

/**
 * Flag SQL shapes whose zero-row result cannot establish that the underlying
 * population is empty (EI-22433765987075358).
 *
 * `HAVING` filters GROUP BY output, so `HAVING count(*) = 1` returning no rows
 * means only that no group matched that predicate — groups with two or more
 * rows may still exist. A caller-provided LIMIT below dev:pg_query's `maxRows`
 * similarly makes the query a bounded sample rather than a census; LIMIT 0 is
 * the sharpest version of that trap because it manufactures an empty result.
 *
 * This is a pure, conservative shape check. String literals and comments are
 * stripped before matching, and dynamic/`ALL` limits are left alone because
 * this builder cannot prove their effective bound without executing SQL.
 */
export function buildPopulationNarrowingAdvisory(
  rawSql: string,
  maxRows: number = PG_READ_QUERY_DEFAULT_MAX_ROWS,
): string | null {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  const hasHaving = /\bhaving\b/i.test(stripped);
  const configuredMaxRows = Number.isFinite(maxRows)
    ? Math.max(1, Math.trunc(maxRows))
    : PG_READ_QUERY_DEFAULT_MAX_ROWS;

  let hasNarrowLimit = false;
  const limitRe = /\blimit\s*(?:\(\s*)?(\d+)\b/gi;
  for (let match = limitRe.exec(stripped); match; match = limitRe.exec(stripped)) {
    const limit = Number(match[1]);
    if (Number.isSafeInteger(limit) && limit < configuredMaxRows) {
      hasNarrowLimit = true;
      break;
    }
  }

  if (!hasHaving && !hasNarrowLimit) return null;

  const clauses = [hasHaving ? 'HAVING' : null, hasNarrowLimit ? 'LIMIT' : null].filter(
    (clause): clause is string => clause !== null,
  );
  const clauseLabel = clauses.join('/');
  const details = hasHaving
    ? 'zero rows means no group matched the HAVING predicate, not that the underlying population is empty'
    : 'zero rows from the bounded query do not establish that the underlying population is empty';
  return (
    `⚠ population-narrowing query shape: this SQL uses ${clauseLabel}; ${details}. ` +
    'Re-run without the narrowing clause before making an absence claim, or report the result as a bounded ' +
    'subset rather than a census. (EI-22433765987075358).'
  );
}

/**
 * Flag a negated comparison on `jsonb_typeof(...)`.
 *
 * PostgreSQL's `jsonb_typeof` returns SQL NULL when its input is absent/NULL.
 * Therefore `NOT (jsonb_typeof(payload->'sections') = 'array')` is also NULL,
 * not TRUE, and a WHERE/FILTER silently excludes exactly the rows the caller
 * meant to count. This is a query-shape trap rather than a relation-specific
 * schema fact, so the advisory is deliberately generic and best-effort.
 */
export function buildJsonbTypeofNegationAdvisory(rawSql: string): string | null {
  const masked = rawSql.split('');
  for (const [from, to] of sqlLiteralAndCommentRanges(rawSql)) {
    for (let i = from; i < to; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  }
  const code = masked.join('');
  const skipWhitespace = (from: number): number => {
    let i = from;
    while (i < code.length && /\s/.test(code[i] ?? '')) i++;
    return i;
  };
  const functionName = 'jsonb_typeof';
  const notRe = /\bNOT\b/gi;

  for (let not = notRe.exec(code); not; not = notRe.exec(code)) {
    let cursor = skipWhitespace(not.index + not[0].length);
    while (code[cursor] === '(') cursor = skipWhitespace(cursor + 1);
    if (code.slice(cursor, cursor + functionName.length).toLowerCase() !== functionName) continue;
    cursor += functionName.length;
    if (/[a-z0-9_$]/i.test(code[cursor] ?? '')) continue;
    cursor = skipWhitespace(cursor);
    if (code[cursor] !== '(') continue;

    const open = cursor;
    let depth = 1;
    let close = -1;
    for (cursor = open + 1; cursor < code.length; cursor++) {
      if (code[cursor] === '(') depth++;
      else if (code[cursor] === ')' && --depth === 0) {
        close = cursor;
        break;
      }
    }
    if (close === -1) continue;

    cursor = skipWhitespace(close + 1);
    if (!/^(?:=|<>|!=|<=|>=|<|>)/.test(code.slice(cursor))) continue;
    return (
      '⚠ nullable jsonb_typeof negation: a missing JSONB key makes ' +
      '`jsonb_typeof(...)` NULL, and `NOT (comparison)` stays NULL, so a WHERE/FILTER ' +
      'silently drops the absent-key rows. Use `coalesce(jsonb_typeof(...) = ..., false)` ' +
      'or test key presence with `?` / `NOT (... ? \'key\')`. (EI-19423706381923521.)'
    );
  }

  return null;
}

/**
 * Flag a read that treats `status = 'open'` (or the candidate VIEW) as the
 * answer to "what can be claimed".
 *
 * WHY THIS IS A DIFFERENT TRAP FROM THE TWO ABOVE. The tenant-scope and
 * always-NULL advisories catch a query that is WRONG. This one catches a query
 * that is RIGHT about a different question — which is worse, because the result
 * is well-formed, plausible, and off by an order of magnitude.
 *
 * The distinction is structural, not a naming accident, and it is why no column
 * or view can ever settle it:
 *
 *   - `status = 'open'` is LIFECYCLE. It is item-intrinsic and durable — a fact
 *     about the row, storable as a column. Legitimately needed.
 *   - `harness_shared.work_items_claimable` (migration 654) is the QUERYABLE
 *     SSOT for the CALLER-INDEPENDENT floors — "claimable by someone". It is the
 *     right target for raw SQL, and an anti-drift integration test binds it to
 *     the real claim path so the two cannot silently diverge.
 *   - `work_items:claimable` answers "claimable by ME, NOW" — the triple
 *     (item, CALLER, MOMENT).
 *
 * Migration 654 omits the per-claim floors from the view DELIBERATELY, and says
 * why: cross-machine-rig, swarm-affinity, redundancy and release-cooldown
 * "depend on the CLAIMING caller's capability/spec, not the row, so a generic
 * 'claimable by someone' predicate cannot bake them in". The view is therefore
 * neither a clean upper nor lower bound on what YOU can claim: it OVER-admits by
 * omitting those per-claim floors, and UNDER-admits on the federated-origin leg,
 * which uses the fail-safe form that "only ever UNDER-admits". Say exactly that
 * rather than implying a direction — a confidently-wrong bound is the failure
 * mode this file exists to prevent.
 *
 * Deliberately NOT quoting a fixed overcount multiplier: the ratio moves with
 * the backlog (and differs per harness), and a stale number in an advisory is
 * the same class of confidently-wrong artifact. Point at the queryable SSOT and
 * the tool instead, both of which compute the live figure.
 *
 * Matched against RAW sql for the same reason as the always-NULL advisory: the
 * interesting token is a string literal (`'open'`), which the stripper erases.
 */
export function buildClaimabilityAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');

  // The SSOT VIEW. Reading it is CORRECT for raw SQL — this is a scope note, not
  // a reprimand: it answers "claimable by someone", not "claimable by me now".
  const viewHit = tables.find((t) => bareTableName(t) === 'work_items_claimable');
  if (viewHit) {
    return (
      `ⓘ caller-independent scope: ${viewHit} is the queryable SSOT for the floors that depend only on ` +
      'the ROW — the right target for raw SQL. It deliberately omits the PER-CLAIM floors ' +
      '(cross-machine-rig, swarm-affinity, redundancy, release-cooldown) because those depend on the ' +
      'claiming caller, so it answers "claimable by someone", not "claimable by ME now". It is neither a ' +
      'clean upper nor lower bound on your own claimable set: it over-admits by omitting those floors, and ' +
      'under-admits on the federated-origin leg (fail-safe form). For "what can I claim right now" plus a ' +
      'per-floor `excludedBreakdown`, use work_items:claimable { harness }.'
    );
  }

  // The TABLE + a status='open' predicate: the shape that reads as "the backlog".
  const tableHit = tables.find((t) => bareTableName(t) === 'work_items');
  if (!tableHit) return null;

  // `status = 'open'`, `status IN ('open', …)`, `status = ANY(ARRAY['open', …])`.
  const openPredicate = /\bstatus\b\s*(?:=|\bin\b|=\s*any)\s*\(?\s*(?:array\s*\[\s*)?'open'/gi;
  let hasOpenPredicate = false;
  for (let m = openPredicate.exec(rawSql); m; m = openPredicate.exec(rawSql)) {
    if (!startsInsideComment(m.index)) {
      hasOpenPredicate = true;
      break;
    }
  }
  if (!hasOpenPredicate) return null;

  // Already going through the real floor function (or the claimable tool's own
  // SQL)? Then the caller knows the difference — say nothing.
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (/\bwork_item_claim_floors\b/i.test(stripped)) return null;

  return (
    `⚠ status='open' is LIFECYCLE, not claimability: ${tableHit} — 'open' means "not terminal", and the ` +
    'real claim path ANDs ~12 further floors on top. Counting open rows therefore OVERCOUNTS claimable ' +
    'work, silently and by a wide margin. Two correct targets, depending on the question: for RAW SQL use ' +
    'harness_shared.work_items_claimable (migration 654 — the queryable SSOT, bound to the real claim path ' +
    'by an anti-drift test); for "what can I claim RIGHT NOW" use work_items:claimable { harness }, which ' +
    'adds the floors that depend on the CALLER and the MOMENT (cross-machine-rig, swarm-affinity, ' +
    'redundancy, release-cooldown, your claim SPEC) and returns a per-floor `excludedBreakdown`. Those ' +
    'caller-relative floors are why claimability cannot be a column at all.'
  );
}

/**
 * BACKLOG FLOW measured over `work_items` — three ways to get a confidently WRONG number, all of which
 * return well-formed rows that look like an answer.
 *
 * Measured 2026-08-17/18, in one investigation, by one agent, reporting to the owner. Each error was
 * independently plausible and together they inverted the SIGN of the reported trend — "the queue grew by
 * 772" was actually "the queue shrank by 1175":
 *
 *   1. NO `lane` PREDICATE. `work_items` holds more than the bug backlog: agents' own end-of-turn
 *      observations live in the same table under `lane='observation'`. An unfiltered aggregate counts
 *      them as filed work. Measured: 1001 "filings" was really 518, with 500 in the observation lane.
 *
 *   2. `authority IN ('committed','validated')` USED AS A FLOW FILTER. `authority` grades how well a
 *      close was JUSTIFIED. Filtering closes by it while counting filings unfiltered compares two
 *      different populations, so a healthy queue reads as a growing one. Fix throughput and backlog flow
 *      are different questions; only one of them has an evidence filter.
 *
 *   3. A HAND-ROLLED `created_ts`/`closed_ts` WINDOW. `work_items:burn_down` already computes this, and
 *      already gets right three things a hand-written GROUP BY does not: it attributes from an
 *      append-only ledger so members that have since died still count, it declares that its buckets sum
 *      to the delta so one bucket cannot be misread as a sample, and it stamps `truncatedByLimit` on the
 *      AGGREGATE so a capped census is never quoted as a total.
 *
 * These compose deliberately: an agent measuring "is the backlog growing" typically writes all three at
 * once, so the advisory reports every part that applies rather than only the first.
 */
export function buildBacklogFlowAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'work_items')) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);
  // The tool's own SQL and the burn-down path already handle all of this.
  if (/\bwork_item_claim_floors\b/i.test(stripped)) return null;

  const isAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(stripped) || /\bgroup\s+by\b/i.test(stripped);
  const parts: string[] = [];

  // (1) An aggregate with no lane predicate silently spans the observation lane.
  // EI-21412161573952069: the lane key usually appears as a JSON LITERAL —
  // `COALESCE(payload->>'lane','') <> 'observation'` — and stripSqlLiteralsAndComments
  // ERASES string literals, so probing only the stripped text made every
  // payload-lane filter read as absent (a false "no lane predicate" on a query
  // that filtered the lane). Probe the RAW text as well: a literal mention is
  // precisely the predicate this check hunts. The accepted trade-off: a mention
  // inside a COMMENT can also suppress the advisory — an acceptable heuristic
  // cost, since the alternative was flagging correctly-filtered queries.
  const hasLanePredicate = /\blane\b/i.test(stripped) || /\blane\b/i.test(rawSql);
  // Resource-governor receipts are stored in this compatibility relation, but
  // they are not filed work and therefore cannot carry the observation lane.
  // A positive marker predicate is an exact subpopulation filter; treating it
  // like a general work_items aggregate would make the lane advice change the
  // question being asked. Keep the detector narrow: require the marker in a
  // WHERE/HAVING predicate, ignore matches inside SQL noise, and do not treat
  // the receipt-exclusion form (`NOT jsonb_exists(...)`) as an exact receipt
  // census.
  const sqlNoise = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideSqlNoise = (idx: number): boolean =>
    sqlNoise.some(([from, to]) => idx >= from && idx < to);
  const hasExactResourceGovernorPopulation = (() => {
    const markerPatterns = [
      /\bjsonb_exists\s*\(\s*(?:coalesce\s*\(\s*)?(?:[A-Za-z_][A-Za-z0-9_$]*\.)?payload\s*(?:,\s*'\{\}'\s*::\s*jsonb\s*)?\)?\s*,\s*'resource_governor'\s*\)/gi,
      /\b(?:[A-Za-z_][A-Za-z0-9_$]*\.)?payload\s*\?\s*'resource_governor'/gi,
    ];
    return markerPatterns.some((pattern) => {
      for (let match = pattern.exec(rawSql); match; match = pattern.exec(rawSql)) {
        if (startsInsideSqlNoise(match.index)) continue;
        const before = stripSqlLiteralsAndComments(rawSql.slice(0, match.index));
        if (!/\b(?:where|having)\b/i.test(before)) continue;
        if (/\bnot\s*(?:\(\s*)?$/i.test(before)) continue;
        return true;
      }
      return false;
    });
  })();
  if (isAggregate && !hasLanePredicate && !hasExactResourceGovernorPopulation) {
    parts.push(
      "no `lane` predicate: harness_shared.work_items also holds agents' own end-of-turn notes under " +
        "lane='observation'. An unfiltered aggregate counts those as filed work — measured 2026-08-17, " +
        'this turned 518 real filings into 1001. Add a lane predicate, or use work_items:list ' +
        '{ includeObservations: false } / work_items:burn_down, which scope it for you.',
    );
  }

  // (2) An evidence-quality column used as if it selected "closed".
  if (/\bauthority\b\s*(?:=|\bin\b|=\s*any)/i.test(stripped)) {
    parts.push(
      '`authority` grades how well a close was JUSTIFIED, not whether the item left the queue. Filtering ' +
        'closes by it while counting filings unfiltered compares two different populations and can invert ' +
        'the sign of a backlog trend. Use it to measure EVIDENCE QUALITY; for flow, count terminal rows ' +
        'without an authority filter.',
    );
  }

  // (3) A hand-rolled window that burn_down already computes correctly.
  if (/\b(created_ts|closed_ts)\b/i.test(stripped) && isAggregate) {
    parts.push(
      'a hand-rolled created_ts/closed_ts window: work_items:burn_down already computes this AND reports ' +
        'what a hand-written GROUP BY cannot — it attributes from an append-only ledger (so members that ' +
        'have since died still count), declares that its buckets sum to the delta (so a bucket cannot be ' +
        'read as a sample), and stamps `truncatedByLimit` on the AGGREGATE (so a capped census is never ' +
        'quoted as a total).',
    );
  }

  if (parts.length === 0) return null;
  return (
    `⚠ BACKLOG FLOW over work_items — ${parts.length} way(s) this query answers a different question than ` +
    `it appears to: ${parts.map((p, i) => `(${i + 1}) ${p}`).join(' ')}`
  );
}

/**
 * The relation → covering-tool map behind {@link buildToolRoutingAdvisory}
 * (plan `sql-escape-tool-routing-2026-08-12`, P-001).
 *
 * ⚠ WHY THIS EXISTS WHEN `seeAlso` ALREADY DOES. `dev:pg_query` declares a
 * static `seeAlso` list (shipped budget-free by
 * `claimable-read-tool-and-sql-encapsulation-audit-2026-07-21` P-004). That was
 * the right call for prompt weight, but it is emitted IDENTICALLY on every call
 * regardless of the query — so an agent reading `harness_shared.routines` is
 * told about `work_items:claimable`. Measured 2026-08-12 over 14 days
 * (`harness_shared.tool_invocations`, workspace `papercusp-workspace`): 15,854
 * calls from 381 distinct agents, 98.6% SUCCEEDING. This is not a failure
 * signal — agents route around the catalog successfully, which is exactly why
 * it went unnoticed. ~286 of those agents were hand-querying relations that
 * already had a good covering tool.
 *
 * So the nudge channel already fires ~15.9k times; it was simply never aimed.
 * This registry aims it.
 *
 * ⚠ EVERY VERB HERE WAS VERIFIED AGAINST THE LIVE TOOL REGISTRY, not recalled.
 * Routing an agent to a phantom verb is strictly worse than the raw SQL it
 * replaces: the SQL works, and the phantom costs a round trip and teaches a
 * name that does not exist. When adding a row, confirm the verb resolves
 * (`agent_tools:list` / the `defineTool` name — note some are declared with
 * DOUBLE quotes, so a single-quote grep under-reports and reads as absence).
 *
 * ⚠ `gives` states what the TOOL adds over the raw read — the reason to switch.
 * A row that cannot say that does not belong here: "there is also a tool" is
 * noise on a hot path, and an advisory nobody acts on trains agents to skim
 * past the ones that matter.
 */
interface ToolRoute {
  /** The verb(s) that answer this relation's hot read. */
  tool: string;
  /** What the tool adds over reading the table directly. */
  gives: string;
}

export const TOOL_ROUTING_BY_TABLE: Record<string, ToolRoute> = {
  work_items: {
    tool: 'work_items:list / work_items:get',
    gives: 'server-side filters, batch id fetch, and the payload/threads projection',
  },
  harness_plans: {
    tool: 'plans:list / plans:get / plans:items',
    gives: 'recency filters, groupBy/aggregateOnly counts, and section-scoped reads',
  },
  routines: {
    tool: 'routines:list',
    // `health.gate_health` is named EXPLICITLY because the gate-health read is the
    // largest single cluster in the SQL corpus (EI-20285616516435031). This string
    // is what an agent sees at the instant they submit that query, and a `gives`
    // listing only cadence/pause/rollup reads as "a different question" to someone
    // mid-`metadata->'gate_health'` SELECT — so the one nudge aimed at the biggest
    // cluster was silent about the very field it needed to name.
    gives:
      'cadence + active state + the deliberate-pause record { reason, by, at }, `health.gate_health` for the green-checkpoint gate (consecutive reds, observed candidate, in-flight re-triage), and rollup:true for the per-group view',
  },
  coord_presence: {
    tool: 'coord:presence / fleet:assignments',
    gives: "the derived sessionState verdict — the raw heartbeat columns here are NOT liveness (a warm-dead session reads heartbeatFresh:true, sessionState:'ended')",
  },
  agent_presence: {
    tool: 'coord:presence',
    gives: 'the one shared liveness oracle every surface derives from',
  },
  coord_event_log: {
    tool: 'coord:feed / coord:catch-up',
    gives: 'audience-scoped history with membership gating, instead of raw envelope rows',
  },
  coord_messages: {
    tool: 'coord:feed / coord:catch-up',
    gives: 'audience-scoped history with membership gating',
  },
  coord_thread_posts: {
    tool: 'work_items:get',
    gives: 'the item-scoped comments for a recognizable issue/work-item thread, with the work-item projection and checkpoint',
  },
  tool_invocations: {
    tool: 'activity:tool-log / dev:telemetry / dev:tool_cooccurrence',
    gives: 'per-tool rollups (count, error rate, p50/p95) and the compact per-session call log',
  },
  adv_sessions: {
    tool: 'sessions:search / sessions:timeline',
    gives: 'hybrid semantic search over transcripts, tolerant of a paraphrase',
  },
  session_turns: {
    tool: 'sessions:search / sessions:timeline',
    gives: 'hybrid semantic search with surrounding context',
  },
  session_briefs: {
    tool: 'sessions:search',
    gives: 'meaning-based retrieval instead of a substring scan',
  },
  agent_facts: {
    tool: 'facts:list',
    gives: 'scope resolution + TTL/retraction handling, so a stale fact is not read as standing',
  },
  // Three verbs, because this relation's traffic is three different questions
  // and D-006 rules that a row must name the verb that can ASK the one in front
  // of it. `issues:list` has NO id filter, so pointing a by-id forensic read
  // there would answer a question nobody asked.
  engineer_issues: {
    tool: 'issues:list / work_items:get / improvements:digest',
    gives:
      'typed filters + unbounded counts (issues:list), one item with its checkpoint (work_items:get — issues:list has no id filter), or scored+deduped triage (improvements:digest)',
  },
  schema_migrations: {
    tool: 'db:migrations',
    gives:
      'a VERDICT when nothing matches — pending / draft-not-armed / no-such-migration — which an empty SQL result cannot tell apart',
  },
  test_runs: {
    tool: 'testing:runs',
    gives:
      "a TYPED status enum: the column is CHECK-constrained to pass|fail|skip|cancelled|error|running, so a hand-written status='failed' matches nothing and reads as a clean \"no failures\"",
  },
  task_ledger: {
    tool: 'processes:list',
    gives: 'provenance — who launched it, for which work-item, and what it costs',
  },
  memory_canonical: {
    tool: 'memory:search',
    gives: 'embedding recall rather than a literal match over stored text',
  },
  goals: {
    tool: 'goals:list / goals:get',
    gives: 'the goal record with its rationale, kill-criteria and attached pots',
  },
  harness_registry: {
    tool: 'harness:status',
    gives: 'live status for one or many harnesses in one call',
  },
  pipeline_events: {
    tool: 'dev:pipeline_position / release:trace',
    gives: "blockedOn + nextAction + per-stage health — a boolean per stage cannot say whether that stage is MOVING",
  },
};

/** A query that reads exactly one relation and does nothing analytic with it. */
export interface PlainSingleRelationRead {
  /** The bare relation name — `harness_shared.work_items` → `work_items`. */
  relation: string;
  /** The relation exactly as the query wrote it, schema qualifier and all. */
  asWritten: string;
}

/**
 * THE answer to "what single relation does this query plainly read" — and
 * deliberately the ONLY one in the tree.
 *
 * Two consumers need this judgement and they must not disagree: the in-tool
 * routing advisory below (P-001), and the SQL corpus atomizer that decides which
 * substitution pair claims a sampled query
 * (`bash-substitution/sql-corpus.ts`, P-007). A second implementation would be a
 * second answer to "what does this query read", so the advisory an agent sees at
 * the point of the query and the audit that decides whether that advisory is
 * EARNED could drift — which is the D-001 failure ("a routing advisory must never
 * out-run the tool's actual coverage") re-created one layer down.
 *
 * ⚠ DELIBERATELY CONSERVATIVE, and the conservatism is the point. `dev:pg_query`
 * exists for genuinely ad-hoc analysis, and that traffic is CORRECT — a
 * cross-table join or a group-by is the tool working as intended. The shape this
 * recognises is the one the audit actually found: a plain
 * `SELECT … FROM <one table> WHERE …`, which is what an agent writes when it does
 * not know the verb exists.
 *
 * Returns null for anything else, including a query whose relations the regex
 * extractor could not resolve. Silence on an unparseable query is the correct
 * failure direction for both consumers: the advisory says nothing, and the
 * corpus atom goes unclaimed rather than being attributed to a pair that never
 * covered it.
 */
export function plainSingleRelationRead(rawSql: string): PlainSingleRelationRead | null {
  const tables = extractReferencedTables(rawSql);
  if (tables.length !== 1) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);

  // Analytic shapes are `dev:pg_query`'s legitimate job — no verb covers them.
  if (/\bgroup\s+by\b/i.test(stripped)) return null;
  if (/\bover\s*\(/i.test(stripped)) return null;
  if (/\b(?:count|sum|avg|min|max|percentile_cont|array_agg|jsonb_agg|string_agg)\s*\(/i.test(stripped)) return null;
  if (/\bexplain\b/i.test(stripped)) return null;
  // A join against a second relation the extractor folded away (a lateral, a
  // set-returning function) is still analysis, not a plain read.
  if (/\bjoin\b|\blateral\b|\bunion\b|\bintersect\b|\bexcept\b/i.test(stripped)) return null;

  return { relation: bareTableName(tables[0]), asWritten: tables[0] };
}

/**
 * A coord-thread post is addressable through `work_items:get` only when the
 * query identifies the stable thread id that work-item/issue writers mint.
 * Numeric post ids, federated post ids, generic `thr-*` conversations, and
 * broad thread scans have no one work-item that this tool can resolve, so they
 * must stay silent rather than receive an unrelated catch-up recommendation.
 *
 * Match the literal predicate on the raw SQL because the shared SQL stripper
 * intentionally erases literal contents. Ignore masked ranges so a comment or
 * string containing an example predicate cannot trigger the route.
 */
function hasRecognizableWorkItemThreadPredicate(rawSql: string): boolean {
  const masked = sqlLiteralAndCommentRanges(rawSql);
  const isMasked = (index: number): boolean =>
    masked.some(([from, to]) => index >= from && index < to);
  const re = /\bthread_id\b\s*=\s*'((?:''|[^'])*)'/gi;
  for (let match = re.exec(rawSql); match; match = re.exec(rawSql)) {
    if (isMasked(match.index)) continue;
    const threadId = match[1]!.replaceAll("''", "'");
    if (/^(?:issue-thread|work-item-thread)-[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(threadId)) {
      return true;
    }
  }
  return false;
}

/**
 * "A tool already answers this read" — the aimed replacement for the static
 * `seeAlso` footer (P-001).
 *
 * ⚠ DELIBERATELY CONSERVATIVE: fires ONLY on a single-relation, non-analytic
 * read — see {@link plainSingleRelationRead}, which is where that judgement
 * lives and which the P-007 SQL corpus atomizer shares, so the advisory and the
 * audit that earns it cannot drift apart.
 *
 * Returns null (stays silent) when the caller is already going through a
 * dedicated advisory for that relation, so the specific warning is never
 * crowded by the generic one.
 */
export function buildToolRoutingAdvisory(rawSql: string): string | null {
  const read = plainSingleRelationRead(rawSql);
  if (!read) return null;

  const bare = read.relation;
  const route = TOOL_ROUTING_BY_TABLE[bare];
  if (!route) return null;

  // coord_thread_posts contains many valid reads that are not work-item
  // comments (numeric post-id scans, federated posts, and generic conversations).
  // Only the stable issue/work-item thread-id shape has a faithful
  // work_items:get replacement; arbitrary post scans are dev:pg_query's job.
  if (bare === 'coord_thread_posts' && !hasRecognizableWorkItemThreadPredicate(rawSql)) {
    return null;
  }

  // Let the dedicated claimability advisory own the work_items claim shape —
  // it says something strictly more specific than "there is a list tool".
  if (bare === 'work_items' && buildClaimabilityAdvisory(rawSql)) return null;

  return `ⓘ a tool covers this read: ${route.tool} — ${route.gives}. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.`;
}

/** Native client tools — the ones an agent here actually edits code with. None is ever an MCP
 *  tool, so none can appear in `tool_invocations` (EI-20103748074297088). */
const NATIVE_CLIENT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash', 'Glob', 'Grep'];

/**
 * Every `workspace_id = '<literal>'` style predicate in a query, as its literal values.
 *
 * Matched against RAW sql for the same reason as the claimability advisory: the interesting
 * token IS the string literal, which the stripper erases. Only equality-shaped operators are
 * collected — a `workspace_id <> 'default'` is a deliberate exclusion, not the habit this
 * catches.
 */
function workspaceIdPredicateValues(rawSql: string): string[] {
  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');
  const re = /\bworkspace_id\b\s*(?:=|\bin\b|=\s*any)\s*\(?\s*(?:array\s*\[\s*)?'([^']*)'/gi;
  const out: string[] = [];
  for (let m = re.exec(rawSql); m; m = re.exec(rawSql)) {
    if (!startsInsideComment(m.index)) out.push(m[1]);
  }
  return out;
}

/**
 * A TENANT predicate written against a CORPUS-namespaced table — the false zero that reads as
 * a real answer (EI-20103748074297088), or against session_turns — the plausible PARTIAL result
 * that is even easier to trust (EI-21477025296868436).
 *
 * {@link CORPUS_NAMESPACED_TABLES} already SUPPRESSES the generic "add workspace_id" suggestion
 * for these tables. That is only half the problem, and it is the half that was already solved:
 * suppressing a wrong SUGGESTION does nothing for a caller who writes the predicate from HABIT,
 * which is what actually happened here. Every other papercusp table an agent touches is
 * tenant-scoped and this very tool advises adding the predicate — correctly — all session long.
 * Applying that habit to session_turn_parts returned 0 rows out of 603,723.
 *
 * So this fires on the PRESENCE of the predicate, not its absence. That inversion is the same
 * one {@link buildTestRunsAdvisory} makes and for the same reason: for these tables the column's
 * presence is the trap, not the fix, so an advisory that clears when it appears would go quiet
 * at precisely the moment it is needed.
 *
 * ⚠ Silent when the value IS 'default' (the caller knows the namespace) and when there is no
 * predicate at all (the correct unscoped read — the suppression path already covers it). The
 * point is to be loud about the wrong answer, never about the right one.
 */
export function buildCorpusNamespaceAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  const corpusHits = tables.filter((t) => CORPUS_NAMESPACED_TABLES.has(bareTableName(t)));
  if (!corpusHits.length) return null;

  const values = workspaceIdPredicateValues(rawSql);
  if (!values.length) return null; // unscoped: correct for these tables

  const sessionTurnsOnly =
    corpusHits.some((t) => bareTableName(t) === 'session_turns') &&
    corpusHits.every((t) => bareTableName(t) === 'session_turns');
  if (sessionTurnsOnly) {
    const tenantValues = [...new Set(values.filter((v) => v !== 'default'))];
    // `default` alone is an intentional host-global slice. A tenant plus
    // `default` is the production reader's full accessible-corpus predicate.
    if (!tenantValues.length || values.includes('default')) return null;
    const tenant = tenantValues[0]!;
    const wrong = tenantValues.slice(0, 2).map((v) => "'" + v + "'").join(', ');
    return (
      '⚠ mixed global/tenant transcript scope: session_turns is NOT a corpus constant. ' +
      "File-backed claude/omp/codex transcripts use workspace_id = 'default' (the host-global " +
      'corpus sentinel), while agent_chat transcripts retain their real workspace id because ' +
      'that source has no owner stamp and must remain tenant-isolated. Filtering only by ' +
      wrong + ' returns a valid but catastrophically incomplete agent_chat-only slice — a ' +
      'plausible non-empty result, not zero. To read the full transcript corpus visible to this ' +
      `workspace, use (workspace_id = '${tenant}' OR workspace_id = 'default'), then narrow with ` +
      '`source_kind`, `owner`, `harness_slug`, or `session_id` for the question you are asking.'
    );
  }

  if (values.includes('default')) return null; // caller already knows the namespace

  const named = [...new Set(corpusHits)].slice(0, 3).join(', ');
  const wrong = [...new Set(values)].slice(0, 2).map((v) => "'" + v + "'").join(', ');
  return (
    '⚠ corpus namespace, not a tenant: ' + named + ' stores every row under the literal ' +
    "workspace_id = 'default' (the session-transcript CORPUS namespace — see " +
    'search/session-ingest.ts, which hardcodes it deliberately). This query filters it by ' +
    wrong + ', which matches ZERO rows out of a fully-populated table and returns a clean, ' +
    'confidence-inspiring empty result. This is the habit-driven form of the trap, so the ' +
    'warning fires BECAUSE the predicate is present: drop it, or write ' +
    "workspace_id = 'default'. To scope to a tenant here, filter on `owner` (the coord " +
    'ownerId) instead — that is the column that actually identifies an agent.'
  );
}

/**
 * `session_turn_parts.text` is faithful-render transcript text, not a JSON
 * argument column. A direct cast is therefore unsafe: tool_use/tool_result
 * and thinking parts can contain ordinary or truncated text and PostgreSQL
 * raises 22P02 before the query can return any rows.
 *
 * Keep this advisory at the SQL boundary so the failed query itself carries
 * the durable fix. The recommended CASE expression is safe for a mixed
 * corpus, while an already guarded CASE should not be nagged again.
 */
export function buildSessionTurnPartsJsonAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'session_turn_parts')) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);
  const textRef = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?text`;
  const directCast = new RegExp(`\\b${textRef}\\s*::\\s*jsonb?\\b`, 'i');
  const castExpression = new RegExp(`\\bcast\\s*\\(\\s*${textRef}\\s+as\\s+jsonb?\\s*\\)`, 'i');
  if (!directCast.test(stripped) && !castExpression.test(stripped)) return null;

  // Suppress the advisory for the guarded form we recommend. This is narrow
  // on purpose: an arbitrary `WHERE text IS JSON` predicate is not treated as
  // proof that every projected cast is protected.
  const guardedCase = new RegExp(
    `\\bcase\\b[\\s\\S]*?\\bwhen\\s+${textRef}\\s+is\\s+json(?:\\s+(?:value|scalar|array|object))?\\b[\\s\\S]*?\\bthen\\s+(?:${textRef}\\s*::\\s*jsonb?\\b|cast\\s*\\(\\s*${textRef}\\s+as\\s+jsonb?\\s*\\))`,
    'i',
  );
  if (guardedCase.test(stripped)) return null;

  return (
    '⚠ unsafe session_turn_parts JSON decode: `text` is heterogeneous faithful-render text ' +
    'across text/tool_use/tool_result/thinking parts, so a direct `text::json/jsonb` or ' +
    'CAST(text AS json/jsonb) can raise PostgreSQL 22P02 on a non-JSON or truncated row. ' +
    'Decode defensively with `CASE WHEN text IS JSON THEN text::jsonb END` (or inspect raw ' +
    'text), and remember this transcript corpus uses workspace_id = \'default\'; it has no ' +
    'separate JSON argument column.'
  );
}

/**
 * Completion evidence read from ONE of its surfaces — a confident false "no evidence"
 * (EI-20203674337042683, WI-38056, plan luna-audit-fixes-2026-08-12 D-001).
 *
 * A terminal work-item's evidence is written to a DIFFERENT column depending on how it
 * was closed, and no route writes both. Measured 2026-08-12 over one fleet's 165 closes:
 *
 *   closed `done`    → payload->'_completionEvidence'   160/160, terminal_completion_ref 1/160
 *   closed `dropped` → terminal_completion_ref            2/5,   payload evidence         3/5
 *   rows with NEITHER surface populated ......................................... 0
 *
 * So coverage is total, but any query that selects ONE surface reports the other route's
 * closes as evidence-free — a well-formed empty that reads as a finding. This is not
 * hypothetical: it is how the WI-38045 fleet audit came to report "2 closes with no
 * evidence", grade an agent's work down for it, and file a defect that did not exist.
 * EI-13845 and WI-37360 are the same trap found twice before.
 *
 * `terminal_reason` is called out separately because it is the column an auditor reaches
 * for FIRST and it does not hold a reason: it preserves the legacy terminal VOCABULARY
 * token ('resolved' / 'closed' — see work-items.ts, the resolved→done / closed→dropped
 * nuance). Reading it as prose yields NULL for exactly the rows whose story is richest.
 */
export function buildSplitCompletionEvidenceAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => ['work_items', 'engineer_issues'].includes(bareTableName(t)))) return null;

  // The two surfaces are probed differently ON PURPOSE. `terminal_completion_ref`
  // and `terminal_reason` are IDENTIFIERS, so they are matched against the
  // literal-and-comment-stripped body. `_completionEvidence` is a jsonb KEY and is
  // therefore only ever written inside a quoted literal — stripping literals
  // deletes exactly the thing being looked for, which silently inverted this
  // advisory (it stayed quiet on the single-surface read it exists for, and fired
  // on the two-surface read it must not).
  const body = stripSqlLiteralsAndComments(rawSql);
  const readsPayloadEvidence = /_completionEvidence/i.test(rawSql);
  const readsTerminalRef = /\bterminal_completion_ref\b/i.test(body);
  const readsTerminalReason = /\bterminal_reason\b/i.test(body);
  if (!readsPayloadEvidence && !readsTerminalRef && !readsTerminalReason) return null;
  // Both evidence surfaces already read: the query cannot under-report, and a
  // terminal_reason mention alongside them is a deliberate vocabulary read.
  if (readsPayloadEvidence && readsTerminalRef) return null;

  const missing = readsPayloadEvidence ? 'terminal_completion_ref' : "payload->'_completionEvidence'";
  const present = readsPayloadEvidence ? "payload->'_completionEvidence'" : 'terminal_completion_ref';
  const reasonNote = readsTerminalReason
    ? ' Also: `terminal_reason` is NOT a free-text reason — it stores the legacy terminal ' +
      "vocabulary token ('resolved'/'closed'), so it is NULL for precisely the closes you are " +
      'probably hunting.'
    : '';
  return (
    '⚠ split completion-evidence surface: this reads ' + present + ' but not ' + missing +
    '. Completion evidence lands on a DIFFERENT column depending on the close route — `done` ' +
    "closes write payload->'_completionEvidence' (measured 160/160) while `dropped` closes " +
    'write terminal_completion_ref — and no route writes both. A single-surface read therefore ' +
    'reports the other route\'s closes as evidence-free, which looks like a finding rather than ' +
    'a gap in the query (rows with neither surface populated: 0 of 165). Read BOTH, or use ' +
    'work_items:get, which already returns them together.' + reasonNote
  );
}

/**
 * `tool_invocations` asked about a NATIVE client tool — a guaranteed zero (EI-20103748074297088).
 *
 * `harness_shared.tool_invocations` is an MCP-tool ledger; native Edit / Write / Bash never pass
 * through MCP, so they never produce a row. Measured 2026-08-10 over 24h: capability:bash 1997,
 * capability:read 73, capability:edit 17 — and ZERO rows for any native name. A query counting
 * code edits there therefore under-reports by exactly the amount of work done with native tools,
 * which for coding agents here is most of it, and returns a well-formed zero while doing it.
 *
 * Paired with {@link buildCorpusNamespaceAdvisory} on purpose. These two traps COMPOSE: an agent
 * that hits this one, correctly reasons "I need the transcript store instead", and lands on
 * session_turn_parts gets a SECOND zero from the tenant-predicate habit — and two sources
 * agreeing feels like corroboration when it is the same mistake twice. So this advisory does not
 * just warn; it hands over the query that works, tenant predicate already correct.
 */
export function buildNativeToolAttributionAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  const masked = sqlLiteralAndCommentRanges(rawSql);
  const startsInsideComment = (idx: number): boolean =>
    masked.some(([from, to]) => idx >= from && idx < to && rawSql.slice(from, from + 2) === '--');
  if (!/\btool_name\b/i.test(stripSqlLiteralsAndComments(rawSql))) return null;

  const hits = new Set<string>();
  for (const name of NATIVE_CLIENT_TOOLS) {
    const re = new RegExp("'" + name + "'", 'g');
    for (let m = re.exec(rawSql); m; m = re.exec(rawSql)) {
      if (!startsInsideComment(m.index)) hits.add(name);
    }
  }
  if (!hits.size) return null;

  return (
    '⚠ harness_shared.tool_invocations records MCP tools ONLY — ' + [...hits].slice(0, 4).join('/') +
    ' are NATIVE client tools and never appear in it, so this returns a well-formed zero rather ' +
    'than a real count (measured 24h: capability:bash 1997, capability:edit 17, native Edit 0). ' +
    'The store that DOES see native tools is harness_shared.session_turn_parts — and it is ' +
    "corpus-namespaced, so it needs workspace_id = 'default', NOT your tenant id. Its `text` " +
    'column is the faithful-render payload; there are no `input`, `content`, or JSON payload ' +
    'columns. For an exact bounded read, use: ' +
    "SELECT owner, ts, tool_name, text FROM harness_shared.session_turn_parts " +
    "WHERE workspace_id = 'default' AND tool_name IN ('Edit','Write','MultiEdit') " +
    "AND ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 50. " +
    '`owner` is the coord ownerId, so it joins straight to an agent.'
  );
}

/**
 * Columns that scope a `tool_invocations` read down to ONE named agent.
 *
 * `coord_owner_id` is the coordination identity; `spawn_id` is the launch identity of a single
 * session. Deliberately NOT `parent_spawn_id` (a lineage question, not "is this agent working")
 * and NOT `role` (a whole population).
 */
const SINGLE_AGENT_SCOPE_COLUMNS = ['coord_owner_id', 'spawn_id'];

/**
 * `tool_invocations` scoped to ONE agent — a coverage gap read as inactivity (EI-21847759967934033).
 *
 * The SIBLING of {@link buildNativeToolAttributionAdvisory}, and it exists because that one is
 * silent here. That advisory fires when a query ASKS FOR a native tool by name, catching the
 * caller who already suspects native tools exist. This one fires on the query that never mentions
 * them: `SELECT tool_name, count(*) FROM tool_invocations WHERE coord_owner_id = '<peer>' AND
 * invoked_at > … GROUP BY 1` — the "is this agent working?" read. Its answer is a truthful list of
 * MCP calls, and it is read as the agent's WHOLE activity.
 *
 * Why this asymmetry is expensive rather than merely incomplete: the error is DIRECTIONAL. Missing
 * rows can only ever make an agent look LESS active, so a sparse window reads as "idle" — and
 * "idle" is the reading that triggers action against a peer (a pointed wake, a deadline, a
 * reassignment). The opposite mistake is impossible, so no amount of care in reading the number
 * protects you; only knowing what the instrument does not record does.
 *
 * MEASURED, not hypothetical. EI-21847759967934033: su-2a1ddad8's ledger window showed only
 * `coord:glance` x22 and `activity:report` x31, so it was told to stop spinning and warned its work
 * might be reassigned; `session_turn_parts` for the same owner carries 17 `Bash` calls — its single
 * most-used tool, and invisible here. Fleet-wide over ingested transcript parts (24h, 2026-08-30):
 * native 54,009 calls across 183 agents vs MCP 35,479 across 128, so roughly 60% of recorded tool
 * use leaves no row in this table. This box's bypass-permissions preamble actively steers agents to
 * native Bash for reads, which is why the blind spot covers the COMMON case rather than an edge.
 *
 * Deliberately requires a scoping PREDICATE, not a mention. A fleet-wide rollup that merely
 * projects or GROUP BYs `coord_owner_id` is asking which MCP tools get used — a question this
 * table answers correctly — and warning there would be noise that trains the reader to skip
 * advisories. `IS NOT NULL` is likewise a population filter, not a single-agent scope.
 *
 * ⚠ THE REMEDY IS DELIBERATELY NOT "read this other store instead". `activity:tool-log` reads
 * harness_shared.agent_activity, which DOES record native calls (verified end-to-end: for the
 * owner above it renders 28 calls including the Bash command text, over the very window the
 * ledger showed as two orient loops) — but that store is not universal either. Measured 24h,
 * 2026-08-30: of 333 su-* owners appearing in tool_invocations, only 182 had any agent_activity
 * rows, so it is EMPTY for roughly 45% of agents. Naming it as the fix without that caveat would
 * relocate the identical directional error onto a second instrument and lend it this advisory's
 * authority. Hence the rule the advisory actually states, which is instrument-independent:
 * positive rows prove activity; absence in ANY of these stores proves nothing.
 */
export function buildAgentActivityLedgerAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  // Identifiers, so match the literal-and-comment-stripped body: an owner id quoted inside an
  // unrelated string must not count, and a column named in a `--` comment is not a predicate.
  const body = stripSqlLiteralsAndComments(rawSql);
  const scoped = SINGLE_AGENT_SCOPE_COLUMNS.some((col) =>
    new RegExp(`\\b${col}\\s*(?:=|<>|!=|~~?\\*?|\\bin\\b|\\blike\\b|\\bilike\\b)`, 'i').test(body),
  );
  if (!scoped) return null;

  return (
    '⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this ' +
    'window is NOT "everything this agent did" — native Claude Code Bash/Read/Grep/Edit produce no ' +
    'row at all, and this box\'s bypass-permissions preamble actively steers agents to native Bash ' +
    'for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 ' +
    'agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is ' +
    'DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty ' +
    'window reads as "idle" and escalates into waking, accusing or reassigning a peer who was ' +
    'working (EI-21847759967934033: this ledger showed one agent making only coord:glance / ' +
    'activity:report while it was in fact running Bash the whole time). THE RULE: positive rows ' +
    'prove activity; absence here proves nothing. To look for the missing half, start with ' +
    "`activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, " +
    'which DOES record native calls, and renders the command text. But do not invert the error ' +
    'onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had ' +
    'any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the ' +
    "transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: " +
    'SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE ' +
    "workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval " +
    "'30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the " +
    'faithful-render payload column, so both take the same id you scoped this query with.'
  );
}

/**
 * `harness_shared.adv_sessions.ended_at IS NULL` is NOT the liveness oracle
 * (WI-1447231 / scheduling-and-liveness-source-of-truth-2026-08-31 P-001).
 *
 * `ended_at` is written by a session's own COOPERATIVE shutdown path. A session
 * killed uncleanly — an operator SIGKILL, an OOM, a hard crash — never reaches
 * that write, so its row keeps `ended_at IS NULL` forever: a zombie that reads
 * exactly like a live session. The one shared liveness oracle every other
 * surface derives from is `coord:presence` / `fleet:assignments` sessionState
 * (`deriveSessionState` in `agent-tools/coordination/presence-wakeability.ts`),
 * which reconciles heartbeat freshness and wakeability instead of trusting this
 * raw column — a warm-dead session can read `heartbeatFresh:true,
 * sessionState:'ended'`, the same one-layer-down mistake this predicate makes.
 *
 * MEASURED: the operator was SIGKILLed at 01:32 UTC on 2026-08-31. An agent
 * read `adv_sessions WHERE ended_at IS NULL` afterward and reported 44 running
 * agents; the true count was ~12 by sessionState, only 3 of them live — every
 * session that was mid-turn when the operator died left a permanent zombie row.
 *
 * Fires on either direction of the predicate: `IS NULL` reads a row as
 * "running", `IS NOT NULL` reads it as "ended" — both trust a column an
 * unclean exit can strand on the wrong side forever, so both are wrong in the
 * same way and get the same warning.
 */
export function buildAdvSessionsLivenessAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'adv_sessions')) return null;

  // Identifiers, so match the literal-and-comment-stripped body: a column
  // named inside a quoted string or a `--` comment is not a predicate.
  const body = stripSqlLiteralsAndComments(rawSql);
  if (!/\bended_at\s+IS\s+(?:NOT\s+)?NULL\b/i.test(body)) return null;

  return (
    '⚠ adv_sessions.ended_at IS NULL/IS NOT NULL is NOT the liveness oracle: `ended_at` is ' +
    "written by a session's own cooperative shutdown, so a session killed uncleanly (operator " +
    'SIGKILL, OOM, crash) never writes it and its row reads "running" forever. MEASURED on the ' +
    '2026-08-31 01:32 UTC operator SIGKILL: this predicate reported 44 running agents where the ' +
    'true count was ~12 by sessionState (only 3 live). The one shared liveness oracle every other ' +
    'surface derives from is coord:presence / fleet:assignments sessionState (deriveSessionState in ' +
    'agent-tools/coordination/presence-wakeability.ts), which reconciles heartbeat freshness and ' +
    'wakeability instead of trusting this raw column. Use coord:presence for a liveness count; if ' +
    'you need this table for something ended_at genuinely answers (e.g. a completed session’s ' +
    'duration), corroborate against sessionState rather than reading the column alone.'
  );
}

/**
 * The agent_facts SUPERSESSION advisory (EI-19450552881841590) — two opposite
 * misreadings of one column, in one builder because they are the same defect
 * seen from either side: `superseded_at` does not mean what its neighbours imply.
 *
 * DIRECTION A — omitting it. `retracted_at IS NULL AND expires_at > now()` reads
 * like "live standing facts" and is the predicate every audit of this table
 * reaches for. P-008 versioning supersedes IN PLACE: re-asserting a key writes a
 * new row and stamps `superseded_at` on the old one. It does NOT stamp
 * `retracted_at` (the old version was replaced, not retracted) and does NOT
 * shorten `expires_at` — so a superseded row keeps BOTH liveness markers intact
 * indefinitely, and only `superseded_at IS NULL` separates it from a current one.
 * The count then reads as "the cap has stopped enforcing", which is alarming,
 * plausible and false.
 *
 * DIRECTION B — trusting it. A reader who DOES filter `superseded_at IS NOT NULL`
 * tends to read those rows as destroyed facts, i.e. cap evictions. They are
 * overwhelmingly ordinary re-assertions. Measured 2026-09-01 over 6h,
 * workspace-wide: 3035 rows superseded, 0 of them evicted, and all 3035 have a
 * live successor under the same (scope, scope_ref, key). Eviction stamps
 * `evicted_at` (together with `retracted_at`); supersession never does.
 *
 * ⚠ THE REMEDY NAMES ALL FIVE CLAUSES, not just `superseded_at`. When the filing
 * was written (2026-08-03) supersession was ~97% of the inflation (86 of 89), so
 * "add superseded_at" was then a complete fix. It is not any more. Measured
 * 2026-09-01 on scope='harness', scope_ref='papercusp': naive 471 vs cap
 * population 200, and the 271-row excess decomposes as superseded 131 (48%),
 * conventions 81 (30%), exempt wall:/dead-end:/guard-rail: slots 59 (22%) —
 * summing exactly to the gap. An advisory naming only the clause the filing
 * named would hand back a predicate still wrong by ~140 rows while carrying this
 * tool's authority, which is the false-confidence failure the advisories above
 * exist to prevent.
 *
 * ⚠ DELIBERATE BOUNDARY: direction A fires only when `superseded_at` is absent
 * entirely. A query that filters it but still counts conventions and exempt
 * slots remains over-counted and this stays silent, because firing on every
 * liveness-shaped read would be noise that trains readers to skip advisories —
 * and a reader who got the hard clause right is shown the other four in the
 * remedy text anyway. That is a chosen tradeoff, not an oversight.
 *
 * The clause list mirrors `capPopulationPredicate` in agent-facts/store.ts —
 * a hand-maintained SECOND COPY of a predicate the store already owns, so it
 * drifts silently unless something pins it. It did: the partition clause added
 * by EI-20365165629381535 (`measurement->'subjectVolatile'`) never reached this
 * text, so for a time the advertised "full predicate" merged the ordinary and
 * volatile populations and compared the total against one of two different
 * caps — the exact over-count this advisory exists to prevent, reproduced by
 * the advisory itself. Do not rely on remembering to update it: the drift pin
 * in pg-read-query.test.ts ("mirrors every column the canonical
 * capPopulationPredicate constrains") derives the required token set from
 * store.ts at test time and fails when a new clause is not named here.
 */
export function buildAgentFactsSupersessionAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'agent_facts')) return null;

  // Identifiers, so match the literal-and-comment-stripped body: a column named
  // inside a quoted string or a `--` comment is not a predicate.
  const body = stripSqlLiteralsAndComments(rawSql);
  const mentionsSuperseded = /\bsuperseded_at\b/i.test(body);

  // DIRECTION B: superseded rows read as destroyed/evicted facts. Fires only when
  // the query never mentions `evicted_at`, so a reader already distinguishing the
  // two is not lectured.
  if (mentionsSuperseded) {
    if (/\bevicted_at\b/i.test(body)) return null;
    const asDestruction = /\bsuperseded_at\s+IS\s+NOT\s+NULL\b/i.test(body);
    if (!asDestruction) return null;
    return (
      '⚠ superseded_at is NOT an eviction marker: it is stamped by ordinary re-assertion ' +
      '(facts:assert upserts by key, superseding the prior version in place), so counting these ' +
      'rows as destroyed facts overstates cap pressure — usually by everything. Measured 6h ' +
      'workspace-wide on 2026-09-01: 3035 rows superseded, 0 of them evicted, and all 3035 still ' +
      'have a LIVE successor under the same (scope, scope_ref, key) — i.e. nothing was lost. The ' +
      'cap sweep stamps `evicted_at` (alongside `retracted_at`); supersession never does. To count ' +
      'real destruction use `evicted_at IS NOT NULL`. To count genuine LOSS, additionally require ' +
      'that no live successor exists for that (scope, scope_ref, key) — a superseded row whose key ' +
      'was simply rewritten is a correction, not a loss.'
    );
  }

  // DIRECTION A: a liveness-shaped read missing the clause. A query mentioning
  // neither marker is not making a liveness claim, so warning there is noise.
  if (!/\bretracted_at\b/i.test(body) && !/\bexpires_at\b/i.test(body)) return null;

  return (
    '⚠ this reads like a "live standing facts" query but omits `superseded_at IS NULL`, so it ' +
    'counts SUPERSEDED versions as live. Re-asserting a key supersedes the old row in place ' +
    'WITHOUT stamping `retracted_at` and WITHOUT shortening `expires_at`, so a superseded row ' +
    'keeps both liveness markers intact forever — the error grows with how diligently the fleet ' +
    'CORRECTS facts, and it reads as "the per-scope cap has stopped enforcing". Measured ' +
    "2026-09-01 on scope='harness', scope_ref='papercusp': this predicate returned 471 against a " +
    'then-200 cap. Adding `superseded_at IS NULL` alone is NOT enough ' +
    '— it closes only 131 of the 271-row gap (conventions account for 81, exempt slots 59). The ' +
    'full predicate, mirroring capPopulationPredicate in agent-facts/store.ts:\n' +
    "  WHERE workspace_id = :ws AND scope = :scope AND coalesce(scope_ref,'') = :ref\n" +
    '    AND source_hive IS NULL          -- local partition; federated rows cap per-source\n' +
    '    AND superseded_at IS NULL        -- CURRENT versions only\n' +
    '    AND retracted_at IS NULL AND expires_at > now()\n' +
    "    AND key NOT LIKE 'wall:%' AND key NOT LIKE 'dead-end:%' AND key NOT LIKE 'guard-rail:%'\n" +
    "    AND COALESCE(kind,'') <> 'convention'\n" +
    "    AND measurement->'subjectVolatile' IS DISTINCT FROM 'true'::jsonb  -- ORDINARY partition\n" +
    "       -- (flip that last clause to = 'true'::jsonb to count the VOLATILE one instead)\n" +
    'That last clause is NOT optional: ordinary and volatile facts are capped as SEPARATE ' +
    'populations under SEPARATE ceilings (FACTS_PER_SCOPE_CAP vs FACTS_VOLATILE_PER_SCOPE_CAP in ' +
    'agent-facts/store.ts), so a count that omits it merges two populations and then compares the ' +
    'total against one of two different caps — the same over-count shape this advisory exists to ' +
    'prevent, one level down. ' +
    'Prefer `facts:list { scope, scopeRef }`, which already scopes correctly; this advisory exists ' +
    'for reads that drop to SQL. For the live at-cap forecast, ' +
    '`facts:assert { dryRun: true }` reports populationSize/cap/atCap from that same predicate.'
  );
}

/**
 * `harness_shared.event_key_fires` is an AGGREGATE LATCH, not a fire log
 * (EI-19464809374955438).
 *
 * One row per (workspace_id, event_key): `first_fired_at`, `last_fired_at`,
 * `fire_count`, `last_payload`. No per-fire history exists anywhere, so a
 * WINDOWED question — "did this key fire between T1 and T2?" — is structurally
 * unanswerable: every fire except the most recent leaves no timestamp behind.
 * The query still runs, and returns 0.
 *
 * That 0 is the whole danger, and it is why this fires at the moment of the
 * query rather than being left to discipline. `0` is the exact shape of "no
 * harm occurred", so a wake-loss investigation returning 0 stranded awaits
 * reads as reassurance when the true reading is "this instrument cannot see
 * it". Measured on the filing that produced this advisory: 81 unbound green
 * awaits cancelled-unfired over 7 days, joined to the latch on
 * `last_fired_at BETWEEN cancelled_at AND expires_ts`, returned stranded_awaits
 * 0 — while that same latch reported fire_count 101 on `release:green:papercusp`
 * and 244 on `green-checkpoint:red:papercusp`, i.e. those keys fire constantly
 * and the window for a missed fire was plainly wide open.
 *
 * ⚠ THIS ADVISORY NAMES NO CLEARING PREDICATE, and that is the point rather than
 * an omission. Every other builder in this file ends by naming the clause that
 * fixes the read; here the information is absent from the database, so the only
 * correct response is to downgrade the CLAIM from "none" to "unknown". Offering
 * a clearing clause would assert that a right answer is reachable by writing
 * better SQL, which is the false-confidence failure these advisories exist to
 * prevent.
 *
 * ⚠ AND `event_wake_attempts` IS NOT THE MISSING LOG — it is the second half of
 * the same trap, which is why the remedy warns about it instead of pointing
 * there. It holds a row per wake ATTEMPT, which exists only when some subscriber
 * was ARMED at fire time, so absence of an attempt row is not absence of a fire.
 * Measured 2026-09-01 across the attempts retention window, restricted to keys
 * whose ENTIRE fire history falls inside it so `fire_count` is directly
 * comparable: 60,692 keys, 192,369 fires, 6,607 observable as distinct
 * attempt-moments (3.4%), and 59,805 keys (98.5%) carrying no attempt row at
 * all. `fleet:context-critical:nonp2p-bug-drain-luna-max-50` alone fired 3,010
 * times and is wholly invisible there. A reader who "corrects" a latch query by
 * joining the attempts log therefore trades a false negative for a quieter one.
 *
 * DELIBERATE BOUNDARY: fires only on a genuine window question — a COMPARISON
 * against a fire timestamp. Reading the latch AS a latch (`SELECT event_key,
 * fire_count`, `max(last_fired_at)`, an ORDER BY recency) is a correct and
 * common use of this table and stays silent; warning there would be noise that
 * trains readers to skim advisories.
 */
export function buildEventFireWindowAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'event_key_fires')) return null;

  // Identifiers, so match the literal-and-comment-stripped body: a column named
  // inside a quoted string or a `--` comment is not a predicate.
  const body = stripSqlLiteralsAndComments(rawSql);

  // A window question is a COMPARISON against a fire timestamp, on either side
  // of the operator. Selecting, aggregating or ordering by one is not.
  const TS = '(?:first_fired_at|last_fired_at)';
  const windowed =
    new RegExp(`\\b${TS}\\s*(?:>=?|<=?|between\\b)`, 'i').test(body) ||
    new RegExp(`(?:>=?|<=?)\\s*(?:\\w+\\.)?${TS}\\b`, 'i').test(body);
  if (!windowed) return null;

  return (
    '⚠ harness_shared.event_key_fires is an AGGREGATE LATCH, not a fire log: ONE row per event key ' +
    '(first_fired_at, last_fired_at, fire_count, last_payload), with no interior history. A windowed ' +
    'predicate on these timestamps therefore CANNOT answer "did this key fire between T1 and T2" — ' +
    'every fire but the most recent left no timestamp behind, so a fire inside your window that was ' +
    'later superseded is invisible. A 0 here means UNKNOWN, never NONE, and it is the exact shape of ' +
    '"no harm occurred": measured on EI-19464809374955438, 81 cancelled-unfired green awaits joined ' +
    'this way returned 0 stranded while the same latch showed fire_count 101 and 244 on the two keys ' +
    'involved. Do NOT reach for harness_shared.event_wake_attempts to repair it — that carries a row ' +
    'per wake ATTEMPT, which exists only when a subscriber was ARMED at fire time, so an absent row ' +
    'is not an absent fire. Measured 2026-09-01 over its retention window (keys whose whole history ' +
    'falls inside it): 192,369 fires, 6,607 observable (3.4%), and 59,805 of 60,692 keys (98.5%) with ' +
    'no attempt row at all. State the result as unanswerable, or narrow to keys with fire_count = 1 ' +
    '(where last_fired_at IS the only fire and a window predicate is exact). Answering it in general ' +
    'needs a bounded per-fire log that does not exist yet.'
  );
}

/**
 * Flag the seconds-as-milliseconds epoch trap on tool-invocation recency reads
 * (EI-20261119579595975).
 *
 * PostgreSQL's `to_timestamp()` accepts epoch SECONDS. A caller that has an
 * epoch-seconds value such as `1786547705.088` and divides it by 1000 because
 * it was thinking in epoch milliseconds silently moves the cutoff to January
 * 1970. A query over `invoked_at` then returns historical rows and can make a
 * wake-attribution claim look proven when it is not.
 *
 * This is deliberately narrow: it only fires for the tool_invocations table,
 * an invoked_at read, and a numeric literal in the epoch-seconds range divided
 * by 1000. A genuine epoch-milliseconds literal is ~1000x larger and remains
 * valid. Dynamic expressions and parameter values are left to the caller,
 * because this builder cannot establish their units without inventing a fact.
 */
export function buildEpochUnitAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\binvoked_at\b/i.test(stripped)) return null;

  // Current and near-future epoch seconds are 10–11 digits; epoch
  // milliseconds are 12–13 digits. Keep the bounds broad enough for old and
  // far-future timestamps without warning on ordinary numeric expressions.
  const epochSecondsLiteral =
    /\bto_timestamp\s*\(\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*\/\s*1000(?:\.0+)?\s*\)/gi;
  for (let match = epochSecondsLiteral.exec(stripped); match; match = epochSecondsLiteral.exec(stripped)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 100_000_000 || value >= 100_000_000_000) continue;
    return (
      '⚠ epoch-unit ambiguity: this tool_invocations query divides an epoch-seconds-sized value by 1000 ' +
      'before passing it to to_timestamp(), moving the cutoff to 1970 and allowing historical rows to ' +
      'masquerade as post-event calls. PostgreSQL to_timestamp() expects epoch seconds; divide by 1000 ' +
      'only when the source is epoch milliseconds. Prefer an ISO timestamptz literal, or assert ' +
      'min(invoked_at) is after the intended event before reporting wake attribution. ' +
      '(EI-20261119579595975).'
    );
  }

  return null;
}

/**
 * Explain the DBOS workflow-status schema when a forensic query fails on its
 * timestamp shape or on a guessed timestamp/name column (EI-23095186684817118).
 *
 * `dbos.workflow_status` is an external DBOS relation rather than one of the
 * harness tables covered by the generic schema redirects. Its created_at and
 * updated_at fields are BIGINT epoch milliseconds, and the workflow label is
 * `name`; without this targeted correction, `knownColumns` tells a caller what
 * exists but not how to form the next valid predicate.
 */
export function buildDbosWorkflowStatusSchemaHint(
  rawSql: string,
  info: { code?: string; message: string; detail?: string },
): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((table) => table.toLowerCase() === 'dbos.workflow_status')) return null;

  const errorText = `${info.message} ${info.detail ?? ''}`;
  const epochTypeMismatch =
    info.code === '42883' &&
    /operator\s+does\s+not\s+exist:\s*bigint\s*[<>=!]+\s*timestamp\b/i.test(errorText);
  const missingColumn = info.code === '42703' ? parseMissingColumnName(errorText) : null;
  const guessedTimestampColumn =
    missingColumn === 'created_at_epoch_ms' || missingColumn === 'updated_at_epoch_ms';
  const guessedWorkflowName = missingColumn === 'workflow_name';

  if (!epochTypeMismatch && !guessedTimestampColumn && !guessedWorkflowName) return null;

  return (
    '`dbos.workflow_status.created_at` and `.updated_at` are BIGINT epoch milliseconds, not ' +
    'timestamptz; compare them with `(extract(epoch from now()) * 1000)::bigint` (or render ' +
    'an existing epoch value with `to_timestamp(updated_at / 1000.0)`). ' +
    '`updated_at_epoch_ms` and `created_at_epoch_ms` are not columns; the workflow label column ' +
    'is `name`, not `workflow_name`. Use `describe: "dbos.workflow_status"` before adding ' +
    'another guessed field.'
  );
}

/**
 * Flag an unbounded substring search over the large tool-invocation JSONB
 * columns (EI-21663090256112441).
 *
 * `maxRows` caps rows returned by {@link pgReadQuery}; it does not cap the
 * amount of work PostgreSQL performs while evaluating a WHERE clause. Casting
 * `args_json` or `metadata_json` to text and applying LIKE/ILIKE therefore
 * forces a per-row JSON serialisation/filter over the multi-million-row
 * `tool_invocations` table when the SQL has no LIMIT. The query can look
 * bounded to a caller while still running until statement_timeout.
 *
 * This is intentionally a pure, conservative shape check. It does not try to
 * infer a query's selectivity or invent a new JSON index. An explicit SQL
 * LIMIT is treated as a caller-provided scan bound; all other JSON-text
 * pattern predicates are surfaced so the dev:pg_query handler can refuse them
 * by default and require an explicit bypass for deliberate forensic scans.
 */
export function buildJsonTextSearchAdvisory(rawSql: string): string | null {
  const tables = extractReferencedTables(rawSql);
  if (!tables.some((t) => bareTableName(t) === 'tool_invocations')) return null;

  const body = stripSqlLiteralsAndComments(rawSql);
  // A SQL LIMIT gives PostgreSQL an opportunity to stop after finding enough
  // rows. LIMIT ALL is not a bound and remains unsafe. FETCH FIRST/NEXT is the
  // equivalent SQL spelling and is treated the same way.
  if (
    (/\blimit\b/i.test(body) && !/\blimit\s+all\b/i.test(body)) ||
    /\bfetch\s+(?:first|next)\b/i.test(body)
  ) {
    return null;
  }

  const matchedColumns: string[] = [];
  for (const column of ['args_json', 'metadata_json']) {
    const qualifiedColumn = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*)?\b${column}\b`;
    const castExpression = String.raw`(?:${qualifiedColumn}\s*::\s*text|cast\s*\(\s*${qualifiedColumn}\s+as\s+text\s*\))`;
    // PostgreSQL exposes LIKE/ILIKE as ~~ / ~~* internally, so recognise both
    // spellings. The stripped body keeps identifiers/operators while erasing
    // pattern literals and comments, preventing quoted examples from firing.
    const pattern = new RegExp(
      String.raw`\(*\s*${castExpression}\s*\)*\s*(?:(?:like|ilike)\b|!?~~\*?)(?=\s|['(]|$)`,
      'i',
    );
    if (pattern.test(body)) matchedColumns.push(column);
  }
  if (!matchedColumns.length) return null;

  const columns = matchedColumns.map((column) => `\`${column}::text\``).join(' or ');
  return (
    '⚠ unbounded JSON-text search: this tool_invocations query applies LIKE/ILIKE to ' +
    `${columns}, which forces PostgreSQL to serialise and scan the large ` +
    '`harness_shared.tool_invocations` JSONB columns row by row; `maxRows` only caps ' +
    'rows returned after the WHERE scan and cannot bound this work. Prefer an indexed ' +
    'scalar predicate such as `workspace_id`, `harness_slug`, `coord_owner_id`, ' +
    '`tool_name`, `goal_ref`, `spawn_id`, or `invoked_at`, add a selective SQL LIMIT/time ' +
    'window, or use `activity:tool-log` / `dev:telemetry` for the documented compact ' +
    'invocation views. This preflight refuses the unbounded shape by default; pass ' +
    '`allowUnboundedJsonSearch: true` only for a deliberate forensic scan. ' +
    '(EI-21663090256112441).'
  );
}

/**
 * Resolve a caller-supplied scope value to a REAL id, or `undefined` if it is absent OR the
 * `'*'` wildcard sentinel (`_harness-scope.ts`: every su/operator-scope call sets
 * `ctx.harnessSlug = '*'`, and the same convention applies to `ctx.workspaceId`). Suggesting a
 * literal `= '*'` predicate is a distinct bug from "no predicate at all" (EI-19324633485547042
 * point 3): `'*'` is not a SQL wildcard for `=`, so the "fix" is a query that matches nothing and
 * reads as a clean, confidence-inspiring empty result — worse than the missing-predicate warning
 * it was supposed to resolve. Every other call site that threads `ctx.harnessSlug` into a real
 * predicate already guards this (`agent-tools/_harness-scope.ts` and ~15 sibling sites); this
 * advisory builder was the one that hadn't.
 */
export function realScopeValue(v?: string | null): string | undefined {
  return v && v !== '*' ? v : undefined;
}

/**
 * A scope column in the SELECT list is not a tenant predicate. The old guard
 * treated any mention as proof of scope, so `SELECT workspace_id, ... WHERE
 * task_id = ...` bypassed the check while `SELECT * ... WHERE task_id = ...`
 * was rejected. Keep this deliberately small and conservative: recognize a
 * column used with a comparison/null/membership operator (or in JOIN USING),
 * while leaving unusual SQL forms fail-closed to the advisory.
 */
function hasTenantPredicate(strippedSql: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const operator =
    `\\b${escaped}\\b\\s*(?:::\\s*[A-Za-z_][A-Za-z0-9_.]*)*\\s*` +
    `(?:=|<>|!=|>=|<=|>|<|\\bIS(?:\\s+NOT)?(?:\\s+DISTINCT\\s+FROM)?\\b|\\bIN\\s*\\(|\\bLIKE\\b|\\bILIKE\\b|\\bBETWEEN\\b)`;
  if (new RegExp(operator, 'i').test(strippedSql)) return true;
  return new RegExp(`\\bUSING\\s*\\([^)]*\\b${escaped}\\b`, 'i').test(strippedSql);
}

/**
 * A narrow value/range predicate used for identity fences. Unlike
 * {@link hasTenantPredicate}, this deliberately excludes open-ended comparisons
 * (`>`, `<`, `LIKE`, `IS`, …), which would make a test-runs query look local while
 * still selecting a broad population.
 */
function hasBoundedPredicate(strippedSql: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cast = `(?:\\s*::\\s*[A-Za-z_][A-Za-z0-9_.]*)*`;
  return new RegExp(
    `\\b${escaped}\\b${cast}\\s*(?:=|\\bIN\\s*\\(|\\bBETWEEN\\b)`,
    'i',
  ).test(strippedSql);
}

/**
 * An exact identity predicate is deliberately narrower than a bounded value/range predicate:
 * `IN (...)` and `BETWEEN` can name several historical rows, while a local run/file lookup must
 * fix one harness, one run group, and one file path before it may omit workspace_id.
 */
function hasExactPredicate(strippedSql: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cast = `(?:\\s*::\\s*[A-Za-z_][A-Za-z0-9_.]*)*`;
  return new RegExp(`\\b${escaped}\\b${cast}\\s*=`, 'i').test(strippedSql);
}

function hasPredicateForTestRunsReference(
  strippedSql: string,
  reference: TestRunsReference,
  column: string,
  bounded: boolean,
): boolean {
  const qualifiedColumn = `${reference.qualifier}.${column}`;
  return bounded
    ? hasBoundedPredicate(strippedSql, qualifiedColumn)
    : hasTenantPredicate(strippedSql, qualifiedColumn);
}

export async function buildTenantScopeAdvisory(
  rawSql: string,
  opts: { client?: OrgSql; workspaceId?: string | null; harnessSlug?: string | null } = {},
): Promise<string | null> {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  if (!/\bwhere\b/i.test(stripped)) return null;
  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;

  // Never suggest a literal '*' predicate — resolve the sentinel to "unresolved" up front so
  // every downstream `suggest`/predicate builder only ever sees a real id or undefined.
  const resolvedOpts = { ...opts, workspaceId: realScopeValue(opts.workspaceId), harnessSlug: realScopeValue(opts.harnessSlug) };

  const testRunsAdvisory = buildTestRunsAdvisory(stripped, tables);
  // P-003: the SEMANTIC advisory — guards what a column MEANS, not which rows
  // belong to you. Independent of the tenancy checks below (a scout_routed_ideas
  // query can be perfectly tenant-scoped and still count the wrong population).
  const ungradedAdvisory = buildUngradedScopeAdvisory(stripped, tables);

  const hasPredicate = (col: string): boolean => hasTenantPredicate(stripped, col);
  const genericMentioned = hasPredicate('workspace_id') || hasPredicate('harness_slug');

  // Tables with a hardcoded per-table override (a real tenancy key that
  // differs from the generic workspace_id/harness_slug heuristic) get their
  // OWN "already scoped" check — a query filtering agent_facts by scope_ref
  // but not harness_slug must still be recognized as correctly scoped, and a
  // query filtering agent_facts by harness_slug alone must still be flagged
  // (that's the exact wrong-predicate footgun this override exists to catch).
  // test_runs is excluded here too — see buildTestRunsAdvisory's doc comment for why its
  // "workspace_id/harness_slug mentioned ⇒ scoped" signal is backwards for that table.
  const overrideTables = tables.filter((t) => TENANT_SCOPE_OVERRIDES[bareTableName(t)]);
  const genericTables = tables.filter(
    (t) => !TENANT_SCOPE_OVERRIDES[bareTableName(t)] && bareTableName(t) !== TEST_RUNS_TABLE,
  );

  const overrideOffenders: Array<{ table: string; override: TenantScopeOverride }> = [];
  for (const t of overrideTables) {
    const override = TENANT_SCOPE_OVERRIDES[bareTableName(t)]!;
    if (override.requiredColumns.some(hasPredicate)) continue; // already correctly scoped
    overrideOffenders.push({ table: t, override });
  }

  const genericOffenders: Array<{ table: string; hasWorkspaceId: boolean; hasHarnessSlug: boolean }> = [];
  if (genericTables.length && !genericMentioned) {
    const info = await readTenantScopeInfo(genericTables, opts.client);
    for (const t of genericTables) {
      if (CORPUS_NAMESPACED_TABLES.has(bareTableName(t))) continue; // see CORPUS_NAMESPACED_TABLES doc
      const i = info.get(t);
      if (!i || (!i.hasWorkspaceId && !i.hasHarnessSlug)) continue;
      genericOffenders.push({ table: t, hasWorkspaceId: i.hasWorkspaceId, hasHarnessSlug: i.hasHarnessSlug });
      if (genericOffenders.length >= 3) break;
    }
  }

  if (!overrideOffenders.length && !genericOffenders.length && !testRunsAdvisory && !ungradedAdvisory)
    return null;

  const parts: string[] = [];

  if (testRunsAdvisory) parts.push(testRunsAdvisory);
  if (ungradedAdvisory) parts.push(ungradedAdvisory);

  for (const { table, override } of overrideOffenders.slice(0, 3)) {
    parts.push(
      `⚠ tenant scope: ${table} (keyed by ${override.keyDescription}) — multi-tenant, but this ` +
        `filtered query has no ${override.requiredColumns.join('/')} predicate — a bare slug/id ` +
        "filter can silently match ANOTHER tenant's rows and read as a clean-looking " +
        `empty/stale result rather than an error. Add: ${override.suggest(resolvedOpts)}.` +
        (override.preferredTool ? ` Or use ${override.preferredTool}.` : '') +
        ' (agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope, EI-18669912007336072).',
    );
  }

  if (genericOffenders.length) {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    // Per-table: only name/suggest a column this SPECIFIC table actually has —
    // never blindly append harness_slug (or workspace_id) from opts, since a
    // sibling table in the same joined query can lack one of them (the exact
    // "names a nonexistent column" shape of EI-18749676091756794).
    for (const off of genericOffenders) {
      const cols = [off.hasWorkspaceId ? 'workspace_id' : null, off.hasHarnessSlug ? 'harness_slug' : null]
        .filter(Boolean)
        .join(' + ');

      // VERIFY BEFORE PRESCRIBING (P-003). Ask the table whether the predicate we
      // are about to recommend matches anything, instead of inferring it from the
      // column's existence. A refutation REPLACES the advisory rather than
      // annotating it: telling an agent to add a predicate AND that the predicate
      // is wrong invites them to add it anyway.
      const checkedWorkspaceId = off.hasWorkspaceId && !!resolvedOpts.workspaceId;
      const checkedHarnessSlug = off.hasHarnessSlug && !!resolvedOpts.harnessSlug;
      const pop = await probeTenantPopulation(
        off.table,
        { hasWorkspaceId: off.hasWorkspaceId, hasHarnessSlug: off.hasHarnessSlug, at: 0 },
        resolvedOpts,
        opts.client,
      );
      const verdict = classifyTenantPrescription(pop, { checkedWorkspaceId, checkedHarnessSlug });
      if (verdict.kind === 'refute') {
        const prescribed =
          verdict.column === 'workspace_id' ? resolvedOpts.workspaceId! : resolvedOpts.harnessSlug!;
        parts.push(refutedTenantAdvisory(off.table, verdict.column, prescribed, verdict.actual));
        continue;
      }

      const suggested: string[] = [];
      if (off.hasWorkspaceId && resolvedOpts.workspaceId) suggested.push(`workspace_id = ${quote(resolvedOpts.workspaceId)}`);
      if (off.hasHarnessSlug && resolvedOpts.harnessSlug) suggested.push(`harness_slug = ${quote(resolvedOpts.harnessSlug)}`);
      const actionable = suggested.length
        ? ` Add: ${suggested.join(' AND ')}.`
        : ` Add the resolved ${cols.replaceAll(' + ', '/')} scope predicate(s).`;
      parts.push(
        `⚠ tenant scope: ${off.table} (keyed by ${cols}) — multi-tenant, but this filtered query has no ` +
          `${cols.replaceAll(' + ', '/')} predicate — a bare slug/id filter can silently match ANOTHER ` +
          `tenant's rows and read as stale/diverged state.${actionable} ` +
          '(agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).',
      );
    }
  }

  return parts.join(' ');
}

export const PG_READ_QUERY_DEFAULT_MAX_ROWS = 200;
export const PG_READ_QUERY_HARD_MAX_ROWS = 2000;
export const PG_READ_QUERY_DEFAULT_TIMEOUT_MS = 5000;
export const PG_READ_QUERY_HARD_TIMEOUT_MS = 30000;

/**
 * Defaults for internal read-only transactions that need the tagged SQL
 * client, rather than the agent-facing raw-query/result-cap surface below.
 * Keep acquisition shorter than the generic db-org ceiling: these reads feed
 * interactive loop status and cold-wake continuity, so a saturated pool must
 * produce a typed failure before the MCP route gives up.
 */
export const PG_READ_TXN_DEFAULT_TIMEOUT_MS = PG_READ_QUERY_DEFAULT_TIMEOUT_MS;
export const PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS = Math.min(DEFAULT_TX_ACQUIRE_DEADLINE_MS, 8_000);

/**
 * Headroom added on top of `timeoutMs` for the WHOLE-call deadline
 * ({@link withCallDeadline}) — connect/acquire + the 3 `SET` statements +
 * commit round-trip, none of which are bounded by `statement_timeout` (that
 * only governs the query once a connection is already open and the
 * transaction has started). Deliberately generous rather than tight: this
 * exists to catch a HUNG acquire (pool exhaustion, or the DB/operator going
 * down mid-call — EI-19415142351884573), not to shave a few ms off a healthy
 * call, so a false-positive timeout on a merely-busy pool is worse than a few
 * extra seconds of real slack.
 */
export const PG_READ_QUERY_CALL_OVERHEAD_MS = 3000;

/**
 * Bound the WHOLE call — not just server-side statement execution — with a
 * timer THIS function owns, rather than trusting the driver/pool/transport to
 * cooperate with a signal or a server-side setting.
 *
 * WHY NOT JUST `statement_timeout` (what pgReadQuery relied on before this):
 * `SET LOCAL statement_timeout` is set INSIDE the transaction, so it does
 * nothing for the phase before the transaction starts — acquiring a
 * connection from the pool. A caller-supplied `timeoutMs: 25000` therefore
 * did not bound the failure mode agents actually hit: three consecutive
 * hangs (one with that explicit 25s timeout) each ran the full 300s client
 * idle-abort while Postgres itself sat completely idle, because the
 * operator was restarting and the connection/acquire phase never returned at
 * all (EI-19415142351884573).
 *
 * WHY NOT AN ABORT SIGNAL: an abort is a request the transport MAY ignore —
 * it only works if whoever holds the promise honours it, which is circular
 * when the whole point is that the transport has stopped behaving normally
 * (EI-18861599591681504). A `Promise.race`-style deadline against a timer
 * this function owns is guaranteed to settle regardless of what `work` (the
 * connect, acquire, or execute) is actually doing.
 *
 * `work`'s eventual settlement is still awaited via `.then(...)` even after
 * the timer wins, so a late resolution/rejection is a no-op (resolve/reject
 * only takes effect once) rather than an unhandled rejection.
 */
export function withCallDeadline<T>(work: Promise<T>, deadlineMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PgReadQueryTimeoutError(timeoutMessage)), deadlineMs);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The message `withCallDeadline` raises for `pgReadQuery`/`explainReadQuery`/`pgMutateQuery` — one string so the call sites can't drift. */
export function callTimeoutMessage(timeoutMs: number, callDeadlineMs: number): string {
  return (
    `Query call did not complete within ${callDeadlineMs}ms of the WHOLE call (connect + acquire + ` +
    `execute) — statement_timeout=${timeoutMs}ms only bounds server-side execution once a connection ` +
    'is already open, so on its own it could not catch a hung connection acquire (pool exhaustion, or ' +
    'the database/operator going down mid-call). If this keeps recurring, check dev:service_health — ' +
    'the operator may be restarting (EI-19415142351884573).'
  );
}

/**
 * Pin the transaction's TimeZone to UTC (EI-19397658288924647).
 *
 * `date_trunc('day', <timestamptz>)` buckets on SESSION-timezone boundaries. On
 * this box the session TZ is America/New_York, so the obvious daily rollup
 * bucketed in EDT — while the result was serialised with a literal `Z`:
 *
 *     date_trunc('day', timestamptz '2026-08-03 01:34:00Z')::date
 *       →  "2026-08-02T00:00:00.000Z"        ← asserts UTC, is not UTC
 *
 * That label is not merely ambiguous, it is affirmatively WRONG about its own
 * timezone, and nothing in the row hints at the shift — an agent selecting only
 * `day, count(*)` gets a clean, plausible, 4h-shifted series. Every measurement
 * here is compared against a UTC anchor (a deploy time, a gate verdict,
 * `host.now`, an incident window), and the shift moves pre-epoch events into the
 * post-epoch bucket — the direction that manufactures a false positive for
 * whatever change is being measured.
 *
 * Fixing the SESSION rather than the rendering makes the bucket boundary and the
 * `Z` agree, which also fixes `now()`-relative filters and every other
 * session-TZ-dependent function in one place. `SET LOCAL` scopes it to this
 * transaction, so it can never leak onto a pooled connection shared with app
 * code that legitimately wants server-local time.
 */
export const SET_LOCAL_UTC = "SET LOCAL TIME ZONE 'UTC'";

/**
 * Re-apply the canonical org search path inside a transaction when the client
 * is routed through PgBouncer transaction pooling. Connect-time startup
 * parameters do not survive that routing, so an unqualified
 * `FROM tool_invocations` otherwise runs with PostgreSQL's `$user, public`
 * default and reports a relation that is present as missing (EI-22453679671058762).
 */
export const SET_LOCAL_ORG_SEARCH_PATH =
  "SELECT set_config('search_path', 'harness_shared, papercusp_shared, public', true)";

/**
 * Run an internal query in one bounded, READ ONLY transaction.
 *
 * This is the shared seam for operator read paths that already use a tagged
 * postgres client (loop status, carry-note continuity, and similar internal
 * reads). `statement_timeout` is installed in the database transaction before
 * the callback runs, while `withAcquisitionDeadline` covers connect + pool
 * acquire + BEGIN + setup. The final whole-call deadline also covers a
 * transaction/commit that fails to settle after the callback returns.
 *
 * Do not replace this with a JS-only Promise.race around the query: postgres-js
 * does not cancel an in-flight statement when the timer wins. The DB-side
 * timeout is what releases a backend stalled in a scan or lock wait.
 */
export async function boundedPgReadTxn<T>(
  fn: (tx: OrgSql) => Promise<T>,
  opts: {
    client?: OrgSql;
    timeoutMs?: number;
    acquireTimeoutMs?: number;
    /**
     * Optional acquisition-registry pool label. Injected clients are
     * deliberately unmeasured by default because they may not be backed by
     * this process's org-admin pool; callers that can identify their pool may
     * opt in to attribution explicitly.
     */
    acquirePool?: string;
  } = {},
): Promise<T> {
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_TXN_DEFAULT_TIMEOUT_MS)),
  );
  const acquireTimeoutMs = Math.max(
    100,
    Math.min(DEFAULT_TX_ACQUIRE_DEADLINE_MS, Math.trunc(opts.acquireTimeoutMs ?? PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS)),
  );
  const sql = opts.client ?? getOrgPg().sql;
  const acquirePool = opts.acquirePool ?? (opts.client ? undefined : 'org-admin');
  const callDeadlineMs = acquireTimeoutMs + timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;
  // EI-22696820908231308: checkpoint verify-reads used this seam immediately
  // after a committed write, but unlike boundedOrgTxn the read path surfaced the
  // first measured pool-queue deadline directly. Retry only a DbCallDeadlineError
  // that the local acquisition registry proved was transient queue pressure. The
  // expired() guard prevents a late transaction from ever invoking fn, so retrying
  // this PRE-callback phase cannot execute a read twice.
  return retryOnRetryableDbDeadline(async () => {
    const work = withAcquisitionDeadline(
      ({ disarm, expired }) =>
        sql.begin(async (tx) => {
          // READ ONLY must be the first transaction setting before the query.
          await tx.unsafe('SET TRANSACTION READ ONLY');
          await tx`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`;
          await tx.unsafe(SET_LOCAL_UTC);
          // A connection can arrive after the acquisition deadline's timer wins
          // the race. Never invoke the caller's callback in that late transaction.
          if (expired()) {
            throw new DbCallDeadlineError(
              'boundedPgReadTxn:acquire(admin)',
              acquireTimeoutMs,
              acquireTimeoutMs,
              acquirePool,
            );
          }
          disarm();
          return fn(tx as unknown as OrgSql);
        }),
      { ms: acquireTimeoutMs, label: 'boundedPgReadTxn:acquire(admin)', pool: acquirePool },
    );
    await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs));
    return (await work) as T;
  });
}

/**
 * Strip SQL noise a naive `;`-scan would misread as a statement separator:
 * single-quoted string literals ('...' with '' escaping), double-quoted
 * identifiers ("..." with "" escaping), dollar-quoted strings ($$...$$ /
 * $tag$...$tag$), `--` line comments, and `/* … *\/` block comments. Quoted
 * content is replaced with an equal-length placeholder (never containing a
 * `;` or quote char) so position/structure is preserved for the caller's
 * `;`-count check — only the literal's TEXT is discarded, never executed.
 * Exported for pg-mutate-query, whose statement validation needs the identical
 * quote/comment semantics — a second implementation would drift.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    // -- line comment: to end of line
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = len;
      i = j;
      continue;
    }
    // /* block comment */ (non-nested)
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? len : j + 2;
      i = j;
      continue;
    }
    // 'single-quoted string' — '' is an escaped quote
    if (ch === "'") {
      out += "''";
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // "double-quoted identifier" — "" is an escaped quote
    if (ch === '"') {
      out += '""';
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // $$...$$ / $tag$...$tag$ dollar-quoted string
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        out += 'x';
        i = end === -1 ? len : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Skip whitespace and SQL comments while locating the EXPLAIN body. */
function skipSqlTrivia(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    if (/\s/.test(sql[i] ?? '')) {
      i++;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readSqlWord(sql: string, start: number): { word: string; end: number } | null {
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(start));
  return match ? { word: match[0], end: start + match[0].length } : null;
}

/** Find the closing parenthesis for EXPLAIN's option list, quote-aware. */
function findSqlClosingParen(sql: string, start: number): number {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      for (i++; i < sql.length; i++) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '"') {
      for (i++; i < sql.length; i++) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return -1;
        i = end + tag.length - 1;
        continue;
      }
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Consume the legacy, non-parenthesized EXPLAIN option spelling. */
function consumeLegacyExplainOptions(sql: string, start: number): number {
  let i = skipSqlTrivia(sql, start);
  const booleanOptions = new Set(['analyze', 'verbose', 'costs', 'settings', 'buffers', 'wal', 'timing', 'summary']);
  const booleanValues = new Set(['true', 'false', 'on', 'off']);
  while (true) {
    const token = readSqlWord(sql, i);
    if (!token) return i;
    const word = token.word.toLowerCase();
    if (word === 'format') {
      const value = readSqlWord(sql, skipSqlTrivia(sql, token.end));
      if (!value || !/^(text|xml|json|yaml)$/i.test(value.word)) return i;
      i = skipSqlTrivia(sql, value.end);
      continue;
    }
    if (!booleanOptions.has(word)) return i;
    i = skipSqlTrivia(sql, token.end);
    const value = readSqlWord(sql, i);
    if (value && booleanValues.has(value.word.toLowerCase())) i = skipSqlTrivia(sql, value.end);
  }
}

function startsWithExplain(raw: string): boolean {
  const q = raw.trim();
  const start = skipSqlTrivia(q, 0);
  const token = readSqlWord(q, start);
  return token?.word.toLowerCase() === 'explain';
}

/**
 * Validate the query is a single read statement and return it trimmed (a
 * single trailing `;` is stripped). Throws PgReadQueryError otherwise. The
 * READ ONLY transaction is the real guard — this just rejects obvious misuse
 * early with a clear message. Quote-aware: a `;` inside a string literal /
 * quoted identifier / comment does NOT count as a statement separator (only
 * the LITERAL, unexecuted text is stripped for this check — the real query
 * below is unmodified).
 */
export function assertSingleReadStatement(raw: string): string {
  const q = raw.trim().replace(/;\s*$/, '').trim();
  if (!q) throw new PgReadQueryError('empty query');
  const noiseStripped = stripSqlLiteralsAndComments(q).trim();
  if (noiseStripped.includes(';')) {
    throw new PgReadQueryError(
      'only a single statement is allowed — remove the `;`-separated statements',
    );
  }
  if (!/^(select|with)\b/i.test(noiseStripped)) {
    throw new PgReadQueryError(
      'only SELECT / WITH…SELECT queries are allowed (this is a read-only surface; use the documented write verbs to change state)',
    );
  }
  const vaultRefusal = personalVaultRefusal(q);
  if (vaultRefusal) throw new PgReadQueryError(vaultRefusal);
  return q;
}

/**
 * Personal Vault relations — the owner's synced mail, calendar and contacts,
 * plus the consent rows that gate them.
 *
 * `authorizePersonalAccess` fences the `personal:*` TOOL surface. It does not
 * reach these tables, and MEASURED 2026-09-18 (WI-10001796) in ONE session,
 * seconds apart:
 *
 *   personal:search { scopes:['personal:gmail'] }  -> allowed:false, no_live_grant
 *   SELECT count(*) FROM harness_shared.personal_documents -> 32,653 gmail messages
 *
 * ⚠ The data-layer control is NOT missing, it is INERT — do not "fix" this by
 * deleting the refusal below once you see RLS in the schema. Migration 874 does
 * run ENABLE ROW LEVEL SECURITY on all six of these and create a policy, so it
 * reads as complete. It has never once evaluated: every agent connection arrives
 * as `harness_admin`, which is simultaneously rolsuper, rolbypassrls, and the
 * tables' OWNER with relforcerowsecurity=false — four independent bypasses, any
 * one of them sufficient on its own. `ALTER TABLE … FORCE ROW LEVEL SECURITY`
 * therefore does NOT repair it either (a superuser bypasses RLS even under
 * FORCE), though it would test green against any non-superuser role.
 *
 * ⛔ Nor is the repair to repoint agent SQL at a non-superuser role, which is the
 * obvious next move and the one this comment used to recommend. MEASURED
 * 2026-09-18 on this cluster via `SET ROLE harness_app`:
 *
 *   personal_documents ->       0 rows   (vault closed)
 *   work_items         ->       0 rows   (the fleet's backlog table, SILENTLY empty)
 *   engineer_issues    -> 214,597 rows   (no RLS, unaffected)
 *
 * Both zeros have the SAME cause: `app.workspace_id` is unset, so every
 * workspace-isolation policy — migration 402 on work_items, 874 here — matches
 * nothing. Neither zero is a consent decision, and neither is an error a caller
 * can see. That makes the obvious repair for the work_items regression (set
 * `app.workspace_id` on agent connections) the exact change that RE-OPENS the
 * vault: policy 874 is `workspace_id = current_setting('app.workspace_id')`, it
 * encodes no grant at all, and this cluster holds exactly ONE workspace — the one
 * every agent already runs in. The role swap closes the vault only for as long as
 * it is also silently emptying work_items, and fixing that undoes it.
 *
 * A data-layer control that actually holds needs the vault policy to encode
 * CONSENT (or these tables revoked outright from whatever role agent SQL uses),
 * not merely workspace. Until one exists, THIS is the control — not a
 * belt-and-braces addition to a working one.
 */
const PERSONAL_VAULT_RELATIONS = [
  'personal_documents',
  'personal_identities',
  'personal_identity_aliases',
  'personal_sync_state',
  'personal_vault_settings',
  'personal_grants',
] as const;

/**
 * The refusal message when `rawSql` touches a Personal Vault relation, else null.
 *
 * Deliberately NOT built on {@link extractReferencedTables}: that one is capped at
 * GUARD_MAX_TABLES and only sees FROM/JOIN/UPDATE/INTO, so a fifth-table join or a
 * set-operation arm slips straight past it. An advisory may be best-effort; a
 * fence may not. This scans the whole statement for the identifier instead.
 *
 * Stripping literals and comments FIRST is what keeps the guard usable rather
 * than merely strict: auditing the vault's own schema — `WHERE relname =
 * 'personal_documents'`, or this file's own doc comments — stays allowed, because
 * there the name is a string, not a table reference. `personal_documents_id` does
 * not match either: `_` is a word character, so the trailing `\b` fails.
 *
 * Absolute rather than grant-aware on purpose. This is a pure SQL helper with no
 * principal in scope; a consent check it cannot actually perform would be worse
 * than none, because it would read like one. The authorized path is
 * `personal:search`, which resolves the caller and requires a live owner grant.
 */
export function personalVaultRefusal(rawSql: string): string | null {
  const stripped = stripSqlLiteralsAndComments(rawSql);
  const hit = PERSONAL_VAULT_RELATIONS.find((rel) => new RegExp(`\\b${rel}\\b`, 'i').test(stripped));
  if (!hit) return null;
  return (
    `refused: harness_shared.${hit} holds Personal Vault data — the owner's synced mail, ` +
    'calendar and contacts. Ad-hoc SQL is not an authorized path to it: no grant is checked ' +
    'here and no vault access is audited, so this door reads the mailbox that personal:search ' +
    'refuses without consent (WI-10001796). Use personal:search, which resolves your principal ' +
    "and requires a live owner grant. Reading vault SCHEMA is still fine — quote the name " +
    "('personal_documents') so it is a literal rather than a table reference."
  );
}

/**
 * Validate an EXPLAIN whose explained statement is read-only. EXPLAIN itself
 * is not a SELECT/WITH statement, so it has its own narrow entry point rather
 * than weakening assertSingleReadStatement. The option list is skipped, then
 * the body goes through the exact same single SELECT/WITH validation.
 */
export function assertReadOnlyExplainStatement(raw: string): string {
  const q = raw.trim().replace(/;\s*$/, '').trim();
  if (!q) throw new PgReadQueryError('empty query');
  const start = skipSqlTrivia(q, 0);
  const explain = readSqlWord(q, start);
  if (!explain || explain.word.toLowerCase() !== 'explain') {
    throw new PgReadQueryError('only EXPLAIN SELECT / WITH…SELECT queries are allowed');
  }

  let bodyStart = skipSqlTrivia(q, explain.end);
  if (q[bodyStart] === '(') {
    const close = findSqlClosingParen(q, bodyStart);
    if (close === -1) throw new PgReadQueryError('EXPLAIN option list is not closed');
    bodyStart = skipSqlTrivia(q, close + 1);
  } else {
    bodyStart = consumeLegacyExplainOptions(q, bodyStart);
  }
  const body = q.slice(bodyStart).trim();
  if (!body) throw new PgReadQueryError('EXPLAIN must include a SELECT / WITH…SELECT statement');
  assertSingleReadStatement(body);
  return q;
}

/**
 * Execute a read-only query. The query is wrapped in `SELECT * FROM (…) LIMIT n+1`
 * so the row cap is enforced in the DB (not after pulling every row into memory).
 * A query whose output has duplicate column names must alias them (PG rejects a
 * subquery with duplicate output columns — a clear error the caller can fix).
 *
 * Defaults to `getOrgPgLosslessBigint()`, NOT `getOrgPg()` — this is arbitrary
 * agent-authored SQL, so a bigint/int8 column (a `pg_stat_statements.queryid`, a
 * snowflake id, …) must come back at EXACT precision rather than silently rounded
 * to the nearest representable `number` past 2^53 (EI-18789855771421275: the
 * rounded value is a syntactically valid bigint that matches zero rows — a
 * confidence-inspiring empty result, not an error). Pass `opts.client` to use a
 * different connection (e.g. a test fixture) — it is NOT defaulted to
 * getOrgPg() and callers overriding it should apply the same lossless-bigint
 * consideration if they pass a client that has the bigint→number override installed.
 */
export async function pgReadQuery(
  rawQuery: string,
  opts: { maxRows?: number; timeoutMs?: number; client?: OrgSql; positiveControlSql?: string } = {},
): Promise<PgReadQueryResult> {
  const isExplain = startsWithExplain(rawQuery);
  const query = isExplain ? assertReadOnlyExplainStatement(rawQuery) : assertSingleReadStatement(rawQuery);
  const positiveControlQuery = opts.positiveControlSql
    ? assertSingleReadStatement(opts.positiveControlSql)
    : null;
  const maxRows = Math.max(
    1,
    Math.min(PG_READ_QUERY_HARD_MAX_ROWS, Math.trunc(opts.maxRows ?? PG_READ_QUERY_DEFAULT_MAX_ROWS)),
  );
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_QUERY_DEFAULT_TIMEOUT_MS)),
  );

  const sql = opts.client ?? getOrgPgLosslessBigint().sql;
  // PgBouncer transaction pooling does not preserve the connect-time
  // search_path configured by getOrgPgLosslessBigint(). Mirror withWorkspace's
  // canonical predicate and re-apply it inside this transaction.
  const usePerTransactionOrgSearchPath = pgbouncerEnabled();
  const startedAt = Date.now();
  let rows: Record<string, unknown>[] = [];
  let positiveControlRows: Record<string, unknown>[] | null = null;
  const callDeadlineMs = timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;
  const work = sql.begin(async (tx) => {
    // READ ONLY must be set before the first data statement in the txn.
    await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await tx.unsafe(SET_LOCAL_UTC);
    if (usePerTransactionOrgSearchPath) {
      await tx.unsafe(SET_LOCAL_ORG_SEARCH_PATH);
    }
    if (positiveControlQuery) {
      positiveControlRows = (await tx.unsafe(
        `SELECT * FROM (${positiveControlQuery}) AS _pgq_positive_control LIMIT 2`,
      )) as unknown as Record<string, unknown>[];
    }
    const resultRows = (await tx.unsafe(
      isExplain ? query : `SELECT * FROM (${query}) AS _pgq LIMIT ${maxRows + 1}`,
    )) as unknown as Record<string, unknown>[];
    // EXPLAIN returns its plan as rows and cannot itself be wrapped in the
    // SELECT * / LIMIT shape above. Keep the same response cap at this seam;
    // the transaction timeout still bounds plan generation.
    rows = isExplain && resultRows.length > maxRows + 1 ? resultRows.slice(0, maxRows + 1) : resultRows;
  });
  // Bound the WHOLE call (not just server-side execution) — see withCallDeadline's doc.
  await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs));
  const elapsedMs = Date.now() - startedAt;

  const truncated = rows.length > maxRows;
  const capped = truncated ? rows.slice(0, maxRows) : rows;
  const fields = capped.length ? Object.keys(capped[0]) : [];
  // Assignment happens inside the transaction callback. TypeScript does not
  // model that awaited closure mutation and otherwise narrows the true branch
  // to `never`, even though the transaction has settled at this point.
  const measuredPositiveControlRows = positiveControlRows as Record<string, unknown>[] | null;
  const positiveControl = measuredPositiveControlRows
    ? {
        rows: measuredPositiveControlRows.slice(0, 1),
        rowCount: Math.min(measuredPositiveControlRows.length, 1),
        truncated: measuredPositiveControlRows.length > 1,
        fields: measuredPositiveControlRows.length ? Object.keys(measuredPositiveControlRows[0]) : [],
      }
    : undefined;
  return { rows: capped, rowCount: capped.length, truncated, fields, elapsedMs, positiveControl };
}

/**
 * Schema-validate a read-only statement against live PG WITHOUT executing it or
 * materializing any rows: parses + plans it via `EXPLAIN (COSTS OFF)` inside the same
 * READ ONLY / statement_timeout-bounded transaction `pgReadQuery` uses. A malformed
 * table/column/function reference surfaces the identical PG error info
 * (extractPgErrorInfo — hint/detail/code/position) a real run would, at zero cost and
 * with zero side effects.
 *
 * Built for EI-10514: schema-checking embedded SQL "replication drills" in rubric
 * criteria at propose time — 10/14 pot-coordination-health drills referenced
 * renamed/nonexistent tables and were unrunnable as written, and nothing caught it
 * until someone tried to actually run one.
 */
export async function explainReadQuery(
  rawQuery: string,
  opts: { timeoutMs?: number; client?: OrgSql } = {},
): Promise<{ ok: true } | { ok: false; error: PgErrorInfo }> {
  let query: string;
  try {
    query = assertSingleReadStatement(rawQuery);
  } catch (err) {
    return { ok: false, error: extractPgErrorInfo(err) };
  }
  const timeoutMs = Math.max(
    100,
    Math.min(PG_READ_QUERY_HARD_TIMEOUT_MS, Math.trunc(opts.timeoutMs ?? PG_READ_QUERY_DEFAULT_TIMEOUT_MS)),
  );
  const sql = opts.client ?? getOrgPg().sql;
  const callDeadlineMs = timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS;
  try {
    const work = sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      // Same TZ pin as pgReadQuery so a query VALIDATES under the session it will RUN under.
      await tx.unsafe(SET_LOCAL_UTC);
      await tx.unsafe(`EXPLAIN (COSTS OFF) ${query}`);
    });
    // Bound the WHOLE call the same way pgReadQuery does — see withCallDeadline's doc.
    await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(timeoutMs, callDeadlineMs));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: extractPgErrorInfo(err) };
  }
}

/**
 * A relation's shape — the `\d` answer, as data.
 *
 * WHY THIS EXISTS (plan bash-to-tool-substitution-2026-07-26, P-011): `\d` is a
 * psql CLIENT meta-command, not SQL, so it cannot be passed through
 * `dev:pg_query`'s statement path at all. The 2026-07-26 bash audit measured 88
 * `psql -c "\d …"` atoms with NO tool form — the single largest psql residue —
 * so an agent inspecting a table's columns, indexes or constraints had to shell
 * out no matter how well-routed it was.
 */
export interface RelationDescription {
  /** Resolved `schema.name`. */
  relation: string;
  /** table | view | materialized view | index | sequence … */
  kind: string;
  columns: Array<{ name: string; type: string; nullable: boolean; default: string | null; comment: string | null }>;
  indexes: Array<{ name: string; definition: string }>;
  constraints: Array<{ name: string; type: string; definition: string }>;
}

const RELATION_KIND: Record<string, string> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  i: 'index',
  S: 'sequence',
  p: 'partitioned table',
  f: 'foreign table',
  c: 'composite type',
  t: 'TOAST table',
};

const CONSTRAINT_TYPE: Record<string, string> = {
  p: 'PRIMARY KEY',
  f: 'FOREIGN KEY',
  u: 'UNIQUE',
  c: 'CHECK',
  x: 'EXCLUDE',
  t: 'TRIGGER',
  // PG 17+ materialises NOT NULL as a real pg_constraint row (contype 'n').
  // Without this the describe output showed a bare "n" for over half the
  // constraints on a typical table.
  n: 'NOT NULL',
};

interface RelationRow {
  schema: string;
  name: string;
  relkind: string;
}

/**
 * Resolve a possibly-bare relation reference to exactly one relation, using the
 * SAME schema preference as the query column-hint path — so `describe:
 * "work_items"` and a query mentioning `work_items` can never disagree about
 * which table they mean.
 */
async function resolveRelation(ref: string, client?: OrgSql): Promise<RelationRow | null> {
  const sql = client ?? getOrgPg().sql;
  const lower = ref.toLowerCase();
  const dot = lower.indexOf('.');
  const schemaPart = dot === -1 ? null : lower.slice(0, dot);
  const namePart = dot === -1 ? lower : lower.slice(dot + 1);

  const rows = (await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND lower(c.relname) = ${namePart}
       AND (${schemaPart}::text IS NULL OR lower(n.nspname) = ${schemaPart}::text)
     ORDER BY n.nspname
  `) as unknown as RelationRow[];

  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => preferSchema(a.schema, b.schema))[0];
}

/**
 * Describe one relation: columns, indexes and constraints in one shape.
 * Returns null when the relation does not exist, so the caller can say so
 * plainly instead of returning a confusingly empty description.
 */
export async function describeRelation(
  ref: string,
  opts: { client?: OrgSql } = {},
): Promise<RelationDescription | null> {
  const sql = opts.client ?? getOrgPg().sql;
  const relation = await resolveRelation(ref, opts.client);
  if (!relation) return null;

  // WI-37360: a column's own COMMENT is the one piece of schema metadata that can name
  // "this column is dead" / "read THAT one instead" directly on the thing an agent is
  // looking at — col_description() joined by ordinal_position (works for tables AND
  // views; COMMENT ON COLUMN is valid on both). Left NULL for a column nobody commented,
  // same as every other optional field here.
  const columnRows = (await sql`
    SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
           col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS comment
      FROM information_schema.columns c
     WHERE c.table_schema = ${relation.schema} AND c.table_name = ${relation.name}
     ORDER BY c.ordinal_position
  `) as unknown as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    comment: string | null;
  }>;

  const indexRows = (await sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = ${relation.schema} AND tablename = ${relation.name}
     ORDER BY indexname
  `) as unknown as Array<{ indexname: string; indexdef: string }>;

  const constraintRows = (await sql`
    SELECT con.conname AS name, con.contype::text AS contype, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${relation.schema} AND c.relname = ${relation.name}
     ORDER BY con.conname
  `) as unknown as Array<{ name: string; contype: string; definition: string }>;

  return {
    relation: `${relation.schema}.${relation.name}`,
    kind: RELATION_KIND[relation.relkind] ?? relation.relkind,
    columns: columnRows.map((r) => ({
      name: r.column_name,
      type: r.data_type || 'unknown',
      nullable: r.is_nullable === 'YES',
      default: r.column_default,
      comment: r.comment,
    })),
    indexes: indexRows.map((r) => ({ name: r.indexname, definition: r.indexdef })),
    constraints: constraintRows.map((r) => ({
      name: r.name,
      type: CONSTRAINT_TYPE[r.contype] ?? r.contype,
      definition: r.definition,
    })),
  };
}

/**
 * List relations matching a pattern — the bare `\d` / `\dt` answer.
 * `*` (or an empty pattern) lists everything outside the system schemas.
 */
export async function listRelations(
  pattern: string,
  opts: { client?: OrgSql; limit?: number } = {},
): Promise<Array<{ relation: string; kind: string }>> {
  const sql = opts.client ?? getOrgPg().sql;
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  // Translate the psql glob (`*`, `?`) into a SQL LIKE pattern.
  const like = pattern === '' || pattern === '*' ? '%' : pattern.toLowerCase().replace(/\*/g, '%').replace(/\?/g, '_');

  const rows = (await sql`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND (lower(n.nspname || '.' || c.relname) LIKE ${like} OR lower(c.relname) LIKE ${like})
     ORDER BY n.nspname, c.relname
     LIMIT ${limit}
  `) as unknown as RelationRow[];

  return rows.map((r) => ({
    relation: `${r.schema}.${r.name}`,
    kind: RELATION_KIND[r.relkind] ?? r.relkind,
  }));
}

/** Index-preserving mask: literal/comment characters become spaces so structural
 * scanning cannot be steered by a paren, AND or WHERE that lives inside a string,
 * while every offset still addresses the SAME character in the raw SQL. That is
 * what lets the emitted partition be sliced VERBATIM from the caller's text —
 * a jsonb key IS a string literal, so a stripped copy would erase it (the lesson
 * buildSilentNullPathAdvisory records). */
function maskSqlNoise(sql: string): string {
  const chars = sql.split('');
  for (const [from, to] of sqlLiteralAndCommentRanges(sql)) {
    for (let k = from; k < to && k < chars.length; k++) chars[k] = ' ';
  }
  return chars.join('');
}

/** Paren depth BEFORE each index, so top-level structure is one lookup. */
function sqlDepthPrefix(masked: string): Int32Array {
  const depth = new Int32Array(masked.length + 1);
  let cur = 0;
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === '(') cur++;
    else if (masked[k] === ')') cur--;
    depth[k + 1] = cur;
  }
  return depth;
}

/** Every `FILTER (WHERE …)` predicate, sliced from the raw SQL. */
function extractFilterPredicates(rawSql: string, masked: string): string[] {
  const out: string[] = [];
  const re = /\bfilter\s*\(/gi;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < masked.length; k++) {
      if (masked[k] === '(') depth++;
      else if (masked[k] === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) continue;
    out.push(
      rawSql
        .slice(open + 1, close)
        .replace(/^\s*where\b/i, '')
        .trim(),
    );
  }
  return out;
}

/** Top-level conjuncts of the FIRST WHERE clause, sliced from the raw SQL.
 *
 * The WHERE is located at whatever depth it actually sits at rather than only
 * at depth 0, because `SELECT EXISTS (SELECT 1 FROM t WHERE …)` — one of the two
 * shapes this advisory exists for — carries its predicates one paren deep. The
 * clause ends at the first sibling clause keyword or as soon as depth drops
 * BELOW the WHERE's own, which is the subquery's closing paren. */
function extractWhereConjuncts(rawSql: string, masked: string): string[] {
  const depth = sqlDepthPrefix(masked);
  // Prefer the SHALLOWEST `where`, not the lexically first one. In a census the
  // first `where` token belongs to a `FILTER (WHERE …)` bucket one paren deep,
  // while the clause carrying the query's shared scope sits at depth 0 and
  // LATER — taking the first would read a bucket as the scope and emit an
  // UNSCOPED partition, which would then trip `tenant_scope_required`. The same
  // rule still selects the only WHERE in `SELECT EXISTS (SELECT 1 … WHERE …)`.
  const whereRe = /\bwhere\b/gi;
  let whereAt: { index: number; length: number } | null = null;
  for (let m = whereRe.exec(masked); m; m = whereRe.exec(masked)) {
    if (!whereAt || depth[m.index]! < depth[whereAt.index]!) {
      whereAt = { index: m.index, length: m[0].length };
    }
  }
  if (!whereAt) return [];
  const base = depth[whereAt.index]!;
  const start = whereAt.index + whereAt.length;

  let end = masked.length;
  for (let k = start; k < masked.length; k++) {
    // depth[k + 1] is the depth AFTER consuming char k, so the first index at
    // which it drops below `base` IS the closing paren — end there, not one
    // past it, or the sliced predicate carries a stray `)`.
    if (depth[k + 1]! < base) {
      end = k;
      break;
    }
  }
  const tailRe = /\b(group\s+by|order\s+by|having|limit|offset|fetch|window|union|intersect|except)\b/gi;
  tailRe.lastIndex = start;
  for (let m = tailRe.exec(masked); m && m.index < end; m = tailRe.exec(masked)) {
    if (depth[m.index] === base) {
      end = m.index;
      break;
    }
  }

  const out: string[] = [];
  let last = start;
  const splitRe = /\b(?:and|or)\b/gi;
  splitRe.lastIndex = start;
  for (let m = splitRe.exec(masked); m && m.index < end; m = splitRe.exec(masked)) {
    if (depth[m.index] !== base) continue;
    out.push(rawSql.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(rawSql.slice(last, end));
  return out.map((s) => s.trim()).filter(Boolean);
}

const NON_SUMMING_MAX_DIMENSIONS = 3;
/** Scope predicates are carried into the generated WHERE instead of becoming
 * dimensions — partitioning BY the tenant would both change the question and
 * make the suggested query trip `tenant_scope_required`. */
const NON_SUMMING_SCOPE_RE = /\b(workspace_id|harness_slug|hive_slug|pot_slug)\b/i;
const NON_SUMMING_JSONB_RE =
  /->>?|#>>?|\bjsonb_typeof\s*\(|\bjsonb_exists\s*\(|\bjsonb_path_exists\s*\(/i;

/**
 * Flag a SCALAR aggregate whose buckets cannot be shown to SUM
 * (WI-10002034, EI-23761509275982493).
 *
 * The measured failure: a census written as three `count(*) FILTER (WHERE …)`
 * expressions returned total 96 / bricked 0 / healthy 2. Those DO NOT SUM — 94
 * rows fell through every FILTER via three-valued logic, because a jsonb path
 * that is ABSENT yields NULL and NULL fails every comparison, `<>` included.
 * The output was a perfectly well-formed row of numbers, so it read as a
 * finding rather than as a broken instrument, and the conclusion drawn from it
 * INVERTED once the same question was re-asked as an exhaustive `GROUP BY`
 * where every row lands in exactly one labelled cell.
 *
 * That is the entire signature of this defect: the wrong answer is shaped
 * exactly like the right one, so it cannot be caught by reading the result. It
 * has to be caught at the moment the query runs — which is what this is for.
 *
 * Deliberately CONSERVATIVE, because a false positive on a correct census is
 * what would train callers to skim past the seam's other advisories. It stays
 * silent when the caller already partitioned (`GROUP BY` present, so the cells
 * are on screen), when no scalar aggregate is present, and when the
 * discriminating predicate is a single non-jsonb dimension — one plain boolean
 * column cannot hide a fall-through worth a full partition.
 */
export interface PredicatePartitionPlan {
  /** The relation the partition runs against. */
  relation: string;
  /** The discriminating expressions, capped, in caller order. */
  dimensions: string[];
  /** Discriminators beyond the cap, named so the preview cannot imply completeness. */
  droppedDimensions: string[];
  /** Tenant predicates, kept as WHERE so the partition holds the caller's scope. */
  scope: string[];
  touchesJsonb: boolean;
}

/** One partition cell as executed: the dimension values plus that cell's size. */
export interface PredicatePartitionCell {
  values: (string | null)[];
  rows: number;
}

export interface PredicatePartitionData {
  cells: PredicatePartitionCell[];
  /** 2-3 rows drawn from the fall-through population, rendered as text. */
  samples: string[];
  /** Total rows in the partition, for the sum check. */
  totalRows?: number;
  truncated?: boolean;
}

/**
 * THE shared primitive (AUTO-BAR-R-001-P-002). Every surface that wants a
 * predicate partition or a NULL profile calls THIS — the query surface here and
 * the claim-spec surface in P-005 — so the two cannot report different
 * partitions for the same predicate. It deliberately lives in pg-read-query
 * rather than a module of its own: the analysis needs this file's
 * stripSqlLiteralsAndComments, sqlLiteralAndCommentRanges and
 * extractReferencedTables, so a separate module would import back into this one
 * and form a cycle. The clause's falsifier is that the computation appears in
 * MORE THAN ONE module, which one exported function in one module satisfies.
 *
 * Returns null when the read does not qualify, which is the boundary clause
 * p002.narrow-reads-unchanged: fewer than two dimensions and no jsonb path must
 * come back exactly as it does today.
 */
export function planPredicatePartition(rawSql: string): PredicatePartitionPlan | null {
  const stripped = stripSqlLiteralsAndComments(rawSql);

  // Already partitioned: the cells are on screen, so nothing is hidden.
  if (/\bgroup\s+by\b/i.test(stripped)) return null;
  if (!/\bcount\s*\(/i.test(stripped) && !/\bexists\s*\(/i.test(stripped)) return null;

  const tables = extractReferencedTables(rawSql);
  if (!tables.length) return null;
  const relation = tables[0]!;

  const masked = maskSqlNoise(rawSql);
  const filters = extractFilterPredicates(rawSql, masked);
  const whereConjuncts = extractWhereConjuncts(rawSql, masked);
  // FILTER buckets ARE the caller's dimensions when present; the surrounding
  // WHERE is then a shared scope rather than a discriminator.
  const predicates = filters.length ? filters : whereConjuncts;
  if (!predicates.length) return null;

  const scope: string[] = [];
  const dimensions: string[] = [];
  const addScope = (text: string): void => {
    if (text && !scope.includes(text)) scope.push(text);
  };
  for (const predicate of predicates) {
    const text = predicate.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (NON_SUMMING_SCOPE_RE.test(text)) addScope(text);
    else if (!dimensions.includes(text)) dimensions.push(text);
  }
  // When FILTER buckets supplied the dimensions the WHERE was never consulted,
  // so its scope predicates would be dropped from the suggested partition.
  if (filters.length) {
    for (const predicate of whereConjuncts) {
      const text = predicate.replace(/\s+/g, ' ').trim();
      if (NON_SUMMING_SCOPE_RE.test(text)) addScope(text);
    }
  }
  if (!dimensions.length) return null;

  const touchesJsonb = dimensions.some((d) => NON_SUMMING_JSONB_RE.test(d));
  if (!touchesJsonb && dimensions.length < 2) return null;

  return {
    relation,
    dimensions: dimensions.slice(0, NON_SUMMING_MAX_DIMENSIONS),
    droppedDimensions: dimensions.slice(NON_SUMMING_MAX_DIMENSIONS),
    scope,
    touchesJsonb,
  };
}

/**
 * The PARTITION SQL a plan implies. Exported because the claim-spec surface
 * (P-005) must issue the SAME statement the query surface issues — an
 * equivalent-looking statement rebuilt independently is exactly how the two
 * surfaces come to disagree.
 */
export function predicatePartitionSql(plan: PredicatePartitionPlan, limit = 50): string {
  const shown = plan.dimensions;
  return (
    'SELECT\n' +
    shown.map((d, i) => `       (${d}) AS d${i + 1}`).join(',\n') +
    ',\n       count(*) AS row_count\n' +
    `  FROM ${plan.relation}` +
    (plan.scope.length ? `\n WHERE ${plan.scope.join('\n   AND ')}` : '') +
    `\n GROUP BY ${shown.map((_, i) => i + 1).join(', ')}` +
    `\n ORDER BY ${shown.length + 1} DESC\n LIMIT ${limit};`
  );
}

/**
 * 2-3 rows drawn from the FALL-THROUGH population specifically — the rows that
 * satisfied no branch. Sampling the relation at large would return rows the
 * caller already believes in; the useful sample is the one they cannot see.
 */
export function predicatePartitionSampleSql(plan: PredicatePartitionPlan, limit = 3): string {
  const nullish = plan.dimensions.map((d) => `(${d}) IS NULL`).join(' OR ');
  const where = [...plan.scope, `(${nullish})`].join('\n   AND ');
  return `SELECT t::text AS sample\n  FROM ${plan.relation} t\n WHERE ${where}\n LIMIT ${limit};`;
}

/**
 * Render the preview onto the advisory channel (AUTO-BAR-R-003-P-002: the same
 * channel the tenant-scope warning already uses, with no new tool, verb, table
 * or configuration key). With `data` it carries the EXECUTED partition, the
 * per-dimension NULL counts and the sample rows the bar requires; without it,
 * it degrades to the statements the caller can run — a probe that failed must
 * not silently look like a probe that found nothing.
 */
export function renderPredicatePartition(
  plan: PredicatePartitionPlan,
  data?: PredicatePartitionData,
): string {
  const { relation, touchesJsonb, dimensions } = plan;
  // Built by the shared helper, never re-derived here: the claim-spec surface
  // issues this same statement, and two independently-built 'equivalent'
  // statements is precisely how the two surfaces come to disagree.
  const partitionSql = predicatePartitionSql(plan);

  const trigger = touchesJsonb
    ? 'at least one discriminating predicate reads a jsonb path, which yields NULL when the key is ABSENT'
    : `this query discriminates on ${dimensions.length} independent dimensions`;

  return (
    `⚠ buckets may not sum: this returns a SCALAR over ${relation}, and ${trigger}. ` +
    'A NULL operand makes a comparison UNKNOWN rather than false, so such a row satisfies NO branch — ' +
    'it is silently absent from every bucket AND from the filtered total, while the numbers still come ' +
    'back well-formed (WI-10002034: a measured census reported 96/0/2 while 94 rows fell through every ' +
    'FILTER, and re-asking it as an exhaustive partition INVERTED the conclusion). A scalar cannot show ' +
    'you this, because the wrong answer is shaped exactly like the right one. Re-ask it as an exhaustive ' +
    'partition, where every row lands in exactly one labelled cell — a NULL in any `d<N>` column IS the ' +
    `fall-through population, and the cells MUST add up to the unfiltered total:\n${partitionSql}\n` +
    'Check that the cells sum before quoting any bucket as a finding.' +
    renderPartitionData(plan, data)
  );
}

/**
 * The EXECUTED half (AUTO-BAR-R-002-P-002): the partition cells, a per-dimension
 * NULL count, and 2-3 fall-through sample rows, rendered onto the advisory
 * string. Absent `data` this contributes nothing and the caller still gets the
 * statements — a probe that could not run must never render as a probe that ran
 * and found nothing.
 */
function renderPartitionData(plan: PredicatePartitionPlan, data?: PredicatePartitionData): string {
  if (!data) return '';
  const labels = plan.dimensions.map((_, i) => `d${i + 1}`);
  if (!data.cells.length) {
    return (
      '\nPARTITION: the probe returned no cells, so the fall-through population is UNMEASURED here — ' +
      'that is not the same as zero. Run the statement above before relying on the scalar.'
    );
  }

  const total = data.cells.reduce((sum, c) => sum + c.rows, 0);
  const nullCounts = labels.map(
    (label, i) =>
      `${label}=${data.cells.filter((c) => c.values[i] === null).reduce((s, c) => s + c.rows, 0)}`,
  );
  const rendered = data.cells
    .slice(0, 12)
    .map((c) => `  ${c.values.map((v) => (v === null ? 'NULL' : v)).join(' | ')} → ${c.rows}`)
    .join('\n');
  const samples = data.samples.length
    ? `\nFALL-THROUGH SAMPLE (${data.samples.length} row(s)):\n` +
      data.samples
        .map((s) => `  ${s.length > 300 ? `${s.slice(0, 300)}…` : s}`)
        .join('\n')
    : '\nFALL-THROUGH SAMPLE: none — no row carries a NULL in any dimension, so nothing fell through.';

  return (
    `\nPARTITION (${labels.join(' | ')} → rows)${data.truncated ? ', TRUNCATED' : ''}:\n${rendered}\n` +
    `PER-DIMENSION NULL ROWS: ${nullCounts.join(', ')}\n` +
    `PARTITION TOTAL: ${total}${typeof data.totalRows === 'number' ? ` of ${data.totalRows}` : ''}` +
    (plan.droppedDimensions.length
      ? `\nNOT PARTITIONED (beyond the cap): ${plan.droppedDimensions.join('; ')} — the cells above are ` +
        'exhaustive only over the dimensions shown.'
      : '') +
    samples
  );
}

/**
 * Thin wrapper kept for the sql-shape advisory list, which composes pure
 * `(sql) => string | null` builders and has no database handle. The EXECUTED
 * preview is attached by the query surface, which does.
 */
export function buildNonSummingPartitionAdvisory(rawSql: string): string | null {
  const plan = planPredicatePartition(rawSql);
  return plan ? renderPredicatePartition(plan) : null;
}

/** Default cap on rendered partition cells; one more is fetched to detect truncation. */
export const PREDICATE_PARTITION_CELL_LIMIT = 50;
/** The probe rides the caller's own read; keep it short enough to never dominate it. */
export const PREDICATE_PARTITION_TIMEOUT_MS = 5_000;

/**
 * The UNFILTERED total the partition cells must add up to — the relation under
 * the caller's scope and nothing else. Built here beside the other two
 * statements for the reason named on {@link predicatePartitionSql}: the sum
 * check is only meaningful if the total and the cells come from the same
 * scope, and two independently-built "equivalent" statements is exactly how
 * they come to disagree.
 */
export function predicatePartitionTotalSql(plan: PredicatePartitionPlan): string {
  return (
    `SELECT count(*) AS total\n  FROM ${plan.relation}` +
    (plan.scope.length ? `\n WHERE ${plan.scope.join('\n   AND ')}` : '') +
    ';'
  );
}

/**
 * The EXECUTED half (AUTO-BAR-R-002-P-002). Issues the statements
 * {@link renderPredicatePartition} would otherwise only SUGGEST — the
 * exhaustive partition, the unfiltered total, and a fall-through sample —
 * through the same bounded read transaction the rest of this surface uses, so
 * the caller gets the cells, the per-dimension NULL counts and 2-3 sample rows
 * ALONGSIDE their scalar instead of homework.
 *
 * FAILS OPEN to `undefined`, and that is load-bearing rather than defensive: a
 * probe that could not run must degrade to the statements-only rendering, NOT
 * to a rendering that reports no cells. `renderPartitionData` keeps those two
 * cases textually distinct because an empty-cells rendering reads as "nothing
 * fell through" — the exact false negative this advisory exists to prevent,
 * reintroduced by its own fix.
 */
export async function executePredicatePartition(
  plan: PredicatePartitionPlan,
  opts: { client?: OrgSql; timeoutMs?: number; cellLimit?: number; sampleLimit?: number } = {},
): Promise<PredicatePartitionData | undefined> {
  const cellLimit = Math.max(1, Math.trunc(opts.cellLimit ?? PREDICATE_PARTITION_CELL_LIMIT));
  const sampleLimit = Math.max(1, Math.trunc(opts.sampleLimit ?? 3));
  try {
    return await boundedPgReadTxn(
      async (tx) => {
        // cellLimit + 1: a partition sitting exactly ON the cap must report as
        // TRUNCATED rather than as exhaustive, or the sum check the advisory
        // asks the reader to run silently becomes unsatisfiable.
        const cellRows = (await tx.unsafe(
          predicatePartitionSql(plan, cellLimit + 1),
        )) as unknown as Record<string, unknown>[];
        const truncated = cellRows.length > cellLimit;
        const cells: PredicatePartitionCell[] = (truncated ? cellRows.slice(0, cellLimit) : cellRows).map(
          (row) => ({
            values: plan.dimensions.map((_, i) => {
              const value = row[`d${i + 1}`];
              return value === null || value === undefined ? null : String(value);
            }),
            rows: Number(row.row_count ?? 0),
          }),
        );

        const totalRow = (await tx.unsafe(
          predicatePartitionTotalSql(plan),
        )) as unknown as Record<string, unknown>[];
        const rawTotal = totalRow[0]?.total;
        const totalRows = rawTotal === null || rawTotal === undefined ? undefined : Number(rawTotal);

        const sampleRows = (await tx.unsafe(
          predicatePartitionSampleSql(plan, sampleLimit),
        )) as unknown as Record<string, unknown>[];
        const samples = sampleRows.map((row) => String(row.sample ?? ''));

        return {
          cells,
          samples,
          ...(typeof totalRows === 'number' && Number.isFinite(totalRows) ? { totalRows } : {}),
          ...(truncated ? { truncated } : {}),
        } satisfies PredicatePartitionData;
      },
      {
        ...(opts.client ? { client: opts.client } : {}),
        timeoutMs: opts.timeoutMs ?? PREDICATE_PARTITION_TIMEOUT_MS,
      },
    );
  } catch {
    // Deliberately swallowed: see the fail-open note above. The caller renders
    // the statements, which is strictly more useful than an error about a
    // probe the caller never asked for.
    return undefined;
  }
}

/**
 * The one call the query surface makes: plan, probe, render. Returns null when
 * the read does not qualify (the p002.narrow-reads-unchanged boundary), and the
 * statements-only string when the probe could not run.
 */
export async function buildExecutedPartitionAdvisory(
  rawSql: string,
  opts: { client?: OrgSql; timeoutMs?: number } = {},
): Promise<string | null> {
  const plan = planPredicatePartition(rawSql);
  if (!plan) return null;
  return renderPredicatePartition(plan, await executePredicatePartition(plan, opts));
}
