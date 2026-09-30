/**
 * @papercusp/cache — core types.
 *
 * The cache is a tag-based, bumpable-generation cache (Fastly surrogate-keys / Drupal
 * cache-tags model): a cached entry records the data tags it depends on plus the GENERATION
 * each tag had at build time; invalidating a tag bumps its generation, so any entry stamped
 * with an older generation is lazily treated as stale on its next read. No eager purge.
 *
 * Tags and keys are BOTH workspace-scoped (D-010): generations live per (workspaceId, tag),
 * cache keys per (workspaceId, key) — two workspaces can never collide.
 */

/** Injectable monotonic clock (ms epoch). Default: Date.now. */
export type Clock = () => number;

/**
 * The bumpable per-tag generation store. SYNC on the read path (an L1 get must not block);
 * the host's implementation keeps an in-process map current via the LISTEN/NOTIFY invalidation
 * bus, with the durable counters in Postgres. The in-memory default ships for tests + the
 * single-process case.
 */
export interface GenerationStore {
  /** Current generation of (workspaceId, tag). Unknown ⇒ 0. */
  current(workspaceId: string, tag: string): number;
  /** Invalidate: increment the generation of each (workspaceId, tag). */
  bump(workspaceId: string, tags: readonly string[]): void;
  /** Snapshot the current generations of `tags` in a workspace (the build stamp). */
  snapshot(workspaceId: string, tags: readonly string[]): Record<string, number>;
}

export interface CacheEntry<V> {
  value: V;
  tags: readonly string[];
  /** Generation of each tag at build time. */
  builtGen: Record<string, number>;
  /** ms epoch; Infinity = no soft TTL. Past soft ⇒ serve stale + revalidate in background. */
  softExpiresAt: number;
  /** ms epoch; Infinity = no hard TTL. Past hard ⇒ must rebuild (await). */
  hardExpiresAt: number;
}

/**
 * The outcome of a single `getOrSet` call, reported synchronously to the per-call
 * {@link GetOrSetOptions.onOutcome} hook BEFORE the value is returned. Lets a host
 * attribute hit-rate per consumer (the global {@link CacheStats} can't — it is one
 * set of counters across every key). `'hit'` = served fresh from L1; `'stale'` =
 * served stale + revalidating in background (SWR); `'miss'` = built (no usable
 * entry); `'bypass'` = the kill-switch is on, so L1 was skipped entirely.
 */
export type CacheOutcome = 'hit' | 'stale' | 'miss' | 'bypass';

/** Primary reason at lookup time. Absent includes eviction/clear/new keys; no key history is retained. */
export type CacheReadReason = 'fresh' | 'soft-ttl' | 'hard-ttl' | 'invalidated' | 'absent' | 'bypass';

export interface GetOrSetOptions {
  /** Data dependencies; invalidating any one of these marks the entry stale. */
  tags?: readonly string[];
  /** Serve-stale-and-revalidate after this many ms. */
  softTtlMs?: number;
  /** Force a blocking rebuild after this many ms. */
  hardTtlMs?: number;
  /** Also cache null/undefined factory results (negative caching). Default false. */
  cacheEmpty?: boolean;
  /**
   * Per-call outcome hook (optional). Invoked synchronously with the call's
   * {@link CacheOutcome} so a host can record per-consumer telemetry the shared
   * {@link CacheStats} can't express. Pure side-channel — it never affects the
   * cached value and any throw from it is swallowed (telemetry must not break a read).
   */
  onOutcome?: (outcome: CacheOutcome, reason: CacheReadReason) => void;
}

export interface CacheStats {
  hits: number;
  misses: number;
  staleServed: number;
  builds: number;
  singleFlightJoins: number;
}
