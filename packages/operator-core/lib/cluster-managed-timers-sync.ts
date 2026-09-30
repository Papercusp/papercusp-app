/**
 * cluster-managed-timers-sync.ts — EI-19454206016477347: primary→worker PUSH sync for
 * the CLUSTER PRIMARY's own managed-timer + DBOS-schedule registries.
 *
 * ## The bug this closes
 *
 * `/api/internal/managed-timers` (the probe target `schedule-federation.ts` calls)
 * answers with WHICHEVER process serves the HTTP request — and under `node:cluster`'s
 * SO_REUSEPORT fan-out, that is always one of the forked WORKERS, never the PRIMARY.
 * The primary is the one process that runs `onPrimary()` (`hono-host.ts`) and therefore
 * the one that owns whatever `managedSetInterval` timers and DBOS scheduled workflows
 * get armed during background-machinery boot — but it never itself answers the route
 * that reports them (WI-6793's own comment in hono-host.ts: "the clustered PRIMARY …
 * never startRequestServers"). So on a clustered host, the primary's OWN timers are
 * structurally invisible to its OWN `/api/internal/managed-timers` route, the same way
 * EI-8816 found the primary's booted harnesses invisible to
 * `dev:dogfood_substrate_status` — federation was reusing a registry (endpoint-ipc)
 * whose defining property (only LISTENING processes appear) excludes exactly the
 * process most worth reaching.
 *
 * ## Fix — mirrors EI-8816's `cluster-booted-handles-sync.ts` PUSH pattern exactly
 *
 * A PUSH model (not request/reply), chosen for the same reason EI-8816 chose it: the
 * `/api/internal/managed-timers` handler must stay a pure in-memory SYNCHRONOUS-cache
 * read on the worker side — it is itself a fan-out target other siblings' probes are
 * time-budgeted against (schedule-federation.ts), so it must not grow a new async
 * round-trip. The PRIMARY periodically broadcasts `{ pid, role, timers: listManaged(),
 * dbosSchedules: await defaultGetRegisteredSchedules(), sentAt }` to every live worker
 * over `node:cluster` IPC (`ClusterHandle.broadcast`, `cluster-fork.ts`); each WORKER
 * caches the latest snapshot and reads it back synchronously via
 * `getCachedPrimaryManagedTimers()`. The managed-timers route handler folds that cache
 * into an optional `primary` field on its JSON response, so a caller probing the
 * worker's port also learns the primary's registries — no new port, no new listener,
 * reuses the exact IPC seam EI-8816 already proved out.
 *
 * ## Deliberately no substrate-ownership gate
 *
 * Unlike `cluster-booted-handles-sync.ts`'s `isSubstrateOwnerProcess()` self-gate, this
 * file broadcasts UNCONDITIONALLY whenever it is wired (i.e. only ever wired from a
 * true-cluster primary — see `hono-host.ts`, which mirrors EI-8816's wiring site). There
 * is no equivalent "confident false zero" risk here: `listBootedHandles()` is
 * unconditionally `[]` in a process that never booted the substrate and therefore LIES
 * if reported as a verified-empty substrate (EI-18735338283879820), but `listManaged()`
 * and `defaultGetRegisteredSchedules()` are simply accurate for WHATEVER process reports
 * them — a request-only primary (`PAPERCUSP_BACKGROUND_WORKERS=0`) may genuinely arm
 * zero background timers, and reporting that as "primary armed 0 timers" is true, not
 * fabricated.
 */
import { listManaged, managedSetInterval, type ManagedEntry } from '@papercusp/scheduled-registry';
import {
  defaultGetRegisteredSchedules,
  type RegisteredSchedule,
} from './dbos/dbos-schedule-introspect';
import { describeProcessRole } from './schedule-federation';

/** IPC message type the primary broadcasts to every worker each interval. */
export const PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE =
  'papercusp:primary-managed-timers-snapshot' as const;

export interface PrimaryManagedTimersSnapshotMessage {
  type: typeof PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE;
  pid: number;
  /** `describeProcessRole()` — 'bg-host' | 'operator'. */
  role: string;
  /** The primary's `managedSetInterval` registry (ephemeral tier). */
  timers: ManagedEntry[];
  /** The primary's registered DBOS scheduled workflows (durable tier) — names + crontabs only. */
  dbosSchedules: RegisteredSchedule[];
  sentAt: number;
}

export interface PrimaryManagedTimersBroadcasterHandle {
  stop(): void;
}

/**
 * PRIMARY side: periodically broadcast this process's OWN `listManaged()` +
 * `defaultGetRegisteredSchedules()` snapshot to every live worker via the
 * caller-supplied `broadcast` (wire to `ClusterHandle.broadcast` from cluster-fork.ts).
 * Broadcasts immediately on start (so a freshly-forked worker's cache isn't empty for a
 * full interval) then every `intervalMs`. The timer is registered under
 * `managedSetInterval` (category 'watchdog') so the broadcaster is ITSELF visible in
 * `schedule:inventory`, matching the sibling cluster-lag-watchdog /
 * cluster-booted-handles-sync convention.
 */
