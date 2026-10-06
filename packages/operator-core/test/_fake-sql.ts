/**
 * Helpers for the positional `tx` fakes that unit tests hand to SQL-issuing
 * handlers (sessions:read, sessions:search, …).
 *
 * postgres.js builds a query when the tag is CALLED but runs it only when the
 * result is AWAITED. A fragment interpolated into another query
 * (`sql\`… AND ${fragment}\``) is never awaited, so it never runs. A fake that
 * hands out the next canned result at CALL time counts every fragment as a
 * query, and one new fragment anywhere in a handler shifts every later answer.
 * `deferredSqlAnswer` hands out its answer only when the call is awaited, which
 * is how the real driver behaves.
 *
 * The D-006 disclosure-ledger reads (personal-vault/transcript-exclusion.ts:
 * the withheld count, the window load, and the `restrictedTurnSql` fragment)
 * answer `[]` — "no disclosures" — without taking a positional slot, so a suite
 * about something else need not script them. Transcript exclusion itself runs
 * against real Postgres in
 * lib/personal-vault/transcript-exclusion.integration.test.ts.
 */

/** True when a fake `sql` call's template reads the personal disclosure ledger. */
export function isDisclosureLedgerSql(args: readonly unknown[]): boolean {
  const parts = args[0];
  return Array.isArray(parts) && (parts as readonly string[]).join(' ').includes('harness_shared.personal_disclosures');
}

/**
 * The value a fake `sql` call returns: `answer` runs only when the caller
 * awaits it (never for an interpolated fragment); a ledger read answers `[]`.
 */
export function deferredSqlAnswer<T>(args: readonly unknown[], answer: () => T | Promise<T>): Promise<T | never[]> {
  let settled: Promise<T | never[]> | undefined;
  const run = (): Promise<T | never[]> =>
    (settled ??= isDisclosureLedgerSql(args) ? Promise.resolve([]) : Promise.resolve().then(answer));
  return {
    then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    catch: (onRejected) => run().catch(onRejected),
    finally: (onFinally) => run().finally(onFinally),
    [Symbol.toStringTag]: 'Promise',
  } as Promise<T | never[]>;
}
