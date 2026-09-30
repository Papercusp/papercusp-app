/**
 * Host-wide admission shared by optional mid-turn and initialize memory
 * injection.
 *
 * This seam originated on `mid-turn-context`, which is served by several
 * SO_REUSEPORT workers. Its original rolling limiter and degraded latch were
 * both process-local, so ten workers could each spend their own allowance and
 * probe recovery independently. A fleet burst therefore multiplied an
 * optional recall path until ordinary MCP responses could not return headers
 * promptly (EI-21270032782365521).
 *
 * WI-41042 extends the SAME admission to initialize-time recall. Initialize is
 * also optional, runs inside every request worker, and previously bypassed the
 * host cap while sharing the same memory/embedding/PG dependencies. Keep one
 * resource for both ports: separate per-port semaphores would recreate the
 * cross-port amplification this guard exists to prevent.
 *
 * Reuse the existing named-resource counting semaphore rather than introduce a
 * second limiter store. There are two deliberately separate gates:
 *
 *   1. one in-flight recall per worker (zero-I/O fast rejection); and
 *   2. at most {@link MID_TURN_MEMORY_MAX_HOLDERS} workers across the host.
 *
 * The resource acquire never waits. A full or unavailable admission store is a
 * clean skip because this context is optional; the caller returns `{ text: '' }`
 * and the agent's tool turn continues. A short, renewable lease is the crash
 * backstop. If a deadline returns before its uncancelled backend promise, the
 * response still returns promptly but the local slot and host lease remain
 * held (and heartbeated) until that underlying work actually settles.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { hostGlobalLockDomain } from '../agent-tools/locks/coordination-domain';
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';
import {
  registerResource,
  tryAcquireResource,
  tryHeartbeatResource,
  tryReleaseResource,
} from '../agent-tools/locks/su-lock-store';
import { runWithTrackedMemoryTimeouts, type TrackedMemoryWork } from './op-deadline';

// The resource id predates initialize coverage. Keep it stable so an upgrade
// cannot temporarily create two independent host budgets under old/new names.
export const MID_TURN_MEMORY_RESOURCE = 'memory-injection:mid-turn';
export const MID_TURN_MEMORY_MAX_HOLDERS = 2;
// Longer than the ~55–60s MCP transport window: several best-effort hygiene
// reads run after the individually bounded 5s availability/hive/search phases,
// and an expired lease must never let a still-running zombie build exceed the
// host cap. A crashed worker suppresses optional recall for at most two minutes.
export const MID_TURN_MEMORY_LOCK_TTL_SEC = 120;
export const MID_TURN_MEMORY_HEARTBEAT_INTERVAL_MS = 40_000;

const REGISTRATION_RETRY_MS = 60_000;
const WARNING_INTERVAL_MS = 60_000;

export interface MidTurnAdmissionLocalState {
  inFlight: boolean;
}

export interface MidTurnAdmissionStore {
  ensureRegistered: () => Promise<boolean>;
  tryAcquire: (ownerId: string) => Promise<{ ok: true; lockId: string } | { ok: false; reason: string }>;
  heartbeat: (ownerId: string, lockId: string) => Promise<void>;
  release: (ownerId: string, lockId: string) => Promise<void>;
}

export type MidTurnAdmissionRunTracker = <T>(run: () => Promise<T>) => Promise<TrackedMemoryWork<T>>;

export type MidTurnAdmissionOutcome<T> = { admitted: true; value: T } | { admitted: false; reason: string };

export interface MidTurnAdmissionGuardOptions {
  ownerId: string;
  state: MidTurnAdmissionLocalState;
  store: MidTurnAdmissionStore;
  trackRun?: MidTurnAdmissionRunTracker;
  onShed?: (reason: string) => void;
  onDiagnostic?: (message: string, error: unknown) => void;
}

const runWithoutTracking: MidTurnAdmissionRunTracker = async <T>(run: () => Promise<T>) => {
  try {
    return { outcome: { ok: true, value: await run() }, pending: null };
  } catch (error) {
    return { outcome: { ok: false, error }, pending: null };
  }
};

async function releaseAdmission(options: MidTurnAdmissionGuardOptions, lockId: string): Promise<void> {
  const { ownerId, store, onDiagnostic } = options;
  try {
    await store.release(ownerId, lockId);
  } catch (error) {
    // Release failure must not discard a successfully built context block.
    // The renewable two-minute lease is the correctness backstop; surface a
    // throttled diagnostic so an expiry-backed release never looks healthy.
    onDiagnostic?.('mid-turn admission release failed; lease will expire', error);
  }
}

function releaseAdmissionAfterDrain(
  options: MidTurnAdmissionGuardOptions,
  lockId: string,
  pending: Promise<void>,
): void {
  const { ownerId, state, store, onDiagnostic } = options;
  let heartbeatInFlight = Promise.resolve();
  const heartbeatTimer = managedSetInterval(
    'mid-turn-memory-admission-heartbeat',
    MID_TURN_MEMORY_HEARTBEAT_INTERVAL_MS,
    () => {
      heartbeatInFlight = heartbeatInFlight
        .then(() => store.heartbeat(ownerId, lockId))
        .catch((error) => {
          onDiagnostic?.('mid-turn admission heartbeat failed while underlying work remained active', error);
        });
    },
    { category: 'watchdog', classification: 'must-sample' },
  );

  const cleanup = async () => {
    heartbeatTimer.stop();
    await heartbeatInFlight;
    await releaseAdmission(options, lockId);
    state.inFlight = false;
  };
  void pending.then(cleanup, cleanup);
}

/**
 * Testable guard core. Separate `state` objects model independent worker realms;
 * a shared `store` models the host-global semaphore they all contend on.
 */
