/**
 * rubrics-replication-sql — EI-10514: schema-validate the SQL embedded in a rubric
 * criterion's REPLICATION DRILL text at propose/amend/ratify time.
 *
 * WHY: rubric replication drills are authored FROM MEMORY of the live schema (they're
 * prose, not code — nothing type-checks or runs them at write time). The first real
 * execution of the pot-coordination-health drills (wake-13, EI-10478) found 10 of 14
 * embedded SQL statements referenced renamed/nonexistent tables/columns
 * (routed_ideas → harness_shared.scout_routed_ideas, scout_ticks.ideas_count →
 * ideas_generated, blender_idea_grades → doesn't exist, …) — a drill that LOOKS like a
 * testing procedure but nobody can actually run, exactly the silent failure the owner's
 * testing-procedure mandate exists to eliminate. This runs a cheap, non-blocking
 * `EXPLAIN (COSTS OFF)` pass over every isolable SQL statement in a criterion's
 * replication text and surfaces (never rejects — see below) anything that wouldn't
 * parse/plan against the live schema, the same idea as plans:lint's validation pass.
 *
 * NON-BLOCKING BY DESIGN: unlike the WI-4287 loss-guards (which throw — they protect
 * against silently losing STORED content, a fully in-our-control invariant), a bad SQL
 * reference is checked against EXTERNAL, moving-target state (the live schema can
 * legitimately be unreachable, mid-migration, or simply slow) — rejecting a propose on a
 * transient DB hiccup would be worse than the bug this fixes. Findings are surfaced in
 * the tool response next to `completeness`, for the caller/reviewer to act on.
 *
 * Extraction is deliberately CONSERVATIVE. A criterion's replication field is free-text
 * prose that may embed zero, one, or several SQL statements anywhere, often followed by
 * more prose with no semicolon in between (e.g. "... ORDER BY invoked_at. Count calls
 * with tool_name LIKE 'plur%' ..." — the query truly ends at the bare period, not the
 * first `;` several sentences later). Mis-slicing a statement produces a FALSE POSITIVE
 * syntax error that erodes trust in the check; failing to isolate an ambiguous one is
 * merely a quiet miss. The asymmetry favors under-detection: a statement is only
 * extracted when its extent is unambiguous — terminated by a `;`, by a `.` immediately
 * followed by whitespace (a sentence boundary — SQL never has a bare `.<space>` outside
 * a string literal: schema-qualified names and numeric literals never have a space after
 * the dot), or by the end of the field text — all tracked OUTSIDE single-quoted string
 * literals so an embedded `'e.g. ...'`/`'a; b'` never triggers a false cut.
 *
 * BIND PLACEHOLDERS (EI-19988213173207009). A drill is a COPY-RUNNABLE recipe a grader
 * parameterises per run, so a `:subject` / `:ws` / `:run_start` placeholder is the CORRECT
 * way to author one — but Postgres cannot parse it, so every such statement came back as
 * `42601 syntax error at or near ":"`. Measured on goal-mode-e2e 2026-08-09: 16 of 16
 * findings were that benign class, across 10 criteria, while the SAME array carried two
 * genuine defects (a `goals.spent_cents` column that does not exist -> 42703, and an
 * ISO-string compared against a BIGINT epoch-ms column -> 22P02). The reviewer had to
 * hand-separate them. A guard whose output is ~100% benign is functionally OFF: the
 * correct response to it becomes "ignore", and that is indistinguishable from the correct
 * response when it finally fires for real.
 *
 * So a statement carrying placeholders is RE-CHECKED with each one replaced by an untyped
 * NULL. That recovers real coverage rather than merely hiding the noise — name resolution
 * runs on the second pass, so a bad table/column in a parameterised drill is now caught
 * where the parse error used to mask it. Verified against live PG: `= NULL` plans, while
 * `AND spent_cents > 0` still fails 42703 and a missing relation still fails 42P01.
 *
 * The substitution is not free, and the cost is ACCOUNTED FOR rather than ignored: an
 * untyped NULL can itself provoke an overload-resolution failure that says nothing about
 * the drill (measured: `date_trunc('day', NULL)` -> `42725 function date_trunc(unknown,
 * unknown) is not unique`). Those codes — and only those — are bucketed as
 * `undeterminable` with the reason attached, because our own dummy literal is a candidate
 * cause and the drill's intended parameter type is not knowable here. Every other code
 * stays a real finding, so an unfamiliar failure surfaces loudly instead of being softened
 * by default.
 */

