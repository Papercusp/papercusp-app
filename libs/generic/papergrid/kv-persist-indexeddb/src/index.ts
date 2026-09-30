// @papercusp/kv-persist-indexeddb
//
// IndexedDB implementation of the @papercusp/kv-persist contract. Mirrors
// versioned records to IndexedDB so they survive a full page reload, and
// rehydrates them on startup. Backend-only: it persists records verbatim and
// relies on the consumer's version (`v`) comparison for freshness (see
// @papercusp/kv-persist's correctness note).
//
// CLIENT-ONLY but import-safe on the server: `indexedDB` is touched only when
// available. When it's undefined (SSR / unsupported), every method is a no-op,
// so a store wired with this behaves exactly like an in-memory store.

import type { KvStorePersistence, Versioned } from '@papercusp/kv-persist';

export interface IndexedDbPersistenceOptions {
  /** IndexedDB database name. Pick a unique name per logical store. */
  dbName?: string;
  /** Object-store name within the database. */
  storeName?: string;
  /**
   * Record-envelope schema version. Used as the IndexedDB *database version*,
   * so bumping it triggers `onupgradeneeded` and wipes the old store. Bump this
   * when the persisted envelope shape changes — NOT when record contents change
   * (content staleness is the consumer's job via the `v` field).
   */
  schemaVersion?: number;
  /**
   * Evict records whose last-seen timestamp is older than this (ms). A
   * storage-size bound only, NOT a correctness mechanism. Default: 7 days.
   */
  maxAgeMs?: number;
  /** Debounce window for batched writes (ms). Default: 400. */
  writeDebounceMs?: number;
}

interface StoredRecord<T> {
  id: string;
  v: number;
  /** Last-seen wall-clock ms — refreshed on every save; drives maxAge eviction. */
  ts: number;
  row: T;
}

/**
 * IndexedDB-backed {@link KvStorePersistence}. Construct directly or via
 * {@link createIndexedDbPersistence}. Safe to construct during SSR — it simply
 * no-ops every method when `indexedDB` is unavailable.
 */
export class IndexedDbKvPersistence<T extends Versioned> implements KvStorePersistence<T> {
  private readonly available: boolean;
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly schemaVersion: number;
  private readonly maxAgeMs: number;
  private readonly writeDebounceMs: number;

  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly pending = new Map<string, StoredRecord<T>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IndexedDbPersistenceOptions = {}) {
    this.available = typeof indexedDB !== 'undefined';
    this.dbName = opts.dbName ?? 'kv-persist';
    this.storeName = opts.storeName ?? 'records';
    this.schemaVersion = opts.schemaVersion ?? 1;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    this.writeDebounceMs = opts.writeDebounceMs ?? 400;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      // schemaVersion IS the IDB version → a bump runs onupgradeneeded, which
      // recreates the store and discards records written under the old shape.
      const req = indexedDB.open(this.dbName, this.schemaVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db.objectStoreNames.contains(this.storeName)) {
          db.deleteObjectStore(this.storeName);
        }
        db.createObjectStore(this.storeName, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another connection (a new tab, or this app after a schemaVersion
        // bump) needs to upgrade, close ours so it isn't blocked; drop the
        // cached promise so the next op transparently reopens.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    });
    return this.dbPromise;
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    try {
      const db = await this.openDb();
      const tx = db.transaction(this.storeName, 'readwrite');
      const os = tx.objectStore(this.storeName);
      for (const rec of batch) os.put(rec);
    } catch {
      /* best-effort — drop this batch rather than throwing into app code */
    }
  }

  async load(): Promise<T[]> {
    if (!this.available) return [];
    try {
      const db = await this.openDb();
      const cutoff = nowMs() - this.maxAgeMs;
      return await new Promise<T[]>((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const os = tx.objectStore(this.storeName);
        const req = os.getAll();
        req.onsuccess = () => {
          const recs = (req.result ?? []) as StoredRecord<T>[];
          const fresh: T[] = [];
          for (const rec of recs) {
            if (rec.ts >= cutoff) {
              fresh.push(rec.row);
            } else {
              // Storage-size eviction of records untouched past maxAge.
              os.delete(rec.id);
            }
          }
          resolve(fresh);
        };
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  save(records: T[]): void {
    if (!this.available || records.length === 0) return;
    const ts = nowMs();
    for (const r of records) {
      this.pending.set(r.id, { id: r.id, v: r.v, ts, row: r });
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => void this.flush(), this.writeDebounceMs);
    }
  }

  async clear(): Promise<void> {
    this.pending.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.available) return;
    try {
      const db = await this.openDb();
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).clear();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Convenience factory mirroring the other persistence helpers. Returns an
 * {@link IndexedDbKvPersistence}; it already no-ops when IndexedDB is absent,
 * so the result is always safe to hand to a store.
 */
export function createIndexedDbPersistence<T extends Versioned>(
  opts: IndexedDbPersistenceOptions = {},
): KvStorePersistence<T> {
  return new IndexedDbKvPersistence<T>(opts);
}

// Wall-clock helper kept separate so the Date access is easy to spot/mock.
function nowMs(): number {
  return Date.now();
}