export function startPrimaryManagedTimersBroadcaster(opts: {
  broadcast: (message: PrimaryManagedTimersSnapshotMessage) => void;
  intervalMs?: number;
  now?: () => number;
  /** Test seam / override for defaultGetRegisteredSchedules. */
  getRegisteredSchedules?: () => Promise<RegisteredSchedule[]>;
}): PrimaryManagedTimersBroadcasterHandle {
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const getRegisteredSchedules = opts.getRegisteredSchedules ?? defaultGetRegisteredSchedules;
  const beat = async (): Promise<void> => {
    let dbosSchedules: RegisteredSchedule[] = [];
    try {
      dbosSchedules = await getRegisteredSchedules();
    } catch {
      // defaultGetRegisteredSchedules already swallows its own errors and returns
      // []; this is belt-and-braces so one registry can never take out the other.
    }
    try {
      opts.broadcast({
        type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
        pid: process.pid,
        role: describeProcessRole(),
        timers: listManaged(),
        dbosSchedules,
        sentAt: now(),
      });
    } catch {
      /* best-effort — a dead/draining worker channel never throws past broadcast() anyway */
    }
  };
  void beat();
  // D-004: 'must-sample' — the broadcast's data source (`listManaged()` /
  // `defaultGetRegisteredSchedules()`) is an in-process registry that exposes NO
  // change-event/subscribe API, and the workers it feeds live in different processes,
  // so there is nothing to subscribe to across that boundary. Not a 'violation':
  // the push here is primary→worker (vs workers polling the route); the timer is only
  // the trigger for a snapshot that has no event source of its own.
  const timer = managedSetInterval('primary-managed-timers-broadcast', intervalMs, beat, {
    category: 'watchdog',
    classification: 'must-sample',
  });
  return {
    stop() {
      timer.stop();
    },
  };
}

export interface RemotePrimaryManagedTimersSnapshot {
  pid: number;
  role: string;
  timers: ManagedEntry[];
  dbosSchedules: RegisteredSchedule[];
  /** The primary's own `sentAt` (epoch ms) from the broadcast message. */
  sentAt: number;
  /** WORKER-side receipt time (epoch ms) — the freshness clock a stale-cache read uses. */
  receivedAt: number;
}

/** Process-local cache of the latest snapshot received from the primary. Only ever
 *  populated in a genuine forked WORKER process (the primary never broadcasts to
 *  itself); stays `null` for the lifetime of a primary / single-process host. */
let cachedPrimary: RemotePrimaryManagedTimersSnapshot | null = null;

/**
 * WORKER side: listen for the primary's managed-timers broadcast and cache the latest
 * snapshot + receipt time. Registers a `process.on('message', ...)` listener by default
 * (injectable `on`/`off` for tests — synthetically emitting on the REAL `process` object
 * risks colliding with the test runner's own worker IPC, which uses the same event —
 * see cluster-booted-handles-sync.test.ts's doc for the concrete collision) — a no-op
 * safe to call in any process (a primary/single-process host simply never receives this
 * message type, so the cache stays `null` there).
 */
export function startWorkerPrimaryManagedTimersCache(
  opts: {
    now?: () => number;
    on?: (event: 'message', cb: (message: unknown) => void) => void;
    off?: (event: 'message', cb: (message: unknown) => void) => void;
  } = {},
): { stop(): void } {
  const now = opts.now ?? (() => Date.now());
  const on = opts.on ?? ((event: 'message', cb: (message: unknown) => void) => process.on(event, cb));
  const off = opts.off ?? ((event: 'message', cb: (message: unknown) => void) => process.off(event, cb));
  const listener = (message: unknown): void => {
    const m = message as Partial<PrimaryManagedTimersSnapshotMessage> | null | undefined;
    if (m?.type !== PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE) return;
    if (typeof m.pid !== 'number' || typeof m.role !== 'string' || !Array.isArray(m.timers)) return;
    cachedPrimary = {
      pid: m.pid,
      role: m.role,
      timers: m.timers as ManagedEntry[],
      dbosSchedules: Array.isArray(m.dbosSchedules) ? (m.dbosSchedules as RegisteredSchedule[]) : [],
      sentAt: typeof m.sentAt === 'number' ? m.sentAt : now(),
      receivedAt: now(),
    };
  };
  on('message', listener);
  return {
    stop() {
      off('message', listener);
    },
  };
}

/** Read the latest cached primary snapshot (or `null` if none has ever arrived). Pure
 *  sync read — this is the seam the managed-timers route handler wires as `primary`. */
export function getCachedPrimaryManagedTimers(): RemotePrimaryManagedTimersSnapshot | null {
  return cachedPrimary;
}

/** Test seam only — set/clear the module-scope cache directly without a real
 *  `process.on('message')` round-trip. */
export function _setCachedPrimaryManagedTimersForTests(
  snapshot: RemotePrimaryManagedTimersSnapshot | null,
): void {
  cachedPrimary = snapshot;
}
