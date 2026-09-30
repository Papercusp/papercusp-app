/**
 * @papercusp/coordination/watermark-store — the Postgres tie-in adapter over
 * the generic WatermarkStore seam. `PgWatermarkStore` binds the per-agent
 * read-cursor to `harness_shared.coord_watermarks`; the seam + in-memory double
 * are re-exported from @papercusp/pubsub-substrate/watermark-store, so the
 * public surface is unchanged.
 */

export * from '@papercusp/pubsub-substrate/watermark-store';
export {
  PgWatermarkStore,
  ensureCoordWatermarksTable,
  type PgWatermarkStoreOptions,
} from './pg-store';
