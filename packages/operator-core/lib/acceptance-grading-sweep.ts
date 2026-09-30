/**
 * Pure decision core for the acceptance-grading stall sweep.
 *
 * plan: acceptance-grading-stall-sweep-2026-08-26 (P-001)
 *
 * WHY A PLAN CAN STALL HERE. A plan ships only after an INDEPENDENT grader emits a
 * scorecard. That grader is recruited lazily: `plans:set-plan-status -> shipped`
 * refuses with `acceptance_ungraded` / `self_graded_only`, and the refusal itself
 * fires `resolveAcceptanceGrader`. Recovery is therefore PULL-triggered — it only
 * re-runs when somebody retries the ship. If the GRADER dies that self-heals, but
 * only because the next ship attempt re-refuses; if the CREATOR dies, no attempt is
 * ever made again and the plan sits ungraded forever with no timer and no owner.
 * The creator is the likeliest of the two to die: it has just finished a long
 * implementation with its context nearly full, and the ship is its last act.
 *
 * This module is the DECISION half of the fix, and it is deliberately PURE — no I/O
 * and no runtime imports, so it unit-tests without a database. The routine action
 * (P-002) observes the world, calls in here, and executes what it is told.
 *
 * It can only ever say "re-dispatch", "escalate", or "leave alone". It never grades,
 * never emits a scorecard, never records a verdict and never relaxes a refusal code
 * (plan requirement R4) — those remain the exclusive province of a real grader.
 */

/** Type-only: erased at compile time, so the pure core keeps its zero-runtime-dep property. */
import type { PlanAcceptanceGateCode } from './plan-acceptance-gate';

/**
 * How long a plan may sit stuck on a grader gap before the sweep re-dispatches.
 *
 * Deliberately equal to `ACCEPTANCE_GRADER_STALE_AFTER_MS` in `./acceptance-grader`:
 * that is the age at which the grader machinery itself already considers a launch
 * receipt stale and retries past it, so re-dispatching sooner would fight it and
 * re-dispatching much later would leave a knowingly-dead grader in place. The
 * relationship is PINNED by a test rather than by a runtime import — importing
 * `acceptance-grader` would drag its DB-bound dependency graph into this pure module
 * and cost the no-database property this file exists to have.
 */
export const ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS = 2 * 60 * 60_000;

/**
 * How long a plan may stay stuck — across however many re-dispatches — before the
 * sweep stops trying on its own and mints a single claimable work-item so a human or
 * agent owner takes it. Six re-dispatch windows: long enough that a merely-slow
 * grader is never escalated, short enough that a genuinely stranded plan surfaces
 * the same working day.
 */
export const ACCEPTANCE_GRADING_ESCALATE_AFTER_MS = 12 * 60 * 60_000;

/**
 * Hard ceiling on the ACTIONABLE decisions one tick may produce (plan requirement
 * R5). Skips are unbounded — deciding to leave a plan alone costs nothing — but
 * dispatches and escalations are capped so a large stalled backlog cannot fan out
 * into an agent-launch storm on the first tick after this ships.
 */
export const ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK = 10;

/**
 * The gate codes that mean "this plan is waiting on a GRADER", as opposed to waiting
 * on its own author. Kept as a literal array rather than imported from
 * `set-plan-status` for the same zero-runtime-dep reason as the threshold above; a
 * test pins it against the exported `ACCEPTANCE_GRADER_GATE_CODES` so the two cannot
 * drift apart silently.
 *
 * Every OTHER refusal — a missing rubric, an unvetted rubric, an unfinished item, an
 * unresolved citation — is the author's work, not a grader's. Re-dispatching a grader
 * at those would recruit somebody to grade a plan that is not ready to be graded.
 */
export const ACCEPTANCE_GRADING_STALL_GATE_CODES: readonly PlanAcceptanceGateCode[] = [
  'acceptance_ungraded',
  'self_graded_only',
];

export type AcceptanceGradingSweepAction = 'skip' | 'dispatch' | 'escalate';

export type AcceptanceGradingSweepReason =
  /** The gate is satisfied — nothing is stuck. */
  | 'gate-satisfied'
  /** Refused, but on something only the plan's author can fix. */
  | 'not-a-grader-gap'
  /** A grader is alive and working right now; re-dispatch would duplicate it. */
  | 'grader-live'
  /** We cannot tell how long it has been stuck, so we decline to act on a guess. */
  | 'stuck-age-unknown'
  /** An escalation work-item already exists; that owner drives from here. */
  | 'already-escalated'
  /** Stuck, but not yet past the re-dispatch window. */
  | 'within-redispatch-grace'
  /** Re-dispatched recently; waiting to see whether that grader takes. */
  | 'redispatch-cooling'
  /** Stuck past the re-dispatch window with no live grader. */
  | 'stalled-past-redispatch'
  /** Stuck past the escalation window; hand it to a single owner. */
  | 'stalled-past-escalation';

/**
 * Everything the decision needs to know about ONE candidate plan, already observed.
 * Gathering these is the caller's job precisely so this function can stay pure.
 */
export interface AcceptanceGradingCandidate {
  planSlug: string;
  /** `evaluatePlanAcceptanceGate().satisfied` — the single definition of stuck-ness (R7). */
  gateSatisfied: boolean;
  /** `evaluatePlanAcceptanceGate().code`, when it refused. */
  gateCode?: PlanAcceptanceGateCode | null;
  /**
   * When this plan first became eligible to be graded — NOT when the sweep first saw
   * it. Null when it cannot be established, which is treated as "do not act".
   */
  stuckSinceMs?: number | null;
  /** When a grader was last dispatched for this plan, or null if never. */
  lastDispatchMs?: number | null;
  /** True when a grader task for this plan is alive right now. */
  graderLive?: boolean;
  /** True when a claimable escalation work-item already names this plan. */
  escalationExists?: boolean;
}