import {
  explainReadQuery,
  extractPgErrorInfo,
  type PgErrorInfo,
} from './pg-read-query';

/**
 * Matches the start of a top-level SQL read statement embedded in prose. `SELECT` alone
 * is specific enough to prose to match bare (case-insensitive — real drills only ever
 * write it uppercase, but this stays lenient). `WITH` is NOT: "with" is an ordinary
 * English preposition ("Count calls WITH tool_name LIKE …" in a drill's own grading
 * prose, a real false-positive hit during development) — so it's only treated as a CTE
 * start when actually shaped like one (`WITH [RECURSIVE] <name> AS (`).
 */
const SQL_START_RE = /\bSELECT\b|\bWITH\s+(?:RECURSIVE\s+)?[A-Za-z_][A-Za-z0-9_]*\s+AS\s*\(/gi;

/**
 * PURE: scan from `start` for the end of one SQL statement, tracking single-quoted
 * string state (with '' escaping) so a `;` or sentence-boundary `.` INSIDE a string
 * literal is never mistaken for the statement's end. Returns the index of the first
 * unquoted `;`, the first unquoted `.` followed by whitespace, or `text.length` if
 * neither occurs (the statement runs to the end of the field).
 */
function findUnquotedStatementEnd(text: string, start: number): number {
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++; // escaped '' — still inside the literal
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === ';') return i;
    if (ch === '.' && /\s/.test(text[i + 1] ?? '')) return i;
  }
  return text.length;
}

/**
 * PURE: extract every unambiguously-delimited SQL statement embedded in free-text drill
 * prose (a criterion's `replication` field). Nested/subquery SELECTs inside an already-
 * captured statement are not independently re-extracted. See module doc for the
 * conservative-extraction rationale.
 */
export function extractReplicationSqlStatements(text: string | undefined | null): string[] {
  const out: string[] = [];
  if (!text) return out;
  SQL_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumedUntil = -1;
  while ((match = SQL_START_RE.exec(text))) {
    const start = match.index;
    if (start < consumedUntil) continue; // nested inside a previously captured statement
    const end = findUnquotedStatementEnd(text, start);
    consumedUntil = end;
    // strip a lone trailing sentence-period this scan intentionally leaves attached
    // when the statement runs to end-of-text (findUnquotedStatementEnd never itself
    // strips it — only the `.`+whitespace mid-text case is excluded from the slice).
    const stmt = text.slice(start, end).trim().replace(/\.$/, '').trim();
    if (stmt) out.push(stmt);
  }
  return out;
}

/**
 * The literal substituted for a bind placeholder before the re-check. Untyped ON PURPOSE:
 * a concrete type (`NULL::text`) would resolve an overload the DRILL never specified,
 * making our guess — not the drill — the thing being validated.
 */
const BIND_PLACEHOLDER_DUMMY = 'NULL';

/** PURE: index just past the closing `q` of the quoted run starting at `start` (a doubled
 *  quote is an escape, not a terminator). Returns text.length for an unterminated run. */
function scanQuotedRun(text: string, start: number, q: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== q) continue;
    if (text[i + 1] === q) {
      i++; // doubled '' / "" — still inside
      continue;
    }
    return i + 1;
  }
  return text.length;
}

/**
 * PURE: replace every `:name` bind placeholder with an untyped NULL literal; returns the
 * rewritten SQL plus the placeholder tokens in order of first appearance (empty ⇒ the
 * statement carried none and is left byte-identical).
 *
 * Scans with enough SQL lexical awareness that it can only ever touch a REAL placeholder —
 * mangling valid SQL here would manufacture exactly the false findings this pass exists to
 * remove. Left untouched: single-quoted strings (so a `'12:30'` time literal survives),
 * double-quoted identifiers, dollar-quoted bodies, line comments, block comments (which PG
 * allows to nest), the `::` cast operator, and `:=`. An array slice (`x[1:3]`) and a bare
 * `": "` need no special case — a digit or a space is not an identifier start.
 */
