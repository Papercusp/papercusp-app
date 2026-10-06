/**
 * revoked-set-cache.ts — process-local read-through cache for the PUBLISHED
 * revocation sets the hyperbee merge loop re-reads at the top of every pass
 * (WI-10005183).
 *
 * WHY: `applyRevocationRefresh` (boot.ts) runs at the top of EVERY merge pass for
 * EVERY booted harness — roughly once a second each. Measured 2026-10-02 00:49Z on
 * bg-host: 86 `contributors.revoked_pubkeys` + 76 `pot_members.revoked_pubkeys`
 * queries per second, every one returning the same (empty) set. The sets change a
 * handful of times a day.
 *
 * HOW IT STAYS EXACT: both tables already carry `emit_change_notify_trg`, which
 * fires `pg_notify('sync_invalidate', { name: 'harness_shared.<table>.changed' })`
 * on EVERY row insert/update/delete — local writes, the revoke tools on another
 * process, and federated projection applies alike. This cache subscribes to that
 * existing LISTEN (sync-sse's bus; no new connection, no migration) and:
 *   - drops EVERY entry when a `contributors` / `pot_members` change arrives
 *     (the trigger's workspace id comes from a GUC that writers may not set, so
 *     the event cannot be scoped — and these writes are rare);
 *   - drops EVERY entry on the initial LISTEN and on every reconnect-relisten, so a
 *     NOTIFY committed while the connection was down cannot leave a stale entry;
 *   - serves NOTHING from cache until its subscriber is attached to a live LISTEN —
 *     before that, and whenever coherence could not start, every read goes straight
 *     to Postgres exactly as it did before this cache existed.
 * A load that an invalidation overtakes is returned to its caller (it is no staler
 * than an uncached query issued at the same instant) but NOT stored, so the next
 * pass re-reads. `REVOKED_SET_CACHE_MAX_AGE_MS` is the fail-safe for a write that
 * bypassed the trigger; it is never the coherence mechanism.
 *
 * The G7 ordering (refresh BEFORE the pass collects its merge set) and the WI-193
 * un-revoke reconciliation are untouched: they live in boot.ts and still run every
 * pass, against a set that is as fresh as the last committed write this process has
 * been told about.
 */
import { pinModuleState } from '@papercusp/module-singleton';

/** Raw trigger events (harness_shared.emit_change_notify) that can change a published revoked set. */
export const REVOKED_SET_SOURCE_EVENTS: ReadonlySet<string> = new Set([
  'harness_shared.contributors.changed',
  'harness_shared.pot_members.changed',
]);

/**
 * Fail-safe bound on how long an entry may be served without a re-read, for a write
 * this process could not hear about. The NOTIFY above is the mechanism.
 */
export const REVOKED_SET_CACHE_MAX_AGE_MS = 30_000;

/** After a failed coherence start, how long to wait before trying again (reads stay uncached meanwhile). */
export const REVOKED_SET_COHERENCE_RETRY_MS = 60_000;

export type RevokedSetSource = 'contributors' | 'pot_members';

/** Cache key for one published set: the table it is read from plus the scope it is read under. */
export function revokedSetCacheKey(source: RevokedSetSource, workspaceId: string, scope: string): string {
  return `${source}\x00${workspaceId}\x00${scope}`;
}

export interface RevokedSetCoherenceHandlers {
  /** Call for every received sync_invalidate event name. */
  onEvent(name: string): void;
  /** Call on the initial LISTEN and every reconnect-relisten. */
  onListen(): void;
}

/**
 * Attach the handlers to a live invalidation LISTEN. Must resolve only once the
 * LISTEN is established, because resolution is what enables serving from cache.
 */
export type StartRevokedSetCoherence = (handlers: RevokedSetCoherenceHandlers) => Promise<void>;

interface Entry {
  epoch: number;
  loadedAt: number;
  value: ReadonlySet<string>;
}

interface Flight {
  epoch: number;
  promise: Promise<ReadonlySet<string>>;
}

interface RevokedSetCacheState {
  /** True once the subscriber is attached to a live LISTEN. Until then nothing is served from cache. */
  coherent: boolean;
  /** Bumped by every invalidation; an entry or flight from an older epoch is never served. */
  epoch: number;
  entries: Map<string, Entry>;
  flights: Map<string, Flight>;
  starting: Promise<void> | null;
  retryAfter: number;
  stats: { hits: number; loads: number; uncachedLoads: number; invalidations: number };
  now: () => number;
  maxAgeMs: number;
  startCoherence: StartRevokedSetCoherence;
}

