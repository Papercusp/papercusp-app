/**
 * cluster-lag-watchdog.ts — recover a cluster request-worker stuck in a
 * SYNCHRONOUS hot loop (EI-1598 / EI-1608).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * A :3070 cluster request-worker can spin into a sustained ~2-core busy loop
 * (the federation/sync layer doing non-yielding synchronous work). The worker
 * does NOT crash — it just stops answering — so `cluster.on('exit')` never fires
 * and the worker is never respawned; /api/health + every MCP tool time out for
 * minutes (EI-1598), and the desktop shows the "lost its operator" recovery page
 * (EI-1608). The existing WORKER-SIDE recycler (`lag-self-restart.ts`) cannot help
 * here: it reads the event-loop-lag histogram on a `setInterval` and exits via a
 * `setTimeout` — both are JS callbacks on the SAME wedged loop, so during a pure
 * synchronous wedge NEITHER fires. Only an EXTERNAL observer (the PRIMARY process,
 * whose event loop is independent) can detect + kill the wedged worker.
 *
 * THE MECHANISM — heartbeat ABSENCE (not lag value)
 * -------------------------------------------------
 * Each worker sends a lightweight heartbeat to the primary every `beatMs`
 * (`startWorkerHeartbeat`). A synchronous wedge stops the worker's interval from
 * firing, so the heartbeats STOP — and silence is the one signal that survives a
 * non-yielding loop. The primary (`startClusterLagWatchdog`) records each worker's
 * last beat and, once a worker has been seen alive, SIGKILLs any worker silent for
 * longer than `silenceMs`; the existing `cluster.on('exit')` handler in
 * `cluster-fork.ts` then respawns it (respawn-budget-aware — a crash/wedge loop
 * still can't fork-bomb the box). Absence-only (not a lag threshold) keeps the
 * false-positive rate near zero: a worker that cannot emit a single beat for tens
 * of seconds is genuinely wedged, whereas a worker doing legitimate heavy work
 * still ticks its interval between chunks.
 *
 * A worker is only watched AFTER its FIRST heartbeat (registered on first message),
 * so a slow-booting worker that hasn't started beating yet is never killed for it —
 * the target is a mid-life wedge, not a boot stall (a boot stall fails health/port
 * bind and is handled elsewhere).
 *
 * SHIPPED GATED (DEFAULT-OFF), same discipline as `lag-self-restart`: arm with
 * PAPERCUSP_CLUSTER_LAG_WATCHDOG=1 once validated under load. Only meaningful in
 * true-cluster mode (workers > 1); inert in single-process mode (no peer to watch).
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';

/** IPC message a worker sends to the primary each interval. */
export const CLUSTER_HEARTBEAT_TYPE = 'papercusp:cluster-heartbeat' as const;
export interface ClusterHeartbeatMessage {
  type: typeof CLUSTER_HEARTBEAT_TYPE;
}

/** Is the heartbeat watchdog armed? DEFAULT-OFF; arm with PAPERCUSP_CLUSTER_LAG_WATCHDOG=1. */
export function clusterLagWatchdogArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_CLUSTER_LAG_WATCHDOG === '1';
}

export interface WorkerHeartbeatHandle {
  stop(): void;
}

/**
 * WORKER side: emit a heartbeat to the primary every `beatMs`. A no-op (returns an
 * inert handle) when `process.send` is unavailable (single-process / not a fork).
 * The timer is `unref()`-ed so it never holds the worker open at shutdown.
 */
