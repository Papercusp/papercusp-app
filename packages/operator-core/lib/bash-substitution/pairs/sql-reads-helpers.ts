/**
 * Translate a hand-written `information_schema` query into the `describe` call
 * that answers it (plan `sql-escape-tool-routing-2026-08-12`, P-009).
 *
 * Split out of `sql-reads.ts` for the same reason `model-drift-helpers.ts` exists
 * beside the service pairs: these are the functions a drift test needs to call
 * directly, and importing them from the pair module would drag the whole pair
 * registry into a test that is only asking "does this query translate".
 *
 * Everything here is a best-effort READ of a query's text. Returning null is
 * always a legitimate answer and is the honest one whenever the shape is not
 * unambiguous — a wrong translation would route an agent to a describe call that
 * answers a different question, which is worse than leaving the query alone.
 */
// WI-38339: `notTerminal` is servable only for a NOT-IN list that IS the canonical
// terminal union, so the comparison must read the SOURCE constant. Its own header
// records why nothing here may re-list the words: hand-copied terminal sets drifted
// and scored ~88% of finished units as stranded.
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/** A SQL string literal's contents, for a `col = 'value'` predicate. */
function literalAfter(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s*=\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/** The contents of a `col LIKE '…'` / `col ILIKE '…'` predicate. */
function likePatternFor(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s+i?like\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/**
 * `… WHERE table_schema='harness_shared' AND table_name='work_items'` →
 * `harness_shared.work_items`.
 *
 * The schema is REQUIRED even though `describe` would accept a bare name,
 * because a bare relation name can resolve in several schemas here (per-harness
 * clones make that ordinary) and silently describing the wrong one is the single
 * most expensive way this translation can be wrong.
 */
export function describeRelationFromColumnsQuery(atom: string): string | null {
  const table = literalAfter(atom, 'table_name');
  if (!table) return null;
  const schema = literalAfter(atom, 'table_schema');
  if (!schema) return null;
  return `${schema}.${table}`;
}

/** `LIMIT 25` → 25. */
function limitOf(atom: string): number | null {
  const n = /\blimit\s+(\d{1,4})\b/i.exec(atom)?.[1];
  return n ? Number(n) : null;
}

/** Render a tool call the way the routing rows and advisories write one. */
function renderCall(verb: string, args: Array<[string, string]>): string {
  if (args.length === 0) return `${verb} {}`;
  return `${verb} { ${args.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
}

/**
 * `… WHERE table_name ILIKE '%coord%'` → `*coord*`
 * `… WHERE table_schema='harness_shared'` → `harness_shared.*`
 *
 * The glob is `listRelations`' own dialect: `*` becomes `%` and the match runs
 * against `lower(schema.name)` OR `lower(name)`, so a bare fragment reaches the
 * same rows the hand-written ILIKE does. A query carrying BOTH a schema and a
 * name fragment translates to the schema-qualified glob, which is the narrower
 * (and therefore safer) of the two readings.
 */
export function describePatternFromTablesQuery(atom: string): string | null {
  const schema = literalAfter(atom, 'table_schema');
  const fragment = likePatternFor(atom, 'table_name');

  if (fragment) {
    const glob = fragment.replace(/%/g, '*');
    return schema ? `${schema}.${glob}` : glob;
  }
  // An EXACT name (`table_name = 'spawned_agents'`) is a glob with no wildcards
  // in it: listRelations lowercases both sides and runs LIKE, so a pattern with
  // no `%` is an equality test. Worth handling rather than declining, because
  // "does this relation exist, and in which schema" is one of the questions the
  // corpus asks most and it is the cheapest of all to answer.
  const exact = literalAfter(atom, 'table_name');
  if (exact) return schema ? `${schema}.${exact}` : exact;
  if (schema) return `${schema}.*`;
  return null;
}

/* ─── TRANCHE 2 ───────────────────────────────────────────────────────────────
 * The three verbs this plan itself shipped. Each translator reads the PREDICATES
 * of a real query and renders the typed call that asks the same question.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * The column an agent used for the migration IDENTIFIER.
 *
 * `schema_migrations` has exactly three columns — filename, applied_at, sha256
 * (verified against the live catalog, not the tool's prose) — yet the corpus
 * queries `name` and `version` repeatedly. Those calls ERRORED: the corpus is
 * filtered to `status='ok'`, but that is the INVOCATION's status, so a query
 * whose SQL failed still appears here. We translate them anyway and deliberately:
 * the agent's QUESTION ("did migration 762 apply?") is one `db:migrations`
 * answers exactly, and a typed `like` arg cannot misname a column. A query that
 * could never return a row is the strongest possible evidence for routing, not a
 * reason to exclude it.
 */
const MIGRATION_ID_COL = String.raw`(?:filename|name|version)`;

/**
 * `WHERE filename LIKE '727%' ORDER BY filename DESC LIMIT 8`
 *   → `db:migrations { like: "727%", limit: 8 }`
 *
 * Null whenever nothing bounds the read: a bare unlimited `SELECT … FROM
 * schema_migrations` is a full-ledger dump (~800 rows) and `db:migrations` caps
 * at 200, so claiming it would be claiming a different answer.
 */
export function migrationsCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const likePattern =
    new RegExp(String.raw`\b${MIGRATION_ID_COL}\s+i?like\s*'([^']+)'`, 'i').exec(atom)?.[1] ??
    new RegExp(String.raw`\b${MIGRATION_ID_COL}\s*=\s*'([^']+)'`, 'i').exec(atom)?.[1] ??
    null;
  // `like` is passed through verbatim: the tool honours a pattern that already
  // carries %/_ and PREFIXES a bare one, which is exactly what the corpus's
  // '727%' / '795-%' / '%797%' / '803-….sql' forms need.
  if (likePattern) args.push(['like', JSON.stringify(likePattern)]);

  const since = /\bapplied_at\s*>=?\s*(?:timestamptz\s*)?'([^']+)'/i.exec(atom)?.[1] ?? null;
  const until = /\bapplied_at\s*<=?\s*(?:timestamptz\s*)?'([^']+)'/i.exec(atom)?.[1] ?? null;
  if (since) args.push(['since', JSON.stringify(since)]);
  if (until) args.push(['until', JSON.stringify(until)]);

  // `order` is always DESC in the tool. A query ordering by applied_at needs the
  // non-default key; ordering by filename IS the default and adds nothing.
  if (/\border\s+by\s+applied_at\b/i.test(atom)) args.push(['order', '"applied_at"']);

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;
  return renderCall('db:migrations', args);
}

