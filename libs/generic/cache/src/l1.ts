/**
 * A tiny LRU over an insertion-ordered Map. Pure, dependency-free, bounded.
 * Stores opaque values; the cache stores CacheEntry objects (never the bare value),
 * so `get` returning undefined unambiguously means "absent".
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

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

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
