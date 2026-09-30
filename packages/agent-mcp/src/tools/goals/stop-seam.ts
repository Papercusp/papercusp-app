/**
 * The host seam that gives `goals:update { status }` real teeth — in BOTH directions.
 *
 * Stop (`paused` | `killed`) and resume (`active`) share ONE executor and one install
 * point. They were split for a while and only the stop half existed, which is exactly
 * how the resume no-op (WI-37615) survived: a `status:'active'` write moved the label,
 * left placement gated and loops disarmed, and the card left the `blocked` lane with
 * nothing running behind it. One seam means there is one place to forget, not two.
 *
 * WHY A SEAM AND NOT A DIRECT CALL. The dep direction is
 * operator-core -> agent-mcp -> tooldef, so a goals tool (which lives HERE) cannot
 * reach the two things that actually halt execution — the pot placement bit
 * (`pot/started`) and the engine-loop disarm (`harness/routines/loop`) — both of
 * which live up in operator-core. operator-core installs the real executor at
 * module load; until then a goal status write behaves exactly as it did before.
 * Same shape as the `setCapabilityTierOverride` seam in capability-tiers-papercusp.
 *
 * WHY THIS EXISTS AT ALL (EI-20013729460455061). `goals:update` was a pure record
 * write: SELECT -> UPDATE -> SELECT, no wake, no stop, no fan-out. Nothing outside
 * the goals tools reads `goals.status`, so pausing or killing a goal changed a
 * label and nothing else while the fleets, loops and pots pursuing it kept running.
 * The tool's own guidance said the goals "should have their pots wound down
 * first" — i.e. the wind-down was documented as a manual prerequisite.
 *
 * THE HONESTY REQUIREMENT (EI-19995648221353323). The measured failure one level
 * down is a stop control that REPORTS more than it does: pot pause is a placement
 * gate, not a throttle — it gates new Mug placements and exerts zero backpressure
 * on sessions already alive with armed self-wake loops. Measured 2026-08-09, a pot
 * read "paused, maxBees 1" while 73 distinct owners ran it at 8-13k calls/hour and
 * drained the account pool to exhaustion. So the report this seam returns MUST
 * distinguish what was actually stopped from what is still running and merely
 * un-attributable — see `unattributedActiveLoops`. A stop control that lets its
 * caller read "paused" as "burn stopped" is the bug, not the fix.
 */

import type { Sql } from 'postgres';

/**
 * The statuses that WIND A GOAL DOWN — one name for the set, so widening it is a
 * single edit rather than five unions that can drift apart.
 *
 * `achieved` belongs here for the same reason `killed` does: both are TERMINAL, and
 * there is provably LESS left to do after success than after abandonment (WI-37832).
 * It was absent until 2026-08-10, which made the status you set when a goal SUCCEEDS
 * the one status that did nothing — pots left ungated, attributed loops left armed
 * and burning against a completed outcome, while the FAILURE status cleaned all of it
 * up. Measured at the time: goal `make-a-website-…-aa0205` sat `achieved` for 2h38m
 * owning pot `panda-gallery` (goal_pots role='owner', removed_at NULL) with its
 * attributed session's engine loop still `active = true`.
 *
 * The one edge case — a session that has MOVED ON having its loop disarmed — is real
 * and self-correcting: a loop belongs to a session, so a session with other work
 * re-arms. (WI-37615 D-013 declines to auto-re-arm on resume for the same reason.)
 */
export type StoppingStatus = 'paused' | 'killed' | 'achieved';