/** The real `test_runs.status` domain — a CHECK constraint, not a convention. */
const TEST_RUN_STATUSES = ['pass', 'fail', 'skip', 'cancelled', 'error', 'running'] as const;

/**
 * Map a status literal an agent WROTE onto one that can actually match.
 *
 * `status='failed'` and `status='passed'` are the corpus's two most common
 * status predicates and NEITHER can ever match a row: the column is
 * CHECK-constrained to pass|fail|skip|cancelled|error|running. This is the
 * failure mode that makes this pair worth more than convenience — see the pair
 * header for what each of the two wrong forms actually returns.
 */
function normaliseTestStatus(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if ((TEST_RUN_STATUSES as readonly string[]).includes(v)) return v;
  if (v === 'passed') return 'pass';
  if (v === 'failed') return 'fail';
  if (v === 'skipped') return 'skip';
  return null;
}

/** Every status literal named in an `= 'x'` / `IN ('a','b')` predicate. */
function statusLiteralsIn(atom: string): string[] | null {
  const inList = /\bstatus\s+(?:not\s+)?in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  if (inList) {
    const raw = [...inList.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    const mapped = raw.map(normaliseTestStatus);
    return mapped.some((m) => m === null) ? null : [...new Set(mapped as string[])];
  }
  const one = /\bstatus\s*(?:=|<>|!=)\s*'([^']*)'/i.exec(atom)?.[1];
  if (one === undefined) return null;
  const mapped = normaliseTestStatus(one);
  return mapped ? [mapped] : null;
}

/**
 * `WHERE file_path LIKE '%adv-agent-detail%' AND status='fail' AND started_at >
 * now() - interval '3 hours' ORDER BY started_at DESC LIMIT 15`
 *   → `testing:runs { filePath: "%adv-agent-detail%", status: ["fail"], sinceHours: 3, limit: 15 }`
 *
 * A NEGATED status predicate translates to its COMPLEMENT over the real enum
 * rather than to a guess at intent: `status <> 'passed'` becomes every status but
 * `pass`, which is what the agent asked for and — critically — not what their SQL
 * returned.
 */
export function testRunsCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const filePath =
    /\bfile(?:_path)?\s+i?like\s*'([^']+)'/i.exec(atom)?.[1] ??
    /\bfile(?:_path)?\s*=\s*'([^']+)'/i.exec(atom)?.[1] ??
    null;
  if (filePath) args.push(['filePath', JSON.stringify(filePath)]);

  const literals = statusLiteralsIn(atom);
  if (literals) {
    const negated = /\bstatus\s+not\s+in\s*\(/i.test(atom) || /\bstatus\s*(?:<>|!=)\s*'/i.test(atom);
    const selected = negated ? TEST_RUN_STATUSES.filter((s) => !literals.includes(s)) : literals;
    if (selected.length > 0) args.push(['status', `[${selected.map((s) => JSON.stringify(s)).join(', ')}]`]);
  }

  const source = /\bsource\s*=\s*'(ci|local|admin-ui)'/i.exec(atom)?.[1];
  if (source) args.push(['source', JSON.stringify(source.toLowerCase())]);

  const commitSha = /\bcommit_sha\s*=\s*'([0-9a-f]{6,40})'/i.exec(atom)?.[1];
  if (commitSha) args.push(['commitSha', JSON.stringify(commitSha)]);

  const runGroup = /\brun_group_id\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (runGroup) args.push(['runGroup', JSON.stringify(runGroup)]);

  // `started_at > now() - interval '90 minutes'`. `since`/`sinceHours` filter on
  // started_at; a window written against finished_at is close but not identical,
  // and the pair's cover() declines those rather than papering over the shift.
  const interval = /\bnow\(\)\s*-\s*interval\s*'(\d+(?:\.\d+)?)\s*(hour|minute|day)s?'/i.exec(atom);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2]!.toLowerCase();
    const hours = unit === 'hour' ? n : unit === 'minute' ? n / 60 : n * 24;
    args.push(['sinceHours', String(Number(hours.toFixed(2)))]);
  }

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;

  // `latestPerFile` defaults TRUE, or FALSE when filePath is given — and raw SQL
  // never collapses unless it says DISTINCT. Left implicit, the default would
  // answer a different question than the query being replaced: a file that
  // failed an hour ago and has passed since drops out of a collapsed read but is
  // present in the SQL's. So it is made EXPLICIT wherever the default would
  // disagree, rather than trusted to line up.
  const collapses = /\bdistinct\b/i.test(atom);
  const hasFilePath = args.some(([k]) => k === 'filePath');
  if (!hasFilePath && !collapses) args.push(['latestPerFile', 'false']);

  return renderCall('testing:runs', args);
}

