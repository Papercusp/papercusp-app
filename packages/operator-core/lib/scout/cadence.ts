/**
 * cadence.ts — Scout P-008: the autonomous cadence GATE (hive-creative-ideation
 * D-010, "prompt-free, brain-in-loop"; resolves b6c3f's invariants-contract Risk
 * A — `routines.trigger_kind` is only cron|webhook|api, so a bare cron is NOT the
 * plan's cadence).
 *
 * The plan's cadence is "idle-capacity + friction-triggered": the Scout loop
 * should fire when the Hive has spare capacity to explore, OR when accumulated
 * friction signals the colony is stuck and a creative leap is wanted — never on a
 * blind clock. This module is that decision as a PURE gate: a cron routine ticks
 * it, but the {@link runScoutTick} action only actually runs a cycle when this
 * gate says so. Pure ⇒ P-014 can assert fire/no-fire over fabricated state with
 * no real clock or fleet (the verifiability Risk A demanded).
 *
 * Priority (so "friction-triggered" stays responsive without thrash):
 *   1. a short friction floor → friction fires fast when the colony is stuck;
 *   2. the normal min-interval floor guards idle/heartbeat fires;
 *   3. idle-capacity fires when the fleet has spare room;
 *   4. a heartbeat ceiling fires eventually so the loop never fully stalls.
 */

export type ScoutCadenceReason =
  /** A pending steward/reviewer revision request — fires the cycle
   *  OUT-OF-CADENCE, ahead of everything else and past the min-interval floor,
   *  so feedback on a routed draft is
   *  iterated immediately and PREEMPTS a fresh-ideation cycle (D-003 #4). The
   *  runaway bound is the per-cycle Scout budget + the autoloop fire-gate, NOT
   *  the cadence floor (D-002). Set from the scheduler's cycle-start coord:inbox
   *  read via {@link ScoutCadenceState.revisionRequestPending}. */
  | 'revision-request'
  /** Accumulated friction crossed the threshold — the colony is stuck, leap now. */
  | 'friction-triggered'
  /** Scout's prior routed ideas are ALL resolved (none pending) — the idea
   *  pipeline has drained, so generate fresh ideas now (owner-set 2026-06-18). */
  | 'ideas-drained'
  /** The fleet has spare capacity to explore. */
  | 'idle-capacity'
  /** VOLUME MODE (WI-4318): the accumulated new-signal score crossed the firing
   *  threshold — enough fresh corpus exists to be worth a cycle. */
  | 'signal-volume'
  /** Nothing triggered, but the max-interval ceiling elapsed — don't stall. */
  | 'heartbeat'
  /** Withheld: the min-interval floor since the last cycle hasn't elapsed. */
  | 'min-interval'
  /** Withheld (VOLUME MODE): ZERO new signal since the last cycle — a fresh
   *  cycle would re-digest a byte-identical corpus into dedup declines (the
   *  stale-repetition churn volume firing exists to kill). Only an explicit
   *  revision request bypasses this (explicit external signal). */
  | 'no-signal'
  /** Withheld: no trigger met and the heartbeat ceiling hasn't elapsed. */
  | 'no-trigger';

