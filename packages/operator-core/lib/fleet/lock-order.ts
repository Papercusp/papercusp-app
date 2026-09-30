/**
 * fleet/lock-order — papercusp's canonical cross-subsystem lock-class order.
 *
 * The total-order algorithm (orderLocks / isCanonicalOrder) lives in
 * @papercusp/structured-concurrency's `createLockOrdering`; this module pins it to
 * papercusp's lock classes (coarsest/most-contended resource first). Acquiring multiple
 * locks in this order makes a circular wait — and therefore a deadlock — impossible.
 */
import { createLockOrdering } from '@papercusp/structured-concurrency';

export type { OrderedLock } from '@papercusp/structured-concurrency';

/** Canonical acquisition order, coarsest/most-contended resource first. */
export const FLEET_LOCK_CLASSES = ['resource', 'db-schema', 'harness', 'file', 'work-item', 'plan-item'] as const;
export type LockClass = (typeof FLEET_LOCK_CLASSES)[number];

const ordering = createLockOrdering(FLEET_LOCK_CLASSES);

/** The canonical-order index of a lock class (lower = acquire first; unknown = last). */
export const lockClassRank = ordering.classRank;
/** Sort a multi-lock acquisition into the canonical global order: by class, then by key. */
export const orderLocks = ordering.orderLocks;
/** True iff `locks` are already in canonical order. */
export const isCanonicalOrder = ordering.isCanonicalOrder;