/**
 * `WHERE title ILIKE '%tmp_pack%' AND state='open' ORDER BY created_at DESC
 * LIMIT 10` → `issues:list { q: "tmp_pack", state: "open", limit: 10 }`
 *
 * `q` matches title + body, so a title-only ILIKE routes to a SUPERSET. That is
 * stated in the covered expression rather than hidden — the reader has to be able
 * to see that the two are not identical.
 */
export function issuesListCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  const q = /\b(?:title|body)\s+i?like\s*'%?([^'%]+)%?'/i.exec(atom)?.[1] ?? null;
  if (q) args.push(['q', JSON.stringify(q)]);

  // `status` is read as `state`. There IS no `status` column on
  // engineer_issues — those queries errored — but the intent is unambiguous, and
  // dropping the predicate instead would render a call returning MORE rows than
  // the query asked for, which is the one thing a translation must never do.
  const state = (/\bstate\s*=\s*'([a-z_]+)'/i.exec(atom)?.[1] ?? /\bstatus\s*=\s*'([a-z_]+)'/i.exec(atom)?.[1]) as
    | string
    | undefined;
  if (state) args.push(['state', JSON.stringify(state.toLowerCase())]);

  // Only bug+change come back by default, so a `kind = 'bug'` predicate that is
  // not translated silently widens the result to include `change`.
  const kindList = /\bkind\s+in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  const kinds = kindList
    ? [...kindList.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
    : ((k) => (k ? [k] : []))(/\bkind\s*=\s*'([a-z]+)'/i.exec(atom)?.[1]);
  if (kinds.length > 0) args.push(['kinds', `[${kinds.map((k) => JSON.stringify(k.toLowerCase())).join(', ')}]`]);

  const assignee = /\bassignee\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (assignee) args.push(['assignee', JSON.stringify(assignee)]);

  const scope = /\bscope\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (scope) args.push(['scope', JSON.stringify(scope)]);

  const severity = /\bseverity\s*=\s*'(critical|major|minor|nit)'/i.exec(atom)?.[1];
  if (severity) args.push(['severity', JSON.stringify(severity.toLowerCase())]);

  // `body` is 76% of this read's bytes and omitted by default, so a query that
  // PROJECTS it has to ask for it back explicitly.
  if (/\bleft\s*\(\s*body\b|\bselect[^;]*\bbody\b/i.test(atom)) args.push(['includeBody', 'true']);

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  if (args.length === 0) return null;
  return renderCall('issues:list', args);
}

/**
 * The gate-health read: `SELECT metadata->'gate_health'->>'consecutiveReds',
 * metadata->'gate_health'->'inFlightRetriage' … FROM harness_shared.routines`.
 *
 * 708 calls / 110 distinct agents over the 14d retention — the largest single
 * cluster the SQL audit measured, and the last one still routing around the
 * catalog. (The census reports this relation at 478/105 because it runs a 7-day
 * window; same cluster, half the window. Do not "reconcile" the two.)
 *
 * `routines:list` has served this since P-002 put `gate_health` at the HEAD of
 * `healthOf()`'s allowlist — the whole object, not a field subset — beside the
 * `nextFireAt`/`lastFiredAt` the same queries read. The capability was never the
 * gap and the tool's own guidance already names this cluster; what never existed
 * was the ROUTING ROW, which is the surface an agent consults on the way to
 * writing the SQL. That is Class C, not Class A, and it is why this pair exists.
 */
export function gateHealthCallFromQuery(atom: string): string | null {
  if (!/\bgate_health\b/i.test(atom)) return null;
  const args: Array<[string, string]> = [];

  // ── Which ROW(S) the query selects ──────────────────────────────────────────
  // `routines:list` has no `target_role` filter and its `name` takes exactly ONE
  // routine (list.ts args: installSlug | name | q | group | rollup). But this
  // corpus selects the row by `target_role='system:<name>'` in 19 of 20 sampled
  // atoms, not by `name`. So the mapping has to go through target_role, and the
  // multi-routine case has to be recognised rather than flattened.
  //
  // The bug this shape exists to prevent: defaulting to `name:'green-checkpoint'`
  // whenever no `name =` predicate is found. That is right for the single-routine
  // reads, and silently WRONG for `target_role IN (a,b,c)` — it would return one
  // row where the SQL returned three, while `cover()` reported it substitutable.
  // A narrowing translation is the exact over-claim D-006 forbids.
  const explicitName =
    /\bname\s*=\s*'([^']+)'/i.exec(atom)?.[1] ?? /\bname\s+i?like\s*'%?([^'%]+)%?'/i.exec(atom)?.[1] ?? null;

  // `target_role IN ('system:a','system:b')` — a multi-routine read.
  const roleInList = /\btarget_role\s+in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  const rolesInList = roleInList ? [...roleInList.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const singleRole = /\btarget_role\s*=\s*'([^']+)'/i.exec(atom)?.[1] ?? null;

  // A routine's target_role is `system:<name>`; the row's own `name` is the tail.
  const roleToName = (role: string): string => role.replace(/^system:/i, '');

  if (explicitName) {
    args.push(['name', JSON.stringify(explicitName)]);
  } else if (rolesInList.length > 1) {
    // Deliberately NO `name` arg: the caller wanted several routines, and the
    // faithful substitution is the unfiltered (install-scoped) list they read the
    // rows out of — a superset, never a silently narrower answer.
  } else if (rolesInList.length === 1) {
    args.push(['name', JSON.stringify(roleToName(rolesInList[0]))]);
  } else if (singleRole) {
    args.push(['name', JSON.stringify(roleToName(singleRole))]);
  } else {
    // No row predicate at all. `gate_health` is written only onto the
    // green-checkpoint routine, so such a query is still asking about that one
    // row: naming it returns what the SQL would have found without scanning an
    // unbounded table.
    args.push(['name', JSON.stringify('green-checkpoint')]);
  }

  const installSlug = /\binstall_slug\s*=\s*'([^']+)'/i.exec(atom)?.[1];
  if (installSlug) args.push(['installSlug', JSON.stringify(installSlug)]);

  return renderCall('routines:list', args);
}

