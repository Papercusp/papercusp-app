/**
 * Shared LRU cache of admin-role `postgres()` clients, keyed by
 * `(adminUrl, harnessSlug)`.
 *
 * Opening **and** tearing down a fresh `postgres()` pool per call burns a
 * connection slot plus TCP + startup round-trips every time. Two hot paths did
 * exactly that per-harness:
 *   - `dispatchOneHarness` (orchestrator-loop) — every 30s tick **and** every
 *     pipeline settle (operator-scalability-event-loop P4-1 / app-wide-load-traps
 *     F-B1: "per-tick PG pool churn");
 *   - the debugger gate (orchestrator-runner) — every pipeline invocation past the
 *     attempt threshold.
 * Cache one client per `(url, harness)` and reuse it instead. Sharing one cache
 * across both callers also *shrinks* the connection budget (one client per
 * harness, not one-per-subsystem) — the whole point of the P4 cluster.
 *
 * Contract — deliberately admin-role + a per-harness `search_path`, **NOT**
 * `getHarnessPg()`: that helper is app-role and RLS-subject, so without a
 * `withWorkspace()` transaction an admin read would silently return zero rows and
 * the caller (e.g. the debugger attempts read) would misbehave. `max:1` so each
 * cached client pins exactly one connection. Keyed by URL too so an embedded-pg
 * discovery change (a new port after a desktop restart) builds a fresh client
 * rather than pinning the dead one; the stale-url entry is dropped by LRU
 * eviction. A query error never ends the client — the `postgres` library
 * reconnects internally — so a cached client survives transient blips.
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';

/** Most distinct `(url, harness)` admin clients kept open at once. */
export const ADMIN_PG_CACHE_MAX = 8;

type PgClient = ReturnType<typeof postgres>;

/**
 * The client factory. Overridable as the last arg so the LRU logic is unit-testable
 * without a live Postgres (the real default opens an actual pool).
 */
export type AdminPgFactory = (url: string, searchPath: string) => PgClient;

const defaultFactory: AdminPgFactory = (url, searchPath) =>
  postgres(url, {
    max: 1,
    connect_timeout: 5,
    // application_name so this cached admin client is attributable in
    // pg_stat_activity (C0-2 of backend-connection-scaling-2026-06-17). Capped at
    // PG's 63-byte NAMEDATALEN-1 limit.
    connection: {
      search_path: searchPath,
      application_name: `pcusp:admin-cache:p${process.pid}`.slice(0, 63),
    },
  });

const cache = new Map<string, PgClient>();

/**
 * Get (or lazily open) the cached admin client for `harnessSlug`. On a hit reuses
 * the open client (refreshing its LRU recency); on a miss opens one via `factory`,
 * first evicting + `.end()`-ing the least-recently-used client when the cache is
 * full.
 */
export function adminClientForHarness(
  harnessSlug: string,
  url: string = getHarnessAdminUrl(),
  factory: AdminPgFactory = defaultFactory,
): PgClient {
  const key = `${url}|${harnessSlug}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-insert to refresh LRU recency (Map preserves insertion order).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (cache.size >= ADMIN_PG_CACHE_MAX) {
    const oldest = cache.entries().next().value;
    if (oldest) {
      cache.delete(oldest[0]);
      void oldest[1].end({ timeout: 2 }).catch(() => {});
    }
  }
  const client = factory(url, `harness_${harnessSlug},harness_shared,public`);
  cache.set(key, client);
  return client;
}

/** Test-only: `.end()` + drop every cached client so each case starts clean. */
export function _resetAdminPgCache(): void {
  for (const client of cache.values()) void client.end({ timeout: 1 }).catch(() => {});
  cache.clear();
}

/** Test-only: current number of cached clients. */
export function _adminPgCacheSize(): number {
  return cache.size;
}
