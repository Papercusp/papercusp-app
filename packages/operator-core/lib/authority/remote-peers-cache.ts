/**
 * remote-peers-cache — a cheap "are there any remote peers for this harness?"
 * check, cached with a short TTL (Phase 2 of
 * distributed-coordination-shared-harness-2026-06-04).
 *
 * The file-lock acquire hot path (the per-edit lock hook) must stay near-zero-cost
 * in the common case — a single box / no federated peers. routeToAuthority does a
 * `shared_presence` query every call to resolve the authority; on a box with no
 * peers that query is pure overhead. This cache answers "no peers → don't even
 * consult the authority, just run locally" from memory, refreshing at most once
 * per `ttlMs`. It is the guard that makes wiring routeFileLockOp into the live
 * acquire path safe: with no remote peers (the overwhelming default), the lock
 * hook pays one cached boolean read, not a DB round-trip.
 *
 * Correctness: a STALE "no peers" answer only costs a missed serialization for up
 * to ttlMs after a peer appears — and a missed serialization is fail-open (D-004,
 * git is the backstop), never a correctness violation. So a short TTL trades a
 * tiny federation-onset latency for hot-path cheapness, safely.
 */

import { lockAuthorityFor, lockAuthorityForHive, type AuthorityResolution, type LockAuthorityDeps } from './lock-authority';

export interface RemotePeersCacheDeps extends LockAuthorityDeps {
  /** Cache TTL in ms. Default 5000. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5_000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

/**
 * True iff the harness has at least one LIVE peer that is NOT this machine
 * (i.e. cross-machine serialization could matter). Cached per harness for ttlMs.
 * On a single box (no swarm) this resolves false and stays cached, so a caller
 * can short-circuit to a purely-local path with no per-call DB query.
 */
export async function hasRemotePeers(
  harnessSlug: string,
  deps: RemotePeersCacheDeps = {},
): Promise<boolean> {
  return cachedHasRemotePeer(harnessSlug, () => lockAuthorityFor(harnessSlug, deps), deps);
}

/**
 * The Hive analog (P-009): true iff the shared HIVE has at least one live remote
 * Swarm — the fast-path guard for routing a Hive member's file-locks to the Hive
 * authority. Same TTL cache, namespaced by `hive:<slug>` so it can't collide with
 * a harness key.
 */
export async function hasRemoteHivePeers(
  potSlug: string,
  deps: RemotePeersCacheDeps = {},
): Promise<boolean> {
  return cachedHasRemotePeer(`hive:${potSlug}`, () => lockAuthorityForHive(potSlug, deps), deps);
}

/** Shared TTL-cached "is there a live remote peer?" over any scope's resolution. */
async function cachedHasRemotePeer(
  cacheKey: string,
  resolve: () => Promise<AuthorityResolution>,
  deps: RemotePeersCacheDeps,
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const resolution = await resolve();
  // A remote peer exists iff there is a live candidate that isn't just self-alone.
  const value = resolution.liveCount > 0 && !(resolution.isSelf && resolution.liveCount === 1);
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  _cache.set(cacheKey, { value, expiresAt: now + ttlMs });
  return value;
}

/** Invalidate the cache for one harness (or all) — call when presence changes
 *  materially (a peer joins/leaves) to pick it up before the TTL. Pass a
 *  `hive:<slug>` key to invalidate a Hive entry. */
export function invalidateRemotePeers(harnessSlug?: string): void {
  if (harnessSlug) _cache.delete(harnessSlug);
  else _cache.clear();
}

/** Invalidate a Hive's remote-peers cache entry. */
export function invalidateRemoteHivePeers(potSlug: string): void {
  _cache.delete(`hive:${potSlug}`);
}

/** Test-only: reset the cache. */
export function __resetRemotePeersCacheForTests(): void {
  _cache.clear();
}