/** Every `'literal'` inside an `IN ( … )` list for `column`. */
function inListFor(atom: string, column: string): string[] {
  const list = new RegExp(String.raw`\b${column}\s+in\s*\(([^)]*)\)`, 'i').exec(atom)?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
}

/* ── WI-38339 readers: the four slices the widened `work_items:list` can ask for ──
 *
 * Kept beside `inListFor` because they share its one real subtlety: `\bstatus\s+in`
 * cannot match `status NOT IN (…)` (the `not` sits between), so the positive and
 * negative list readers below never claim each other's atoms.
 */

/** The SELECT list — everything between `select` and the first `from`. */
export function selectListOf(atom: string): string {
  return /\bselect\b([\s\S]*?)\bfrom\b/i.exec(atom)?.[1] ?? '';
}

/** `status IN ('a','b')` / `state IN (…)` → lowercased members. */
export function inStatesFor(atom: string): string[] {
  return [...inListFor(atom, 'status'), ...inListFor(atom, 'state')].map((s) => s.toLowerCase());
}

/** `status NOT IN ('done','dropped',…)` → lowercased members. */
export function notInStatesFor(atom: string): string[] {
  const list = /\b(?:status|state)\s+not\s+in\s*\(([^)]*)\)/i.exec(atom)?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!.toLowerCase()) : [];
}

/**
 * SET-equality against {@link ANY_FAMILY_TERMINAL_STATES} — the whole servability
 * test for `notTerminal`, and the reason it is a set comparison rather than a
 * regex. Measured over 7d of real agent SQL naming `work_items`: 100 statements
 * carry a `NOT IN` state list, and the dominant ones enumerate EXACTLY this union
 * in a dozen different ORDERS — i.e. the corpus is full of hand-copied terminal
 * sets, which is precisely the drift the constant exists to end.
 *
 * A PROPER SUBSET (`NOT IN ('done','dropped')`, 4 calls) must NOT be claimed:
 * `notTerminal` would additionally exclude `resolved`/`closed`/`passed`/
 * `deprecated`, answering with FEWER rows than the query asked for — the silent
 * narrowing fact `substitution-pair-narrowing-over-claim` records. A SUPERSET is
 * refused for the mirror reason. Order and case are irrelevant; membership is not.
 */
export function isCanonicalTerminalUnion(states: readonly string[]): boolean {
  const want = new Set(ANY_FAMILY_TERMINAL_STATES.map((s) => s.toLowerCase()));
  const got = new Set(states);
  return got.size === want.size && [...got].every((s) => want.has(s));
}

/**
 * `created_at >= '…'` → the literal. INCLUSIVE ONLY, deliberately: `createdSince`
 * is `>=`, and rendering an exclusive `>` as an inclusive arg shifts the boundary
 * by exactly the rows sitting on it — a difference invisible in the result, which
 * is the same trap that kept the issue family's EXCLUSIVE `createdAfter` from
 * being reused for this argument in the first place.
 */
