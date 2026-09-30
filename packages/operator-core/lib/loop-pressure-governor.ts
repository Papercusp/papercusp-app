/**
 * loop-pressure-governor.ts — P5-2 (operator-scalability-event-loop-2026-06-16).
 *
 * Closed-loop concurrency feedback. The fleet's effective agent concurrency
 * already self-throttles on provider 429s via the AIMD governor (rate-limit-layer
 * D-005). But a 429 is a REMOTE signal — it says nothing about whether THIS box's
 * single event loop is melting under the work it already admitted. That local
 * saturation is exactly what crash-looped :3070 (p99 loop delay ~103s; see the
 * operator-crash-loop insight): the loop was wedged while the fleet kept admitting
 * more agents into it.
 *
 * P5-1 added the signal — {@link loopPressure} (a band off the event-loop-lag
 * histogram). This governor closes the loop on it: a light timer reads
 * loopPressure() and, on a transition INTO `critical` saturation, applies ONE AIMD
 * multiplicative-decrease (halve effective concurrency toward the floor) so the
 * fleet sheds the load the box can't carry; on recovery to `ok` it records a clean
 * step and the existing AIMD ramp (+1 per N) walks concurrency back up. Debounced
 * by transition so a sustained-critical loop is penalized once per episode, not
 * once per tick.
 *
 * Bounded + self-recovering by construction: it only narrows effective concurrency
 * UNDER the user's `maxSimultaneousAgents` cap, never below the floor, and ramps
 * back automatically — so a false `critical` (a one-off long GC) costs at most a
 * temporary, self-correcting dip. Inactive while no finite cap is installed (AIMD
 * off). Always-on infra like the lag monitor + the P5-1 load-shedding it pairs with.
 *
 * WI-41147 leg b — the POOL-BURN lever. A second, slower feedback input on the SAME
 * AIMD seam: when the account pool's AGGREGATE burn verdict says every route is
 * burning (`throttle`) or walled (`shed`) — see `aggregatePoolBurn` — selection can
 * no longer spread the load away, so the only remaining lever is fewer concurrent
 * agents. Debounced per episode exactly like the pressure lever (an escalation
 * penalizes once; recovery to `none` records one clean step), flag-gated by
 * ACCOUNT_BURN_GOVERNOR in the default reader, and NEVER acts on missing data (a
 * failed pool read keeps the last verdict rather than faking a recovery).
 */
import { loopPressure, type LoopPressure } from './event-loop-lag-monitor';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { BurnAction, BurnDisposition } from './inference-gateway/burn-governor';
import {
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
} from '@papercusp/papercusp-shared/agent';

/** One pool-burn observation for the lever: the aggregate action, what it RESTS ON, and its WHY. */
export interface PoolBurnRead {
  action: BurnAction;
  /**
   * What `action` rests on — a measured provider wall vs this system pacing itself off a
   * projection. Carried beside the action rather than left to the reason prose (P-005): this
   * lever's log line is the fleet's first sight of a pool burn, and `pool burn 'shed'` with the
   * disposition dropped is indistinguishable from "the provider walled us".
   */
  disposition: BurnDisposition;
  /** The one canonical rendering of this verdict — `renderPoolBurnLabel`. Leads with disposition. */
  label: string;
  reason: string;
}

export interface LoopPressureGovernorOpts {
  /** Evaluation cadence (ms). Default 15_000 — fast enough to react within seconds
   *  of sustained saturation, slow enough to be free. */
  intervalMs?: number;
  /** Pool-burn evaluation cadence (ms). Default 60_000 — burn state only moves on
   *  probe/traffic cadence (minutes), and each evaluation reads the persisted pool. */
  burnIntervalMs?: number;
  /** Pressure source. Defaults to the live {@link loopPressure}; injected in tests. */
  readPressure?: () => LoopPressure;
  /** Pool-aggregate burn source (WI-41147 leg b). Defaults to the flag-gated live
   *  account-pool aggregate ({@link defaultReadPoolBurn}); injected in tests. */
  readPoolBurn?: () => Promise<PoolBurnRead>;
  /** AIMD multiplicative-decrease. Defaults to the global governor seam; injected in tests. */
  onPenalty?: () => void;
  /** AIMD clean-step. Defaults to the global governor seam; injected in tests. */
  onClean?: () => void;
  /** Structured log sink. Default console.warn. */
  log?: (line: string) => void;
}

export interface LoopPressureGovernorHandle {
  /** Stop the timers (unref'd already, so they never hold the process open). */
  stop(): void;
  /** Run one PRESSURE evaluation step now — drives the pressure timer; exported for tests. */
  tick(): void;
  /** Run one POOL-BURN evaluation now (in-flight-guarded — a pending read is never
   *  doubled) — drives the burn timer; exported for tests. */
  tickBurn(): Promise<void>;
}

/**
 * Default pool-burn read: the flag-gated aggregate over the live account pool. Lazily imports
 * the pool/flags surfaces so this always-on watchdog module stays light for callers that never
 * use the default (tests inject; boot pays the import once). A flag-read failure fails soft to
 * ON (matching the selection wiring in account-pool-store); any other failure PROPAGATES so the
 * caller keeps its last verdict instead of mistaking a broken read for a recovery.
 */
