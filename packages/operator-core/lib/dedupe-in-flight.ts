/**
 * dedupe-in-flight.ts — generic per-key single-flight de-dup (EI-19303672371455669).
 *
 * Extracted from `system-health/compute.ts` (EI-22091013068319789) so a SECOND
 * caller — `sync-resolver/adv-roster-read.ts`'s roster cache — can reuse the
 * exact same primitive instead of re-deriving it. `system-health/compute.ts` is
 * a large module with its own periodic-tick side effects; importing a shared
 * leaf like this one keeps a hot resolver path from pulling that module graph
 * in just to reuse ~10 lines of logic (reuse-first: extend/share, don't fork).
 */

/**
 * Concurrent callers sharing the same `key` await the SAME in-flight `fn()`
 * promise instead of each independently invoking `fn`. Cleared from `store`
 * the instant the promise SETTLES — success OR failure — so a failed call is
 * retryable on the very next invocation, never cached as a permanent
 * rejection. Pure (no module-level state of its own) so it's directly
 * unit-testable without standing up whatever `fn` actually does.
 */
export function dedupeInFlight<T>(store: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = store.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (store.get(key) === promise) store.delete(key);
  });
  store.set(key, promise);
  return promise;
}