export function substituteBindPlaceholders(sql: string): { sql: string; placeholders: string[] } {
  const placeholders: string[] = [];
  const n = sql.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const end = scanQuotedRun(sql, i, ch);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ':' && sql[i + 1] === ':') {
      out += '::'; // cast operator — never a placeholder
      i += 2;
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const token = sql.slice(i, j);
      // deduped: a drill that binds `:ws` three times is reported once, so the list reads
      // as the drill's parameter SET rather than a hit count.
      if (!placeholders.includes(token)) placeholders.push(token);
      out += BIND_PLACEHOLDER_DUMMY;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { sql: out, placeholders };
}

/**
 * SQLSTATEs that the substituted untyped NULL can ITSELF provoke, mapped to the reason a
 * reviewer needs. A statement failing with one of these only AFTER substitution cannot be
 * attributed to the drill, so it is bucketed as `undeterminable` rather than reported as a
 * defect.
 *
 * Deliberately a CLOSED list of type/overload-resolution codes. Everything else — notably
 * `42P01` undefined table and `42703` undefined column, which no value literal can cause —
 * stays a REAL finding, so an unfamiliar code fails loudly instead of being softened by
 * default. That is the safe direction for a guard: over-reporting costs a reviewer one
 * glance, under-reporting is the bug this whole pass exists to fix.
 */
const SUBSTITUTION_ATTRIBUTABLE_CODES = new Map<string, string>([
  [
    '42725',
    "ambiguous function: the substituted untyped NULL cannot select an overload, and the drill's intended parameter type is not knowable here",
  ],
  [
    '42883',
    'no function matches the substituted untyped NULL — this may equally be a misspelled function in the drill, so read the SQL before dismissing it',
  ],
  ['42P18', 'indeterminate datatype for the substituted placeholder'],
  ['42804', 'datatype mismatch involving the substituted placeholder'],
  [
    '42803',
    'grouping error: a placeholder in a GROUP BY / HAVING position cannot be stood in for by a literal',
  ],
  [
    '42601',
    'still fails to parse after substitution — either genuinely malformed SQL, or a placeholder sitting where no literal can occupy',
  ],
]);

/** One embedded SQL statement that failed to parse/plan against the live schema. */
export interface ReplicationSqlFinding {
  criterionKey: string;
  sql: string;
  error: PgErrorInfo;
  /** true when the statement carried bind placeholders that were substituted before this
   *  error was produced — i.e. the error comes from the SECOND pass, not the drill as written. */
  afterPlaceholderSubstitution?: boolean;
  /** The placeholder tokens found in the statement (`:subject`, …), in order. */
  placeholders?: string[];
  /** Why this landed in `undeterminable` instead of `findings`. Set only on that bucket. */
  undeterminableReason?: string;
}

export interface ReplicationSqlValidationResult {
  /** Total embedded statements isolated + checked across all criteria. */
  checked: number;
  /**
   * REAL defects only — a statement that failed EXPLAIN for a reason the drill owns
   * (undefined table/column, bad cast, …). This is the list a reviewer must act on, and
   * keeping it real-only is the point of EI-19988213173207009: it used to be padded with a
   * benign bind-placeholder finding per parameterised statement.
   */
  findings: ReplicationSqlFinding[];
  /**
   * Statements whose ONLY failure was attributable to our own substituted dummy literal
   * (see SUBSTITUTION_ATTRIBUTABLE_CODES) — reported, with a reason each, but never mixed
   * into `findings` and never counted against `ok`.
   */
  undeterminable: ReplicationSqlFinding[];
  /**
   * Count of parameterised statements that planned CLEANLY once their placeholders were
   * substituted — i.e. coverage genuinely gained, not noise suppressed. These were the 16
   * of 16 false findings measured on goal-mode-e2e.
   */
  placeholderOnly: number;
  /** true when there are no REAL findings (`undeterminable` does not clear or set this). */
  ok: boolean;
  /** One-line rendering of the split, so a reviewer never has to re-derive it by hand. */
  summary: string;
}

