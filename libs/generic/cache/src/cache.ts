import { InMemoryGenerationStore } from './generation-store';
import { LruCache } from './l1';
import type { CacheEntry, CacheOutcome, CacheReadReason, CacheStats, Clock, GenerationStore, GetOrSetOptions } from './types';

const SEP = '\0';

export interface CacheConfig {
  /** Bumpable-generation store. Default: in-memory. The host injects a NOTIFY-fed/PG store. */
  generationStore?: GenerationStore;
  /** L1 max entries (LRU). Default 10_000. */
  maxL1Entries?: number;
  /** Clock seam (tests). Default Date.now. */
  clock?: Clock;
  /** Default soft TTL (ms) applied when getOrSet doesn't specify one. Default: none. */
  defaultSoftTtlMs?: number;
  /** Default hard TTL (ms). Default: none. */
  defaultHardTtlMs?: number;
  /**
   * Kill-switch seam (operational hardening). When it returns `true`, `getOrSet`
   * BYPASSES L1 entirely — it never reads, writes, or single-flights an entry, it
   * just runs the factory and returns its result (byte-identical to having no
   * cache). The host wires this to a flag so the cache can be disabled at runtime
   * without a restart. Read SYNC on the hot path (must not block an L1 get), so the
   * host keeps the flag in a sync-cached boolean. Default: never bypass (always on).
   */
  bypass?: () => boolean;
}

/** Fire the per-call outcome hook, swallowing any throw (telemetry must not break a read). */
function reportOutcome(opts: GetOrSetOptions, outcome: CacheOutcome, reason: CacheReadReason): void {
  if (!opts.onOutcome) return;
  try {
    opts.onOutcome(outcome, reason);
  } catch {
    /* a telemetry hook must never affect the cached value */
  }
}

/**
 * Workspace-scoped tag cache with L1 + single-flight + stale-while-revalidate.
 *
 * - Keys + tags are workspace-scoped (D-010): a missing/empty workspaceId throws.
 * - Invalidation is by TAG (bump a per-(ws,tag) generation); entries stamped with an older
 *   generation are lazily stale — no eager purge.
 * - Single-flight: concurrent getOrSet on the same key share one factory run.
 * - SWR: past softTtl (but generation-fresh + within hardTtl) ⇒ serve stale + rebuild in bg.
 * - Generations are snapshotted BEFORE the factory runs, so a bump during a build marks the
 *   result stale on its next read (never masked) — closes the build/invalidate race (D-014).
 */
export class Cache {
  private readonly l1: LruCache<CacheEntry<unknown>>;
  private readonly gens: GenerationStore;
  private readonly clock: Clock;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly defSoftTtl: number;
  private readonly defHardTtl: number;
  private readonly bypass: () => boolean;
  readonly stats: CacheStats = { hits: 0, misses: 0, staleServed: 0, builds: 0, singleFlightJoins: 0 };

  constructor(cfg: CacheConfig = {}) {
    this.gens = cfg.generationStore ?? new InMemoryGenerationStore();
    this.l1 = new LruCache<CacheEntry<unknown>>(cfg.maxL1Entries ?? 10_000);
    this.clock = cfg.clock ?? ((): number => Date.now());
    this.defSoftTtl = cfg.defaultSoftTtlMs ?? Infinity;
    this.defHardTtl = cfg.defaultHardTtlMs ?? Infinity;
    this.bypass = cfg.bypass ?? ((): boolean => false);
  }

  private fullKey(workspaceId: string, key: string): string {
    if (!workspaceId) throw new Error('Cache: workspaceId is required (workspace-scoped keys — D-010)');
    return workspaceId + SEP + key;
  }

  private freshness(workspaceId: string, entry: CacheEntry<unknown>, now: number): CacheReadReason {
    if (now >= entry.hardExpiresAt) return 'hard-ttl';
    for (const tag of entry.tags) {
      if (this.gens.current(workspaceId, tag) !== (entry.builtGen[tag] ?? 0)) return 'invalidated';
    }
    if (now >= entry.softExpiresAt) return 'soft-ttl';
    return 'fresh';
  }