/** The live signals the gate reads (supplied by the scheduler from fleet + watchdog). */
export interface ScoutCadenceState {
  /** Fleet idle ratio in [0,1]: 1 = fully idle, 0 = saturated. */
  idleRatio: number;
  /** Count of recent unaddressed friction signals (watchdog + friction-markers). */
  frictionSignals: number;
  /**
   * When the last Scout cycle actually RAN (epoch ms), or null if never. This is
   * the cadence clock the min-interval / heartbeat floors are measured from, and
   * (EI-1600) it MUST reflect the last successful cycle-RUN (scout_ticks
   * status='ran'/'fired'), NOT the autoloop `last_fired_at` fire-ATTEMPT clock — a
   * hung/errored fire that advanced the attempt clock without running a cycle must
   * not reset this floor (else Scout goes dark, gating every tick as min-interval).
   */
  lastRunAtMs: number | null;
  /**
   * The autoloop fire-slot clock (epoch ms) — `autoloop_state.last_fired_at` — used
   * ONLY by the scheduler's single-flight `claimFire` CAS, NOT by the cadence gate
   * (the pure {@link shouldRunScoutCycle} ignores it). It is DELIBERATELY decoupled
   * from {@link lastRunAtMs} (EI-1600): the cadence floor measures the last RUN,
   * while the claim must CAS against the fire-slot value it read. Omit (the
   * pure-gate default) ⇒ the scheduler falls back to {@link lastRunAtMs} for the
   * claim (the legacy single-source behaviour the unit-test fakes rely on).
   */
  fireSlotLastMs?: number | null;
  /** Now (epoch ms). */
  nowMs: number;
  /**
   * Total Scout-routed ideas ever recorded for this scope (cached outcome ledger),
   * and how many are still pending (unresolved). When `routedIdeaTotal > 0` AND
   * `pendingIdeaCount === 0` the idea pipeline has DRAINED — every prior idea is
   * resolved (won or lost) — so the gate fires `ideas-drained` to generate more
   * (owner-set 2026-06-18). Both optional: omit (the pure-gate default) to disable
   * the drain trigger entirely — the scheduler supplies them from the ledger.
   */
  routedIdeaTotal?: number;
  pendingIdeaCount?: number;
  /**
   * A steward/reviewer revision request is waiting for this Scout (the scheduler read one at
   * cycle-start from coord:inbox addressed to `scout:<hive>` — P-001). When true the
   * gate fires `revision-request` immediately, ahead of every other trigger AND past
   * the min-interval floor (out-of-cadence), so a routed-draft revision iterates
   * now and preempts fresh ideation (queen-scout-feedback-loop D-001/D-003 #4).
   * Optional (pure-gate default false) — omit when there is no feedback channel.
   */
  revisionRequestPending?: boolean;
  /**
   * The autoloop fire-clock (`autoloop_state.last_fired_at`, epoch ms) the
   * scheduler's single-flight CAS claims against (EI-304). DECOUPLED from
   * {@link lastRunAtMs} (EI-1600): the cadence floor measures from the last cycle
   * that actually RAN, while the single-flight claim must CAS against the autoloop
   * clock `recordFire` stamps on every fire outcome. The gate never reads this —
   * only the scheduler's `claimFire`. Optional: when omitted (the pure-gate /
   * unit-test default) the claim falls back to {@link lastRunAtMs}, byte-identical
   * to the pre-decouple behaviour.
   */
  lastFireClaimAtMs?: number | null;
  /**
   * VOLUME MODE (blender-self-learning-2026-07-12 P-002 / WI-4318): the
   * weighted new-signal score since the last successful cycle, computed by
   * {@link weightedSignalScore} over the signal-accumulator's per-lane counts
   * (scout/signal-accumulator.ts). Supplying a finite number switches the gate
   * to volume-based firing: score ≥ {@link ScoutCadenceOptions.signalScoreThreshold}
   * fires `signal-volume`; score ≤ 0 withholds EVERYTHING except an explicit
   * revision request (`no-signal` — a stale corpus never fires); the normal
   * floor drops to {@link ScoutCadenceOptions.minVolumeIntervalSec} (burst
   * coalescing). Omit (the pure-gate default, the SCOUT_VOLUME_CADENCE kill
   * switch, and the not-yet-populated accumulator fallback) ⇒ the legacy
   * time-based behavior, byte-identical.
   */
  signalScore?: number;
}

export interface ScoutCadenceOptions {
  /** Floor between cycles for idle/heartbeat fires. Default 3600s (1h). */
  minIntervalSec?: number;
  /** Shorter floor for friction-triggered fires (so friction is responsive). Default min(minInterval, 900s). */
  minFrictionIntervalSec?: number;
  /** Heartbeat ceiling — fire at least this often regardless of triggers (the
   *  "configurable cadence" knob; owner-set 2026-06-18). Default 3600s (1h) so
   *  Scout runs on a steady hourly clock even while the hive is busy/healthy (it
   *  used to be a 24h backstop, which left Scout effectively dark on a never-idle
   *  hive). Override per-routine via the cadence payload; 0 disables. */
  maxIntervalSec?: number;
  /** idleRatio at/above which idle-capacity fires. Default 0.5. */
  idleThreshold?: number;
  /** frictionSignals at/above which friction fires (within the friction floor). Default 3. */
  frictionThreshold?: number;
  /** VOLUME MODE: weighted new-signal score at/above which `signal-volume`
   *  fires. Default 25 (≈ a dozen observations, or a few reverts + captures —
   *  see DEFAULT_LANE_WEIGHTS in signal-accumulator.ts). Tunable per routine
   *  via the cadence payload. */
  signalScoreThreshold?: number;
  /** VOLUME MODE: the normal floor between cycles (replaces minIntervalSec for
   *  non-friction triggers) — bursts coalesce instead of firing per-signal.
   *  Default 900s (15min). */
  minVolumeIntervalSec?: number;
}

export interface ScoutCadenceVerdict {
  fire: boolean;
  reason: ScoutCadenceReason;
  /** Seconds until the next possible fire, when withheld by a floor. */
  retryAfterSec?: number;
}

const DEFAULTS = {
  minIntervalSec: 3600,
  // Owner-set 2026-06-18: an HOURLY heartbeat (was 86400 = 24h). With minInterval
  // also 3600, Scout fires ~once an hour even on a never-idle hive (friction can
  // still fire it sooner, down to the 15-min friction floor). Configurable per
  // routine via the cadence payload.
  maxIntervalSec: 3600,
  idleThreshold: 0.5,
  frictionThreshold: 3,
  // VOLUME MODE (WI-4318, owner-approved 2026-07-12): fire when the weighted
  // new-signal score crosses this; coalesce bursts at a 15-min floor.
  signalScoreThreshold: 25,
  minVolumeIntervalSec: 900,
} as const;

/** The pure-gate defaults, exported for surfaces that must render the SAME
 *  numbers the gate judges by (the Learning tab's cadence card) — never a
 *  UI-side copy that can drift. */