async function defaultReadPoolBurn(): Promise<PoolBurnRead> {
  const [{ FLAGS }, { getFlag }] = await Promise.all([
    import('@papercusp/flags'),
    import('@papercusp/flags/server'),
  ]);
  const on = await getFlag(FLAGS.ACCOUNT_BURN_GOVERNOR, 'system').catch(() => true);
  if (!on) {
    return {
      action: 'none',
      disposition: 'no-verdict',
      label: 'NONE (no wall asserted)',
      reason: 'ACCOUNT_BURN_GOVERNOR is off — burn lever stands down',
    };
  }
  const [{ loadAccountPool }, { accountBurnVerdict }, { aggregatePoolBurn }] = await Promise.all([
    import('./deployment/account-pool-store'),
    import('./deployment/account-pool'),
    import('./inference-gateway/burn-governor'),
  ]);
  const pool = await loadAccountPool();
  const now = Date.now();
  // The full stale-gated VERDICT per account, not `accountBurnAction`'s bare action: the
  // disposition has to survive the rollup, and a projection dropped here cannot be recovered
  // downstream (P-005).
  const agg = aggregatePoolBurn(
    pool.accounts.map((a) => {
      const v = accountBurnVerdict(a.rate, now);
      return { action: v.action, disposition: v.disposition };
    }),
  );
  return { action: agg.action, disposition: agg.disposition, label: agg.label, reason: agg.reason };
}

// One per process. A second start() returns the existing handle (idempotent boot).
let active: LoopPressureGovernorHandle | undefined;

export function startLoopPressureGovernor(opts: LoopPressureGovernorOpts = {}): LoopPressureGovernorHandle {
  if (active) return active;
  const intervalMs = opts.intervalMs ?? 15_000;
  const burnIntervalMs = opts.burnIntervalMs ?? 60_000;
  const readPressure = opts.readPressure ?? loopPressure;
  const readPoolBurn = opts.readPoolBurn ?? defaultReadPoolBurn;
  const onPenalty = opts.onPenalty ?? recordGlobalConcurrencyPenalty;
  const onClean = opts.onClean ?? recordGlobalConcurrencyClean;
  const log = opts.log ?? ((m) => console.warn(m));
  let last: LoopPressure = 'ok';
  let lastBurn: BurnAction = 'none';
  // The rendered form of `lastBurn`, kept in step with it so the read-failure line can restate
  // the verdict it is HOLDING with its disposition intact — `'shed'` alone would tell a reader
  // the provider walled us when the held verdict may be a pacing projection (P-005).
  let lastLabel = 'NONE (no wall asserted)';
  let burnInFlight = false;

  const tick = (): void => {
    const p = readPressure();
    if (p === 'critical' && last !== 'critical') {
      // Transition INTO critical → shed once. Debounced: a loop that STAYS critical
      // isn't halved every tick (that would crater eff to the floor in a few ticks).
      onPenalty();
      log('[loop-governor] event loop critically saturated — shedding effective agent concurrency (P5-2)');
    } else if (p === 'ok' && last !== 'ok') {
      // Fully recovered → start ramping eff back (the AIMD +1-per-N walk continues it).
      onClean();
      log('[loop-governor] event loop recovered — ramping effective agent concurrency back up (P5-2)');
    }
    last = p;
  };

  const BURN_SEVERITY: Record<BurnAction, number> = { none: 0, throttle: 1, shed: 2 };

  const tickBurn = async (): Promise<void> => {
    if (burnInFlight) return; // a pending pool read is never doubled
    burnInFlight = true;
    try {
      const { action, label, reason } = await readPoolBurn();
      if (action !== lastBurn) {
        if (BURN_SEVERITY[action] > BURN_SEVERITY[lastBurn]) {
          // Escalation (none→throttle, none→shed, throttle→shed) — each is a new, worse
          // episode: shed once. Debounced: a pool that STAYS throttled isn't re-penalized.
          onPenalty();
          // `label` and never a bare `'${action}'`: this line is where an operator or agent first
          // sees a pool burn, and the disposition is the half that says whether the provider
          // walled us or we are pacing ourselves (P-005).
          lastLabel = label;
          log(`[loop-governor] pool burn ${label} — shedding effective agent concurrency (WI-41147): ${reason}`);
        } else if (action === 'none') {
          // Fully recovered → one clean step (the AIMD +1-per-N walk continues it).
          onClean();
          lastLabel = label;
          log(`[loop-governor] pool burn recovered — ramping effective agent concurrency back up (WI-41147): ${reason}`);
        } else {
          lastLabel = label;
        }
        // shed → throttle: still a degraded episode — no penalty, no clean; recovery fires at 'none'.
        lastBurn = action;
      }
    } catch (e) {
      // A failed read is NOT a verdict: keep the last state — mapping failure to 'none'
      // here would fire a fake recovery clean mid-episode (never act on missing data).
      log(`[loop-governor] pool burn read failed — keeping last verdict ${lastLabel}: ${String(e)}`);
    } finally {
      burnInFlight = false;
    }
  };

  const timer = managedSetInterval('loop-pressure-governor', intervalMs, tick, { category: 'watchdog' });
  const burnTimer = managedSetInterval(
    'loop-pressure-governor-burn',
    burnIntervalMs,
    () => void tickBurn(),
    { category: 'watchdog' },
  );

  const handle: LoopPressureGovernorHandle = {
    stop() {
      timer.stop();
      burnTimer.stop();
      if (active === handle) active = undefined;
    },
    tick,
    tickBurn,
  };
  active = handle;
  return handle;
}

/** Stop the running governor (test/lifecycle hook). */
export function stopLoopPressureGovernor(): void {
  active?.stop();
}
