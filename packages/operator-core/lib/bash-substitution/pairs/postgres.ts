/**
 * Equivalence pairs — the POSTGRES family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-007).
 *
 * Population: 798 `psql` atoms across 30 sessions.
 * Proposed replacement: `dev:pg_query`.
 *
 * This is the audit's best-adopted pair (~85%) and the ONLY tool with a routing
 * row in CLAUDE.md — which is the plan's central evidence that routing, not
 * capability, is the lever. So the residue here is pure shape gap, and worth
 * reading precisely.
 *
 * ── What the corpus says, bucketed ───────────────────────────────────────────
 *   277  SELECT via -c            → substitutable, but ONLY against the operator DB
 *   289  connection via shell var → `psql "$ODDS_DB"`, `psql "$(node -e …)"`
 *   101  -c other (SHOW, …)       → not a SELECT
 *    88  `\d` introspection       → no tool form (P-011)
 *    19  heredoc SQL              → multi-statement, no tool form
 *    18  DDL/DML                  → correctly no tool form (read-only tool)
 *     6  -f file.sql              → that is db:migrate, not this
 *
 * ── The finding the plan did not anticipate ──────────────────────────────────
 * `dev:pg_query` has NO database selector — it runs against the operator
 * Postgres, full stop. But a large share of real psql traffic targets a
 * DIFFERENT database entirely: `$ODDS_DB`, `$PGURL/oddsmith_028_rehearsal`,
 * `wi5635_scratch`. Those calls are not badly-routed operator reads; they are
 * reads of another database that this tool structurally cannot serve.
 *
 * So per D-008 the pattern is narrowed to what is genuinely substitutable: a
 * SELECT, issued with `-c`, against a LITERAL operator-Postgres connection.
 * Everything else falls outside rather than dragging the verdict down — and,
 * importantly, is never nudged toward a tool that would silently query the
 * WRONG DATABASE. That failure mode would be worse than the raw psql it
 * replaced, because it returns plausible rows instead of an error.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * A literal operator-Postgres connection. Either the URL form
 * (`postgresql://…/papercusp`) or the flag form (`-d papercusp`). A `$`-bearing
 * connection is excluded by the pattern: we cannot know which database it
 * resolves to, and guessing is the wrong-database failure above.
 */
const OPERATOR_DB = /(?:\/papercusp\b|-d\s+papercusp\b)/;

/** Statements `dev:pg_query` accepts: a single read-only SELECT / WITH…SELECT. */
const READ_ONLY_STATEMENT = /^\s*(?:select|with)\b/i;

/** Anything that mutates — rejected by the tool's read-only transaction. */
const MUTATING = /\b(?:insert|update|delete|create|alter|drop|truncate|grant|revoke|begin|commit|vacuum|analyze)\b/i;

/** Extract the argument of `-c`, tolerating single or double quoting. */
function extractCommandArg(atom: string): string | null {
  const match = /-c\s+("([^"]*)"?|'([^']*)'?|(\S+))/.exec(atom);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * P-007a — `psql <operator-db> -c "SELECT …"`. The genuinely substitutable
 * subset, and the one the CLAUDE.md routing row already advertises.
 *
 * NOTE ON ATOM TRUNCATION: the atomiser splits on `;` and `|`, so a SQL body
 * containing either is cut short (`… ORDER BY id DESC LIMIT`). That is harmless
 * for matching — the verb, the connection and the leading SELECT all sit before
 * any separator — and the alternative (a quote-aware shell parser) costs far
 * more than it buys. Coverage therefore judges the statement's HEAD, which is
 * exactly what decides whether `dev:pg_query` accepts it.
 */
export const psqlSelectRead: BashSubstitutionPair = {
  id: 'postgres.psql-select',
  intentLabel: 'operator-db-select',
  bashPattern: new RegExp(
    // No shell expansion in the connection, and no heredoc.
    String.raw`^psql\s+(?![^\n]*[$\`])(?![^\n]*<<)` +
      // ...and not a MULTI-STATEMENT invocation (two or more `-c`). See the
      // note on the psql-describe pattern below: `dev:pg_query` runs one
      // statement per call, so a two-`-c` command has no single-call tool
      // expression and must fall OUTSIDE the pattern (D-008) rather than
      // being claimed and then either failing coverage or — worse — passing it
      // because `cover()` only inspects the first `-c`.
      String.raw`(?![^\n]*-c\s+[^\n]*-c\s+)` +
      // A literal operator-Postgres connection, then a -c SELECT/WITH.
      String.raw`[^\n]*(?:\/papercusp\b|-d\s+papercusp\b)[^\n]*-c\s+["']?\s*(?:select|with)\b`,
    'i',
  ),
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { sql } runs read-only SELECT/WITH against the operator Postgres directly — no connection string, no psql, and it applies the row cap and statement_timeout for you.',
  routing: {
    want: 'a one-off SELECT against the OPERATOR database',
    use: '`dev:pg_query { sql }` (read-only txn + row cap + statement_timeout)',
    insteadOf:
      '`psql -d papercusp -c "SELECT …"`. ⚠ ONLY the operator DB — a `$VAR`/other-database connection has NO tool form, so keep using psql for those rather than risk querying the WRONG database',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (!OPERATOR_DB.test(atom)) {
      return { covered: false, reason: 'targets a non-operator database; dev:pg_query has no database selector' };
    }
    const sql = extractCommandArg(atom);
    if (!sql) return { covered: false, reason: 'no -c statement to run' };
    if (!READ_ONLY_STATEMENT.test(sql)) {
      return { covered: false, reason: `statement is not a SELECT/WITH ("${sql.slice(0, 40)}")` };
    }
    // A leading SELECT followed by a mutation keyword would be a compound
    // statement; dev:pg_query takes exactly one read-only statement.
    const body = sql.replace(READ_ONLY_STATEMENT, '');
    if (MUTATING.test(body)) {
      return { covered: false, reason: 'compound or mutating statement; dev:pg_query accepts one read-only statement' };
    }
    return { covered: true, expression: `dev:pg_query { sql: "${sql.slice(0, 60)}…" }` };
  },
};