export function startWorkerHeartbeat(opts: { beatMs?: number; send?: (m: ClusterHeartbeatMessage) => void } = {}): WorkerHeartbeatHandle {
  const beatMs = opts.beatMs ?? 2_000;
  // Bind once: `process.send` is only present in a forked worker with an IPC channel.
  const send =
    opts.send ?? (typeof process.send === 'function' ? (m: ClusterHeartbeatMessage) => process.send!(m) : undefined);
  if (!send) return { stop() {} };
  const beat = (): void => {
    try {
      send({ type: CLUSTER_HEARTBEAT_TYPE });
    } catch {
      /* channel closed (primary gone / draining) — nothing to do */
    }
  };
  beat(); // announce immediately so the primary registers this worker without waiting a full interval
  const timer = managedSetInterval('cluster-lag-beat', beatMs, beat, { category: 'watchdog' });
  return {
    stop() {
      timer.stop();
    },
  };
}

/** The slice of `node:cluster` the watchdog needs on the PRIMARY (injected for tests). */
export interface WatchdogClusterLike {
  on(event: 'message', cb: (worker: { id: number }, message: unknown) => void): void;
  on(event: 'exit', cb: (worker: { id: number }, code: number, signal: string | null) => void): void;
}
export interface WatchdogWorkerRef {
  readonly id: number;
  kill(signal?: string): void;
}

export interface ClusterLagWatchdogHandle {
  stop(): void;
  /** Test seam: ids currently being watched (registered, not yet exited). */
  watchedIds(): number[];
}

export interface ClusterLagWatchdogOptions {
  cluster: WatchdogClusterLike;
  /** Resolve a live worker reference by id (to SIGKILL it). The caller threads the
   *  forked-worker registry; a worker not (or no longer) present is skipped. */
  workerById: (id: number) => WatchdogWorkerRef | undefined;
  /** How often the primary scans for silent workers. Default 5s. */
  scanMs?: number;
  /** Silence that marks a worker wedged. Default 30s (≈15 missed 2s beats — well
   *  above any legit GC/IO pause, far below the multi-minute outage it recovers). */
  silenceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * PRIMARY side: watch worker heartbeats and SIGKILL a worker that has gone silent
 * past `silenceMs` (the existing `cluster.on('exit')` respawns it). Returns a handle
 * with `stop()` — wire it to the drain/shutdown path so the watchdog doesn't fight a
 * graceful drain. The scan timer is `unref()`-ed.
 */
export function startClusterLagWatchdog(opts: ClusterLagWatchdogOptions): ClusterLagWatchdogHandle {
  const scanMs = opts.scanMs ?? 5_000;
  const silenceMs = opts.silenceMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((m) => console.warn(m));
  /** worker id → last heartbeat timestamp (ms). A worker is watched only once seen. */
  const lastBeat = new Map<number, number>();
  let stopped = false;

  opts.cluster.on('message', (worker, message) => {
    if (stopped) return;
    if ((message as { type?: unknown } | null | undefined)?.type === CLUSTER_HEARTBEAT_TYPE) {
      lastBeat.set(worker.id, now());
    }
  });
  opts.cluster.on('exit', (worker) => {
    lastBeat.delete(worker.id); // stop tracking a dead worker; the respawn re-registers on its first beat
  });

  const scan = (): void => {
    if (stopped) return;
    const t = now();
    for (const [id, last] of lastBeat) {
      if (t - last <= silenceMs) continue;
      const worker = opts.workerById(id);
      // Drop the entry first so a slow exit doesn't re-trigger a kill next scan; if the
      // worker is already gone, the exit handler will (or did) clean up anyway.
      lastBeat.delete(id);
      if (!worker) continue;
      log(
        `[cluster-watchdog] worker ${id} silent ${Math.round((t - last) / 1000)}s (> ${Math.round(silenceMs / 1000)}s) — event loop wedged; SIGKILL to force respawn (EI-1598/1608)`,
      );
      try {
        worker.kill('SIGKILL');
      } catch {
        /* already exiting */
      }
    }
  };
  const timer = managedSetInterval('cluster-lag-scan', scanMs, scan, { category: 'watchdog' });

  return {
    stop() {
      stopped = true;
      timer.stop();
      lastBeat.clear();
    },
    watchedIds() {
      return [...lastBeat.keys()];
    },
  };
}
