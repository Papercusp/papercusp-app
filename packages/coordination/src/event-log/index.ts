/**
 * @papercusp/coordination/event-log — the Postgres tie-in adapter over the
 * generic CoordEventLog seam. `PgCoordLog` binds the append-only log to
 * `harness_shared.coord_event_log`; the seam + portable backends (FsCoordLog /
 * InMemoryCoordLog) are re-exported from the borrowable generic lib
 * (@papercusp/pubsub-substrate/event-log), so the public surface of this
 * subpath is unchanged.
 */

export * from '@papercusp/pubsub-substrate/event-log';
export {
  PgCoordLog,
  ensureCoordEventLogTable,
  DEFAULT_COORD_WORKSPACE,
  type PgCoordLogOptions,
} from './pg-log';
export { isPgContentionError, withPgContentionRetry, type PgContentionRetryOptions } from './pg-retry';
// NOTE: the conformance harness imports `vitest`, so it is deliberately NOT
// re-exported here (this barrel is imported by production code). Test code
// imports it from the dedicated `@papercusp/coordination/event-log/conformance`
// subpath — which re-exports the generic suite.