/**
 * P-007b — `psql <operator-db> -c "\d table"`: schema introspection.
 *
 * 88 atoms, and the single largest psql residue with no tool form. `\d` is a
 * psql CLIENT meta-command, not SQL, so it cannot be passed through
 * `dev:pg_query` at all — an agent inspecting a table's columns, indexes or
 * constraints has no choice but to shell out.
 *
 * Closed by P-011, which adds a `describe` mode to `dev:pg_query` rather than
 * inventing a second tool: it is the same capability (read the operator DB),
 * the same read-only envelope, and the same routing row.
 */
export const psqlDescribe: BashSubstitutionPair = {
  id: 'postgres.psql-describe',
  intentLabel: 'operator-db-describe',
  // Only the RELATION-describing meta-commands: `\d`, `\d+`, `\dt`, `\dv`,
  // `\di`, `\dm`. `\df` (functions), `\dn` (schemas) and `\du` (roles) address
  // object classes that are not relations, so per D-008 they fall OUTSIDE the
  // pattern rather than dragging the verdict down — describing them is a
  // separate capability, not a missing corner of this one.
  // A MULTI-STATEMENT psql (two or more `-c`) is excluded outright. `dev:pg_query`
  // runs one statement per call, so `psql … -c "SELECT …" -c "\d table"` has no
  // single-call tool expression — it falls outside the pattern per D-008 rather
  // than dragging the verdict down.
  //
  // This exclusion was invisible until the atomizer was fixed (D-047), and the way
  // it hid is worth recording: the old splitter cut on the `;` INSIDE the SELECT's
  // quotes, so the corpus contained a tidy `-c "\d harness_shared.watchdog_ticks"`
  // fragment that matched and covered cleanly. The bug was not merely inflating the
  // denominator — it was MANUFACTURING favourable evidence, by shredding the exact
  // commands a pattern could not honestly serve into pieces that it could.
  bashPattern: new RegExp(
    String.raw`^psql\s+(?![^\n]*[$\`])(?![^\n]*-c\s+[^\n]*-c\s+)[^\n]*(?:\/papercusp\b|-d\s+papercusp\b)[^\n]*-c\s+["']?\s*\\d(?:[tvim]|\+)*(?:\s|["']|$)`,
    'i',
  ),
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { describe: "schema.table" } returns columns, indexes and constraints — the `\\d` equivalent; a `*` glob lists matching relations, like `\\dt`.',
  routing: {
    want: "a table's columns / indexes / constraints",
    use: '`dev:pg_query { describe: "schema.table" }` (a `*` glob lists relations)',
    insteadOf: '`psql -c "\\d table"` (`\\df`/`\\dn`/`\\du` are other object classes — no tool form)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const sql = extractCommandArg(atom);
    if (!sql) return { covered: false, reason: 'no -c meta-command' };

    const match = /^\s*\\d((?:[tvim]|\+)*)\s*(\S*)/.exec(sql);
    if (!match) return { covered: false, reason: `unsupported psql meta-command "${sql.slice(0, 30)}"` };

    const [, modifiers, target] = match;
    // `\df`/`\dn`/`\du` should never reach here (excluded by the pattern), but
    // an envelope that silently passed them would produce a false equivalence.
    if (/[^tvim+]/.test(modifiers)) {
      return { covered: false, reason: `meta-command \\d${modifiers} addresses a non-relation object class` };
    }
    if (!target) {
      return { covered: true, expression: 'dev:pg_query { describe: "*" } // lists all relations' };
    }
    // A glob (`\dt harness_shared.*`) maps onto describe's listing mode.
    return { covered: true, expression: `dev:pg_query { describe: "${target}" }` };
  },
};

/** Every pair in the postgres family, in registry order. */
export const POSTGRES_PAIRS: BashSubstitutionPair[] = [psqlSelectRead, psqlDescribe];
