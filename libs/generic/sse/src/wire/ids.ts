/**
 * Monotonic id allocator.
 *
 * Used by `getChannel()` and `sseResponse()` to assign auto-increment ids to
 * events that don't carry an explicit id. Process-local state — ids reset on
 * operator restart. For durable ids across restart (Last-Event-ID resumption
 * past a restart), callers should seed via `setFloor()` from a persistent
 * source like a PG sequence — see `pgListenChannel`.
 *
 * Not exported as a public API; consumed internally by channel.ts and
 * response.ts.
 */

export interface IdAllocator {
  /** Get the next id and advance. */
  next(): number;
  /** Current floor — the next call to `next()` will return floor + 1. */
  readonly floor: number;
  /** Seed the counter so subsequent ids are > value. No-op if value <= current floor. */
  setFloor(value: number): void;
}

export function createIdAllocator(initial: number = 0): IdAllocator {
  let floor = initial;
  return {
    next() {
      floor += 1;
      return floor;
    },
    get floor() {
      return floor;
    },
    setFloor(value: number) {
      if (value > floor) floor = value;
    },
  };
}