function inclusiveBoundFor(atom: string, column: 'created' | 'updated'): string | null {
  return new RegExp(String.raw`\b${column}_(?:at|ts)\s*>=\s*'([^']+)'`, 'i').exec(atom)?.[1] ?? null;
}

/** `work_items:get` takes 1–100 ids per call (get.ts `ids`: maxItems 100). */
export const WORK_ITEMS_GET_MAX_IDS = 100;

/* ── The residual-predicate rule ──────────────────────────────────────────────
 *
 * A translation is equivalent only if EVERY predicate in the WHERE clause is
 * accounted for. The obvious way to build one of these translators — extract the
 * predicates you recognise and render them — silently DROPS the rest, and each
 * drop changes the answer: dropping `status NOT IN (…)` WIDENS it, dropping an
 * OR-branch NARROWS it. Neither is visible in a coverage count.
 *
 * That is not hypothetical. The first version of these two pairs scored a clean
 * 20/20 and 20/20 while 10 of the 40 sampled atoms rendered a call answering a
 * different question — `state NOT IN (…)`, `taken_by IS NULL`, `feature_order IS
 * NOT NULL`, an OR over `payload::text`, and an OR of two `harness_slug` values,
 * every one of them quietly discarded. It was found by printing the rendered
 * calls and reading them, exactly as fact `substitution-pair-narrowing-over-claim`
 * prescribes.
 *
 * So the shape is a POSITIVE WHITELIST: the WHERE clause must be built ONLY from
 * predicates the verb can express, AND-joined. Anything else — an OR across two
 * columns, an IS NULL, a NOT IN, a function call, a column nobody taught it —
 * fails to match and the pair simply does not claim the atom. Unclaimed traffic
 * stays SQL and stays visible to the census, which is the honest outcome; a
 * claimed atom rendered wrong is not.
 *
 * AND-only is a real constraint, not a simplification: `work_items:list` ANDs its
 * filter arguments, so an OR between two different columns is not expressible in
 * one call at all.
 */

/** A single-quoted SQL string literal. */
const STR = String.raw`'[^']*'`;
/** An optional table alias (`w.title`). */
const ALIAS = String.raw`(?:\w+\.)?`;

/**
 * `feature_id = 'X'` / `id IN ('A','B')` — the by-id selector.
 *
 * ⚠ The leading `\b` is load-bearing and its absence is not a style nit. Without
 * it, `id` matches the TAIL of `workspace_id`, so `WHERE workspace_id = '…'`
 * reads as an id selector: the by-id pair claimed a `SELECT DISTINCT
 * harness_slug` that selects no item at all, and the search pair's negative
 * lookahead excluded every query mentioning `workspace_id` — which is most of
 * them. One missing boundary, wrong in both directions at once.
 */
const ID_PREDICATE = String.raw`${ALIAS}\b(?:feature_id|id)\s*(?:=\s*${STR}|in\s*\(\s*${STR}(?:\s*,\s*${STR})*\s*\))`;

/**
 * Scope predicates BOTH verbs apply implicitly: the call is scoped to the
 * caller's workspace, and `harness` is a first-class argument. Free to consume.
 */
const SCOPE_PREDICATE = String.raw`${ALIAS}\b(?:workspace_id|harness_slug|scope)\s*=\s*${STR}`;

/**
 * The typed slices `work_items:list` can actually ask for.
 *
 * WI-38339 widened the VERB with four more (`states`, `notTerminal`,
 * `createdSince`/`updatedSince`, `sourcePlanSlug`), and this whitelist does NOT
 * follow automatically — it is positive by construction, so every new argument
 * has to be admitted here deliberately. That is the point: a shape that grew on
 * its own would start claiming atoms nobody checked a rendering for.
 *
 * Three deliberate NARROWINGS, each of which leaves real corpus traffic to SQL:
 *  • `IN (…)` is admitted, but a NOT-IN list is only SERVABLE when it is exactly
 *    the canonical terminal union — `cover()` decides that, not this regex,
 *    because it is a set comparison and not a syntactic one.
 *  • A time bound is admitted ONLY as `>= 'literal'`. Exclusive `>` is left to
 *    SQL on purpose: `createdSince` is INCLUSIVE, and this item's own design
 *    decision was that a boundary silently shifting by one row is exactly the
 *    kind of difference no reader can see in a result set. A `now() - interval`
 *    bound cannot match either (the literal does not follow the operator), which
 *    is correct — its value is re-evaluated per run, and a rendered constant is
 *    not the same query.
 *  • `source_plan_slug` is admitted as a FILTER only. The verb projects it for
 *    feature rows and not for issue rows, so a query SELECTING it is refused in
 *    `cover()` rather than served a row missing the column it exists to read.
 */
const FILTER_PREDICATE =
  String.raw`${ALIAS}\b(?:(?:title|summary)\s+i?like\s*${STR}` +
  String.raw`|(?:status|state)\s*=\s*${STR}` +
  String.raw`|(?:status|state)\s+(?:not\s+)?in\s*\(\s*${STR}(?:\s*,\s*${STR})*\s*\)` +
  String.raw`|(?:item_kind|kind)\s*=\s*${STR}` +
  String.raw`|(?:taken_by|assignee)\s*=\s*${STR}` +
  String.raw`|source_plan_slug\s*=\s*${STR}` +
  String.raw`|(?:created|updated)_(?:at|ts)\s*>=\s*${STR}` +
  String.raw`|(?:completion_)?authority\s*=\s*${STR})`;

