/**
 * event-loop-sentinel-host.ts — main-thread half of the event-loop sentinel.
 *
 * Arms the heartbeat and spawns the watcher. The decision lives in the pure
 * `event-loop-sentinel.ts`; the watcher body in `event-loop-sentinel.worker.ts`.
 *
 * ## What this bounds, and why the memory watchdog cannot
 *
 * `papercup-staging-api.service` (:3170) blocked its event loop at
 * 2026-08-03 16:14:17Z and stayed wedged 30+ minutes, recovered only by a manual
 * restart. Every liveness signal stayed green throughout — port bound, pid
 * alive, `systemctl is-active` active, and TCP connects SUCCEEDING (the kernel
 * completes the handshake without the process). Its RSS at the sample before
 * the block was **2013 MiB against a 3200 MiB limit, and falling**, so
 * `memory-watchdog.ts` had nothing to act on and was right not to act.
 *
 * The two watchdogs are therefore complements, not alternatives:
 *
 * | failure | detector |
 * |---|---|
 * | heap grows without bound | `memory-watchdog.ts` (RSS high-water mark) |
 * | loop DEGRADED but still turning | `event-loop-lag-monitor.ts` (libuv histogram) |
 * | loop STOPPED turning, at any heap size | this |
 * | never alive since boot | `dev:service_health` accept-queue probe, out of process |
 *
 * The last row is deliberately NOT this file's job — see the `sawHeartbeat`
 * guard in the pure module for why a never-started host must not be killed
 * from in-process.
 *
 * ## Why `event-loop-lag-monitor.ts` does not already cover this
 *
 * It looks like it should: it owns a `monitorEventLoopDelay()` libuv histogram
 * and even captures a cpuprofile when p95 lag crosses its threshold. But it
 * READS that histogram from a `managedSetInterval` on the MAIN loop
 * (`event-loop-lag-monitor.ts:364`). The histogram keeps accumulating in C
 * while the loop is blocked; the reader that would report it never runs. So it
 * reports lag right up to the moment of a wedge and then goes silent — the
 * detector goes quiet exactly when the thing it watches dies.
 *
 * That is the same fate-sharing defect as the memory watchdog's sampler, and it
 * is why this sentinel had to be a separate off-thread module rather than an
 * option on the lag monitor. The two are complements: the lag monitor answers
 * "how degraded, and by what" while the loop still turns; this answers "has it
 * stopped" when it does not.
 *
 * ## Fail-soft is a hard requirement
 *
 * Every failure path here disables the sentinel and leaves the host running.
 * A watchdog that can take down the process it protects, on its own bugs, is
 * strictly worse than no watchdog — so a spawn failure, a bad config, or an
 * unsupported runtime degrades to "no sentinel", loudly, never to a crash.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { SENTINEL_SAB_INT32_LEN, type LoopSentinelThresholds } from './event-loop-sentinel';
import type { SentinelWorkerData } from './event-loop-sentinel.worker';

/**
 * Defaults.
 *
 * `wedgeAfterMs` is the load-bearing one: it must sit far above NORMAL loop lag
 * on this host or the sentinel becomes a random killer. Measured worst-case
 * event-loop lag here is ~3475 ms (round-3 cpuprofile captures, p95 501 ms), so
 * 20 s is ~6x the worst observed legitimate stall — and combined with
 * `observationsToAct: 3` at a 2 s cadence, a kill needs ~24 s of CONTINUOUS
 * block. That still bounds the observed 30-minute outage by ~75x.
 */
export const SENTINEL_DEFAULTS = {
  heartbeatIntervalMs: 1_000,
  observeIntervalMs: 2_000,
  wedgeAfterMs: 20_000,
  observationsToAct: 3,
  /** Boot legitimately runs long synchronous work (migrations, substrate). */
  startupGraceMs: 120_000,
} as const;

export type SentinelMode = 'kill' | 'observe' | 'off';

export interface SentinelConfig {
  mode: SentinelMode;
  thresholds: LoopSentinelThresholds;
  heartbeatIntervalMs: number;
  observeIntervalMs: number;
}

/**
 * Resolve config from the environment. Pure — takes the env, returns config, so
 * the defaults and the parsing are testable without spawning anything.
 *
 * `PAPERCUSP_EVENT_LOOP_SENTINEL`: `0`/`off`/`false` → off; `observe` → detect
 * and log but never kill; anything else (incl. unset) → armed. Armed-by-default
 * matches `memory-watchdog.ts`, which already self-recycles this same host: a
 * detector that ships disabled is one nobody ever turns on.
 *
 * `PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS`: override `wedgeAfterMs`. Ignored
 * unless finite and > 0, so a typo degrades to the safe default rather than to
 * a 0 ms threshold that kills instantly.
 */
