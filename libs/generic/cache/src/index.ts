/**
 * @papercusp/cache — a generic, workspace-scoped, tag-based cache.
 *
 * getOrSet(workspaceId, key, factory, { tags }) caches the factory result keyed by
 * (workspaceId, key); invalidateByTag(workspaceId, tag) bumps a per-(workspace,tag)
 * GENERATION, lazily marking every entry carrying that tag stale on its next read (no
 * eager purge). Adds an in-process L1 LRU, single-flight (one factory run per key under
 * concurrency), and stale-while-revalidate.
 *
 * PURE + injected: the bumpable-generation store is a seam (in-memory default; the host
 * wires a LISTEN/NOTIFY-fed in-process map backed by Postgres). Zero domain coupling.
 *
 * Workspace scoping is mandatory (D-010): keys and tags are namespaced per workspace, so
 * two workspaces can never collide — the cross-workspace-leak guard.
 *
 * caching-layer-tag-eca-2026-06-22.
 */
export { Cache } from './cache';
export type { CacheConfig } from './cache';
export { getOrSetBounded } from './bounded';
export type { BoundedOutcome } from './bounded';
export { InMemoryGenerationStore } from './generation-store';
export { LruCache } from './l1';
export type { CacheEntry, CacheOutcome, CacheReadReason, CacheStats, Clock, GenerationStore, GetOrSetOptions } from './types';

import { Cache, type CacheConfig } from './cache';

/** configure() seam — create a Cache (host injects the GenerationStore + default TTLs). */
export function createCache(config: CacheConfig = {}): Cache {
  return new Cache(config);
}
