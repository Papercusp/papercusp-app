/**
 * on-conflict-diagnostic.ts — turn Postgres SQLSTATE 42P10 into a message that
 * names the DEFECT instead of describing the symptom.
 *
 * ── The problem (EI-18790766038338123) ──────────────────────────────────────
 * When a running process sends an `ON CONFLICT (...)` spec that matches no
 * unique index on the target relation, Postgres answers with one sentence:
 *
 *     there is no unique or exclusion constraint matching the ON CONFLICT specification
 *
 * That sentence names neither the table, nor the spec that failed to infer, nor
 * the actual cause. So every agent who meets it starts the diagnosis from zero.
 * For migration 689 alone, FOUR independent sessions each re-derived the same
 * root cause — schema/code deploy skew — inside one hour of each other. The
 * ORDERING side of that class is now guarded by lint:migrations; this is the
 * DETECTION side, which was wide open.
 *
 * ── Why this needs no new machinery ─────────────────────────────────────────
 * The process already HOLDS everything the message is missing. postgres-js
 * decorates every rejected query error with the failing statement — see
 * `queryError()` in postgres/src/connection.js, which defines `query`,
 * `parameters` and `args` on the error object (non-enumerable unless the
 * `debug` option is on, but always readable). So the relation and the
 * ON CONFLICT target are both recoverable from the error ALONE, synchronously,
 * with no extra round-trip and no access to a pool.
 *
 * ── Why this is deliberately PURE and SYNCHRONOUS ───────────────────────────
 * Listing the unique indexes that DO exist would need a live query. That would
 * make this async, connection-bound, and capable of failing (or hanging) while
 * already handling a failure — the worst possible place for a second fallible
 * step. Instead the message names the exact one-line command that lists them.
 * The diagnosis still collapses to a single read, and the enrichment itself
 * cannot throw, hang, or need a connection.
 *
 * ── The original message is preserved VERBATIM ──────────────────────────────
 * The enriched text opens with Postgres' own sentence, unchanged, so any
 * existing substring or regex matcher over the old text keeps matching — the
 * tool-error classifier's dual-engine `messagePattern` rules, a log grep, an
 * agent's own recall. This function only ever APPENDS explanation.
 */

/**
 * Postgres SQLSTATE for "no unique or exclusion constraint matching the
 * ON CONFLICT specification". Named so call sites read as intent, not trivia.
 */
export const ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE = '42P10';

/**
 * The invariant fragment of Postgres' own 42P10 text. Used as a FALLBACK
 * recogniser: an error that crossed a boundary which dropped `.code` (a
 * re-wrap, a serialize/deserialize hop, an aggregate error) still carries its
 * message, and this class of skew is expensive enough to be worth catching on
 * either signal rather than only the tidy one.
 */
const PG_42P10_MESSAGE_FRAGMENT = 'no unique or exclusion constraint matching';

/**
 * A SQL identifier: quoted ("a""b") or bare, per Postgres' own lexing.
 *
 * DELIBERATELY ASCII-ONLY. An earlier draft admitted non-ASCII identifiers via
 * a high-Unicode tail, which is a silent hazard: written as LITERAL high
 * characters the class parses as one contiguous range starting at `_`, which
 * also swallows `{ | } ~` — and it still compiles and still behaves correctly
 * on every happy-path identifier, so nothing surfaces the defect. Measured, not
 * assumed: that draft matched "{|}~". Every relation in this repo is ASCII, and
 * a non-ASCII one degrades to `null` here, which callers render as an explicit
 * "could not recover" line rather than a confidently wrong answer.
 */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

/** `INSERT INTO schema.table` / `INSERT INTO "S"."T"` / `INSERT INTO t`. */
const INSERT_TARGET_RE = new RegExp(
  String.raw`\binsert\s+into\s+(${IDENT}(?:\s*\.\s*${IDENT})*)`,
  'i',
);