/**
 * A WHERE clause composed ONLY of `allowed`, AND-joined, running to the end of
 * the statement. The trailing anchor is what makes this a whitelist rather than a
 * prefix test: an unrecognised predicate leaves text the alternation cannot
 * consume, so the match fails instead of silently stopping early.
 */
function whereBuiltOnlyFrom(allowed: string): string {
  return String.raw`\bwhere\s+\(?\s*(?:${allowed})\s*\)?(?:\s+and\s+\(?\s*(?:${allowed})\s*\)?)*\s*(?:\border\s+by\b|\blimit\b|\bgroup\s+by\b|$)`;
}

/**
 * The residual rule again, on the PROJECTION side: a call that returns the right
 * rows but not the COLUMN the query exists to read has not served it. Neither
 * verb projects these, so a query selecting one is left to SQL. (`\b` keeps
 * `completion_ref` from matching inside `terminal_completion_ref`, which both
 * verbs DO return.)
 *
 * Established by reading a real full-tier `work_items:get` result: every field it
 * projects appears as a KEY even when null, so a name that never appears — `notes`,
 * `terminal_reason` — is genuinely absent rather than merely empty on that row.
 * The gate-health pair sets the same standard for its own unprojected columns.
 *
 * ── RE-VERIFIED 2026-08-13 (WI-38365). THIS LIST IS DELIBERATE, NOT INCIDENTAL ──
 * It was challenged as an accidental over-refusal — the theory being that these
 * atoms are servable and the pair is merely fussy about the SELECT list. Measured,
 * that is false: all seven columns are genuinely absent from the verb's output.
 *
 * The measurement is stated here because the sentence above ("established by
 * reading a real result") is not reproducible, and an unfalsifiable claim is what
 * invited the re-litigation. Method, so the next reader re-runs it instead:
 *
 *  1. Pick rows where the DB column is NON-NULL (`count(*) FILTER (WHERE col IS
 *     NOT NULL)`, then one exemplar id each). A null row cannot distinguish "not
 *     projected" from "projected and empty", which is the whole trap.
 *  2. Call `work_items:get { ids, payloadTier: 'full' }` and test KEY PRESENCE
 *     with `n in workItem` — NOT `=== undefined` and NOT a grep, for the reason
 *     in step 3.
 *  3. Carry a control both ways: a nonsense key (`zzzControlNotAKey`) must read
 *     absent, and a known-projected one (`terminalOwner`) must read present, or
 *     the probe proves nothing.
 *
 * Result on 5 feature-family rows chosen per (1): all 7 names 0/5 at the row
 * path; `terminalOwner`/`terminalCompletionRef`/`completionAuthority`/`state`/
 * `assignee` 5/5. ⚠ A whole-body grep DISAGREES and is wrong: `conditionKey`
 * appears once, at `payload._bridge.conditionKey` — free-form payload content on
 * one row, not the `condition_key` COLUMN a `SELECT condition_key` reads. Testing
 * the exact row path is what tells those apart.
 *
 * WHAT THE LIST COSTS, so a future widener knows the stakes rather than guessing:
 * over 7d it is the sole reason ~88 by-id calls stay on raw SQL — `terminal_reason`
 * 32 calls/21 sessions, `completion_ref` 29/19, `source_plan_item_ids` 8/8,
 * `condition_key` 7/7, `needs_human_review` 6/5, `feature_order` 4/2. That is a
 * real population, and refusing it is still correct: routing it would hand back a
 * row missing the very column the query exists to read. The way to shrink this
 * list is to make the VERB project a column and then delete it from here — never
 * to delete it from here alone. `sql-reads-helpers.test.ts` pins each entry.
 */
const UNPROJECTED_BY_BOTH = String.raw`notes|terminal_reason|condition_key|feature_order|source_plan_item_ids|needs_human_review|completion_ref`;

/** `work_items:list` returns a leaner row than `get` — these are its extra gaps. */
const UNPROJECTED_BY_LIST = String.raw`${UNPROJECTED_BY_BOTH}|terminal_owner|taken_at|last_progress_at|closed_ts|closed_at|lane`;

/** Shapes that disqualify either pair outright, whatever the WHERE looks like. */
const NOT_A_PLAIN_ROW_READ = String.raw`^(?!.*\bjoin\b)(?!.*\b(?:count|sum|avg|min|max)\s*\()(?!.*\bgroup\s+by\b)`;

/** `sql.work-items-by-id` — an id selector plus (optionally) scope, nothing else. */
export const WORK_ITEMS_BY_ID_SHAPE = new RegExp(
  `${NOT_A_PLAIN_ROW_READ}(?!.*\\b(?:${UNPROJECTED_BY_BOTH})\\b)(?=[\\s\\S]*${ID_PREDICATE})[\\s\\S]*${whereBuiltOnlyFrom(`${ID_PREDICATE}|${SCOPE_PREDICATE}`)}`,
  'is',
);

