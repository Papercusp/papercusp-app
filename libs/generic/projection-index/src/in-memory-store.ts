import type {
  ProjectionStore,
  IndexedEntry,
  Delta,
  QueryOptions,
  IndexKey,
  SortOrder,
} from './types';
import { refOf } from './diff';

/** Shallow copy of an entry wrapper so callers can't mutate stored rows in place. */
function clone<E>(e: IndexedEntry<E>): IndexedEntry<E> {
  return { ...e };
}

/**
 * Compare two entries by `sortKey` (entries without one sort last in both
 * directions), then by a stable, direction-independent identity tiebreak so query
 * results are fully deterministic.
 */
function compare<E>(order: SortOrder) {
  const dir = order === 'desc' ? -1 : 1;
  return (a: IndexedEntry<E>, b: IndexedEntry<E>): number => {
    const au = a.sortKey === undefined;
    const bu = b.sortKey === undefined;
    if (au && bu) {
      // fall through to identity tiebreak
    } else if (au) {
      return 1; // undefined sorts last regardless of direction
    } else if (bu) {
      return -1;
    } else if (a.sortKey! < b.sortKey!) {
      return -1 * dir;
    } else if (a.sortKey! > b.sortKey!) {
      return 1 * dir;
    }
    const ai = a.sourceId + '\x00' + a.entryId;
    const bi = b.sourceId + '\x00' + b.entryId;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  };
}

/**
 * In-memory `ProjectionStore` — the lib's default + the reference implementation a
 * PG-backed store is conformance-tested against. Synchronous under the hood, async
 * at the surface. Suitable for tests, small indexes, and process-local projections.
 */
export class InMemoryProjectionStore<E> implements ProjectionStore<E> {
  /** identity ref → entry */
  private readonly rows = new Map<string, IndexedEntry<E>>();

  async contributionsOf(sourceId: string): Promise<IndexedEntry<E>[]> {
    const out: IndexedEntry<E>[] = [];
    for (const e of this.rows.values()) {
      if (e.sourceId === sourceId) out.push(clone(e));
    }
    return out;
  }

  async applyDelta(_sourceId: string, delta: Delta<E>): Promise<void> {
    for (const ref of delta.delete) {
      this.rows.delete(refOf(ref.sourceId, ref.key, ref.entryId));
    }
    for (const e of delta.put) {
      this.rows.set(refOf(e.sourceId, e.key, e.entryId), clone(e));
    }
  }

  async byKey(key: IndexKey, opts: QueryOptions = {}): Promise<IndexedEntry<E>[]> {
    let rows: IndexedEntry<E>[] = [];
    for (const e of this.rows.values()) if (e.key === key) rows.push(e);

    if (opts.kinds && opts.kinds.length > 0) {
      const allowed = new Set(opts.kinds);
      rows = rows.filter((e) => e.kind !== undefined && allowed.has(e.kind));
    }

    rows.sort(compare(opts.order ?? 'asc'));

    if (opts.limit !== undefined) rows = rows.slice(0, Math.max(0, opts.limit));

    return rows.map(clone);
  }

  // --- introspection helpers (not part of the ProjectionStore contract) ---

  /** Total persisted contributions across all keys. */
  size(): number {
    return this.rows.size;
  }

  /** Distinct keys currently populated. */
  keys(): IndexKey[] {
    return [...new Set([...this.rows.values()].map((e) => e.key))];
  }

  /** Drop everything — handy between test cases. */
  clear(): void {
    this.rows.clear();
  }
}
