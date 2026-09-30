/**
 * Divergence check for the `harness_shared.session_turns.turn_origin_verdict`
 * COLUMN COMMENT (EI-21506915532672609).
 *
 * The comment is a second copy of a truth the code owns — the set of verdicts
 * `stampTurnProvenance` can persist — and it drifted exactly the way the
 * derived-truth ladder predicts. Migration 794's text enumerated five values and
 * omitted three real ones (`unenrolled-origin`, `owner-dialog`, `not-user-turn`),
 * so the census an agent naturally writes from `dev:pg_query { describe }`
 * returned a structural zero that reads as "the owner never said it".
 *
 * The comment cannot be DERIVED (it lives in an immutable applied migration), so
 * this is the PIN rung: assert that every verdict the code can emit is named in
 * the comment a reader will actually meet.
 *
 * DIRECTION IS DELIBERATE. This checks CODE ⊆ COMMENT, never the reverse. The
 * comment legitimately names values the emitter does not currently produce —
 * `unknown` is RESERVED for classified-but-undeterminable, and session-ingest.ts
 * calls the NULL-vs-unknown distinction load-bearing — so a comment mentioning a
 * currently-unemitted verdict is correct, while a comment MISSING an emitted one
 * is the defect. A symmetric check would have demanded deleting `unknown`, which
 * is the failure this module exists downstream of.
 */

/** The `turn_origin` filter enum in agent-tools/search/filters.ts. */
const TURN_ORIGIN_ENUM = /turn_origin:\s*z\s*\.enum\(\s*\[([^\]]*)\]/;

/** A single-quoted SQL string literal, allowing doubled-quote escapes. */
const SQL_STRING = /'((?:[^']|'')*)'/;

const VERDICT_COMMENT_STMT =
  /COMMENT\s+ON\s+COLUMN\s+harness_shared\.session_turns\.turn_origin_verdict\s+IS\s+/i;

/**
 * The persisted-verdict vocabulary, read from the zod enum that `sessions:search`
 * exposes. That enum is the authoritative *filterable* set and was confirmed
 * against the live table on 2026-09-05: the same seven values, and nothing else.
 */
export function extractPersistedVerdicts(filtersSource: string): string[] {
  const m = TURN_ORIGIN_ENUM.exec(filtersSource);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * Pull the comment text out of a migration, unescaping SQL's doubled quotes so
 * callers compare against the string a reader actually sees.
 */
export function extractVerdictComment(sqlSource: string): string | null {
  const stmt = VERDICT_COMMENT_STMT.exec(sqlSource);
  if (!stmt) return null;
  const rest = sqlSource.slice(stmt.index + stmt[0].length);
  const lit = SQL_STRING.exec(rest);
  if (!lit || lit.index !== 0) return null;
  return lit[1].replace(/''/g, "'");
}

export interface VerdictCommentVerdict {
  ok: boolean;
  missing: string[];
  violations: string[];
}

/**
 * Every verdict the code can persist must be named in the comment.
 */
export function judgeVerdictComment(
  comment: string,
  persistedVerdicts: readonly string[],
): VerdictCommentVerdict {
  const violations: string[] = [];

  if (persistedVerdicts.length === 0) {
    // A vacuous pass is the one outcome this guard must never produce: an empty
    // vocabulary would make every comment satisfy it, including 794's.
    violations.push(
      'no persisted verdicts were extracted — the filters.ts turn_origin enum moved or was renamed, so this check measured nothing',
    );
    return { ok: false, missing: [], violations };
  }

  const missing = persistedVerdicts.filter((v) => !comment.includes(v));
  if (missing.length > 0) {
    violations.push(
      `column comment omits persisted verdict(s) ${missing.map((v) => `'${v}'`).join(', ')} — ` +
        'an agent reading it via `dev:pg_query { describe }` will write a filter that silently ' +
        'excludes them. Omitting a value the classifier emits is how a real owner directive ' +
        'reads back as "never said" (EI-21506915532672609).',
    );
  }

  return { ok: violations.length === 0, missing, violations };
}