/** `sql.work-items-search` — typed slices plus scope, and NO id selector. */
export const WORK_ITEMS_SEARCH_SHAPE = new RegExp(
  `${NOT_A_PLAIN_ROW_READ}(?!.*\\b(?:${UNPROJECTED_BY_LIST})\\b)(?![\\s\\S]*${ID_PREDICATE})(?=[\\s\\S]*${FILTER_PREDICATE})[\\s\\S]*${whereBuiltOnlyFrom(`${FILTER_PREDICATE}|${SCOPE_PREDICATE}`)}`,
  'is',
);

/**
 * The BY-ID forensic read — the dominant `work_items` shape by a wide margin:
 * `SELECT feature_id, status, taken_by, terminal_owner, authority,
 * (payload->'_completionEvidence' IS NOT NULL) AS has_evidence FROM
 * harness_shared.work_items WHERE workspace_id = '…' AND harness_slug = '…' AND
 * feature_id = 'EI-…'`.
 *
 * Measured over the 14d corpus: id predicates account for ~743 of 1,404 plain
 * single-relation atoms (`feature_id` 617, bare `id` 126) across 191 agents.
 * (The census reports this relation smaller because it runs a 7-DAY window —
 * `DEFAULT_CENSUS_WINDOW_DAYS = 7`. Same relation, half the window; do not
 * "reconcile" the two into a discrepancy.)
 *
 * ⚠ THIS PAIR EXISTS BECAUSE A SIBLING PAIR'S REASONING WAS WRONG. The
 * `engineerIssuesSearch` comment above states that `work_items:get { id }` "does
 * not surface the terminal/authority columns those queries exist to read". That
 * is FALSE against the live verb, and it is the single claim that would have
 * talked this pair out of existing. Measured on CLOSED item
 * EI-20285616516435031: `terminalOwner`, `completionAuthority: 'committed'` and
 * `closedAt` all come back populated. A closed item was used deliberately — on an
 * OPEN row those fields are null, and a null is not evidence about whether a
 * field is projected.
 *
 * Column mapping (SQL → verb): `feature_id`/`id` → `id`, `status` → `state`,
 * `taken_by` → `assignee`, `item_kind` → `kind`, `harness_slug` → `harness`,
 * `terminal_owner` → `terminalOwner`, `authority` → `completionAuthority`.
 */
export function workItemsGetCallFromQuery(atom: string): string | null {
  const ids = [
    ...inListFor(atom, 'feature_id'),
    ...inListFor(atom, 'id'),
    ...((id) => (id ? [id] : []))(literalAfter(atom, 'feature_id') ?? literalAfter(atom, 'id')),
  ];
  // De-duplicate: `feature_id = 'X'` and a same-atom `id IN ('X')` are one item.
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  // Beyond the verb's own batch ceiling the substitution stops being one call,
  // so it is not one this pair may claim.
  if (unique.length > WORK_ITEMS_GET_MAX_IDS) return null;

  const args: Array<[string, string]> = [];
  args.push(
    unique.length === 1
      ? ['id', JSON.stringify(unique[0])]
      : ['ids', `[${unique.map((id) => JSON.stringify(id)).join(', ')}]`],
  );

  // `harness_slug` is a real narrowing here: ids are unique per harness only, and
  // `get` takes `harness` precisely to disambiguate a repeated feature id.
  const harness = literalAfter(atom, 'harness_slug');
  if (harness) args.push(['harness', JSON.stringify(harness)]);

  // A payload/summary read is served, but ONLY at the full payload tier: the
  // default (trimmed) tier DROPS `workItem.payload` and `workItem.summary`, so
  // rendering the bare call for a query that reads either would hand back a row
  // missing the very field the query exists to read.
  //
  // ⚠ Match `payload` ANYWHERE, not just `payload->`. Caught by reading the
  // rendered calls: `SELECT jsonb_object_keys(payload) … WHERE feature_id='…'`
  // reads the payload through a function call with no arrow in it, so an
  // arrow-anchored test silently emitted the trimmed call for a query whose
  // entire purpose was the payload.
  if (/\bpayload\b/i.test(atom) || /\bsummary\b/i.test(atom)) {
    args.push(['payloadTier', JSON.stringify('full')]);
  }

  return renderCall('work_items:get', args);
}

/**
 * The SEARCH / SLICE read: `SELECT feature_id, status, taken_by, title FROM
 * harness_shared.work_items WHERE harness_slug='papercusp' AND title ILIKE
 * '%census%' AND status='open'`.
 *
 * ⚠⚠ `includeObservations: true` IS EMITTED ON EVERY CALL, AND IT IS THE WHOLE
 * REASON THIS TRANSLATION IS SAFE. `work_items:list` EXCLUDES
 * `payload.lane:'observation'` rows BY DEFAULT (D-005) — roughly 2,700 of them
 * open at any time — while the raw `SELECT` this pair replaces returns them.
 * Omitting the flag would render a call that silently answers with FEWER rows
 * than the query asked for, which is the narrowing over-claim D-006 forbids and
 * the exact failure recorded in fact `substitution-pair-narrowing-over-claim`.
 * The flag is dropped ONLY when the query itself excludes the observation lane.
 */
