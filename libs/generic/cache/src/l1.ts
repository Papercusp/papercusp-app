/**
 * A tiny LRU over an insertion-ordered Map. Pure, dependency-free, bounded.
 * Stores opaque values; the cache stores CacheEntry objects (never the bare value),
 * so `get` returning undefined unambiguously means "absent".
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private pruneCursor: IterableIterator<[string, V]> | undefined;

  constructor(private readonly maxEntries: number) {
    if (maxEntries <= 0) throw new Error('LruCache: maxEntries must be > 0');
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Touch: move to most-recently-used (end of insertion order).
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Remove matching values without touching recency or copying the key set.
   * Continue the scan on the next call so cold entries are eventually visited.
   * The iterator is live: deleted/replaced entries cannot supply stale values.
   */
  prune(predicate: (value: V) => boolean, maxChecks: number): { checked: number; removed: number } {
    if (!Number.isInteger(maxChecks) || maxChecks <= 0) throw new Error('LruCache: maxChecks must be a positive integer');
    this.pruneCursor ??= this.map.entries();
    let checked = 0, removed = 0;
    while (checked < maxChecks) {
      const next = this.pruneCursor.next();
      if (next.done) {
        this.pruneCursor = undefined;
        break;
      }
      const [key, value] = next.value;
      checked++;
      if (predicate(value)) {
        this.map.delete(key);
        removed++;
      }
    }
    return { checked, removed };
  }

  clear(): void {
    this.map.clear();
    this.pruneCursor = undefined;
  }

  get size(): number {
    return this.map.size;
  }
}
