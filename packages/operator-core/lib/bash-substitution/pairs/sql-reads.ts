/**
 * Equivalence pairs — the SQL corpus (plan `sql-escape-tool-routing-2026-08-12`,
 * P-009). The first pairs in this registry whose evidence is queries rather than
 * shell commands; the machinery they run on is P-007's.
 *
 * ── WHY THESE TWO FIRST ──────────────────────────────────────────────────────
 * D-005's census of 14 days of agent-written `dev:pg_query` calls ranked the
 * addressable traffic by DISTINCT AGENTS, and the top of that list was not a
 * papercusp table at all — it was `information_schema`:
 *
 *     information_schema.tables    228 calls / 105 agents
 *     information_schema.columns   216 calls /  93 agents
 *
 * More distinct agents than any papercusp relation except `work_items` and
 * `routines`, and both entirely absent from `TOOL_ROUTING_BY_TABLE`. They are
 * also the purest possible statement of this plan's thesis — that the lever is
 * ROUTING, not capability — because the tool that answers them is the SAME TOOL
 * the agent is already calling. `dev:pg_query { describe }` has shipped this
 * capability the whole time; 105 agents hand-wrote the catalog query instead,
 * because nothing ever told them the mode existed.
 *
 * ── WHAT NARROWING IS DOING HERE (D-008, applied to a second corpus) ─────────
 * Neither pair claims every read of its relation, and the exclusions are not
 * gaps — they are the boundary of what `describe` can FAITHFULLY express. A
 * cross-table column search and a `table_name IN (…)` list are real questions
 * that this tool answers only with a superset, and routing them here would be
 * worse than the SQL they replace: the agent would get a plausible answer to a
 * question they did not ask. Those shapes fall OUTSIDE the pattern rather than
 * dragging the verdict down, exactly as `postgres.psql-select` handles a
 * `$VAR`-connection psql.
 */

import {
  describeRelationFromColumnsQuery,
  describePatternFromTablesQuery,
  migrationsCallFromQuery,
  testRunsCallFromQuery,
  issuesListCallFromQuery,
  gateHealthCallFromQuery,
  workItemsGetCallFromQuery,
  workItemsListCallFromQuery,
  WORK_ITEMS_BY_ID_SHAPE,
  WORK_ITEMS_SEARCH_SHAPE,
  // WI-38339 — the semantic halves of the widened search shape: set-equality
  // against the terminal union, and the SELECT-list read the projection rule needs.
  isCanonicalTerminalUnion,
  notInStatesFor,
  selectListOf,
} from './sql-reads-helpers';
import type { CoverageResult, DeliberateNoPairDecision, SqlSubstitutionPair } from '../types';

/**
 * Measured negative SQL-routing decisions. This is deliberately adjacent to
 * SQL_READ_PAIRS: a no-pair ruling is registry data, not a relation skip-list
 * hidden in the census action.
 */
export const SQL_READ_NO_PAIR_DECISIONS: readonly DeliberateNoPairDecision[] = [
  {
    relation: 'pg_stat_activity',
    decisionRef: 'sql-escape-tool-routing-2026-08-12#D-007',
    rationale:
      'dev:pg_active_queries served 0/956 real calls; the measured population was one-session-heavy and the verb cannot express its query filters or required columns.',
    baseline: {
      windowDays: 14,
      calls: 956,
      atoms: 235,
      distinctAgents: 72,
    },
    // 100 independent agents is materially above the 72-agent measured
    // baseline and is intentionally an explicit, reviewable threshold.
    reRaiseAtDistinctAgents: 100,
  },
];

/**
 * P-009a — `SELECT column_name … FROM information_schema.columns WHERE
 * table_schema='X' AND table_name='Y'`: the columns of ONE relation.
 *
 * 216 atoms across 93 agents, and the sample is strikingly uniform: a
 * schema+table equality pair, projecting some subset of column_name / data_type /
 * is_nullable / udt_name. `dev:pg_query { describe: "X.Y" }` returns exactly
 * that, plus the indexes, constraints and column COMMENTs the hand-written query
 * does not reach at all.
 *
 * NARROWED to a single-table equality with no column-level predicate. The two
 * excluded shapes are both real and both genuinely unserved:
 *  - `table_name IN ('a','b')` — describe takes one relation per call;
 *  - `WHERE column_name ILIKE '%checkpoint%'` (with or without a table) — a
 *    column SEARCH across relations, which describe cannot express at all. It is
 *    the one shape here that would be actively harmed by a nudge, since describe
 *    would return every column of one table and the agent asked about one column
 *    across many.
 */
