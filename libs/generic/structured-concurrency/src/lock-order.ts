/**
 * lock-order — deadlock avoidance by a total acquisition order (the dining-philosophers
 * fix).
 *
 * The one residual cross-layer deadlock surface is an agent holding MULTIPLE locks across
 * subsystems. A TOTAL global order — always acquire in one canonical class order, ties
 * broken by key — makes a circular wait, and therefore a deadlock, impossible.
 *
 * Pure + generic: the host supplies the class order (coarsest/most-contended first); the
 * algorithm is the sort + the canonical-order check. Stable.
 */

export interface OrderedLock {
  lockClass: string;
  key: string;
}

export interface LockOrdering {
  /** The canonical-order index of a lock class (lower = acquire first; unknown = last). */
  classRank(lockClass: string): number;
  /** Sort a multi-lock acquisition into canonical global order: by class, then by key. */
  orderLocks<T extends OrderedLock>(locks: readonly T[]): T[];
  /** True iff `locks` are already in canonical order. */
  isCanonicalOrder(locks: readonly OrderedLock[]): boolean;
}

/**
 * Build a lock ordering over a host-supplied total class order. Acquiring the result of
 * `orderLocks` in sequence guarantees no circular wait across the given classes.
 */
export function createLockOrdering(classOrder: readonly string[]): LockOrdering {
  const rank = new Map<string, number>(classOrder.map((c, i) => [c, i]));
  const classRank = (lockClass: string): number => rank.get(lockClass) ?? Number.MAX_SAFE_INTEGER;
  function orderLocks<T extends OrderedLock>(locks: readonly T[]): T[] {
    return [...locks].sort((a, b) => {
      const r = classRank(a.lockClass) - classRank(b.lockClass);
      if (r !== 0) return r;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }
  function isCanonicalOrder(locks: readonly OrderedLock[]): boolean {
    const ordered = orderLocks(locks);
    return locks.every((l, i) => l.lockClass === ordered[i].lockClass && l.key === ordered[i].key);
  }
  return { classRank, orderLocks, isCanonicalOrder };
}