export const SCOUT_CADENCE_DEFAULTS = DEFAULTS;

/**
 * Decide whether to run a Scout cycle now. Pure over {@link ScoutCadenceState}.
 */
export function shouldRunScoutCycle(
  state: ScoutCadenceState,
  opts: ScoutCadenceOptions = {},
): ScoutCadenceVerdict {
  const minInterval = nonNeg(opts.minIntervalSec, DEFAULTS.minIntervalSec);
  const minFrictionInterval = nonNeg(opts.minFrictionIntervalSec, Math.min(minInterval, 900));
  const maxInterval = nonNeg(opts.maxIntervalSec, DEFAULTS.maxIntervalSec);
  const idleThreshold = opts.idleThreshold ?? DEFAULTS.idleThreshold;
  const frictionThreshold = opts.frictionThreshold ?? DEFAULTS.frictionThreshold;
  // VOLUME MODE (WI-4318): active only when the scheduler supplies a finite
  // score (flag ON + accumulator populated); otherwise every volume branch
  // below is skipped and the gate is byte-identical to the legacy behavior.
  const volumeMode = typeof state.signalScore === 'number' && Number.isFinite(state.signalScore);
  const signalScore = volumeMode ? (state.signalScore as number) : 0;
  const scoreThreshold = nonNeg(opts.signalScoreThreshold, DEFAULTS.signalScoreThreshold);
  const minVolumeInterval = nonNeg(opts.minVolumeIntervalSec, DEFAULTS.minVolumeIntervalSec);

  const elapsedSec =
    state.lastRunAtMs == null ? Number.POSITIVE_INFINITY : (state.nowMs - state.lastRunAtMs) / 1000;
  const frictionTriggered = state.frictionSignals >= frictionThreshold;

  // 0. Revision requests PREEMPT everything.
  //    A pending steward/reviewer request fires the cycle OUT-OF-CADENCE — ahead of
  //    friction and PAST the min-interval floor — so feedback on a
  //    routed draft is iterated immediately and never waits behind (or is starved
  //    by) fresh ideation (D-003 #4). This is the deliberate floor BYPASS: the
  //    revision loop's runaway bound is the per-cycle Scout budget + the autoloop
  //    fire-gate (D-002), not the cadence interval. Disabled (the pure-gate
  //    default) when the scheduler supplies no `revisionRequestPending`.
  if (state.revisionRequestPending === true) {
    return { fire: true, reason: 'revision-request' };
  }

  // 0.5. VOLUME MODE zero-signal veto (WI-4318): the corpus is byte-identical
  //      to the last cycle — friction, drain, idle and heartbeat are ALL
  //      withheld (a cycle over an unchanged corpus only regenerates dedup
  //      declines). Only an explicit revision request (above) fires.
  if (volumeMode && signalScore <= 0) {
    return { fire: false, reason: 'no-signal' };
  }

  // 1. Friction fires fast (own short floor) — the colony is stuck, leap now.
  if (frictionTriggered) {
    if (elapsedSec >= minFrictionInterval) return { fire: true, reason: 'friction-triggered' };
    return { fire: false, reason: 'min-interval', retryAfterSec: Math.ceil(minFrictionInterval - elapsedSec) };
  }

  // 2. The normal floor guards volume/idle/heartbeat/drain fires. In volume
  //    mode the floor is the shorter burst-coalescing window: with a real
  //    volume trigger, the hourly clock is no longer what stops runaway firing
  //    — the score threshold is — so the floor only needs to coalesce bursts.
  const normalFloor = volumeMode ? minVolumeInterval : minInterval;
  if (elapsedSec < normalFloor) {
    return { fire: false, reason: 'min-interval', retryAfterSec: Math.ceil(normalFloor - elapsedSec) };
  }

  // 2.5. VOLUME MODE: enough new signal accumulated — fire now (the primary
  //      trigger of the data-volume design; owner-set 2026-07-12).
  if (volumeMode && signalScore >= scoreThreshold) {
    return { fire: true, reason: 'signal-volume' };
  }

  // 3. Idea pipeline drained — every prior routed idea is resolved (none pending),
  //    so generate fresh ideas now instead of waiting out the heartbeat. Bounded by
  //    the min-interval floor above ⇒ never fires more often than the heartbeat
  //    (same hourly cost ceiling). Disabled when the scheduler omits the counts.
  if (
    typeof state.routedIdeaTotal === 'number' &&
    state.routedIdeaTotal > 0 &&
    state.pendingIdeaCount === 0
  ) {
    return { fire: true, reason: 'ideas-drained' };
  }

  // 4. Idle capacity — the fleet has room to explore.
  if (state.idleRatio >= idleThreshold) return { fire: true, reason: 'idle-capacity' };

  // 5. Heartbeat ceiling — don't let the loop stall forever under sustained load.
  if (maxInterval > 0 && elapsedSec >= maxInterval) return { fire: true, reason: 'heartbeat' };

  return { fire: false, reason: 'no-trigger' };
}

function nonNeg(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;
}
