/**
 * @papercusp/pubsub-substrate/watermark-store — the per-agent "last-read"
 * cursor seam (in-memory double; the host injects a Postgres backend).
 * Separate from the event log by design: a watermark is mutable
 * single-row-per-owner state, not an append-only channel. The value shape +
 * pure merge live in `@papercusp/pubsub-substrate/core`; this is only the
 * persistence.
 *
 * The Postgres backend (`PgWatermarkStore`) is the host tie-in adapter and
 * lives in `@papercusp/coordination/watermark-store`.
 */

export type { WatermarkStore } from './types';
export { InMemoryWatermarkStore } from './memory-store';
// NOTE: conformance imports `vitest`, so it is NOT re-exported here (this
// barrel is imported by production code). Test code imports it from the
// dedicated `@papercusp/pubsub-substrate/watermark-store/conformance` subpath.
