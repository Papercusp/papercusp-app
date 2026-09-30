// @papercusp/kv-persist
//
// Storage-agnostic contract for durably persisting *versioned* records and
// rehydrating them later. Deliberately backend-independent and free of any
// grid / bloom / sync coupling: a record is just `{ id, v }` plus its payload,
// where `v` is a monotonic version. Implementations (e.g.
// @papercusp/kv-persist-indexeddb) decide *where* records live; consumers (e.g.
// a bloom row store, or any future data store) decide *what* to persist.
//
// CORRECTNESS NOTE FOR CONSUMERS: this layer persists records verbatim and
// never reasons about freshness. A persisted record is only valid for its
// exact `id:v`. Staleness must be resolved by the consumer comparing the
// persisted `v` against an authoritative source (e.g. a freshly-fetched
// manifest) and refetching anything whose version moved on. This is why the
// contract carries `v` at all.

/** Minimal shape every persisted record must have: a stable id + version. */
export interface Versioned {
  id: string;
  v: number;
}

/**
 * A durable store for versioned records.
 *
 * - `load()` rehydrates everything previously saved (best-effort; resolves to
 *   [] when nothing is stored or the backend is unavailable).
 * - `save()` mirrors records to durable storage. Fire-and-forget by contract —
 *   implementations may batch/debounce — so callers must not rely on a write
 *   having landed synchronously.
 * - `clear()` drops all persisted records.
 */
export interface KvStorePersistence<T extends Versioned> {
  load(): Promise<T[]>;
  save(records: T[]): void;
  clear(): void;
}

/**
 * A persistence that stores nothing. Useful as a default, in tests, and as the
 * fallback an implementation returns when its backend is unavailable (e.g.
 * IndexedDB during SSR or in private-mode browsers) so a store wired with it
 * behaves exactly like an in-memory store.
 */
export function createNoopPersistence<T extends Versioned>(): KvStorePersistence<T> {
  return {
    load: async () => [],
    save: () => { /* no-op */ },
    clear: () => { /* no-op */ },
  };
}