/**
 * Everything between `ON CONFLICT` and its `DO NOTHING` / `DO UPDATE` action —
 * i.e. the conflict target: `(col, ...)`, `(col) WHERE ...`, or
 * `ON CONSTRAINT n`. Non-greedy so the FIRST `DO` terminates it (a
 * `DO UPDATE SET x = ...` body may contain further parenthesised expressions).
 */
const ON_CONFLICT_TARGET_RE =
  /\bon\s+conflict\b([\s\S]*?)\bdo\s+(?:nothing|update)\b/i;

/** Collapse whitespace/newlines so a multi-line statement reads on one line. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Read a property that postgres-js defined as non-enumerable. Direct access
 * works on a non-enumerable own property; only spread/JSON drop it, which is
 * why an error that has been through a structured-clone hop may arrive without
 * it. Handled: the caller degrades rather than fails.
 */
function readErrProp(err: unknown, key: string): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * True when `err` is the ON CONFLICT/index-skew failure. Matches on SQLSTATE
 * first (authoritative) and falls back to the message fragment for errors that
 * lost their code crossing a boundary.
 */
export function isOnConflictSkewError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  if (code === ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE) return true;
  const message = readErrProp(err, 'message');
  return !!message && message.toLowerCase().includes(PG_42P10_MESSAGE_FRAGMENT);
}

/** The relation an `INSERT ... ON CONFLICT` statement targets, if recoverable. */
export function parseInsertTarget(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = INSERT_TARGET_RE.exec(sql);
  return m ? squash(m[1]) : null;
}

/** The `ON CONFLICT` conflict-target clause as written, if recoverable. */
export function parseConflictTarget(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = ON_CONFLICT_TARGET_RE.exec(sql);
  if (!m) return null;
  const target = squash(m[1]);
  // A bare `ON CONFLICT DO NOTHING` carries no target and can never raise
  // 42P10 (there is nothing to infer), so an empty capture here means the
  // statement did not match the shape we think it did — say so rather than
  // present an empty clause as if it were the finding.
  return target.length > 0 ? target : null;
}

const UNRECOVERABLE = '(could not recover from the failing statement)';

/**
 * Build the enriched message for a 42P10, or `null` when `err` is not that
 * error. Returning `null` (rather than a passthrough string) keeps call sites
 * honest: they fall back to their existing formatting untouched.
 *
 * Never throws: every field degrades to an explicit "could not recover" line,
 * so a partial parse still delivers the CAUSE — which is the half that actually
 * shortens the diagnosis.
 */
export function explainOnConflictSkew(err: unknown): string | null {
  if (!isOnConflictSkewError(err)) return null;

  const original =
    readErrProp(err, 'message') ??
    'there is no unique or exclusion constraint matching the ON CONFLICT specification';
  const sql = readErrProp(err, 'query');
  const table = parseInsertTarget(sql);
  const target = parseConflictTarget(sql);

  const lines: string[] = [
    original,
    '',
    `  -- ON CONFLICT / index skew (SQLSTATE ${ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE}) --`,
    `  table:           ${table ?? UNRECOVERABLE}`,
    `  conflict target: ${target ?? UNRECOVERABLE}`,
    '',
    "  CAUSE: the running code's ON CONFLICT target matches no unique index on that",
    '  relation. This is almost always schema/code DEPLOY SKEW — the running build was',
    '  compiled against a different unique index than the live database now has. Check',
    '  whether a migration added, dropped, or reshaped a unique index on this table.',
  ];

  if (table) {
    lines.push(
      '',
      '  NEXT: list the unique indexes that actually exist and compare them with the',
      '  conflict target above --',
      `      dev:pg_query { describe: "${table}" }`,
    );
  } else {
    lines.push(
      '',
      '  NEXT: the failing statement was not attached to this error, so the relation',
      '  could not be named. Recover it from the call site, then list that relation’s',
      '  unique indexes with dev:pg_query { describe: "<schema.table>" }.',
    );
  }

  return lines.join('\n');
}
