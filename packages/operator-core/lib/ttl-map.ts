/**
 * Bounded in-memory TTL map — the one sanctioned shape for ephemeral
 * read-through caches (EI-79/EI-127 class: bare `Map` + expiresAt grows
 * forever because expired keys are only ever overwritten, never removed).
 *
 * - Expired entries are deleted on read (`get`/`getEntry`) and swept on
 *   every `set`, so the map never retains dead keys.
 * - `maxEntries` bounds live entries; the oldest insertion is evicted first.
 * - `now` is a per-call parameter so callers with a clock seam (tests) can
 *   inject time; defaults to Date.now().
 *
 * NOT for durable state (storage policy: Postgres by default) — only for
 * caches whose loss is a re-fetch.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlMap<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs: number; maxEntries?: number }) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 1024;
  }

  /**
   * Live entry lookup, or undefined on miss/expiry. The wrapper (rather than
   * the bare value) lets callers cache `null`/`undefined` as a real negative
   * result and still distinguish it from a miss.
   */
  getEntry(key: string, now: number = Date.now()): { value: V } | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string, now: number = Date.now()): V | undefined {
    return this.getEntry(key, now)?.value;
  }

  /** Insert/refresh. Sweeps all expired keys, then evicts the oldest live
   *  insertion if the bound is hit. */
  set(key: string, value: V, now: number = Date.now()): void {
    for (const [k, e] of this.map) {
      if (e.expiresAt <= now) this.map.delete(k);
    }
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
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