/** What a goal stop did, per pot and in total. Every field is a MEASUREMENT, not an intent. */
export interface GoalStopReport {
  /** The goal whose status moved. */
  goalId: string;
  /** The status it moved INTO — 'paused', 'killed' and 'achieved' all fan out. */
  status: StoppingStatus;
  /**
   * Pots whose placement was gated, i.e. those this goal is the `owner` of.
   * A `contributing` link is deliberately NOT stopped: that pot is driven by
   * a DIFFERENT goal's placement, and stopping it would halt work this goal does
   * not own (goal_pots role semantics, migration 765 D-019/D-021).
   */
  potsStopped: string[];
  /** Live pairings this goal only contributes to — listed so the caller sees they were spared. */
  potsSkippedContributing: string[];
  /**
   * Engine loops disarmed. Scoped to sessions ATTRIBUTED to this goal (a GOAL-mode
   * `agent_modes` row whose `subject` is this goal id) — never harness-wide, because
   * a goal's pot is routinely the same harness dozens of unrelated su sessions
   * loop in, and disarming those would be a fleet-wide kill switch fired by a label change.
   */
  loopsStopped: string[];
  /**
   * ⚠ THE HONEST GAP. Active engine loops running IN this goal's owned pots that
   * could NOT be attributed to the goal, and were therefore left running. A non-zero
   * value means the goal is paused but real burn continues — the exact false-premise
   * state EI-19995648221353323 measured. Surfaced at the moment the intent is
   * expressed rather than discovered days later from the account pool.
   */
  unattributedActiveLoops: number;
  /**
   * Sessions whose GOAL-mode row was CLEARED. Populated only for a TERMINAL status
   * (see {@link isTerminalStatus}) — a `paused` goal keeps its rows, because they are
   * the attribution index `executeGoalResume` reads to report on those same sessions.
   *
   * Gating placement and disarming loops without this left the session still being
   * TOLD a finished goal was its standing mission: `agent_modes` has no `enabled`
   * column (9 columns, verified against the table), so the row's existence IS the
   * active state (WI-37834).
   */
  modesCleared: string[];
  /**
   * ⚠ THE HONEST GAP, modes edition. Sessions whose GOAL-mode row could NOT be
   * cleared because it is `ownerDirected` and this fan-out is not an owner-authority
   * channel (modes/store.ts OWNER-STICKY, D-003) — so the clear was REFUSED, not
   * skipped. Reported rather than bypassed on purpose: a machine fan-out overriding
   * an owner's explicit instruction is a bigger defect than a stale mode row, and
   * silently reporting success would be the exact false-premise state
   * `unattributedActiveLoops` already exists to prevent.
   */
  modesLeftArmed: string[];
  /** The standing drain fleet declared by goals:start, when present. */
  drainFleet?: string | null;
  /** True when the terminal goal's declared drain fleet is winding down (or absent). */
  drainFleetWoundDown?: boolean | null;
  /** A surfaced failure when the terminal goal's declared drain fleet could not be retired. */
  drainFleetWindDownError?: string | null;
  /**
   * True when the stop is materially incomplete: placement was gated but loops are
   * still burning in scope, or a mode row could not be cleared. Callers should render
   * this, not just the status.
   */
  degraded: boolean;
}

/**
 * What a goal RESUME did (WI-37615, plan D-013). Deliberately not a mirror-image of
 * `GoalStopReport`: resume is not the inverse of pause, and a symmetric-looking
 * report would imply it is.
 */
export interface GoalResumeReport {
  goalId: string;
  status: 'active';
  /** Pots whose placement was re-opened — the same OWNED set the stop gates. */
  potsResumed: string[];
  /** Contributing links, spared on the way down and untouched on the way up. */
  potsSkippedContributing: string[];
  /**
   * ⚠ THE HONEST GAP, resume edition. Sessions attributed to this goal whose engine
   * loop is currently disarmed and which this resume deliberately did NOT re-arm.
   *
   * WHY NOT RE-ARM: a loop belongs to a SESSION. By the time a goal resumes, the
   * sessions its pause disarmed are routinely dead, and re-arming a dead session's
   * loop is meaningless; re-arming a LIVE one the owner has since re-tasked is
   * worse. The fleet re-forms from placement — that is what placement is for.
   *
   * WHY IT IS A CURRENT-STATE MEASUREMENT and not a replay of what the pause did:
   * loop disarms have NO durable audit trail. `harness_shared.routine_loop_transitions`
   * records only `parked` and `rearmed` (measured 2026-08-09), so that table's silence
   * about a disarm is not evidence of anything. This counts what is disarmed NOW.
   */
  loopsLeftDisarmed: number;
  /**
   * ⚠ ALWAYS FALSE. The pause DELETES the pot's declared time-wake routine row, which
   * takes its cadence with it; nothing can reconstruct it, and `pot:start` does not
   * either. Stated as a constant rather than measured because `getPotTimeWake` returns
   * null both for "cleared" and for "never declared".
   */
  timeWakeRestored: false;
  /** True when the resume is materially incomplete — currently, when loops stayed disarmed. */
  degraded: boolean;
}

