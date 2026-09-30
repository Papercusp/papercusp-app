/**
 * Doc claim: CLAUDE.md's `pg_stat_activity` self-match rule points readers at
 * `dev:pg_active_queries` as the SAFE alternative. That recommendation rests on two
 * properties of the live code, either of which could be edited away without anything
 * failing loudly — at which point the documented advice silently becomes wrong:
 *
 *   1. `pgActiveQueries` (packages/operator-core/lib/dev-data.ts) EXCLUDES ITS OWN
 *      statement. It does so via `query NOT ILIKE '%pg_stat_activity%'`, which works
 *      because its own query text necessarily contains `pg_stat_activity`.
 *   2. `dev:pg_active_queries` exposes NO caller-supplied pattern argument, so a caller
 *      cannot reintroduce the `query LIKE '%pattern%'` self-match through the tool.
 *
 * Drop either and the trap is reachable again through the very tool the docs name as
 * the way out. This judge is deliberately pure so the test can prove it FAILS on the
 * pre-fix shapes rather than only passing on the current tree.
 */

/** Strip `//` line comments so a predicate MENTIONED in prose never counts as wiring. */
export function stripLineComments(source: string): string[] {
  return source.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  });
}

/**
 * Extract the body of a named `export async function` up to the next top-level
 * `export `, so a predicate belonging to a NEIGHBOURING function can never be
 * miscredited to this one.
 */
export function extractFunctionBody(source: string, fnName: string): string | null {
  const start = source.indexOf(`export async function ${fnName}`);
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const nextExport = rest.indexOf('\nexport ');
  return nextExport === -1 ? source.slice(start) : source.slice(start, start + 1 + nextExport);
}

/** Argument names that would hand a caller a pattern to inject into the WHERE clause. */
const PATTERN_ARG_NAMES = ['query', 'pattern', 'like', 'ilike', 'filter', 'grep', 'match', 'search'];

export type PgActiveQueriesSafetyVerdict = {
  ok: boolean;
  /** 1-indexed lines carrying a real (non-comment) self-exclusion predicate. */
  selfExclusionAt: number[];
  /** Pattern-shaped argument names found on the tool's zod schema. */
  patternArgs: string[];
  problems: string[];
};

export function judgePgActiveQueriesSafety(input: {
  devDataSource: string;
  toolSource: string;
}): PgActiveQueriesSafetyVerdict {
  const problems: string[] = [];
  const selfExclusionAt: number[] = [];
  const patternArgs: string[] = [];

  // ---- 1. the SQL still excludes its own backend -------------------------------
  const body = extractFunctionBody(input.devDataSource, 'pgActiveQueries');
  if (body === null) {
    problems.push(
      'pgActiveQueries was not found in dev-data.ts — CLAUDE.md names dev:pg_active_queries as the ' +
        'self-match-safe alternative; re-verify that claim and update the doc part ' +
        '`long-jobs-background-them-at-pg-stat-activity-self`.',
    );
  } else {
    const lines = stripLineComments(body);
    lines.forEach((line, i) => {
      const flat = line.replace(/\s+/g, ' ');
      // Either idiom is a genuine self-exclusion: excluding statements that mention the
      // catalog view (which this one necessarily does), or excluding this backend by pid.
      const excludesByViewName = /query\s+NOT\s+I?LIKE\s+'%pg_stat_activity%'/i.test(flat);
      const excludesByBackendPid = /pid\s*(<>|!=)\s*pg_backend_pid\(\)/i.test(flat);
      if (excludesByViewName || excludesByBackendPid) selfExclusionAt.push(i + 1);
    });
    if (selfExclusionAt.length === 0) {
      problems.push(
        "pgActiveQueries no longer excludes its own backend (expected `query NOT ILIKE '%pg_stat_activity%'` " +
          'or `pid <> pg_backend_pid()`): dev:pg_active_queries can now report itself, so CLAUDE.md must ' +
          'stop naming it as the safe alternative.',
      );
    }
  }

  // ---- 2. the tool still exposes no caller-supplied pattern ---------------------
  const argsMatch = input.toolSource.match(/args:\s*z\.object\(\{([\s\S]*?)\}\)/);
  if (!argsMatch) {
    problems.push('could not locate the zod args object on dev:pg_active_queries.');
  } else {
    const argLines = stripLineComments(argsMatch[1]);
    for (const line of argLines) {
      const declared = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (declared && PATTERN_ARG_NAMES.includes(declared[1].toLowerCase())) {
        patternArgs.push(declared[1]);
      }
    }
    if (patternArgs.length > 0) {
      problems.push(
        `dev:pg_active_queries now accepts a pattern-shaped argument (${patternArgs.join(', ')}), which lets a ` +
          'caller reintroduce the `query LIKE \'%pattern%\'` self-match through the tool CLAUDE.md recommends ' +
          'as the way out of it.',
      );
    }
  }

  return { ok: problems.length === 0, selfExclusionAt, patternArgs, problems };
}
