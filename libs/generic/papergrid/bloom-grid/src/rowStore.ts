// Import from the deep path to avoid pulling in IBLT/XorFilter submodules,
// which use Node's Buffer and fail to load under Astro/Vite in the browser.
// The deep module uses CJS default export; Vite's SSR runner and Node ESM
// disagree on how deeply CJS defaults get wrapped, so we unwrap until we
// hit the actual class (must be a function).
import * as BloomFilterModule from 'bloom-filters/dist/bloom/bloom-filter.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveBloomFilter(mod: any): any {
  for (let i = 0; i < 3; i++) {
    if (typeof mod === 'function' && typeof mod.create === 'function') return mod;
    if (mod && typeof mod === 'object' && 'default' in mod) mod = mod.default;
    else break;
  }
  return mod;
}
const BloomFilter = resolveBloomFilter(BloomFilterModule);
import type { ManifestEntry, Versioned } from './protocol';
import type { KvStorePersistence } from '@papercusp/kv-persist';

/**
 * Optional durable backing for a row store. This is just the generic
 * `@papercusp/kv-persist` contract — persistence is intentionally NOT coupled to
 * bloom-grid, so any KvStorePersistence implementation (e.g.
 * @papercusp/kv-persist-indexeddb) can back the store. The in-memory store stays
 * the source of truth; the adapter mirrors row payloads to durable storage and
 * rehydrates them when the store is created.
 *
 * CORRECTNESS CONTRACT: only versioned row payloads are persisted — never the
 * manifest. The manifest (the current `{id, v}` set for a query) is always
 * re-fetched from the server, so a persisted row is only ever trusted for its
 * exact `id:v`. When the server reports a newer `v`, the bloom misses it and
 * `findMissing` flags it for refetch — so persisted rows can never go stale
 * undetected, no matter how long they sat in storage.
 */
export type RowStorePersistence<TRow extends Versioned> = KvStorePersistence<TRow>;

export interface RowStoreOptions<TRow extends Versioned = Versioned> {
  capacity?: number;
  fpRate?: number;
  /** Durable backing store. When omitted the store is in-memory only. */
  persistence?: RowStorePersistence<TRow>;
}

export interface RowStore<TRow extends Versioned> {
  upsert(rows: TRow[]): void;
  get(id: string): TRow | undefined;
  has(id: string, v: number): boolean;
  bloomJSON(): unknown | undefined;
  subscribe(fn: () => void): () => void;
  getVersion(): number;
  size(): number;
  clear(): void;
  findMissing(manifest: ManifestEntry[]): ManifestEntry[];
  /**
   * Resolves once initial rehydration from persistence has completed (or
   * immediately when there is no persistence). Await this before building a
   * bloom for the first server request, otherwise the rehydrated rows aren't
   * in the bloom yet and the server re-downloads them.
   */
  ready: Promise<void>;
}

export function createRowStore<TRow extends Versioned>(
  opts: RowStoreOptions<TRow> = {},
): RowStore<TRow> {
  const capacity = opts.capacity ?? 20_000;
  const fpRate = opts.fpRate ?? 0.01;
  const persistence = opts.persistence;

  let store = new Map<string, TRow>();
  let bloom = BloomFilter.create(capacity, fpRate);
  const subs = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    subs.forEach((fn) => fn());
  };

  // Apply rows to the in-memory store + bloom WITHOUT writing back to
  // persistence — shared by upsert() and by rehydration.
  const applyRows = (rows: TRow[]) => {
    for (const r of rows) {
      store.set(r.id, r);
      bloom.add(`${r.id}:${r.v}`);
    }
  };

  // Rehydrate from persistence (if any). `ready` lets callers gate their first
  // bloom-backed request on hydration so cached rows aren't re-downloaded.
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });
  if (persistence) {
    void persistence
      .load()
      .then((rows) => {
        if (rows && rows.length > 0) {
          applyRows(rows);
          notify();
        }
      })
      .catch(() => { /* best-effort — fall back to an empty store */ })
      .finally(() => resolveReady());
  } else {
    resolveReady();
  }

  return {
    ready,
    upsert(rows) {
      if (!rows || rows.length === 0) return;
      applyRows(rows);
      persistence?.save(rows);
      notify();
    },
    get(id) {
      return store.get(id);
    },
    has(id, v) {
      const existing = store.get(id);
      return existing !== undefined && existing.v === v;
    },
    bloomJSON() {
      if (store.size === 0) return undefined;
      return bloom.saveAsJSON();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getVersion() {
      return version;
    },
    size() {
      return store.size;
    },
    clear() {
      store = new Map();
      bloom = BloomFilter.create(capacity, fpRate);
      persistence?.clear();
      notify();
    },
    findMissing(manifest) {
      return manifest.filter((m) => {
        const existing = store.get(m.id);
        return existing === undefined || existing.v !== m.v;
      });
    },
  };
}
