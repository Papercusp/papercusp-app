/**
 * A shared BRANCHED sql-mock for the `vi.mock('@papercusp/db-org', ...)` /
 * `sqlMock.mockImplementation(...)` pattern used across ~375 test files in this
 * package (EI-12141 — "test mock/prod query-shape drift silently red-pins a
 * regression guard", class: silent gate-red).
 *
 * The hand-rolled version of this pattern looks like:
 *
 *   sqlMock.mockImplementation(async (strings) => {
 *     const query = Array.isArray(strings) ? strings.join(' ') : '';
 *     return query.includes('some_literal_substring') ? [{ ...fixture }] : [];
 *   });
 *
 * That silently falls through to `[]` for ANY query that doesn't match the
 * hardcoded substring — including one that used to match before the real query
 * was refactored. The traced instance (EI-11796 / WI-4864): a query shape
 * changed from a `COUNT(*) AS active_claims` aggregate to a row list, the old
 * `.includes('active_claims')` matcher stopped matching anything, and the mock
 * quietly returned `[]` for a query it was supposed to fake a held claim for —
 * masquerading as an unrelated, hard-to-triage red instead of a loud "your mock
 * doesn't cover this query anymore".
 *
 * `createBranchedSqlMock` replaces the ad-hoc `.includes()` chain with a small
 * ordered list of labeled branches and TWO loud-failure guarantees a hand-rolled
 * chain doesn't give you:
 *
 *   1. UNMATCHED QUERY throws immediately (naming the query text + every
 *      declared branch label) instead of silently falling through to `[]` —
 *      the false-red/false-green case above.
 *   2. `assertAllMatched()` throws (naming the never-hit label(s)) when a query
 *      shape refactor makes a declared branch permanently unreachable — the
 *      DEAD-BRANCH case (the same drift caught from the other direction: the
 *      branch's fixture is never exercised, so the test passes for the wrong
 *      reason). Call it at the end of any test that cares its fixtures are
 *      still live.
 *
 * Usage (replacing a hand-rolled `sqlMock.mockImplementation`):
 *
 *   const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
 *   vi.mock('@papercusp/db-org', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@papercusp/db-org')>()),
 *     getOrgPg: () => ({ sql: sqlMock }),
 *   }));
 *
 *   const branches = createBranchedSqlMock([
 *     { label: 'held-claims', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held', kind: 'feature' }] },
 *   ]);
 *   sqlMock.mockImplementation(branches.handler);
 *   // ... exercise the code under test ...
 *   branches.assertAllMatched(); // optional — asserts every declared branch fired at least once
 *
 * A test that legitimately doesn't care about every query the code under test
 * issues (it only needs ONE specific fixture; every other query can safely
 * no-op) should say so EXPLICITLY — either pass `{ onUnmatched: 'empty' }`, or
 * add a low-priority catch-all branch (`{ label: '...', match: () => true,
 * respond: () => [] }`) as the LAST entry so the intent is visible in the
 * branch list itself, not silently defaulted.
 */

import { reassembleSql } from './sql-prepare-validation';

/** One call this mock received, as the validator needs to see it. */
export interface CapturedQuery {
  /**
   * The call reassembled into `$1..$n` parameterised SQL. Where an
   * interpolation was a FRAGMENT rather than a scalar bind, the placeholder is
   * a visible marker instead — see {@link CapturedQuery.composed}.
   */
  readonly sql: string;
  /**
   * At least one interpolation was an `sql` fragment, so {@link
   * CapturedQuery.sql} is NOT the statement production would issue: the
   * fragment's own SQL text is missing from it.
   *
   * This flag is why the validator can refuse to judge the statement. Before it
   * existed, a composed query reassembled to something like `... NOT IN $3 ...`,
   * which looked like an ordinary parameterised query, so it was PREPAREd, so
   * Postgres raised 42P18, so it was classified `untypeable` — a tolerated
   * non-finding. The guard reported green over SQL it had never parsed
   * (EI-22238479367433132).
   */
  readonly composed: boolean;
  /** How many of this call's interpolations were fragments. 0 ⇒ not composed. */
  readonly fragmentArgs: number;
}

