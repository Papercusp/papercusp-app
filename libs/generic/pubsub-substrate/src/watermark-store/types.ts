/**
 * types.ts — the WatermarkStore seam: per-agent "last-read" cursors (L3).
 *
 * Kept SEPARATE from CoordEventLog by design (D-009): a watermark is a
 * MUTABLE single-doc-per-owner read cursor, not an append-only channel —
 * the same data shape as presence, a different shape from the event log.
 * It shares the coord identity vocabulary, not a storage interface.
 *
 * The value shape + the pure partial-merge rule live in
 * `@papercusp/coordination/core` (`Watermark`, `mergeWatermark`,
 * `normaliseWatermark`, `emptyWatermark`); this seam is only the
 * persistence. The production impl is PG (`PgWatermarkStore`, over an
 * injected PgHandle); `InMemoryWatermarkStore` is the test double +
 * swappability proof (coord-channels-pg-port P-002).
 */

import type { Watermark } from '../core/watermark';

export interface WatermarkStore {
  /**
   * Read an owner's watermark. A never-written (or malformed) owner reads
   * as `emptyWatermark()` — "never read anything" — never an error.
   */
  read(ownerId: string): Promise<Watermark>;
  /**
   * Merge `patch` into the owner's watermark and persist it. Omitted fields
   * keep their current value; `subscriptions_fired` is *replaced* when
   * supplied, not appended (the caller owns dedup). Returns the merged value.
   */
  write(ownerId: string, patch: Partial<Watermark>): Promise<Watermark>;
}