export function workItemsListCallFromQuery(atom: string): string | null {
  const args: Array<[string, string]> = [];

  // `q` is a literal substring over title AND body/summary (list.ts:242), so a
  // title-only ILIKE routes to a SUPERSET. Stated in the expression, never hidden.
  const q = likePatternFor(atom, 'title') ?? likePatternFor(atom, 'summary');
  if (q) args.push(['q', JSON.stringify(q.replace(/%/g, ''))]);

  // The DB column is `status`; the verb's arg is `state`. Both spellings appear
  // in the corpus and mean the same thing here.
  const state = literalAfter(atom, 'status') ?? literalAfter(atom, 'state');
  if (state) args.push(['state', JSON.stringify(state.toLowerCase())]);

  // `item_kind` → `kind`. An IN-list of kinds is NOT translatable: `kind` takes
  // one value per call, so rendering the first would narrow the answer.
  if (inListFor(atom, 'item_kind').length === 0) {
    const kind = literalAfter(atom, 'item_kind') ?? literalAfter(atom, 'kind');
    if (kind) args.push(['kind', JSON.stringify(kind.toLowerCase())]);
  }

  // WI-38339 — a state SET. The singular `state` arg accepts an array, exactly as
  // the SQL `IN` list does; an atom carrying both still renders one faithful call.
  const states = inStatesFor(atom);
  if (states.length) args.push(['state', `[${states.map((s) => JSON.stringify(s)).join(', ')}]`]);

  // WI-38339 — "everything still live". Only when the NOT-IN list IS the canonical
  // union (see isCanonicalTerminalUnion); `cover()` refuses every other list rather
  // than letting this silently render the wrong exclusion.
  const notIn = notInStatesFor(atom);
  if (notIn.length && isCanonicalTerminalUnion(notIn)) args.push(['notTerminal', 'true']);

  const assignee = literalAfter(atom, 'taken_by') ?? literalAfter(atom, 'assignee');
  if (assignee) args.push(['assignee', JSON.stringify(assignee)]);

  // WI-38339 — "what work came out of this plan": 104 hand-written statements/7d.
  const sourcePlanSlug = literalAfter(atom, 'source_plan_slug');
  if (sourcePlanSlug) args.push(['sourcePlanSlug', JSON.stringify(sourcePlanSlug)]);

  // WI-38339 — the INCLUSIVE created/updated window.
  const createdSince = inclusiveBoundFor(atom, 'created');
  if (createdSince) args.push(['createdSince', JSON.stringify(createdSince)]);
  const updatedSince = inclusiveBoundFor(atom, 'updated');
  if (updatedSince) args.push(['updatedSince', JSON.stringify(updatedSince)]);

  const harness = literalAfter(atom, 'harness_slug');
  if (harness) args.push(['harness', JSON.stringify(harness)]);

  // The completion-authority judgement is a first-class filter, so an
  // `authority = 'proposed'` slice is served rather than left to SQL.
  const authority = /\b(?:completion_)?authority\s*=\s*'(committed|proposed|validated|pending_human|invalid)'/i.exec(
    atom,
  )?.[1];
  if (authority) args.push(['completionAuthority', JSON.stringify(authority.toLowerCase())]);

  if (args.length === 0) return null;

  // WI-38339 — the PROJECTION half of the widening, and the half that is easy to
  // miss: the verb can now FILTER on a created/updated window, but its default
  // (trimmed/standard) tiers project neither timestamp — id, kind, harness, title,
  // summary, state, assignee, severity, priority, plan_ref and the holder scalars,
  // and nothing else. MEASURED on a live full-tier call, where `createdAt` /
  // `updatedAt` / `closedAt` do come back. So a query that READS the column it
  // filters on needs the full tier, exactly as the by-id pair does for `payload`.
  // Restricted to the SELECT list: a WHERE-only mention needs no wider result.
  if (/\b(?:created|updated)_(?:at|ts)\b/i.test(selectListOf(atom))) {
    args.push(['payloadTier', JSON.stringify('full')]);
  }

  // See the banner. This flag is UNCONDITIONAL: the raw SELECT being replaced
  // returns observation-lane rows and the verb's default drops them.
  //
  // ⚠ An earlier version omitted the flag whenever the query mentioned `lane`,
  // reasoning that such a query "already handles observations". That was exactly
  // backwards for the shape the corpus actually contains — `WHERE lane =
  // 'observation'` asks for ONLY observations, so omitting the flag rendered a
  // call returning NONE of them. `cover()` now refuses a lane predicate outright
  // (the verb has an include/exclude boolean, not a lane filter), which is why
  // there is no longer a case in which omitting this flag is correct.
  args.push(['includeObservations', 'true']);

  const limit = limitOf(atom);
  if (limit !== null) args.push(['limit', String(limit)]);

  return renderCall('work_items:list', args);
}