  async getOrSet<V>(
    workspaceId: string,
    key: string,
    factory: () => Promise<V> | V,
    opts: GetOrSetOptions = {},
  ): Promise<V> {
    const fk = this.fullKey(workspaceId, key);
    // Kill-switch: disabled ⇒ bypass L1 entirely (no read/write/single-flight),
    // just run the factory. fullKey() still ran above so the workspace-scope guard
    // (D-010) is enforced even while bypassed.
    if (this.bypass()) {
      reportOutcome(opts, 'bypass', 'bypass');
      return factory();
    }
    const now = this.clock();
    const existing = this.l1.get(fk) as CacheEntry<V> | undefined;
    const state = existing ? this.freshness(workspaceId, existing, now) : 'absent';
    if (existing) {
      if (state === 'fresh') {
        this.stats.hits++;
        reportOutcome(opts, 'hit', state);
        return existing.value;
      }
      if (state === 'soft-ttl') {
        this.stats.staleServed++;
        reportOutcome(opts, 'stale', state);
        // Background revalidate; keep serving stale meanwhile.
        void this.build(workspaceId, fk, factory, opts).catch(() => undefined);
        return existing.value;
      }
      // Hard expiry or invalidation ⇒ rebuild (await).
    }
    this.stats.misses++;
    reportOutcome(opts, 'miss', state);
    return this.build(workspaceId, fk, factory, opts);
  }

  /** Single-flight build. Snapshots generations before the factory runs. */
  private build<V>(
    workspaceId: string,
    fk: string,
    factory: () => Promise<V> | V,
    opts: GetOrSetOptions,
  ): Promise<V> {
    const existing = this.inflight.get(fk);
    if (existing) {
      this.stats.singleFlightJoins++;
      return existing as Promise<V>;
    }
    const tags = opts.tags ?? [];
    const builtGen = this.gens.snapshot(workspaceId, tags);
    const p = (async (): Promise<V> => {
      this.stats.builds++;
      const value = await factory();
      const cacheable = value !== undefined && value !== null ? true : opts.cacheEmpty === true;
      if (cacheable) {
        const now = this.clock();
        const soft = opts.softTtlMs ?? this.defSoftTtl;
        const hard = opts.hardTtlMs ?? this.defHardTtl;
        this.l1.set(fk, {
          value,
          tags,
          builtGen,
          softExpiresAt: soft === Infinity ? Infinity : now + soft,
          hardExpiresAt: hard === Infinity ? Infinity : now + hard,
        });
      }
      return value;
    })();
    this.inflight.set(fk, p as Promise<unknown>);
    // NOT p.finally(cleanup): .finally() derives a NEW promise that re-rejects on a
    // factory rejection, and discarding it makes every rejecting factory an
    // unhandled rejection even when the caller handles `p` itself. then(f, f)
    // observes both settlements without deriving a rejecting promise.
    const cleanup = (): void => {
      if (this.inflight.get(fk) === (p as Promise<unknown>)) this.inflight.delete(fk);
    };
    void p.then(cleanup, cleanup);
    return p;
  }

  /** Invalidate every entry tagged `tag` in `workspaceId`. */
  invalidateByTag(workspaceId: string, tag: string): void {
    if (!workspaceId) throw new Error('Cache: workspaceId is required');
    this.gens.bump(workspaceId, [tag]);
  }

  invalidateByTags(workspaceId: string, tags: readonly string[]): void {
    if (!workspaceId) throw new Error('Cache: workspaceId is required');
    if (tags.length > 0) this.gens.bump(workspaceId, tags);
  }

  /** Drop the L1 entry for a key (does not touch generations). */
  forget(workspaceId: string, key: string): void {
    this.l1.delete(this.fullKey(workspaceId, key));
  }

  /** Cold-bust: clear the entire L1 (used on a listener (re)connect — D-011). Generations
   *  are unaffected; entries simply have to be rebuilt. */
  clearL1(): void {
    this.l1.clear();
  }
}