async function startViaSyncSse(handlers: RevokedSetCoherenceHandlers): Promise<void> {
  const { registerInvalidationListenHook, subscribe } = await import('../../sync-sse');
  registerInvalidationListenHook(handlers.onListen);
  // `subscribe` awaits the bus's LISTEN start, so resolving here means the LISTEN is live.
  await subscribe((event) => handlers.onEvent(event.name));
}

function defaults(): Pick<RevokedSetCacheState, 'now' | 'maxAgeMs' | 'startCoherence'> {
  return { now: Date.now, maxAgeMs: REVOKED_SET_CACHE_MAX_AGE_MS, startCoherence: startViaSyncSse };
}

function freshState(): RevokedSetCacheState {
  return {
    coherent: false,
    epoch: 0,
    entries: new Map(),
    flights: new Map(),
    starting: null,
    retryAfter: 0,
    stats: { hits: 0, loads: 0, uncachedLoads: 0, invalidations: 0 },
    ...defaults(),
  };
}

const state = pinModuleState<RevokedSetCacheState>('@papercusp/operator-core.revokedSetCache', freshState);

function invalidateAll(): void {
  state.epoch++;
  state.entries.clear();
  state.stats.invalidations++;
}

const handlers: RevokedSetCoherenceHandlers = {
  onEvent(name) {
    if (REVOKED_SET_SOURCE_EVENTS.has(name)) invalidateAll();
  },
  onListen() {
    invalidateAll();
  },
};

function maybeStartCoherence(): void {
  if (state.coherent || state.starting || state.now() < state.retryAfter) return;
  const starting = (async () => {
    await state.startCoherence(handlers);
    // Anything read before the subscriber was attached could have missed a NOTIFY.
    invalidateAll();
    state.coherent = true;
  })();
  state.starting = starting;
  starting
    .catch((err) => {
      state.retryAfter = state.now() + REVOKED_SET_COHERENCE_RETRY_MS;
      console.warn(
        '[revoked-set-cache] could not attach to sync_invalidate; revocation reads stay uncached:',
        err instanceof Error ? err.message : String(err),
      );
    })
    .finally(() => {
      if (state.starting === starting) state.starting = null;
    });
}

/**
 * Read a published revoked set through the cache. `load` is the exact uncached
 * read; it runs whenever the cache cannot vouch for a stored value. The returned
 * Set is always a fresh copy, so callers may mutate it.
 */
export async function readRevokedSetCached(
  key: string,
  load: () => Promise<Set<string>>,
): Promise<Set<string>> {
  if (!state.coherent) {
    maybeStartCoherence();
    state.stats.uncachedLoads++;
    return load();
  }
  const epoch = state.epoch;
  const hit = state.entries.get(key);
  if (hit && hit.epoch === epoch && state.now() - hit.loadedAt < state.maxAgeMs) {
    state.stats.hits++;
    return new Set(hit.value);
  }
  const flight = state.flights.get(key);
  if (flight && flight.epoch === epoch) {
    state.stats.hits++;
    return new Set(await flight.promise);
  }
  const loadedAt = state.now();
  const promise: Promise<ReadonlySet<string>> = load().then((value) => new Set(value));
  state.flights.set(key, { epoch, promise });
  state.stats.loads++;
  try {
    const value = await promise;
    if (state.epoch === epoch) state.entries.set(key, { epoch, loadedAt, value });
    return new Set(value);
  } finally {
    if (state.flights.get(key)?.promise === promise) state.flights.delete(key);
  }
}

/** Counters for live verification: how many reads were served from cache vs re-read. */
export function revokedSetCacheStats(): {
  coherent: boolean;
  epoch: number;
  entries: number;
  hits: number;
  loads: number;
  uncachedLoads: number;
  invalidations: number;
} {
  return { coherent: state.coherent, epoch: state.epoch, entries: state.entries.size, ...state.stats };
}

/** Test seam: replace the clock, the max age, or how coherence attaches. */
export function _configureRevokedSetCacheForTests(
  deps: Partial<Pick<RevokedSetCacheState, 'now' | 'maxAgeMs' | 'startCoherence'>>,
): void {
  if (deps.now) state.now = deps.now;
  if (deps.maxAgeMs !== undefined) state.maxAgeMs = deps.maxAgeMs;
  if (deps.startCoherence) state.startCoherence = deps.startCoherence;
}

/** Test seam: forget every entry, flight, counter and the coherence state. */
export function _resetRevokedSetCacheForTests(): void {
  Object.assign(state, freshState());
}