export interface SqlMockBranch {
  /** Short human label — surfaces in both failure modes' error messages. */
  label: string;
  /** Matched (in declaration order — first match wins) against the joined SQL template text. */
  match: (queryText: string, args: unknown[]) => boolean;
  /** Produces the mocked row set for a matching call. */
  respond: (queryText: string, args: unknown[]) => unknown[] | Promise<unknown[]>;
}

export interface BranchedSqlMock {
  /** Pass directly to `sqlMock.mockImplementation(branches.handler)`. */
  handler: (...args: unknown[]) => Promise<unknown[]>;
  /** Throws (naming the unreached label(s)) if any declared branch was never matched. */
  assertAllMatched: () => void;
  /**
   * Clears hit-tracking AND {@link BranchedSqlMock.capturedSql} (NOT the branch
   * list) — call in beforeEach when reusing one mock across tests.
   */
  resetHits: () => void;
  /** True once every declared branch has matched at least one call. */
  readonly allMatched: boolean;
  /**
   * Every query this mock received, in call order, reassembled into
   * PARAMETERISED `$1..$n` SQL (WI-2141982).
   *
   * ⚠ This is deliberately NOT the same text `match` sees. Branch matching gets
   * `queryTextOf`'s joined form, which DELETES every interpolation — fine for a
   * substring matcher, but not valid SQL, so it cannot be parsed or PREPAREd.
   * `capturedSql` rebuilds the placeholders via `reassembleSql` so the text is
   * something a database can actually judge.
   *
   * The point: a mocked suite never sends its SQL anywhere, so nothing ever
   * parses it, and a query that is well-formed-looking and WRONG (the incident:
   * `column "t.payload" does not exist`) stays green. Hand this to
   * `validateManyByPrepare` from `./sql-prepare-validation` to have Postgres
   * parse and plan it without executing it. Captured BEFORE branch matching, so
   * a query no branch covers is still available for validation.
   *
   * ⚠ Text only — it cannot tell you whether the text is FAITHFUL. Prefer
   * {@link BranchedSqlMock.capturedForValidation}, which carries the
   * composed-query flag with it.
   */
  readonly capturedSql: readonly string[];
  /** Same calls as {@link capturedSql}, each with its faithfulness flag. */
  readonly capturedQueries: readonly CapturedQuery[];
  /**
   * {@link capturedQueries} in the exact shape `validateManyByPrepare` takes,
   * labelled by call order.
   *
   * Use THIS rather than mapping `capturedSql` yourself: the `composed` flag is
   * what stops a fragment-composed statement being PREPAREd and coming back
   * `untypeable` — a tolerated non-finding that silently counts as coverage
   * (EI-22238479367433132). A caller that drops the flag re-opens that hole.
   */
  readonly capturedForValidation: readonly { sql: string; label: string; composed: boolean }[];
}

export interface CreateBranchedSqlMockOptions {
  /**
   * What to do when a call matches no declared branch. Default `'throw'` — the
   * whole point of this helper (a hand-rolled `.includes()` chain silently
   * returns `[]` here, which is the exact EI-12141 failure class). Pass
   * `'empty'` only for a deliberately-permissive test; prefer an explicit
   * catch-all branch instead where practical so the intent is visible in the
   * branch list.
   */
  onUnmatched?: 'throw' | 'empty';
}

function queryTextOf(strings: unknown): string {
  return Array.isArray(strings) ? strings.join(' ') : String(strings ?? '');
}

/**
 * Recognise an interpolated `sql` FRAGMENT — `sql\`a AND b\``, `sql([...])`, or
 * anything else built by calling the tag rather than passing a value.
 *
 * The primary test needs no knowledge of postgres-lib internals, because under
 * a mock there is a better signal available: a nested fragment is built by
 * calling THIS MOCK, so the value interpolated into the outer call is an object
 * this mock itself returned. `produced` is that record, and identity in it is
 * exact — no shape guessing, no false positives on a jsonb bind (which is a
 * plain object and would defeat any structural heuristic).
 *
 * The `strings` check is a secondary, best-effort arm for a fragment built with
 * a REAL postgres instance and then passed into a mocked query. It cannot be
 * exact, so it is deliberately narrow: a genuine postgres `Query` carries its
 * own template array, and no scalar bind shape in this repo does.
 */
