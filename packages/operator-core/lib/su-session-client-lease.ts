/**
 * pui-chat-first-ux-2026-09-28 P-009 (WI-10004114): a PUI chat's engine must not
 * outlive its client unattended.
 *
 * Evidence that motivated it: after a pui client was killed (SIGHUP, SIGTERM) or
 * even after a clean /exit, its attached Claude engine kept running as a live SU
 * identity for minutes, once parked on a permission prompt no client could
 * answer. Claude Code and Codex end with their process and resume from the
 * transcript; a PUI chat now does the same unless its owner detached it.
 *
 * The lease is DURABLE (adv_sessions.su_client_lease_until), not an in-process
 * subscriber count. An attached engine lives in ONE operator worker while its
 * client's event stream can be served by ANY worker of a clustered host
 * (WI-10003879): counting only the owner's own subscribers would end engines
 * whose owner is watching through a sibling worker. So:
 *
 *   - every worker holding an open su-session event stream renews the lease
 *     (trackSuClientStream), and attaching clears a previous detach;
 *   - the worker that owns the engine sweeps its own engines and ends one whose
 *     lease has lapsed (superviseSuClientLease), unless it was detached;
 *   - a fresh engine gets an initial lease, so a client that dies between the
 *     launch and its first attach is still reclaimed.
 *
 * The comparison uses the database clock, so workers with skewed clocks agree.
 */
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/** How long one renewal keeps an engine alive with no stream renewing it. */
export const SU_CLIENT_LEASE_TTL_MS = 30_000;
/** How long a new engine waits for its first client before it is reclaimed. */
export const SU_CLIENT_INITIAL_LEASE_MS = 60_000;

export interface SuClientLeaseConfig {
  ttlMs: number;
  renewMs: number;
  sweepMs: number;
  initialMs: number;
}

function positiveEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * The effective timings. The env overrides exist for the real-PTY acceptance
 * test, which cannot wait out a production lease; renew and sweep are derived
 * from the TTL so a shortened TTL can never be outrun by its own renewal.
 */
export function suClientLeaseConfig(): SuClientLeaseConfig {
  const ttlMs = positiveEnv('PAPERCUSP_SU_CLIENT_LEASE_TTL_MS') ?? SU_CLIENT_LEASE_TTL_MS;
  return {
    ttlMs,
    renewMs: Math.max(100, Math.floor(ttlMs / 3)),
    sweepMs: Math.max(100, Math.floor(ttlMs / 6)),
    initialMs: positiveEnv('PAPERCUSP_SU_CLIENT_INITIAL_LEASE_MS')
      ?? Math.max(SU_CLIENT_INITIAL_LEASE_MS, ttlMs * 2),
  };
}

/** The durable side of the lease. Injected in unit tests. */
export interface SuClientLeaseStore {
  /** A client attached (or an engine started): lease = now()+ttl, detach cleared. */
  grant(advSessionId: number, ttlMs: number): Promise<void>;
  /** Extend the lease of every session a local stream is still watching. */
  renew(advSessionIds: readonly number[], ttlMs: number): Promise<void>;
  /** Keep the session running with no client. False when no live row matched. */
  detach(advSessionId: number): Promise<boolean>;
  /** The subset whose lease has lapsed and that was not detached. */
  expired(advSessionIds: readonly number[]): Promise<number[]>;
}

