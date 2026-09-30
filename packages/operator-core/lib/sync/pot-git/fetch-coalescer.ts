/**
 * fetch-coalescer.ts — WI-6418: one in-flight pot-git FETCH per repo, process-wide.
 *
 * ## Why this exists
 *
 * pot-git had an in-flight guard on the SERVE side (`serve-wiring.ts`) and none
 * at all on the FETCH side. Nothing recorded "a fetch for this repo is already
 * running", so every driver that wanted a repo opened its own session for it.
 *
 * That is fatal when combined with the serve-side admission rule, because a
 * second request for the same repo on the same channel either supersedes the
 * first (pre-WI-6412) or is refused (post-WI-6412). Concretely, on this fleet:
 *
 *   - ~12+ hive/pot `git-sync` routines run every 180s, STAGGERED — so a fetch
 *     drive for the same repo lands roughly every ~15s in aggregate.
 *   - They share one mux channel, so `state.nextClientId++` is a single counter
 *     across all of them (which is why observed session ids climbed 1→13 with
 *     no re-dial: it was never one client retrying, it was N drivers racing).
 *   - A 4.1GB pot needs ~175s at the measured throughput.
 *
 * 175s of work, interrupted every 15s, never finishes — at ANY throughput. The
 * ceiling is a PERIOD, not a RATE, which is why three rounds of real, measured
 * throughput optimisation moved it by exactly zero. Repos that finish inside one
 * drive period were unaffected, which is what made it read as a perf problem.
 *
 * ## The contract
 *
 * A second caller for a key already in flight is REFUSED (`already-in-flight`),
 * not queued and not joined to the first.
 *
 * Not joining is deliberate. Joining would hand caller B the result of caller
 * A's fetch, but A was driven by a DIFFERENT announcement — possibly an older
 * version — so B would report success for work that never covered its own
 * input. The honest answer is "not now, still busy", and every caller here
 * already has a correct response to that: the ref-announce driver holds its
 * fed-event cursor and re-reads the row next tick. Refusing also cannot
 * deadlock, which a join across two independent drivers can.
 *
 * ⚠ `already-in-flight` is NOT a failure, and callers must not fold it into one.
 * The whole point is to stop a benign "someone else is already doing this" from
 * being reported as a transport error — that is what drove the retry storm this
 * module exists to end.
 */

/** Outcome of a coalesced call: either `fn` ran, or it was skipped as a dupe. */
export type CoalescedRun<T> = { ran: true; result: T } | { ran: false; reason: 'already-in-flight' };

/**
 * Keyed by (channel/topic scope, repoKey) rather than repoKey alone: two
 * genuinely different peers/topics serving the same repo name are different
 * transfers and must not block each other. Same-scope duplicates are the case
 * this collapses.
 */
export function fetchCoalescerKey(scope: string, repoKey: string): string {
  return `${scope}\x00${repoKey}`;
}

/**
 * Process-wide, matching the serve side's `inFlightServes`. The resource being
 * protected is the repo's object store and the peer channel, both of which are
 * shared by every driver in this process — so a per-driver or per-module
 * registry would not actually exclude anything.
 */
const inFlightFetches = new Map<string, Promise<unknown>>();

/**
 * Run `fn` unless a call for `key` is already in flight.
 *
 * The entry is released in `finally`, including when `fn` throws — a leaked
 * entry would permanently wedge every future fetch for that repo, which is
 * strictly worse than the bug this fixes, so the release path must have no
 * conditions on it whatsoever.
 */
export async function withFetchCoalescing<T>(key: string, fn: () => Promise<T>): Promise<CoalescedRun<T>> {
  if (inFlightFetches.has(key)) return { ran: false, reason: 'already-in-flight' };

  // Register BEFORE the first await so two callers in the same tick cannot both
  // observe an empty map. `fn()` is invoked here (not awaited) for the same
  // reason: an `await` before the map write would open exactly the race this
  // guard exists to close.
  const pending = (async () => fn())();
  inFlightFetches.set(key, pending);
  try {
    return { ran: true, result: await pending };
  } finally {
    // Only delete OUR entry. A slow release racing a later caller's insert must
    // never evict the newer in-flight run and re-open the door.
    if (inFlightFetches.get(key) === pending) inFlightFetches.delete(key);
  }
}

/** Is a fetch for this key running right now? Diagnostics/tests only. */
export function isFetchInFlight(key: string): boolean {
  return inFlightFetches.has(key);
}

/** Live coalescer entries. Test-only — asserts the map does not leak. */
export function inFlightFetchCountForTest(): number {
  return inFlightFetches.size;
}