/** Bound worst-case latency on a rubric with an unusually large number of embedded
 *  statements — EXPLAIN is cheap (single-digit ms) but this stays a hard ceiling. */
const MAX_STATEMENTS_CHECKED = 60;

/** EXPLAIN one statement, normalising a thrown driver error into the same shape as a
 *  returned one so callers only ever branch on `ok`. */
function explainOrError(sql: string): Promise<{ ok: true } | { ok: false; error: PgErrorInfo }> {
  return explainReadQuery(sql).catch(
    (err): { ok: false; error: PgErrorInfo } => ({ ok: false, error: extractPgErrorInfo(err) }),
  );
}

/**
 * PURE: render the real/benign split as one line. The reviewer should never be the thing
 * that separates signal from noise (EI-19988213173207009), so the counts lead — a caller
 * reads "0 real" instead of counting an undifferentiated `findings` array.
 */
export function summarizeReplicationSqlCheck(
  r: Omit<ReplicationSqlValidationResult, 'summary'>,
): string {
  if (r.checked === 0) return 'no embedded drill SQL to check';
  const parts = [
    `${r.checked} statement(s) checked`,
    `${r.findings.length} real finding(s)`,
  ];
  if (r.placeholderOnly > 0) {
    parts.push(
      `${r.placeholderOnly} parameterised drill(s) clean once bind placeholders were substituted`,
    );
  }
  if (r.undeterminable.length > 0) {
    parts.push(
      `${r.undeterminable.length} undeterminable (the substituted placeholder may itself be the cause — see undeterminable[])`,
    );
  }
  return parts.join(' · ');
}

/**
 * Run the EI-10514 schema-validation pass over every criterion's replication text.
 * Best-effort / fail-open: any unexpected error from the check itself (not a specific
 * statement's EXPLAIN failure — that's a legitimate finding) is swallowed so a lint-style
 * check never breaks the write path it's advising on.
 */
export async function validateRubricReplicationSql(
  criteria: ReadonlyArray<{ key: string; replication?: string }>,
): Promise<ReplicationSqlValidationResult> {
  const findings: ReplicationSqlFinding[] = [];
  const undeterminable: ReplicationSqlFinding[] = [];
  let checked = 0;
  let placeholderOnly = 0;
  try {
    outer: for (const c of criteria) {
      for (const sql of extractReplicationSqlStatements(c.replication)) {
        if (checked >= MAX_STATEMENTS_CHECKED) break outer;
        checked++;
        const first = await explainOrError(sql);
        if (first.ok) continue;

        // A parameterised drill cannot parse as written, so a bare failure here says
        // nothing until the placeholders are stood in for. Statements with none keep the
        // original one-pass behaviour exactly.
        const { sql: substituted, placeholders } = substituteBindPlaceholders(sql);
        if (placeholders.length === 0) {
          findings.push({ criterionKey: c.key, sql, error: first.error });
          continue;
        }

        const retry = await explainOrError(substituted);
        if (retry.ok) {
          placeholderOnly++;
          continue;
        }
        const finding: ReplicationSqlFinding = {
          criterionKey: c.key,
          sql,
          error: retry.error,
          afterPlaceholderSubstitution: true,
          placeholders,
        };
        const reason = retry.error.code
          ? SUBSTITUTION_ATTRIBUTABLE_CODES.get(retry.error.code)
          : undefined;
        if (reason) undeterminable.push({ ...finding, undeterminableReason: reason });
        else findings.push(finding);
      }
    }
  } catch {
    // fail-open — see module doc: never let this advisory check break a rubric write.
  }
  const result = { checked, findings, undeterminable, placeholderOnly, ok: findings.length === 0 };
  return { ...result, summary: summarizeReplicationSqlCheck(result) };
}