export function resolveSentinelConfig(
  env: NodeJS.ProcessEnv = process.env,
): SentinelConfig {
  const raw = (env.PAPERCUSP_EVENT_LOOP_SENTINEL ?? '').trim().toLowerCase();
  const mode: SentinelMode =
    raw === '0' || raw === 'off' || raw === 'false'
      ? 'off'
      : raw === 'observe'
        ? 'observe'
        : 'kill';

  const wedgeOverride = Number(env.PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS);
  const wedgeAfterMs =
    Number.isFinite(wedgeOverride) && wedgeOverride > 0
      ? wedgeOverride
      : SENTINEL_DEFAULTS.wedgeAfterMs;

  return {
    mode,
    heartbeatIntervalMs: SENTINEL_DEFAULTS.heartbeatIntervalMs,
    observeIntervalMs: SENTINEL_DEFAULTS.observeIntervalMs,
    thresholds: {
      wedgeAfterMs,
      observationsToAct: SENTINEL_DEFAULTS.observationsToAct,
      startupGraceMs: SENTINEL_DEFAULTS.startupGraceMs,
    },
  };
}

export interface EventLoopSentinelHandle {
  /** Stop the heartbeat and terminate the watcher. */
  stop(): Promise<void>;
  /** Whether the watcher was started (false when off or spawn failed). */
  active(): boolean;
  /**
   * Whether the watcher thread is STILL ALIVE.
   *
   * Distinct from `active()` on purpose. `active()` says "we spawned one";
   * this says "it did not die on us". A worker that spawns and then exits
   * cleanly is indistinguishable from a healthy one unless you watch 'exit' —
   * measured 2026-08-04, when an `unref()` inside the worker let the thread
   * exit with code 0 straight after reporting ready. The host logged "armed",
   * `active()` returned true, and the sentinel detected nothing.
   */
  workerAlive(): boolean;
  /** Current heartbeat counter — diagnostics for /api/health. */
  beats(): number;
  /**
   * The sentinel's SharedArrayBuffer (layout: `SENTINEL_SAB_IDX`), or null when
   * the sentinel is off/failed to spawn. Callers wire this into
   * `setLagPublishTarget()` (event-loop-lag-monitor.ts) so the lag monitor's
   * last-known percentiles ride along the SAME memory the sentinel already
   * reads off-thread — a wedge's kill/warn log then carries the last observed
   * lag even though the reader that would normally report it never runs
   * during the block itself.
   */
  sab: SharedArrayBuffer | null;
}

const INACTIVE: EventLoopSentinelHandle = {
  stop: async () => {},
  active: () => false,
  workerAlive: () => false,
  beats: () => 0,
  sab: null,
};

/**
 * Resolve the worker body for the runtime we are actually in.
 *
 * Two runtimes, two artifacts, and getting this wrong makes the sentinel
 * silently absent rather than visibly broken:
 *
 * - **tsx** (`npx tsx bin/hono-host.ts` — dev, desktop sidecar, AND the bg-host):
 *   the `.ts` sits beside this module and loads directly.
 *
 *   ⚠ CORRECTED 2026-08-10. This bullet used to claim "measured: a Worker
 *   spawned from a tsx-run parent resolves repo `.ts` fine, under vitest too",
 *   and that claim is FALSE — it is what let the sentinel ship dead. A worker
 *   thread does NOT inherit the parent's registered ESM loader hooks, so the
 *   `.ts` entry is loaded by NODE'S NATIVE type stripping (Node 25), whose
 *   standard ESM resolution has no extensionless lookup. The entry itself
 *   loads; its extensionless RELATIVE IMPORT is what throws. Hence the fix is
 *   an explicit extension in `event-loop-sentinel.worker.ts`, not a loader —
 *   and this path now needs no loader at all, verified against a plain-`node`
 *   parent as well as a tsx one.
 *
 *   The second error in the old text: bg-host was listed as "bundled". It is
 *   not — it runs `npx tsx` from the working tree, which is precisely why it
 *   took the `.ts` fallback and why IT was the host left unguarded.
 * - **bundled** (`node dist-host/hono-host.mjs` — :3170 staging): plain node,
 *   NO tsx loader; `bundle-host.sh` esbuilds the worker to a sibling `.mjs`.
 *   `bundle-host.sh` esbuilds it to `event-loop-sentinel.worker.mjs` beside the
 *   entry, which is what `dirname(here)` resolves to inside a bundle.
 *
 * Prefer the `.mjs` and fall back to the `.ts`. This is the same sibling-asset
 * trap that silently disabled the embed worker (WI-4196) and the cpu-task
 * worker: esbuild emits only JS, never sibling assets, so anything resolved
 * relative to the executing module has to be placed there by the build.
 */
function workerPath(): string {
  const here =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const bundled = resolve(dir, 'event-loop-sentinel.worker.mjs');
  return existsSync(bundled) ? bundled : resolve(dir, 'event-loop-sentinel.worker.ts');
}