export async function guardMidTurnMemoryAdmission<T>(
  options: MidTurnAdmissionGuardOptions,
  run: () => Promise<T>,
): Promise<MidTurnAdmissionOutcome<T>> {
  const { ownerId, state, store, trackRun = runWithoutTracking, onShed, onDiagnostic } = options;
  let releaseDeferred = false;

  if (state.inFlight) {
    onShed?.('local_in_flight');
    return { admitted: false, reason: 'local_in_flight' };
  }

  // Claim the local slot before the first await. Two requests entering this
  // worker in the same tick must not both reach the shared store under the same
  // stable process owner (that acquire is intentionally idempotent per owner).
  state.inFlight = true;
  try {
    let registered: boolean;
    try {
      registered = await store.ensureRegistered();
    } catch (error) {
      onDiagnostic?.('mid-turn admission resource registration failed', error);
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }
    if (!registered) {
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }

    let acquired: Awaited<ReturnType<MidTurnAdmissionStore['tryAcquire']>>;
    try {
      acquired = await store.tryAcquire(ownerId);
    } catch (error) {
      onDiagnostic?.('mid-turn admission acquire failed', error);
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }
    if (!acquired.ok) {
      onShed?.(acquired.reason);
      return { admitted: false, reason: acquired.reason };
    }

    try {
      const tracked = await trackRun(run);
      if (tracked.pending) {
        releaseAdmissionAfterDrain(options, acquired.lockId, tracked.pending);
        releaseDeferred = true;
      }
      if (!tracked.outcome.ok) throw tracked.outcome.error;
      return { admitted: true, value: tracked.outcome.value };
    } finally {
      if (!releaseDeferred) await releaseAdmission(options, acquired.lockId);
    }
  } finally {
    if (!releaseDeferred) state.inFlight = false;
  }
}

interface ProductionAdmissionState extends MidTurnAdmissionLocalState {
  registered: boolean;
  registrationPromise: Promise<boolean> | null;
  registrationRetryAfter: number;
  nextWarningAt: number;
}

// Pinned across duplicated module records inside one worker. Different worker
// processes still get distinct state and meet through the shared lock store.
const productionState = pinModuleState<ProductionAdmissionState>(
  '@papercusp/operator-core.midTurnMemoryAdmission',
  () => ({
    inFlight: false,
    registered: false,
    registrationPromise: null,
    registrationRetryAfter: 0,
    nextWarningAt: 0,
  }),
);

const productionOwnerId = `mid-turn-memory:${process.pid}`;