export const informationSchemaColumns: SqlSubstitutionPair = {
  id: 'sql.information-schema-columns',
  intentLabel: 'relation-column-introspection',
  corpus: 'sql',
  relation: 'information_schema.columns',
  // A single-table equality, and NOT a column-name search. The lookahead is what
  // keeps the cross-relation column hunt outside the population; without it the
  // fixture would carry a shape the tool cannot answer and the verdict would be
  // `needs-widening` for a reason that is not about this intent.
  sqlShape: /^(?!.*\bcolumn_name\s*(?:i?like|~|~\*|=\s*any)\b)(?=.*\btable_name\s*=\s*')/is,
  toolName: 'dev:pg_query',
  advisoryText:
    "dev:pg_query { describe: \"schema.table\" } returns that relation's columns with their types, nullability and COMMENTs, plus its indexes and constraints — one call, no information_schema query to write.",
  routing: {
    want: "one relation's columns and their types",
    use: '`dev:pg_query { describe: "schema.table" }` (same tool — also returns indexes, constraints and column comments)',
    insteadOf:
      "a hand-written `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='…' AND table_name='…'`. ⚠ A column SEARCH across relations (`column_name ILIKE '%x%'`) has no describe form — keep querying the catalog for that",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const target = describeRelationFromColumnsQuery(atom);
    if (!target) {
      return { covered: false, reason: 'no single schema-qualified table equality to resolve into a describe target' };
    }
    if (/\btable_name\s+in\s*\(/i.test(atom)) {
      return { covered: false, reason: 'lists several tables; dev:pg_query { describe } takes one relation per call' };
    }
    // `… AND column_name IN ('a','b')` — a named subset of ONE relation's
    // columns, and 5 of the 20 sampled atoms are this. describe returns the
    // relation's FULL column list, which contains the answer: the question is
    // "do these columns exist / what are their types", and a complete structured
    // description of that one relation answers it exactly. Recorded as covered
    // WITH the difference stated in the expression, rather than silently — a
    // superset is only acceptable when the reader can see that it is one.
    if (/\bcolumn_name\s+in\s*\(/i.test(atom)) {
      return { covered: true, expression: `dev:pg_query { describe: "${target}" } // returns every column, including those` };
    }
    return { covered: true, expression: `dev:pg_query { describe: "${target}" }` };
  },
};

/**
 * P-009b — `SELECT table_name FROM information_schema.tables WHERE table_name
 * ILIKE '%frag%'`: FINDING a relation whose name you half-remember.
 *
 * 228 atoms across 105 agents — the widest-reach cluster in the whole SQL corpus.
 * The dominant shape is a substring hunt (`%coord%`, `%rubric%`, `%checkpoint%`),
 * with a schema listing (`table_schema='harness_shared'`) second.
 *
 * `listRelations` (the engine behind `describe`) translates a psql glob into
 * `lower(schema.name) LIKE … OR lower(name) LIKE …`, so `describe: "*coord*"`
 * IS the substring hunt and `describe: "harness_shared.*"` IS the schema
 * listing — including the case-insensitivity, which it gets by lowering both
 * sides rather than by ILIKE. It also excludes `pg_catalog` and
 * `information_schema` itself, which is what most of these queries hand-write as
 * a `NOT IN` clause.
 *
 * Verified against the implementation (`pg-read-query.ts` listRelations), not
 * against the tool's description — the D-001 discipline, since the description is
 * what would have let an unfaithful claim through.
 */
export const informationSchemaTables: SqlSubstitutionPair = {
  id: 'sql.information-schema-tables',
  intentLabel: 'relation-name-lookup',
  corpus: 'sql',
  relation: 'information_schema.tables',
  // A QUOTED predicate on the relation name or its schema, and nothing reading
  // the server/connection. Both exclusions were measured, not guessed: the
  // corpus carries a `SELECT current_setting('port') … FROM information_schema
  // .tables` (a connection question wearing a catalog query's clothes) and an
  // atom whose literals arrived unquoted, which no translation can resolve
  // without guessing. Per D-008 they fall outside rather than dragging a verdict
  // about relation-name lookup.
  sqlShape:
    /^(?!.*\b(?:current_setting|inet_server_port|current_database)\s*\()(?!.*\btable_(?:name|schema)\s+in\s*\()(?!.*\btable_name\s+i?like\s*'[^']*'.*\btable_name\s+i?like\s*')(?=.*\btable_(?:name|schema)\s*(?:=|i?like)\s*')/is,
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { describe: "*fragment*" } finds relations by name fragment (the glob becomes a case-insensitive LIKE over schema.name), and { describe: "schema.*" } lists a schema — the same answer without the information_schema query.',
  routing: {
    want: 'to FIND a relation whose name you half-remember',
    use: '`dev:pg_query { describe: "*fragment*" }` — glob matched case-insensitively against `schema.name`; `{ describe: "schema.*" }` lists one schema',
    insteadOf:
      "a hand-written `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%fragment%'`. ⚠ Names only, one glob per call — an explicit `table_name IN (…)` list, a `table_type` filter, or anything else the catalog holds still wants information_schema",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    // Anything reaching past the relation NAME is a catalog question describe
    // does not answer, whatever else the query also does.
    if (/\btable_type\b/i.test(atom)) {
      return { covered: false, reason: 'filters or projects table_type; describe reports a relation KIND, not the catalog column' };
    }
    if (/\b(?:current_setting|inet_server_port|current_database)\s*\(/i.test(atom)) {
      return { covered: false, reason: 'also reads server/connection settings, which no describe call returns' };
    }
    // Anchored TIGHTLY to the predicate. A looser `table_name … IN (` (which is
    // what this was first written as) matches the projection's `table_name`
    // against the WHERE clause's `table_schema NOT IN (…)` several tokens later,
    // and reports a set-membership question about a query that asks nothing of
    // the kind. Caught because the reason printed did not describe the atom.
    if (/\btable_name\s+in\s*\(/i.test(atom)) {
      return { covered: false, reason: 'asks for an explicit list of names; a glob cannot express set membership' };
    }
    if (/\btable_name\s+i?like\s*'[^']*'[\s\S]*\btable_name\s+i?like\s*'/i.test(atom)) {
      return { covered: false, reason: 'searches several name fragments at once; describe takes one glob per call' };
    }
    const pattern = describePatternFromTablesQuery(atom);
    if (!pattern) {
      return { covered: false, reason: 'no name fragment or schema to translate into a describe glob' };
    }
    return { covered: true, expression: `dev:pg_query { describe: "${pattern}" }` };
  },
};

/**
 * P-009c — `SELECT filename, applied_at FROM harness_shared.schema_migrations
 * WHERE filename LIKE '727%'`: "did migration NNN apply?"
 *
 * 135 atoms across 59 agents. The shape is remarkably uniform — a single
 * migration-number prefix, sometimes with an ordered `LIMIT` for "the recent
 * ones" — and `db:migrations { like }` was built from this exact census (P-003).
 *
 * WHY IT IS WORTH ROUTING, beyond convenience: the raw query answers the
 * dominant question WRONG. Zero rows is ambiguous three ways — not applied yet,
 * authored-but-not-armed (`NNN-*.sql.DRAFT`, which the runner will NEVER apply),
 * or a wrong guess at the number — and the SQL renders all three as an identical
 * empty result. `db:migrations` returns a `lookup` verdict distinguishing them.
 *
 * The corpus also queries `name` and `version`, which DO NOT EXIST on this table
 * (filename, applied_at, sha256 — verified against the live catalog). Those calls
 * errored; the translator still covers them, because the question they ask is one
 * a typed `like` arg answers and cannot misname. See MIGRATION_ID_COL.
 *
 * NARROWED away from the four multi-pattern forms the single `like` arg cannot
 * express: a POSIX regex (`~ '^(79[4-9]|80[0-7])'`), `LIKE ANY (ARRAY[…])`, a
 * `filename IN (…)` list, an OR of two fragments, and a `>=`/`<` number RANGE.
 * Each is a real question and each would need several calls, so per D-008 they
 * fall outside the population rather than dragging its verdict.
 */
export const schemaMigrationsApplied: SqlSubstitutionPair = {
  id: 'sql.schema-migrations-applied',
  intentLabel: 'applied-migration-lookup',
  corpus: 'sql',
  relation: 'schema_migrations',
  sqlShape:
    /^(?!.*\b(?:filename|name|version)\s*~)(?!.*\bi?like\s+any\s*\()(?!.*\b(?:filename|name|version)\s+in\s*\()(?!.*\b(?:filename|name|version)\s*(?:>=|<=|>|<)\s*'?\d)(?!.*\bi?like\s*'[^']*'[\s\S]*\bi?like\s*')/is,
  toolName: 'db:migrations',
  advisoryText:
    'db:migrations { like: "795" } reads the applied ledger by migration number — and when nothing matches it returns a VERDICT (pending / draft-not-armed / no-such-migration / unknown) instead of the empty result that cannot tell those three apart.',
  routing: {
    want: 'whether migration NNN applied, or the most recent migrations',
    use: '`db:migrations { like: "795" }` — a bare number is a prefix match; an empty match returns a verdict (pending / draft-not-armed / no-such-migration) rather than an ambiguous zero rows',
    insteadOf:
      "a hand-written `SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'`. ⚠ One pattern per call — a `filename IN (…)` list, a POSIX-regex range (`~ '^(79[4-9])'`), `LIKE ANY (ARRAY[…])` or a `>= '750' AND < '760'` number range still wants SQL",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (/\bcount\s*\(|\bmax\s*\(\s*applied_at/i.test(atom)) {
      // `total` and `newest` ride on every response, so the aggregate IS
      // answered — but only as a by-product of a row read, and saying "covered"
      // without saying that would overstate the match.
      const call = migrationsCallFromQuery(atom);
      return call
        ? { covered: true, expression: `${call} // count → \`total\`, max(applied_at) → \`newest\`` }
        : { covered: false, reason: 'a bare aggregate over the whole ledger with nothing to bound the read' };
    }
    const call = migrationsCallFromQuery(atom);
    if (!call) {
      return {
        covered: false,
        reason: 'no migration-number predicate, time window or limit — an unbounded ledger dump, which db:migrations caps at 200 rows',
      };
    }
    return { covered: true, expression: call };
  },
};

/**
 * P-009d — `SELECT file_path, status, started_at FROM harness_shared.test_runs
 * WHERE file_path LIKE '%foo.test.ts%' ORDER BY started_at DESC LIMIT 15`: the
 * run history of a test file.
 *
 * 98 atoms across 27 agents, and — uniquely in this corpus — all 98 are DISTINCT.
 * That is the finding, not a curiosity: every agent is re-deriving the same query
 * against a 20-column table it cannot see, and the guesses show it. `suite`,
 * `failed`, `passed`, `failing_files`, `failing_tests`, `test_name`, `run_id`,
 * `workspace`, `group_key`, `note`, `file`, `sha`, `failure_summary`, `payload`,
 * `files`, `workspace_slug`, `failed_count` — none of these columns exist.
 *
 * TWO FAILURE MODES, and the second is why this pair matters most:
 *  - a hallucinated COLUMN errors loudly, which is survivable;
 *  - a hallucinated STATUS LITERAL does not. `status` is CHECK-constrained to
 *    pass|fail|skip|cancelled|error|running, so `WHERE status='failed'` matches
 *    nothing and reads as "no failures", while `WHERE status <> 'passed'` matches
 *    EVERYTHING — including every passing row — and reads as a wall of failures.
 *    Both are silent. `testing:runs { status: [...] }` is a typed enum, so
 *    neither is writable.
 *
 * NARROWED to the predicates the tool can express. Excluded: aggregates and
 * `DISTINCT ON`, and any predicate over a column `testing:runs` cannot filter —
 * `failing_files`/`failing_tests` (which do not exist), `output_tail ILIKE` (a
 * full-text hunt through captured output), `test_name`, and a bare `id` lookup.
 */
export const testRunsHistory: SqlSubstitutionPair = {
  id: 'sql.test-runs-history',
  intentLabel: 'test-run-history',
  corpus: 'sql',
  relation: 'test_runs',
  // Two trailing exclusions, both cases where the tool cannot ASK the question:
  //  - a `finished_at` window: `since`/`sinceHours` filter STARTED_at, and a run
  //    that starts inside one window and finishes in the next belongs to
  //    different sets under the two readings;
  //  - `workspace_id IS NULL` / `harness_slug IS NULL`: the deliberate way to
  //    select the CI/gate rows, and `workspace` selects a VALUE — it has no way
  //    to select NULL. `source:'ci'` is a near proxy and not the same set (a
  //    legacy admin-ui row is NULL-scoped too), so routing it there would be a
  //    guess wearing an equivalence's clothes.
  sqlShape:
    /^(?!.*\b(?:count|date_trunc|avg|sum)\s*\()(?!.*\bdistinct\s+on\b)(?!.*\bgroup\s+by\b)(?!.*\b(?:failing_files|failing_tests|test_name|failure_summary|suite_id)\b)(?!.*\boutput_tail\s+i?like)(?!.*\bpayload\s*(?:->|\?))(?!.*\bid\s*=)(?!.*\bfinished_at\s*[<>])(?!.*\b(?:workspace_id|harness_slug)\s+is\s+(?:not\s+)?null)(?=.*\b(?:file(?:_path)?\s+i?like|file(?:_path)?\s*=|status\s*(?:=|<>|!=|\s+(?:not\s+)?in)|source\s*=|commit_sha\s*=|run_group_id\s*=|now\(\)\s*-\s*interval))/is,
  toolName: 'testing:runs',
  advisoryText:
    "testing:runs { filePath: \"foo.test.ts\", status: [\"fail\",\"error\"] } reads the same history with a TYPED status enum — the raw column is CHECK-constrained to pass|fail|skip|cancelled|error|running, so a hand-written status='failed' silently matches nothing and status <> 'passed' silently matches everything.",
  routing: {
    want: "a test file's run history, or which tests are failing",
    use: '`testing:runs { filePath, status: ["fail","error"], sinceHours }` — typed status enum, and `outputTail` comes back on the red rows',
    insteadOf:
      "`SELECT … FROM test_runs WHERE file_path LIKE '%x%' AND status='failed'` — ⚠ that literal can NEVER match (pass|fail|skip|cancelled|error|running), so it reads as a clean \"no failures\". Aggregates, `DISTINCT ON`, an `output_tail` hunt, a `finished_at` window or `workspace_id IS NULL` still want SQL",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    // The tool's window filters `started_at`; a window written against
    // finished_at selects a genuinely different set (a long run starts in one
    // window and finishes in the next), so it is declined rather than shifted.
    if (/\bfinished_at\s*[<>]/i.test(atom) && !/\bstarted_at\s*[<>]/i.test(atom)) {
      return { covered: false, reason: 'windows on finished_at; testing:runs filters started_at, which selects a different set' };
    }
    if (/\bworkspace_id\s+is\s+null|\bharness_slug\s+is\s+null/i.test(atom)) {
      return { covered: false, reason: 'asks for the NULL-scoped CI rows explicitly; `workspace` selects a value, it cannot select NULL' };
    }
    const call = testRunsCallFromQuery(atom);
    if (!call) return { covered: false, reason: 'no file, status, source, commit, run-group or time predicate to translate' };
    const negated = /\bstatus\s+not\s+in\s*\(|\bstatus\s*(?:<>|!=)\s*'/i.test(atom);
    if (negated) {
      // Rendered as the COMPLEMENT over the real enum, which is what the agent
      // asked for — and, when they wrote `<> 'passed'`, is NOT what they got.
      return { covered: true, expression: `${call} // negated status → the complement over the real enum` };
    }
    return { covered: true, expression: call };
  },
};

/**
 * P-009e — `SELECT issue_id, title, state FROM harness_shared.engineer_issues
 * WHERE title ILIKE '%tmp_pack%' ORDER BY created_at DESC LIMIT 10`: FINDING
 * filed issues by text or by state.
 *
 * ⚠ THIS PAIR CLAIMS A MINORITY OF ITS RELATION'S TRAFFIC, DELIBERATELY — see
 * D-006. `engineer_issues` is the corpus's single heaviest relation (349 atoms /
 * 60 agents), and the plan's own headline read that as "349 calls `issues:list`
 * would serve". Reading the actual population says otherwise: the dominant shape
 * is a BY-ID forensic read — `WHERE issue_id = 'WI-38048'` projecting
 * `terminal_owner`, `authority`, `terminal_completion_ref`, `closed_ts` and
 * `payload->` paths — and `issues:list` has NO id filter and returns none of
 * those columns. Routing it there would answer a question nobody asked.
 *
 * So the pair claims only what the verb genuinely serves — a text search (`q`,
 * over title+body) and the typed state/assignee/scope/severity slices — and the
 * by-id remainder is left to SQL rather than mis-routed by THIS pair.
 *
 * ⚠ CORRECTION (EI-20285223214931386, 2026-08-12). This comment used to end:
 * "`work_items:get { id }` covers the ORDINARY fields of a single item … but it
 * does not surface the terminal/authority columns those queries exist to read."
 * That is FALSE. Measured on closed item EI-20285616516435031, `work_items:get`
 * returns `terminalOwner`, `terminalCompletionRef`, `terminalCompletionEvidence`
 * and `completionAuthority` populated (a CLOSED item was used deliberately — on
 * an open row those fields are null, and a null cannot tell you whether a field
 * is projected at all). The by-id forensic read IS servable, and that one wrong
 * premise is what made the largest cluster on the box look unroutable for as
 * long as it stood. It is now claimed by `sql.work-items-by-id` below.
 *
 * A `state IN (…)` / `state NOT IN (…)` predicate is excluded too: `state` is a
 * single enum arg here, and the corpus's "everything not terminal" queries need
 * a set the verb cannot take.
 */
export const engineerIssuesSearch: SqlSubstitutionPair = {
  id: 'sql.engineer-issues-search',
  intentLabel: 'issue-search',
  corpus: 'sql',
  relation: 'engineer_issues',
  // Three further exclusions, each a question `issues:list` cannot ask rather
  // than a shape it merely renders awkwardly:
  //  - a TIME predicate (`created_at > '…'`) — there is no time-window arg at
  //    all, so translating without it would return a strictly larger set;
  //  - an OR of several title fragments — `q` is one substring per call;
  //  - a REGEX text match (`title ~* '(^|[^a-z0-9])…'`) — `q` is a substring.
  // The first is the dangerous one: dropping a predicate silently WIDENS the
  // answer, which is the failure mode a routing nudge must never introduce.
  sqlShape:
    /^(?!.*\b(?:issue_)?id\s*(?:=|\s+in\s*\(|\s*=\s*any))(?!.*\bpayload\s*(?:->|\?))(?!.*\b(?:terminal_owner|terminal_completion_ref|terminal_reason|authority|completion_authority|closed_ts|created_by|assigned_by|signal_origin|parent_id)\b)(?!.*\bjsonb_)(?!.*\bstate\s+(?:not\s+)?in\s*\()(?!.*\bselect\s+\*)(?!.*\b(?:created_at|updated_at|closed_at|created_ts|updated_ts)\s*[<>])(?!.*\b(?:title|body)\s*~)(?!.*\b(?:title|body)\s+i?like\s*'[^']*'[\s\S]*\bor\b[\s\S]*\b(?:title|body)\s+i?like\s*')(?=.*\b(?:title\s+i?like|body\s+i?like|state\s*=\s*'|status\s*=\s*'|assignee\s*=\s*'|scope\s*=\s*'|severity\s*=\s*'))/is,
  toolName: 'issues:list',
  advisoryText:
    'issues:list { q, state, assignee, scope, severity } reads filed issues with typed filters and unbounded counts. Note `q` matches title AND body, and `body` is omitted unless you pass includeBody — it is 76% of the bytes.',
  routing: {
    want: 'to find filed issues by text, state, assignee or scope',
    use: '`issues:list { q: "fragment", state, assignee, limit }` — `q` matches title + body, `rollup:"state"` gives counts over the whole filtered set',
    insteadOf:
      "`SELECT … FROM engineer_issues WHERE title ILIKE '%x%'`. ⚠ NO id filter — a single-item read (`WHERE issue_id='WI-123'`) is `work_items:get { id }` — and no time-window arg, so a `created_at` slice, an OR of several fragments, a regex match, and `payload->`/terminal-column forensics stay SQL",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (/\b(?:title|body)\s+i?like\s*'[^']*'[\s\S]*\bor\b[\s\S]*\b(?:title|body)\s+i?like\s*'/i.test(atom)) {
      return { covered: false, reason: 'ORs several text fragments; `q` is one substring per call' };
    }
    const call = issuesListCallFromQuery(atom);
    if (!call) return { covered: false, reason: 'no text fragment or typed slice to translate into issues:list args' };
    if (/\btitle\s+i?like/i.test(atom) && !/\bbody\s+i?like/i.test(atom)) {
      // `q` spans title AND body, so a title-only search routes to a superset.
      // Stated in the expression: a superset is acceptable only when the reader
      // can see that it is one.
      return { covered: true, expression: `${call} // q matches title AND body — a superset of a title-only ILIKE` };
    }
    return { covered: true, expression: call };
  },
};

/** Every pair in the SQL corpus, in registry order. */
/**
 * The gate-health read — the LARGEST single cluster the SQL audit measured (708
 * calls / 110 distinct agents over the 14d retention) and the one the plan's own
 * acceptance grade caught still routing around the catalog.
 *
 * This pair is deliberately Class C, not Class A. `routines:list` has been able
 * to answer this since P-002, and D-002 ruled that no fourth gate surface should
 * be added — that ruling stands and this does not reopen it. What was missing was
 * only the routing ROW: the capability existed, carried the right guidance, and
 * was still unreachable from the one table an agent reads before writing SQL.
 * Capability and reachability are separate failures, and closing the first is
 * what makes it easy to believe you have closed the second.
 */
export const gateHealthRead: SqlSubstitutionPair = {
  id: 'sql.gate-health',
  intentLabel: 'gate-health-read',
  corpus: 'sql',
  relation: 'routines',
  // Claim ONLY the gate-health corpus, not all `routines` traffic. Pause-state
  // and cadence reads are a different intent with a different residual, and a
  // pair that swallowed them would over-claim exactly the way D-006 forbids.
  sqlShape: /\bgate_health\b/is,
  toolName: 'routines:list',
  // The residual lives HERE, in the prose surface, rather than in the table cell:
  // `routing.*` renders into a markdown row every agent carries in-prompt and is
  // capped at 300 chars for that reason, so the full boundary would either blow
  // the cap or squeeze out the part that matters.
  advisoryText:
    "routines:list { name: 'green-checkpoint', installSlug: '<your install>' } returns `health.gate_health` — the live in-flight-retriage marker, observed candidate and consecutive-red count — plus nextFireAt/lastFiredAt, which is the whole of this read. No raw SQL needed. ⚠ PASS `installSlug`: every install runs a routine of this name, so name alone returns one row PER INSTALL (21 on this box) and the result is then truncated by the payload shaper — the sampled SQL this replaces all scoped by `install_slug`, and dropping it is what makes another pot's row, which sorts first and reads `consecutiveReds: 0`, look like yours. ⚠ Only the projected row comes back: `tier`, `payload_template`, `concurrency`, `catchup`, `reschedule_interval_sec` and any `metadata` key outside the operational allowlist are NOT returned, and a cross-routine aggregate or a JOIN still wants SQL. ⚠ Different questions, different surfaces: \"is my change live / what is blocking it\" is dev:pipeline_position, and the sha the gate is judging is state:read { cell:'gate.greenCheckpoint.candidate' } — which carries its own provenance caveat.",
  routing: {
    want: "the green-checkpoint gate's health (consecutive reds, observed candidate, whether a re-triage is in flight)",
    use: "`routines:list { name: 'green-checkpoint', installSlug: '<your install>' }` — read `health.gate_health`, plus `nextFireAt` / `lastFiredAt`. ⚠ OMIT installSlug and EVERY install's row comes back (21 here, truncated to 12); row 1 is another pot's and reads healthy",
    insteadOf:
      "a hand-written `SELECT metadata->'gate_health'->… FROM harness_shared.routines`. ⚠ Unprojected columns (`tier`, `concurrency`), cross-routine aggregates and JOINs still want SQL. \"Is my change live\" is dev:pipeline_position; the judged sha is state:read { cell:'gate.greenCheckpoint.candidate' }",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (/\bjoin\b/i.test(atom)) {
      return { covered: false, reason: 'a JOIN across relations — routines:list reads one table' };
    }
    if (/\bcount\s*\(|\bgroup\s+by\b/i.test(atom)) {
      return {
        covered: false,
        reason: 'an aggregate over routines — routines:list returns rows (or rollup:true per GROUP, which is a different shape)',
      };
    }
    const unprojected = /\b(tier|payload_template|concurrency|catchup|reschedule_interval_sec|target_owner_id)\b/i.exec(atom);
    if (unprojected) {
      return {
        covered: false,
        reason: `selects \`${unprojected[1]}\`, which is not on the projected row — the verb fetches the column but does not return it`,
      };
    }
    const call = gateHealthCallFromQuery(atom);
    return call
      ? { covered: true, expression: `${call} // gate_health → \`health.gate_health\`` }
      : { covered: false, reason: 'no gate_health projection — a different routines read with a different residual' };
  },
};

/**
 * The WHERE clause alone, so a `payload->` PREDICATE can be told apart from a
 * `payload->` PROJECTION. The distinction is the difference between a question
 * the verb cannot ask and a column it simply returns, and a regex over the whole
 * atom cannot see it: `(payload->'_completionEvidence' IS NOT NULL) AS has_evidence`
 * is a projection, and `WHERE payload->>'lane' = 'observation'` is a filter.
 */
function whereClauseOf(atom: string): string {
  return /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i.exec(atom)?.[1] ?? '';
}

/** A `payload->…` used as a FILTER (not merely projected). */
function hasPayloadPredicate(atom: string): boolean {
  return /\bpayload\s*(?:->>?|\?)/i.test(whereClauseOf(atom));
}

/**
 * P-009 follow-on (EI-20285223214931386) — the BY-ID read of a single work item:
 * `SELECT feature_id, status, taken_by, terminal_owner, authority FROM
 * harness_shared.work_items WHERE workspace_id='…' AND feature_id='EI-…'`.
 *
 * `work_items` is the largest uncovered cluster the P-008 census measured on its
 * FIRST live run — i.e. the audit found something real on day one, which is the
 * point of it.
 *
 * ── WHY THIS IS CLASS C, NOT CLASS A ────────────────────────────────────────
 * Both verbs have existed all along. What never existed was the ROUTING ROW, and
 * the same document that lacked it carried a HAND-WRITTEN row pointing at
 * `work_items:list` — so CLAUDE.md advised a route the PreToolUse gate knew
 * nothing about, while the census correctly reported the relation uncovered.
 * Capability and reachability are separate failures; closing the first is what
 * makes it easy to believe you have closed the second.
 *
 * ── THE CORRECTION THIS PAIR CARRIES ────────────────────────────────────────
 * `engineerIssuesSearch` above states that `work_items:get { id }` "does not
 * surface the terminal/authority columns those queries exist to read". Measured
 * false on closed item EI-20285616516435031: `terminalOwner`,
 * `completionAuthority:'committed'` and `closedAt` all come back populated. That
 * single wrong premise is what made the dominant cluster look unservable.
 */
export const workItemsById: SqlSubstitutionPair = {
  id: 'sql.work-items-by-id',
  intentLabel: 'work-item-by-id',
  corpus: 'sql',
  relation: 'work_items',
  // Requires an id predicate; the search pair below forbids one, so the two
  // partition this relation's traffic rather than competing for it.
  // A positive WHITELIST (see the residual-predicate rule in sql-reads-helpers):
  // the WHERE must be an id selector plus optional scope and NOTHING else. This
  // is what keeps a payload PREDICATE, an `IS NULL`, or an OR-branch from being
  // claimed and then quietly dropped — while a payload PROJECTION stays claimed,
  // because the verb returns the whole payload at payloadTier:'full'.
  sqlShape: WORK_ITEMS_BY_ID_SHAPE,
  toolName: 'work_items:get',
  advisoryText:
    "work_items:get { id } — or { ids: [...] } for up to 100 at once — returns the whole row: state, assignee, severity, kind, parent, createdAt/updatedAt/closedAt AND the forensic columns (terminalOwner, terminalCompletionRef, terminalCompletionEvidence, completionAuthority), plus the holder, checkpoint and priorWork warnings raw SQL cannot show you. ⚠ The DEFAULT tier DROPS `payload` and `summary`; pass payloadTier:'full' for those (framework-reserved, so a schema-validating client sends it via tools:invoke). A `payload->` PREDICATE, a `source_plan_slug` slice, an aggregate or a JOIN still wants SQL.",
  routing: {
    want: 'one work-item (or up to 100) by id, including its terminal/authority columns',
    use: '`work_items:get { id }` / `{ ids: [...] }` — whole row incl. terminalOwner, completionAuthority, plus holder + checkpoint; add payloadTier:"full" for payload/summary',
    insteadOf:
      "a hand-written `SELECT … FROM work_items WHERE feature_id='EI-…'`. ⚠ `payload->` PREDICATES, `source_plan_slug` slices, aggregates and JOINs stay SQL",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (hasPayloadPredicate(atom)) {
      // The id already selects the row, so `get` would return one the SQL's
      // extra predicate may have filtered OUT — a superset, and a misleading one.
      return { covered: false, reason: 'filters on a payload-> path; work_items:get selects by id only' };
    }
    const call = workItemsGetCallFromQuery(atom);
    if (!call) return { covered: false, reason: 'no id literal to translate (or more ids than the 100-per-call ceiling)' };
    return { covered: true, expression: call };
  },
};

/**
 * The SEARCH / SLICE read: finding work-items by title text, state, kind or
 * assignee — the shape CLAUDE.md's hand-written storage-policy row has pointed at
 * `work_items:list` all along without the gate ever knowing.
 *
 * ⚠ The translation ALWAYS emits `includeObservations: true`. `work_items:list`
 * excludes `payload.lane:'observation'` rows by default (D-005) — ~2,700 of them
 * — while the raw SELECT it replaces returns them. Without the flag the rendered
 * call answers with FEWER rows than the query asked for: a silent narrowing, the
 * over-claim D-006 exists to forbid.
 */
export const workItemsSearch: SqlSubstitutionPair = {
  id: 'sql.work-items-search',
  intentLabel: 'work-item-search',
  corpus: 'sql',
  relation: 'work_items',
  // The same positive whitelist, over the typed slices `work_items:list` can ask
  // for. Everything the corpus writes that the verb CANNOT ask — `taken_by IS
  // NULL`, `feature_order IS NOT NULL`, an `item_kind IN (…)` list, a `lane`
  // filter, an OR across two columns — fails to match and is left to SQL. An id
  // selector is excluded because that is the by-id pair above and `list` has no
  // id filter at all.
  //
  // WI-38339 WIDENED THIS, and the widening was NOT automatic: the tool grew four
  // arguments (array-valued `state`, `notTerminal`, `createdSince`/`updatedSince`,
  // `sourcePlanSlug`) and this whitelist admitted them one at a time, each with a
  // rendering read by eye. Three shapes the corpus writes are STILL excluded on
  // purpose, and the reasons are semantic rather than syntactic — see `cover()`
  // and `inclusiveBoundFor`: an exclusion set that is not the canonical terminal
  // union, an exclusive `>` / `now() - interval` time bound, and a query that
  // PROJECTS `source_plan_slug` (filtering on it is served; reading it back is
  // not, on issue-family rows).
  sqlShape: WORK_ITEMS_SEARCH_SHAPE,
  toolName: 'work_items:list',
  advisoryText:
    "work_items:list { q, state, notTerminal, kind, assignee, harness, sourcePlanSlug, createdSince, updatedSince, completionAuthority, limit } reads a filtered slice with server-side filters; `state` accepts one value or an array for a state set. ⚠ `q` is a literal substring over title AND body/summary, so a title-only ILIKE routes to a SUPERSET. ⚠ It EXCLUDES observation-lane rows by default — pass includeObservations:true to match what a raw SELECT returns. ⚠ `notTerminal` means one specific set (the canonical terminal union) — for any OTHER exclusion, stay in SQL. ⚠ createdSince/updatedSince are INCLUSIVE (`>=`) and take an ISO literal, so an exclusive `>` or a `now() - interval` bound stays SQL, and reading either timestamp back needs payloadTier:\"full\". No id filter (that is work_items:get), and source_plan_slug can be FILTERED but is projected on feature rows only, so selecting it, a kind IN-list, a payload-> predicate, an aggregate or a JOIN still wants SQL.",
  routing: {
    want: 'a filtered work-item / issue slice — text, state set, kind, assignee, plan of origin, or a created/updated window',
    use: '`work_items:list { q, state, notTerminal, kind, assignee, sourcePlanSlug, createdSince, updatedSince, limit }` — add includeObservations:true to match a raw SELECT, and completionAuthority to list under-evidenced closes',
    // ⚠ Under 300 chars — routing-table.test.ts budgets this as a table cell.
    insteadOf:
      "`SELECT … WHERE title ILIKE '%x%'`, or `status NOT IN ('done',…)` — that IS `notTerminal`. ⚠ `q` is a literal substring over title+summary, not token search. No id filter; exclusive `>`/`now()` windows, non-union exclusions, source_plan_slug PROJECTION, aggregates and JOINs stay SQL",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (hasPayloadPredicate(atom)) {
      return { covered: false, reason: 'filters on a payload-> path; work_items:list has no payload filter' };
    }
    // ⚠ Found by READING the rendered calls, not by the coverage count. The
    // corpus shape is `WHERE lane = 'observation'` — asking for ONLY observation
    // rows. `includeObservations` is a boolean that ADDS them to the ordinary
    // backlog; there is no observations-only mode, so every rendering of this
    // shape is wrong in one direction or the other (omit the flag → none of the
    // rows asked for; pass it → the backlog as well). Not servable, so not claimed.
    if (/\blane\s*(?:=|<>|!=|\s+in\s*\()/i.test(whereClauseOf(atom))) {
      return { covered: false, reason: 'filters by lane; work_items:list has an include-observations boolean, not a lane filter' };
    }
    // ⚠ Also found by reading: 9 of 20 sampled atoms OR several text fragments
    // together. `q` is ONE substring per call, so rendering the first fragment
    // answers a strictly narrower question than the one asked — the same silent
    // narrowing recorded in fact `substitution-pair-narrowing-over-claim`, and
    // the reason `engineerIssuesSearch` carries this identical guard.
    if (/\b(?:title|summary)\s+i?like\s*'[^']*'[\s\S]*\bor\b[\s\S]*\b(?:title|summary)\s+i?like\s*'/i.test(atom)) {
      return { covered: false, reason: 'ORs several text fragments; `q` is one substring per call' };
    }
    if (inListCount(atom, 'item_kind') > 1) {
      return { covered: false, reason: 'an IN-list of kinds; `kind` takes one value per call' };
    }
    // WI-38339 — `notTerminal` is the ONLY exclusion the verb can express, and it
    // means one specific set. A NOT-IN list that is not set-equal to the canonical
    // terminal union is refused rather than approximated: a proper subset renders a
    // strictly NARROWER answer (the classic silent narrowing), a superset a wider
    // one, and neither is visible in the rows that come back. The shape admits the
    // syntax so this check can run; set equality is not a thing a regex decides.
    const notIn = notInStatesFor(atom);
    if (notIn.length > 0 && !isCanonicalTerminalUnion(notIn)) {
      return {
        covered: false,
        reason: 'excludes a state set that is not the canonical terminal union; the verb has notTerminal, not an arbitrary exclusion list',
      };
    }
    // WI-38339 — filtering on `source_plan_slug` is served; PROJECTING it is not.
    // The verb carries it on feature-family rows only (the issue-family mapper does
    // not emit the key at all), so a query selecting the column would be handed a
    // result missing it for half the rows — the residual-PROJECTION rule, which is
    // why `sourcePlanSlug` was admitted to the filter whitelist and not here.
    if (/\bsource_plan_slug\b/i.test(selectListOf(atom))) {
      return { covered: false, reason: 'projects source_plan_slug; work_items:list returns it on feature-family rows only' };
    }
    const call = workItemsListCallFromQuery(atom);
    if (!call) return { covered: false, reason: 'no text fragment or typed slice to translate into work_items:list args' };
    if (/\btitle\s+i?like/i.test(atom) && !/\bsummary\s+i?like/i.test(atom)) {
      // A superset is acceptable only when the reader can SEE that it is one.
      return { covered: true, expression: `${call} // q matches title AND summary — a superset of a title-only ILIKE` };
    }
    return { covered: true, expression: call };
  },
};

/** Count of `'literal'` entries in an `IN ( … )` list for `column`. */
function inListCount(atom: string, column: string): number {
  const list = new RegExp(String.raw`\b${column}\s+in\s*\(([^)]*)\)`, 'i').exec(atom)?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].length : 0;
}

export const SQL_READ_PAIRS: SqlSubstitutionPair[] = [
  informationSchemaColumns,
  informationSchemaTables,
  schemaMigrationsApplied,
  testRunsHistory,
  engineerIssuesSearch,
  gateHealthRead,
  workItemsById,
  workItemsSearch,
];
