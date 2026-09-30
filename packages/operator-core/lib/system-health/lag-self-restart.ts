/**
 * lag-self-restart — bounded self-heal when a worker's event loop saturates
 * (infra-self-healing-supervision-2026-06-19, R4-4; EI-1598).
 *
 * `event-loop-lag-monitor.ts` already samples the loop and exposes `loopPressure()`
 * ('ok' | 'elevated' | 'critical') plus the CPU-profile sampler (round-3 F1, which
 * identifies the CULPRIT). This module bounds the BLAST RADIUS: when a worker's loop
 * stays 'critical' for `sustainChecks` consecutive samples — the wedged-worker class
 * users hit on 2026-06-19 (a worker pegged 233% CPU for 33 min while /api/health
 * died, requiring a manual recycle) — the worker exits NON-ZERO so cluster-fork /
 * systemd `Restart` respawns a fresh one. The other reusePort workers keep serving
 * through the recycle. A self-restart is the RELIEF; the durable culprit fix is
 * round-3 F1's offload.
 *
 * DELIBERATELY DEFAULT-OFF (arm with PAPERCUSP_LAG_SELF_RESTART=1): a self-restart is
 * a real, disruptive action, so it is opt-in until validated under load. A long
 * sustain window + a minimum-uptime guard ensure a slow boot or a one-off GC pause
 * never recycles a worker. Consumes the monitor's read-only export — it does NOT
 * edit the monitor (round-3 F1's file).
 */
import { loopPressure as defaultLoopPressure } from '../event-loop-lag-monitor';
import { managedSetInterval } from '@papercusp/scheduled-registry';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_SUSTAIN_CHECKS = 8; // ~2 min of unbroken 'critical' at 15s cadence
const DEFAULT_MIN_UPTIME_MS = 120_000;
const DEFAULT_EXIT_CODE = 75; // EX_TEMPFAIL — restart under Restart=on-failure & =always

/**
 * PURE: the self-restart decision. Recycle only once the loop has been critical
 * for the full sustain window AND the worker is past its minimum uptime (so a slow
 * boot or a transient GC pause can never trip it).
 */
export function shouldSelfRestart(args: {
  consecutiveCritical: number;
  sustainChecks: number;
  uptimeMs: number;
  minUptimeMs: number;
}): boolean {
  return args.uptimeMs >= args.minUptimeMs && args.consecutiveCritical >= args.sustainChecks;
}

export interface LagSelfRestartOpts {
  intervalMs?: number;
  sustainChecks?: number;
  /**
   * P-003 (mcp-reliability-hardening-2026-07-11): per-process random EXTRA sustain
   * checks in [0, jitterChecks], drawn once at start. On a multi-worker reusePort
   * cluster the pressure signal is highly correlated across workers (they share the
   * box), so identical thresholds recycle MANY workers near-simultaneously —
   * observed 2026-07-10 22:43–22:47: 7 recycles in ~4 min, each severing its
   * in-flight requests. Jitter desynchronizes the herd. Default 0 (off) so the
   * pure API is unchanged; the hono-host call site arms it.
   */
  jitterChecks?: number;
  /** Seam for the jitter draw — defaults to Math.random. */
  rand?: () => number;
  minUptimeMs?: number;
  exitCode?: number;
  /** Seam — defaults to the monitor's loopPressure(). */
  pressure?: () => 'ok' | 'elevated' | 'critical';
  /** Seam — defaults to process.exit. */
  exit?: (code: number) => void;
  /** Seam — defaults to Date.now. */
  now?: () => number;
  /** Seam — boot timestamp; defaults to now() at start. */
  bootAt?: number;
  log?: (line: string, detail: Record<string, unknown>) => void;
}

export interface LagSelfRestartHandle {
  stop(): void;
  /** Current consecutive-critical count (for an endpoint/test). */
  consecutiveCritical(): number;
}

/**
 * Start the lag self-restart watcher on a request-worker loop. DEFAULT-OFF unless
 * PAPERCUSP_LAG_SELF_RESTART=1. The timer is `unref`'d so it never keeps the process
 * alive. Returns a handle whose `stop()` clears the timer.
 */
export function startLagSelfRestart(opts: LagSelfRestartOpts = {}): LagSelfRestartHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const jitterChecks = Math.max(0, Math.floor(opts.jitterChecks ?? 0));
  const rand = opts.rand ?? Math.random;
  // P-003: the effective sustain window = base + a per-process jitter draw, so
  // co-saturated reusePort siblings don't all recycle in the same beat.
  const sustainChecks =
    Math.max(1, opts.sustainChecks ?? DEFAULT_SUSTAIN_CHECKS) +
    (jitterChecks > 0 ? Math.floor(rand() * (jitterChecks + 1)) : 0);
  const minUptimeMs = opts.minUptimeMs ?? DEFAULT_MIN_UPTIME_MS;
  const exitCode = opts.exitCode ?? DEFAULT_EXIT_CODE;
  const pressure = opts.pressure ?? defaultLoopPressure;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? Date.now;
  const bootAt = opts.bootAt ?? now();
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  // Armed only by explicit opt-in — a self-restart is disruptive (it's the relief
  // valve, not a default). Off → an inert no-op handle.
  if (process.env.PAPERCUSP_LAG_SELF_RESTART !== '1') {
    return { stop() {}, consecutiveCritical: () => 0 };
  }

  let consecutiveCritical = 0;
  let restarted = false;

  const timer = managedSetInterval('lag-self-restart', intervalMs, () => {
    if (restarted) return;
    const p = pressure();
    if (p === 'critical') consecutiveCritical += 1;
    else consecutiveCritical = 0;

    if (
      shouldSelfRestart({
        consecutiveCritical,
        sustainChecks,
        uptimeMs: now() - bootAt,
        minUptimeMs,
      })
    ) {
      restarted = true;
      log(
        '[lag-self-restart] event loop critical for the full sustain window — recycling this worker (systemd/cluster will respawn)',
        { consecutiveCritical, sustainChecks, intervalMs, exitCode },
      );
      // A short flush delay, then exit NON-ZERO so the worker is respawned. The
      // other reusePort workers keep serving through the gap.
      setTimeout(() => exit(exitCode), 250).unref?.();
    }
  }, { category: 'watchdog' });

  return {
    stop() {
      timer.stop();
    },
    consecutiveCritical: () => consecutiveCritical,
  };
}