export const pgSuClientLeaseStore: SuClientLeaseStore = {
  async grant(advSessionId, ttlMs) {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET su_client_lease_until = now() + make_interval(secs => ${ttlMs}::double precision / 1000),
             su_client_detached_at = NULL
       WHERE id = ${advSessionId} AND ended_at IS NULL`;
  },
  async renew(advSessionIds, ttlMs) {
    if (advSessionIds.length === 0) return;
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET su_client_lease_until = GREATEST(
               COALESCE(su_client_lease_until, now()),
               now() + make_interval(secs => ${ttlMs}::double precision / 1000))
       WHERE id = ANY(${[...advSessionIds]}::bigint[]) AND ended_at IS NULL`;
  },
  async detach(advSessionId) {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET su_client_detached_at = now()
       WHERE id = ${advSessionId} AND ended_at IS NULL
       RETURNING id`;
    return rows.length > 0;
  },
  async expired(advSessionIds) {
    if (advSessionIds.length === 0) return [];
    const { sql } = getOrgPg();
    const rows = await sql<{ id: string | number }[]>`
      SELECT id FROM harness_shared.adv_sessions
       WHERE id = ANY(${[...advSessionIds]}::bigint[])
         AND su_client_detached_at IS NULL
         AND su_client_lease_until IS NOT NULL
         AND su_client_lease_until < now()`;
    return rows.map((row) => Number(row.id));
  },
};

interface Supervision {
  onExpired: () => void | Promise<void>;
}

const state = pinModuleState('@papercusp/operator-core.su-client-lease', () => ({
  store: null as SuClientLeaseStore | null,
  /** advSessionId -> open event streams in THIS process. */
  streams: new Map<number, number>(),
  renewTimer: null as ManagedHandle | null,
  /** advSessionId -> the engine this process owns for it. */
  supervised: new Map<number, Supervision>(),
  sweepTimer: null as ManagedHandle | null,
  sweeping: false,
  warned: new Set<string>(),
  /** Arm real timers inside a Vitest worker (see _armSuClientLeaseTimersForTest). */
  timersInTest: false,
}));

function store(): SuClientLeaseStore {
  return state.store ?? pgSuClientLeaseStore;
}

/** A lease write that fails must not break a stream or an engine; it is a
 * degraded lease, reported once per kind rather than per tick. */
function warnOnce(kind: string, error: unknown): void {
  if (state.warned.has(kind)) return;
  state.warned.add(kind);
  console.warn(`[su-client-lease] ${kind} failed (further ${kind} failures are silent)`, error);
}

function validId(advSessionId: number): boolean {
  return Number.isSafeInteger(advSessionId) && advSessionId > 0;
}

function ensureRenewTimer(): void {
  if (state.renewTimer) return;
  const { renewMs } = suClientLeaseConfig();
  // D-004 'must-sample': "a client is watching" is an open socket in THIS
  // process, and no event reaches the worker that owns the engine when that
  // stays true. Renewing is how the owner learns it, so it is sampled.
  state.renewTimer = managedSetInterval('su-client-lease-renew', renewMs, async () => {
    const ids = [...state.streams.keys()];
    if (ids.length === 0) return;
    try {
      await store().renew(ids, suClientLeaseConfig().ttlMs);
    } catch (error) {
      warnOnce('renew', error);
    }
  }, { category: 'liveness', classification: 'must-sample', allowInTest: state.timersInTest });
}

function stopRenewTimerIfIdle(): void {
  if (state.streams.size > 0 || !state.renewTimer) return;
  state.renewTimer.stop();
  state.renewTimer = null;
}

/**
 * Record one open client event stream for a session and renew its lease while
 * it stays open. Returns an idempotent release for when the stream closes.
 * The lease is NOT shortened on close: another worker may still be serving a
 * stream for the same session, and a lapse is decided by the database alone.
 */
export function trackSuClientStream(advSessionId: number): () => void {
  if (!validId(advSessionId)) return () => undefined;
  state.streams.set(advSessionId, (state.streams.get(advSessionId) ?? 0) + 1);
  void store().grant(advSessionId, suClientLeaseConfig().ttlMs).catch((error) => warnOnce('grant', error));
  ensureRenewTimer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const open = (state.streams.get(advSessionId) ?? 1) - 1;
    if (open > 0) state.streams.set(advSessionId, open);
    else state.streams.delete(advSessionId);
    stopRenewTimerIfIdle();
  };
}

/** Give a freshly started engine time to be attached before it can lapse. */
export async function grantSuClientLease(advSessionId: number, ttlMs = suClientLeaseConfig().initialMs): Promise<void> {
  if (!validId(advSessionId)) return;
  try {
    await store().grant(advSessionId, ttlMs);
  } catch (error) {
    warnOnce('grant', error);
  }
}

export interface SuClientLeaseDiagnostics {
  config: SuClientLeaseConfig;
  /** advSessionId -> open event streams in this process. */
  streams: Array<[number, number]>;
  supervised: number[];
  sweeping: boolean;
  renewTimer: boolean;
  sweepTimer: boolean;
  timersInTest: boolean;
}

/** This process's view of the lease machinery, for failure evidence: which
 * streams it believes are open, which engines it supervises, and whether its
 * timers run. The durable lease itself is the adv_sessions row. */
export function suClientLeaseDiagnostics(): SuClientLeaseDiagnostics {
  return {
    config: suClientLeaseConfig(),
    streams: [...state.streams.entries()],
    supervised: [...state.supervised.keys()],
    sweeping: state.sweeping,
    renewTimer: state.renewTimer !== null,
    sweepTimer: state.sweepTimer !== null,
    timersInTest: state.timersInTest,
  };
}

/** The owner asked for this session to keep running with no client attached. */
export async function detachSuClientLease(advSessionId: number): Promise<boolean> {
  if (!validId(advSessionId)) return false;
  return store().detach(advSessionId);
}

async function sweep(): Promise<void> {
  if (state.sweeping || state.supervised.size === 0) return;
  state.sweeping = true;
  try {
    let expired: number[];
    try {
      expired = await store().expired([...state.supervised.keys()]);
    } catch (error) {
      // A lease that cannot be read proves nothing about the client. Keep the
      // engine: the failure mode is a lingering engine, never a killed one.
      warnOnce('sweep', error);
      return;
    }
    for (const advSessionId of expired) {
      const supervision = state.supervised.get(advSessionId);
      if (!supervision) continue;
      state.supervised.delete(advSessionId);
      // Ending an engine awaits its process teardown. Not awaited here: one
      // engine whose close hangs must not hold `sweeping` and so stop every
      // later sweep in this process from ending anything else.
      void Promise.resolve()
        .then(() => supervision.onExpired())
        .catch((error) => console.warn(`[su-client-lease] ending unattended session ${advSessionId} failed`, error));
    }
  } finally {
    state.sweeping = false;
    stopSweepTimerIfIdle();
  }
}

function ensureSweepTimer(): void {
  if (state.sweepTimer) return;
  // D-004 'timeout-reaper': the lease lapsing IS the trigger, and a lapse is
  // the absence of renewals; there is no event for "nothing happened".
  state.sweepTimer = managedSetInterval('su-client-lease-sweep', suClientLeaseConfig().sweepMs,
    () => sweep(), { category: 'liveness', classification: 'timeout-reaper', allowInTest: state.timersInTest });
}

function stopSweepTimerIfIdle(): void {
  if (state.supervised.size > 0 || !state.sweepTimer || state.sweeping) return;
  state.sweepTimer.stop();
  state.sweepTimer = null;
}

/**
 * Supervise one engine THIS process owns: `onExpired` runs once, after the
 * session's lease lapses while it is not detached. Returns an idempotent
 * release that only removes this registration, never a later one for the same
 * session (a resumed engine re-registers under the same id).
 */
export function superviseSuClientLease(
  advSessionId: number,
  onExpired: () => void | Promise<void>,
): () => void {
  if (!validId(advSessionId)) return () => undefined;
  const supervision: Supervision = { onExpired };
  state.supervised.set(advSessionId, supervision);
  ensureSweepTimer();
  return () => {
    if (state.supervised.get(advSessionId) === supervision) state.supervised.delete(advSessionId);
    stopSweepTimerIfIdle();
  };
}

/** Test-only: replace the durable store and forget all in-process state. */
export function _resetSuClientLeaseForTest(store: SuClientLeaseStore | null = null): void {
  state.renewTimer?.stop();
  state.sweepTimer?.stop();
  state.store = store;
  state.streams.clear();
  state.supervised.clear();
  state.renewTimer = null;
  state.sweepTimer = null;
  state.sweeping = false;
  state.warned.clear();
  state.timersInTest = false;
}

/** Test-only: run one sweep now. */
export function _sweepSuClientLeasesForTest(): Promise<void> {
  return sweep();
}

/**
 * Test-only: an operator served inside a Vitest worker (the real-PTY suite)
 * gets inert lease timers, because managedSetInterval disarms its default
 * backend there. Its engines then never lapse and a /detach is never
 * distinguishable from an attached engine. Arming replaces any timer already
 * held (it may be one of those inert handles) and picks up the current
 * PAPERCUSP_SU_CLIENT_LEASE_TTL_MS, so call it again after changing that.
 */
export function _armSuClientLeaseTimersForTest(arm: boolean): void {
  state.timersInTest = arm;
  state.renewTimer?.stop();
  state.sweepTimer?.stop();
  state.renewTimer = null;
  state.sweepTimer = null;
  if (state.streams.size > 0) ensureRenewTimer();
  if (state.supervised.size > 0) ensureSweepTimer();
}
