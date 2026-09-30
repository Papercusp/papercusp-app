/**
 * cold-join-canary — the D-007 recurrence guard for the SEEDED-install path
 * (plan hive-seed-bundle-2026-07-04 P-008).
 *
 * With the seed shipping (P-006/P-007), a normal first boot RESTORES the bundled
 * seed and the live join only carries the DELTA — so the full COLD join (no seed,
 * whole-history transfer) stops being exercised on every install and can silently
 * bit-rot. This canary periodically forces a REAL cold join (restore disabled, via
 * the `--no-seed` hatch) so the cold path keeps getting proven end-to-end; a
 * failure is surfaced (debounced) to the operator via the shared watchdog ledger.
 *
 * Structure mirrors release-deploy-staleness-watchdog.ts: a pure kill-switch/window
 * helper (unit-tested, no DB) + a FAIL-SOFT sweep wired into the shared
 * routinesTick, with an injected executor + injected ledger seams so the whole
 * decision path is testable with no DB and no real join.
 *
 * DEFAULT DISABLED (interval <= 0). A full cold join is HEAVY (multi-GB clone +
 * federation) — it must NOT run on every shared operator host. A designated
 * canary / release environment opts in via PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC.
 * The heavy cold-join EXECUTOR itself is injected (its live wiring to a packaged /
 * rig environment lands with the E2E work, P-010); this module owns the schedule,
 * the debounce clock, the pass/fail recording, and the alerting shell.
 */

import { recordFire, recentWatchdogFires } from '../../pot/watchdog';

/** Interval between forced cold joins. `<= 0` DISABLES the canary (the default —
 *  a cold join is too heavy to run on an ordinary host). A canary/release env sets
 *  it (e.g. 86400 = daily). Env: PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC. */
export function coldJoinCanaryIntervalSec(): number {
  const n = Number(process.env.PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The debounce window (hours) derived from the interval — the fire ledger doubles
 *  as the "already ran this interval" clock. Always >= 1h so a sub-hour interval
 *  still debounces to at least one tick-window. */
export function coldJoinCanaryWindowHours(intervalSec: number): number {
  return Math.max(1, Math.round(intervalSec / 3600));
}

/** What the injected cold-join executor reports. */
export interface ColdJoinProbeResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/** The heavy executor: run a REAL cold join (seed disabled) + assert it reaches a
 *  usable hive. Injected — its live implementation (a packaged / rig cold boot)
 *  lands with P-010; the canary owns everything AROUND it. */
export type ColdJoinExecutor = () => Promise<ColdJoinProbeResult>;

export interface ColdJoinCanarySweepResult {
  /** 'ran' = canary executed + the cold join PASSED; 'failed' = executed + the cold
   *  join reported not-ok (alerted); 'error' = the executor threw (alerted);
   *  'skipped' = disabled / debounced / no executor wired. */
  readonly outcome: 'ran' | 'failed' | 'error' | 'skipped';
  readonly passed?: boolean;
  readonly reason: string;
}

export interface ColdJoinCanarySweepOpts {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
  /** Override the interval (tests / a per-env config). Default: the env resolver. */
  intervalSec?: number;
  /** The heavy cold-join executor. Absent ⇒ the canary is enabled-but-unwired (a
   *  loud skip, never a fake pass). */
  coldJoin?: ColdJoinExecutor;
  /** Ledger seams (default: the shared hive_watchdog_fires ledger). */
  recentFires?: (workspaceId: string, installSlug: string, windowHours: number) => Promise<number>;
  record?: (opts: { workspaceId: string; installSlug: string; reason: string }) => Promise<void>;
  log?: (msg: string) => void;
}

const SOURCE = 'cold-join-canary' as const;

/**
 * The cold-join canary sweep. Fail-soft (never throws — a guard that crashes its
 * host guards nothing) and default-safe (disabled ⇒ a complete no-op). When enabled
 * AND not fired within the interval window, it runs the injected cold-join executor,
 * records the outcome (which also opens the debounce window so it runs once per
 * interval), and alerts on a failure/crash.
 */
export async function runColdJoinCanarySweep(opts: ColdJoinCanarySweepOpts = {}): Promise<ColdJoinCanarySweepResult> {
  const log = opts.log ?? (() => {});
  const intervalSec = opts.intervalSec ?? coldJoinCanaryIntervalSec();
  if (intervalSec <= 0) return { outcome: 'skipped', reason: 'disabled (interval <= 0)' };

  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const windowHours = coldJoinCanaryWindowHours(intervalSec);
  const recentFires = opts.recentFires ?? ((ws, slug, h) => recentWatchdogFires(ws, slug, h, SOURCE));
  const record =
    opts.record ??
    ((o: { workspaceId: string; installSlug: string; reason: string }) =>
      recordFire({ ...o, source: SOURCE, wakeAt: null }));

  // Debounce = "already ran this interval". A fire recorded on every completed run
  // (below) is the clock, so a fresh window means it's due.
  let firedRecently = 0;
  try {
    firedRecently = await recentFires(workspaceId, installSlug, windowHours);
  } catch {
    // A ledger read failure must not wedge the canary — treat as "unknown, skip
    // this tick" rather than hammering a heavy cold join on every 30s tick.
    return { outcome: 'skipped', reason: 'ledger read failed — skipping this tick' };
  }
  if (firedRecently > 0) return { outcome: 'skipped', reason: `debounced (ran within ${windowHours}h)` };

  if (!opts.coldJoin) {
    // Enabled + due but nothing to run: a misconfiguration worth surfacing, never a
    // fake pass. Do NOT record a fire — re-evaluate next tick once wired.
    log('[cold-join-canary] enabled but no cold-join executor wired (P-010) — skipping');
    return { outcome: 'skipped', reason: 'no cold-join executor wired' };
  }

  try {
    const result = await opts.coldJoin();
    // Record the run (pass OR fail) — this both audits it and opens the interval
    // debounce window so it runs once per interval, not every tick.
    await record({
      workspaceId,
      installSlug,
      reason: result.ok
        ? `cold-join canary PASSED${result.detail ? ` — ${result.detail}` : ''}`
        : `cold-join canary FAILED${result.detail ? ` — ${result.detail}` : ''}`,
    });
    if (!result.ok) {
      const reason = `cold-join canary FAILED${result.detail ? ` — ${result.detail}` : ''}`;
      log(`[cold-join-canary] ALERT: ${reason}`);
      return { outcome: 'failed', passed: false, reason };
    }
    return { outcome: 'ran', passed: true, reason: `cold-join canary passed${result.detail ? ` — ${result.detail}` : ''}` };
  } catch (e) {
    const reason = `cold-join canary EXECUTOR THREW: ${e instanceof Error ? e.message : String(e)}`;
    // Record so a persistently-crashing canary debounces instead of running every tick.
    await record({ workspaceId, installSlug, reason }).catch(() => {});
    log(`[cold-join-canary] ALERT: ${reason}`);
    return { outcome: 'error', reason };
  }
}
