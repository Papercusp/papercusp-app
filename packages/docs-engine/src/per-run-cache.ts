/**
 * Shared per-run cache helper for outline-style payloads.
 *
 * Keyed by ctx.runId ?? ctx.spawnId ?? '_anonymous'. Bounded LRU
 * (FIFO eviction at max). Used by every tool that wraps buildOutline
 * so the cache pattern lives in one place and a future tool gets it
 * for free.
 */

export interface RunCacheCtx {
  runId?: string;
  spawnId?: string;
}

export class RunCache<T> {
  private map = new Map<string, T>();
  constructor(private readonly max = 100) {}

  private key(ctx: RunCacheCtx, scope: string = ''): string {
    const base = ctx.runId ?? ctx.spawnId ?? '_anonymous';
    return scope ? `${base}:${scope}` : base;
  }

  get(ctx: RunCacheCtx, scope: string = ''): T | undefined {
    return this.map.get(this.key(ctx, scope));
  }

  set(ctx: RunCacheCtx, value: T, scope: string = ''): void {
    this.map.set(this.key(ctx, scope), value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Test/debug helper — current size. */
  get size(): number {
    return this.map.size;
  }

  /** Test/debug helper — clear all entries. */
  clear(): void {
    this.map.clear();
  }
}