export type GoalTransitionReport = GoalStopReport | GoalResumeReport;

export interface GoalTransitionInput {
  goalId: string;
  workspaceId: string;
  /** The status the goal moved INTO. Only these four fan out. */
  status: StoppingStatus | 'active';
  /** The agent performing the transition, for the audit trail. */
  actor?: string | null;
  /**
   * The caller's transaction, when the transition accompanies a goal write.
   * Keeping the handle on the seam makes terminal relationship cleanup commit
   * or roll back with the status row; background sweeps omit it and use their
   * normal host connection.
   */
  sql?: Sql;
}

/** @deprecated Narrower alias kept only so existing call sites keep reading naturally. */
export type GoalStopInput = GoalTransitionInput & { status: StoppingStatus };

export type GoalTransitionExecutor = (input: GoalTransitionInput) => Promise<GoalTransitionReport>;

let executor: GoalTransitionExecutor | undefined;

/**
 * Install (or clear, with `undefined`) the host executor. Called once by
 * operator-core at module load. Idempotent — a re-install replaces.
 *
 * ONE executor covers stop AND resume rather than two parallel seams: they are two
 * directions of a single question ("what happens when a goal's status moves"), and a
 * second seam would be a second install point to forget — which is precisely the
 * failure mode this seam already exists to guard against.
 */
export function setGoalTransitionExecutor(fn: GoalTransitionExecutor | undefined): void {
  executor = fn;
}

/** The installed executor, or undefined when the host has not wired one. */
export function getGoalTransitionExecutor(): GoalTransitionExecutor | undefined {
  return executor;
}

/**
 * The one membership list. Every guard below reads it rather than repeating the
 * literals, so adding a status is a single edit and the guards CANNOT disagree with
 * each other — the drift that let `achieved` be a first-class member of
 * `GOAL_STATUSES` while being invisible to this seam (WI-37832).
 */
export const STOPPING_STATUSES: readonly StoppingStatus[] = ['paused', 'killed', 'achieved'];

/** A goal status that triggers the stop fan-out. */
export function isStoppingStatus(status: string): status is StoppingStatus {
  return (STOPPING_STATUSES as readonly string[]).includes(status);
}

/**
 * The stopping statuses that are also TERMINAL — the goal is over, not merely
 * suspended. A strict subset of {@link STOPPING_STATUSES}, and the distinction is
 * load-bearing: `paused` gates placement and disarms loops but must KEEP the
 * GOAL-mode rows, because `executeGoalResume` reads exactly those rows as its
 * attribution index. Clear them on a pause and resume can no longer name the
 * sessions it is reporting on (WI-37834).
 */
export const TERMINAL_STATUSES: readonly StoppingStatus[] = ['killed', 'achieved'];

/** A stopping status after which the goal is OVER, not merely suspended. */
export function isTerminalStatus(status: string): status is 'killed' | 'achieved' {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A goal status that triggers the resume fan-out (WI-37615). */
export function isResumingStatus(status: string): status is 'active' {
  return status === 'active';
}

/** Any status that fans out at all — the union of the two above. */
export function isTransitioningStatus(status: string): status is StoppingStatus | 'active' {
  return isStoppingStatus(status) || isResumingStatus(status);
}

/** Narrow a transition report to the stop arm. */
export function isStopReport(r: GoalTransitionReport): r is GoalStopReport {
  return isStoppingStatus(r.status);
}
