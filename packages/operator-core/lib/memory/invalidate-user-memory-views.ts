/**
 * Invalidate every live view of a user's memory corpus in one call.
 *
 * WHY THIS EXISTS (WI-39540): the settings Memory page renders a bounded
 * window over the corpus AND a total beside it ("Showing 500 of 2,465").
 * Those are two sync queries reading the same underlying set, so a write that
 * refreshed only the rows would leave the denominator stale — and a stale
 * denominator is worse than none, because the pair invites arithmetic ("1,965
 * more to load") that is then wrong.
 *
 * Six separate call sites fired `notifySyncInvalidate('userMemory.list')`
 * before this module existed. Adding a second literal at each of them would
 * have worked exactly until the seventh site was written — the drift shape
 * this codebase keeps re-learning. One helper means a new write path gets
 * both views right by default, and the key list has a single home.
 *
 * Add a key here when you add a sync query over the memory corpus.
 */
import { notifySyncInvalidate } from '../sync-sse';

/** Every sync query whose result changes when a user's memories change.
 *  learning.retainFeed / learning.retainDetail (WI-39535): the Retained ledger
 *  interleaves the shared-memory pool as its own kind, so a memory write moves
 *  its rows and any open memory detail exactly like the settings page's. */
export const USER_MEMORY_SYNC_KEYS = [
  'userMemory.list',
  'userMemory.total',
  'learning.retainFeed',
  'learning.retainFeed.summary',
  'learning.retainCounts',
  'learning.retainDetail',
] as const;

/**
 * Best-effort — invalidation is a freshness optimisation, never a
 * correctness requirement, and a write must not fail because an SSE fan-out
 * did. Mirrors the `.catch(() => {})` every call site already applied.
 */
export async function invalidateUserMemoryViews(): Promise<void> {
  await Promise.all(
    // `await` inside the try — NOT `notifySyncInvalidate(key).catch(…)`. That form only
    // handles a REJECTED promise, so it leaked the two failures this helper exists to
    // absorb: a SYNCHRONOUS throw (the `.catch` is never reached, and the throw escapes
    // `.map`) and a non-promise return (`.catch` of undefined -> TypeError). Both landed as
    // UNHANDLED REJECTIONS rather than assertion failures, so every `expect` still passed
    // while the whole stateful lane went red — the "a failure that fails no assertion"
    // class. `await` normalises all three shapes (sync throw / rejection / plain value).
    USER_MEMORY_SYNC_KEYS.map(async (key) => {
      try {
        await notifySyncInvalidate(key);
      } catch {
        /* best-effort — see the contract above: a fan-out must never fail the write */
      }
    }),
  );
}
