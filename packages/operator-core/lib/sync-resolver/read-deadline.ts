/**
 * read-deadline.ts — bounding a resolver's fan-out so a HUNG dependency
 * degrades instead of taking the whole read down with it.
 *
 * WHY THIS EXISTS (WI-39813)
 *
 * The learning.* reads fan their legs out with `Promise.all` and give each leg
 * its own `try/catch` / `.catch`, then record the casualty in a `degraded` /
 * `errors` field. That reads like leg isolation, and for a leg that THROWS it
 * is. For a leg that merely HANGS it is nothing at all: `Promise.all` waits for
 * the slowest leg, so one wedged dependency blows the sync layer's ~10s
 * resolver timeout and the ENTIRE query 500s — shipping zero rows even though
 * every other leg had already returned, and never shipping the `degraded` flag
 * either, because the response itself never ships.
 *
 * That is the mechanism behind the owner-reported "Loading retained items…
 * forever" (2026-08-17): the client sets no `retry`, so TanStack v5's default
 * 3 retries apply, every attempt costs the full resolver timeout, and
 * `isLoading = isPending && isFetching` stays true across the whole sequence —
 * starving the error branch for ~45s+ before `refetchInterval` re-fires it.
 *
 * Slowness is the CHARACTERISTIC symptom of a hiccuping store here, not the
 * exception: memory-backend p50 is measured at ~10.9s with 69% of calls eating
 * a >=10s timeout (WI-39554), and several legs are full-corpus reads over
 * exactly that backend. So per-leg error handling is NOT leg isolation — a
 * deadline is what makes "the view must never 500 because one store hiccuped"
 * true for a slow store and not merely for a throwing one.
 *
 * WHY A DEADLINE AND NOT A PER-CALL BUDGET
 *
 * A read typically has MORE THAN ONE sequential fan-out (readRetainFeed does
 * the rows, and then the counts). Two independent 6s budgets total 12s and
 * overrun the very ~10s timeout the bound exists to stay under. One deadline
 * shared by every phase cannot: whatever the first phase spends, the next
 * phase simply has less.
 */

/**
 * The sync layer's per-query resolver timeout. Documented here as the ceiling
 * every read budget must sit UNDER — a budget at or above it cannot prevent the
 * 500 it exists to prevent.
 */
export const RESOLVER_READ_TIMEOUT_MS = 10_000;

/** Bounds one leg by the deadline it was created from. */
export type WithinBudget = <T>(p: Promise<T>, label: string) => Promise<T>;

/**
 * The rejection a lapsed deadline produces (WI-39823).
 *
 * WHY A TYPE AND NOT JUST THE MESSAGE: a caller frequently needs to treat a
 * BUDGET expiry differently from an ordinary leg failure — most often because
 * its existing `catch` degrades to a confident empty value (`return null`,
 * `cycles: []`) that a client renders as "nothing here" or, worse, as a
 * permanent spinner. Sorting a timeout out of that path by matching on message
 * text is the brittle version of this; `instanceof` is the durable one.
 *
 * The `message` is deliberately UNCHANGED from the original literal
 * (`<label> exceeded the read budget`) — existing guards assert on that exact
 * string, and subclassing `Error` keeps both `instanceof Error` and `.message`
 * true, so this is additive to every caller that predates it.
 */
export class ReadBudgetExceededError extends Error {
  /** The leg label the budget lapsed on — the "which leg" a bare message hides. */
  readonly label: string;
  constructor(label: string) {
    super(`${label} exceeded the read budget`);
    this.name = 'ReadBudgetExceededError';
    this.label = label;
  }
}

/**
 * True when `err` is a lapsed read deadline rather than a failing dependency.
 *
 * Prefer this over `instanceof` at a module boundary: this file can be loaded
 * through more than one module record here (bare specifier vs relative path,
 * bundled copy beside source), and a cross-record `instanceof` silently answers
 * false. The name check is the fallback that survives that.
 */
export function isReadBudgetExceeded(err: unknown): boolean {
  return (
    err instanceof ReadBudgetExceededError ||
    (err instanceof Error && err.name === 'ReadBudgetExceededError')
  );
}

/**
 * Open a deadline `budgetMs` from now and return the bounding function for it.
 *
 * Every call shares the ONE deadline, so a read with several sequential
 * fan-outs can never exceed it in total. On expiry the returned promise REJECTS
 * with a labelled error, which is deliberate: it means a caller routes the
 * timeout into whatever `catch` already handles a failing leg, rather than
 * needing a second, parallel degradation path.
 *
 * A leg that resolves after the deadline loses the race harmlessly — its value
 * is simply dropped. An ALREADY-SETTLED promise still wins even at zero
 * remaining, because its `.then` is a microtask and the expiry a macrotask; so
 * a spent deadline never steals a result that was ready.
 */
export function createReadDeadline(budgetMs: number): WithinBudget {
  const deadlineAt = Date.now() + budgetMs;
  return <T>(p: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ReadBudgetExceededError(label)),
        Math.max(0, deadlineAt - Date.now()),
      );
      // Never hold the process open for a budget that is about to be moot.
      (timer as unknown as { unref?: () => void }).unref?.();
      p.then(
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