function isFragmentValue(value: unknown, produced: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (produced.has(value as object)) return true;
  return Array.isArray((value as { strings?: unknown }).strings);
}

export function createBranchedSqlMock(
  branches: SqlMockBranch[],
  options: CreateBranchedSqlMockOptions = {},
): BranchedSqlMock {
  if (branches.length === 0) {
    throw new Error('createBranchedSqlMock: at least one branch is required');
  }
  const onUnmatched = options.onUnmatched ?? 'throw';
  const hit = new Set<string>();
  const captured: CapturedQuery[] = [];
  /**
   * Every promise this mock has handed back. A nested `sql` fragment is built
   * by calling this mock, so its return value reappearing as an interpolated
   * arg of a LATER call is exact proof that arg is a fragment, not a bind.
   */
  const produced = new WeakSet<object>();

  const dispatch = async (args: unknown[]): Promise<unknown[]> => {
    const queryText = queryTextOf(args[0]);
    // Capture FIRST, so a query that matches no branch (and is about to throw)
    // is still available for PREPARE-validation. See `capturedSql`.
    const interpolations = args.slice(1);
    const fragmentArgs = interpolations.filter((v) => isFragmentValue(v, produced)).length;
    captured.push({
      sql: Array.isArray(args[0])
        ? reassembleSql(args[0] as readonly string[], {
            isFragment: (i) => isFragmentValue(interpolations[i], produced),
          })
        : queryText,
      composed: fragmentArgs > 0,
      fragmentArgs,
    });
    const branch = branches.find((b) => b.match(queryText, args));
    if (!branch) {
      if (onUnmatched === 'empty') return [];
      const labels = branches.map((b) => `  - ${b.label}`).join('\n');
      throw new Error(
        `createBranchedSqlMock: no branch matched a query.\n` +
          `Query text: ${queryText || '(empty)'}\n` +
          `Declared branches:\n${labels}\n` +
          `A real query shape changed (or a new query was issued that no branch covers) — this is the ` +
          `EI-12141 failure class this helper exists to catch loudly instead of silently returning [] ` +
          `and masquerading as an unrelated red/green. Add a branch for this query, or pass ` +
          `{ onUnmatched: 'empty' } / add a catch-all branch if this test deliberately doesn't care.`,
      );
    }
    hit.add(branch.label);
    return await branch.respond(queryText, args);
  };

  /**
   * Deliberately NOT an `async` function: we need a reference to the promise
   * itself in order to record it in `produced`, and an async function body
   * cannot see its own promise. `dispatch` still runs synchronously up to its
   * first `await`, so capture and branch selection happen exactly when they did
   * before, and a no-branch-matched error still surfaces as a rejection.
   */
  const handler = (...args: unknown[]): Promise<unknown[]> => {
    const promise = dispatch(args);
    produced.add(promise);
    return promise;
  };

  return {
    handler,
    assertAllMatched: () => {
      const unreached = branches.filter((b) => !hit.has(b.label)).map((b) => b.label);
      if (unreached.length > 0) {
        throw new Error(
          `createBranchedSqlMock: ${unreached.length} branch(es) were never matched: ${unreached.join(', ')}.\n` +
            `A declared branch no call ever reaches is either dead test setup or a sign the matcher no ` +
            `longer lines up with the real query — the same query-shape-drift class this helper exists ` +
            `to catch (EI-12141), just caught from the other direction.`,
        );
      }
    },
    resetHits: () => {
      hit.clear();
      captured.length = 0;
    },
    get allMatched() {
      return branches.every((b) => hit.has(b.label));
    },
    get capturedSql(): readonly string[] {
      return captured.map((c) => c.sql);
    },
    get capturedQueries(): readonly CapturedQuery[] {
      return captured;
    },
    get capturedForValidation(): readonly { sql: string; label: string; composed: boolean }[] {
      return captured.map((c, i) => ({
        sql: c.sql,
        label: c.composed ? `q${i} (composed)` : `q${i}`,
        composed: c.composed,
      }));
    },
  };
}
