/**
 * getOrSetBounded — getOrSet with the CALLER's wait capped at a deadline.
 *
 * The prompt-build pattern (operator sentinel/memory blocks): a cached read
 * must never stall the caller longer than `deadlineMs`, but the underlying
 * build should keep running so the NEXT caller is served from cache.
 *
 *   - fresh hit            → resolves immediately, deadline irrelevant;
 *   - stale hit (SWR)      → resolves immediately, revalidate in background;
 *   - cold miss            → the factory runs, but the caller waits at most
 *     `deadlineMs`: past it the call returns { ok:false, reason:'deadline' }
 *     while the single-flight build keeps running and lands in cache.
 *
 * Never rejects: a factory failure resolves { ok:false, reason:'error' } with
 * the error attached — degrade/log policy stays with the caller. On a deadline
 * win the abandoned build promise is detached so a late rejection can't surface
 * as an unhandled rejection.
 */

import type { Cache } from './cache';
import type { GetOrSetOptions } from './types';

export type BoundedOutcome<V> =
  | { ok: true; value: V }
  | { ok: false; reason: 'deadline' }
  | { ok: false; reason: 'error'; error: unknown };

/** Sentinel for a deadline win — never a legal factory value. */
const DEADLINE: unique symbol = Symbol('cache-getOrSetBounded-deadline');

export async function getOrSetBounded<V>(
  cache: Cache,
  workspaceId: string,
  key: string,
  factory: () => Promise<V> | V,
  opts: GetOrSetOptions & { deadlineMs: number },
): Promise<BoundedOutcome<V>> {
  const { deadlineMs, ...getOrSet } = opts;
  const built = cache.getOrSet(workspaceId, key, factory, getOrSet);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
  });
  try {
    const winner = await Promise.race([built, deadline]);
    if (winner === DEADLINE) {
      built.catch(() => undefined);
      return { ok: false, reason: 'deadline' };
    }
    return { ok: true, value: winner };
  } catch (error) {
    return { ok: false, reason: 'error', error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