function warnOnce(message: string, error?: unknown): void {
  if (process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  if (now < productionState.nextWarningAt) return;
  productionState.nextWarningAt = now + WARNING_INTERVAL_MS;
  const detail = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
  console.warn(`[memory-injection] ${message}${detail}`);
}

async function ensureProductionResource(): Promise<boolean> {
  if (productionState.registered) return true;
  if (Date.now() < productionState.registrationRetryAfter) return false;
  if (productionState.registrationPromise) return productionState.registrationPromise;

  const domain = hostGlobalLockDomain();
  const registrationOwner = `${productionOwnerId}:register`;
  productionState.registrationPromise = inWorkspaceTxn(domain, registrationOwner, (tx) =>
    registerResource(tx, {
      resource: MID_TURN_MEMORY_RESOURCE,
      description: 'Host-wide concurrency budget for optional initialize and mid-turn MCP memory injection across operator workers.',
      rule_text:
        'The initialize and mid-turn optional-memory ports acquire a shared, no-wait hold. They release only after caller-visible and timed-out underlying work settle, heartbeating the crash-safe lease while needed. Full or unavailable capacity sheds recall; callers must never wait for this resource.',
      enforcement: 'enforced',
      max_holders: MID_TURN_MEMORY_MAX_HOLDERS,
    }),
  )
    .then((result) => {
      const capacity = result.resource.max_holders;
      // A lower operator-set ceiling is safe. Unbounded or wider-than-code
      // policy is not: fail closed instead of silently losing the host cap.
      if (capacity == null || capacity > MID_TURN_MEMORY_MAX_HOLDERS) {
        throw new Error(
          `${MID_TURN_MEMORY_RESOURCE} capacity is ${String(capacity)}; expected <= ${MID_TURN_MEMORY_MAX_HOLDERS}`,
        );
      }
      productionState.registered = true;
      return true;
    })
    .catch((error) => {
      productionState.registrationRetryAfter = Date.now() + REGISTRATION_RETRY_MS;
      warnOnce('host-wide mid-turn admission is unavailable; optional recall is being shed', error);
      return false;
    })
    .finally(() => {
      productionState.registrationPromise = null;
    });

  return productionState.registrationPromise;
}

const productionStore: MidTurnAdmissionStore = {
  ensureRegistered: ensureProductionResource,
  async tryAcquire(ownerId) {
    const domain = hostGlobalLockDomain();
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: domain,
        resource: MID_TURN_MEMORY_RESOURCE,
        mode: 'shared',
        owner: ownerId,
        ownerLabel: `operator-worker:${process.pid}`,
        reason: 'optional initialize or mid-turn MCP memory recall',
        ttlSec: MID_TURN_MEMORY_LOCK_TTL_SEC,
      }),
    );
    return result.ok ? { ok: true as const, lockId: result.lock_id } : { ok: false as const, reason: result.reason };
  },
  async heartbeat(ownerId, lockId) {
    const domain = hostGlobalLockDomain();
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      tryHeartbeatResource(tx, domain, ownerId, lockId, MID_TURN_MEMORY_LOCK_TTL_SEC),
    );
    if (!result.extended) throw new Error('admission lease expired before heartbeat');
  },
  async release(ownerId, lockId) {
    const domain = hostGlobalLockDomain();
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      tryReleaseResource(tx, {
        coordinationDomain: domain,
        owner: ownerId,
        lockId,
      }),
    );
    if (result.released === 0) {
      const expired = result.expired?.some((entry) => entry.lockId === lockId) ?? false;
      throw new Error(expired ? 'admission lease expired before release' : 'admission lock was not released');
    }
  },
};

/** Production entry point shared by initialize and mid-turn optional recall. */
export function withOptionalMemoryAdmission<T>(run: () => Promise<T>): Promise<MidTurnAdmissionOutcome<T>> {
  return guardMidTurnMemoryAdmission(
    {
      ownerId: productionOwnerId,
      state: productionState,
      store: productionStore,
      trackRun: runWithTrackedMemoryTimeouts,
      onShed: (reason) => warnOnce(`host-wide optional-memory admission shed recall (${reason})`),
      onDiagnostic: (message, error) => warnOnce(message, error),
    },
    run,
  );
}

/** Compatibility name for the original mid-turn caller. */
export function withMidTurnMemoryAdmission<T>(run: () => Promise<T>): Promise<MidTurnAdmissionOutcome<T>> {
  return withOptionalMemoryAdmission(run);
}