/**
 * Start the sentinel. Call once at host boot, AFTER the port is bound (so the
 * startup grace covers boot rather than the sentinel racing it).
 *
 * Returns an inactive handle — never throws — when disabled or when the worker
 * cannot spawn.
 */
export function startEventLoopSentinel(
  opts: {
    env?: NodeJS.ProcessEnv;
    log?: (line: string, detail: Record<string, unknown>) => void;
    /**
     * Override the worker artifact. Tests point this at an esbuilt `.mjs`,
     * because the `.ts` form is loadable only under tsx — a plain-node Worker
     * (which is what vitest's pool gives you) cannot resolve its extensionless
     * import and fails ASYNCHRONOUSLY, via the 'error' event, long after the
     * constructor has already returned successfully.
     */
    workerPath?: string;
    /**
     * Explicit test seam for the one focused test that exercises the REAL
     * heartbeat. Keep false by default so importing/booting a host under
     * Vitest cannot arm background intervals accidentally.
     */
    allowHeartbeatInTest?: boolean;
  } = {},
): EventLoopSentinelHandle {
  const env = opts.env ?? process.env;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  const cfg = resolveSentinelConfig(env);
  if (cfg.mode === 'off') {
    log('[event-loop-sentinel] disabled by PAPERCUSP_EVENT_LOOP_SENTINEL', {
      value: env.PAPERCUSP_EVENT_LOOP_SENTINEL,
    });
    return INACTIVE;
  }

  // Int32Array + Atomics: the ONLY channel that works here. A postMessage
  // round-trip would need the main loop to answer, which is precisely what a
  // wedge prevents — measured: the worker's reply queued until the block ended.
  // Sized for SENTINEL_SAB_IDX (heartbeat + last-known lag percentiles), not
  // just the heartbeat — see that layout's doc.
  const sab = new SharedArrayBuffer(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(sab);

  let worker: Worker;
  try {
    const data: SentinelWorkerData = {
      sab,
      thresholds: cfg.thresholds,
      observeIntervalMs: cfg.observeIntervalMs,
      mode: cfg.mode,
      pid: process.pid,
    };
    worker = new Worker(opts.workerPath ?? workerPath(), { workerData: data });
  } catch (err) {
    // Fail-soft: no sentinel is strictly better than a crashed host.
    log('[event-loop-sentinel] worker spawn FAILED — sentinel disabled, host unaffected', {
      error: String(err).slice(0, 300),
    });
    return INACTIVE;
  }

  let workerAlive = true;
  let stopping = false;

  worker.on('error', (err) => {
    workerAlive = false;
    log('[event-loop-sentinel] worker error — sentinel disabled, host unaffected', {
      error: String(err).slice(0, 300),
    });
  });

  // A watcher that dies silently is worse than none, because the "armed" line
  // above already told the operator it was watching. Report it loudly — an exit
  // that is NOT part of stop() means the host is now unguarded.
  worker.on('exit', (code) => {
    workerAlive = false;
    if (stopping) return;
    log(
      '[event-loop-sentinel] worker EXITED on its own — the host is NO LONGER guarded against a blocked event loop',
      { code },
    );
  });

  // Parent-side unref: the worker must not keep the process alive. This is the
  // ONLY correct place for it — an unref inside the worker kills the watcher
  // thread instead (see the comment in event-loop-sentinel.worker.ts).
  worker.unref();

  // The heartbeat. `managedSetInterval` (never a bare setInterval) so it is
  // visible in schedule:inventory alongside the memory watchdog. When the loop
  // blocks this callback stops firing — which IS the signal.
  const heartbeat = managedSetInterval(
    'event-loop-sentinel-heartbeat',
    cfg.heartbeatIntervalMs,
    () => {
      Atomics.add(view, 0, 1);
    },
    // D-004: 'must-sample'. Nothing PUBLISHES "the event loop is still turning" —
    // liveness here is only observable by emitting a beat and watching it stop,
    // the same shape as D-004's PID-liveness example. A subscription cannot
    // express it: a blocked loop would also fail to deliver the event.
    {
      category: 'watchdog',
      classification: 'must-sample',
      allowInTest: opts.allowHeartbeatInTest ?? false,
    },
  );

  log('[event-loop-sentinel] armed', {
    mode: cfg.mode,
    wedgeAfterMs: cfg.thresholds.wedgeAfterMs,
    observationsToAct: cfg.thresholds.observationsToAct,
    startupGraceMs: cfg.thresholds.startupGraceMs,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    observeIntervalMs: cfg.observeIntervalMs,
  });

  return {
    async stop() {
      stopping = true;
      heartbeat.stop();
      try {
        await worker.terminate();
      } catch {
        /* noop */
      }
    },
    active: () => true,
    workerAlive: () => workerAlive,
    beats: () => Atomics.load(view, 0),
    sab,
  };
}
