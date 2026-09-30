/**
 * @papercusp/coordination/presence — the Postgres tie-in adapter over the
 * generic PresenceStore seam. `PgPresenceStore` binds presence to
 * `harness_shared.coord_presence`; the seam + in-memory double are re-exported
 * from @papercusp/pubsub-substrate/presence, so the public surface is unchanged.
 */

export * from '@papercusp/pubsub-substrate/presence';
export { PgPresenceStore, ensureCoordPresenceTable, type PgPresenceStoreOptions } from './pg-store';
