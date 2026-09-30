/**
 * @papercusp/pubsub-substrate/presence — the live-presence seam (in-memory
 * double; the host injects a Postgres backend). Separate from the event log by
 * design: presence is mutable single-row-per-owner state, not an append-only
 * channel.
 *
 * The Postgres backend (`PgPresenceStore`) is the host tie-in adapter and lives
 * in `@papercusp/coordination/presence`.
 */

export {
  PRESENCE_STALE_MS,
  type PresenceIdentity,
  type PresenceInput,
  type PresenceListOptions,
  type PresenceRecord,
  type PresenceStore,
} from './types';
export { InMemoryPresenceStore, type InMemoryPresenceStoreOptions } from './memory-store';