export interface AcceptanceGradingDecision {
  planSlug: string;
  action: AcceptanceGradingSweepAction;
  reason: AcceptanceGradingSweepReason;
  /** Age in ms at decision time, when it could be established. */
  stuckForMs: number | null;
}

export interface AcceptanceGradingThresholds {
  redispatchAfterMs?: number;
  escalateAfterMs?: number;
}

/**
 * Decide what to do about ONE candidate. Pure: same inputs, same output, no clock of
 * its own (`nowMs` is passed in) and no I/O.
 *
 * The ordering of the guards is the substance of the function, so it is spelled out
 * rather than collapsed: each one is a distinct reason a plan must be left alone, and
 * every early return is a case where acting would be wrong rather than merely
 * unnecessary.
 */
export function decideAcceptanceGradingAction(
  candidate: AcceptanceGradingCandidate,
  nowMs: number,
  thresholds: AcceptanceGradingThresholds = {},
): AcceptanceGradingDecision {
  const redispatchAfterMs = thresholds.redispatchAfterMs ?? ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS;
  const escalateAfterMs = thresholds.escalateAfterMs ?? ACCEPTANCE_GRADING_ESCALATE_AFTER_MS;

  const stuckSince = candidate.stuckSinceMs ?? null;
  const stuckForMs = stuckSince === null ? null : Math.max(0, nowMs - stuckSince);
  const skip = (reason: AcceptanceGradingSweepReason): AcceptanceGradingDecision => ({
    planSlug: candidate.planSlug,
    action: 'skip',
    reason,
    stuckForMs,
  });

  // R6 — a plan that is not stuck is left alone.
  if (candidate.gateSatisfied) return skip('gate-satisfied');

  // R6 — refused, but on the author's work rather than a grader's absence.
  if (!candidate.gateCode || !ACCEPTANCE_GRADING_STALL_GATE_CODES.includes(candidate.gateCode)) {
    return skip('not-a-grader-gap');
  }

  // R2 — a live grader makes every further action a duplicate. This is the guard that
  // makes repeated ticks safe, and it is checked before any age arithmetic so that a
  // grader working on a long-stuck plan is never disturbed.
  if (candidate.graderLive) return skip('grader-live');

  // R3 — one owner, not a crowd. Once an escalation exists it drives; the sweep stops.
  if (candidate.escalationExists) return skip('already-escalated');

  // Acting on an unknown age would be acting on a guess.
  if (stuckForMs === null) return skip('stuck-age-unknown');

  if (stuckForMs >= escalateAfterMs) {
    return { planSlug: candidate.planSlug, action: 'escalate', reason: 'stalled-past-escalation', stuckForMs };
  }

  if (stuckForMs < redispatchAfterMs) return skip('within-redispatch-grace');

  // R2 — having re-dispatched recently, give that grader its own full window to appear
  // before dispatching another. Without this a plan whose grader is slow to register
  // would be re-dispatched on every single tick.
  if (candidate.lastDispatchMs !== null && candidate.lastDispatchMs !== undefined) {
    const sinceDispatch = nowMs - candidate.lastDispatchMs;
    if (sinceDispatch < redispatchAfterMs) return skip('redispatch-cooling');
  }

  return { planSlug: candidate.planSlug, action: 'dispatch', reason: 'stalled-past-redispatch', stuckForMs };
}

export interface AcceptanceGradingSweepPlan {
  /** Every decision made, in candidate order — including the skips, for observability. */
  decisions: AcceptanceGradingDecision[];
  /** The decisions to actually execute, already capped at `maxPerTick`. */
  actionable: AcceptanceGradingDecision[];
  /** How many actionable decisions the per-tick cap deferred to a later tick. */
  deferredByCap: number;
  counts: { skipped: number; dispatch: number; escalate: number };
}

export interface AcceptanceGradingSweepOpts extends AcceptanceGradingThresholds {
  maxPerTick?: number;
}

/**
 * Decide the whole tick. Pure.
 *
 * Actionable work is ordered MOST-STALLED FIRST so that when the cap bites it defers
 * the least-stuck plans, and ties break on slug so the order is deterministic — a
 * test that asserts on which plans a capped tick chose must not depend on input order.
 */
export function planAcceptanceGradingSweep(
  candidates: readonly AcceptanceGradingCandidate[],
  nowMs: number,
  opts: AcceptanceGradingSweepOpts = {},
): AcceptanceGradingSweepPlan {
  const maxPerTick = Math.max(0, opts.maxPerTick ?? ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK);
  const decisions = candidates.map((c) => decideAcceptanceGradingAction(c, nowMs, opts));

  const ranked = decisions
    .filter((d) => d.action !== 'skip')
    .sort((a, b) => (b.stuckForMs ?? 0) - (a.stuckForMs ?? 0) || a.planSlug.localeCompare(b.planSlug));

  const actionable = ranked.slice(0, maxPerTick);
  return {
    decisions,
    actionable,
    deferredByCap: ranked.length - actionable.length,
    counts: {
      skipped: decisions.length - ranked.length,
      dispatch: actionable.filter((d) => d.action === 'dispatch').length,
      escalate: actionable.filter((d) => d.action === 'escalate').length,
    },
  };
}
