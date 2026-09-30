/**
 * @papercusp/pubsub-substrate/event-log — the swappable append-only channel
 * log seam (the outbox/CDC channel-log). Two host-free backends satisfy
 * `CoordEventLog` and pass the SAME conformance suite (the swappability gate):
 *   - `FsCoordLog`        — the portable default (detached agents, no PG).
 *   - `InMemoryCoordLog`  — the test double / detached proof.
 *
 * The optional Postgres backend (`PgCoordLog`) is the host tie-in adapter and
 * lives in `@papercusp/coordination/event-log`, injected with a PgHandle.
 */

export {
  type CoordEventLog,
  type AppendLineIfAbsentResult,
  type LineSurface,
  type EventSurface,
  type ReadLinesOpts,
  type CoordLogCursorRow,
  type CoordLogCursorPage,
} from './types';
export { FsCoordLog, type FsCoordLogOptions } from './fs-log';
export { InMemoryCoordLog } from './memory-log';
// NOTE: the conformance harness imports `vitest`, so it is deliberately NOT
// re-exported here (this barrel is imported by production code). Test code
// imports it from the dedicated `@papercusp/pubsub-substrate/event-log/conformance`
// subpath — mirroring the presence/watermark-store conformance subpaths.
