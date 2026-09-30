/**
 * goal-liveness-watchdog (system-notices-on-its-own-2026-08-16 P-001) — alarm on
 * an ACTIVE goal that nobody is actually working.
 *
 * WHY THIS EXISTS. Every layer BELOW goal was already watched — engine loops,
 * cadence drift, idle sessions, orphaned MCP processes, supervision units, stale
 * executors, cgroups, green-stall, git-sync-stall, origin-freshness,
 * carry-drill-drop, compaction-compliance, cluster-lag, memory. GOAL, the layer
 * the product has been organized around since mug/kettle/cup was retired in its
 * favor, had NOTHING: `routines:list { q:'goal' }` returned zero rows.
 *
 * Measured on 2026-08-16, the moment this file was written: of the 6 goals with
 * `status='active'` in papercusp-workspace, only 2 had a live holder. The other
 * 4 — including `make-sidestage-web-ios-and-android-ready-for-pub-dd62af` and
 * `the-gui-chat-surface-is-ready-to-ship-to-strange-8fa0ed`, both real product
 * goals — had been dark since 08-14 and 08-11 while every surface reported them
 * healthy. The detection event was a human asking.
 *
 * THE DEFECT THIS MAKES IMPOSSIBLE. A goal's holder is recorded as a row in
 * `harness_shared.agent_modes` (mode='goal', subject=<goal id>). That row is
 * ordinary durable state: it OUTLIVES the session that wrote it. Nothing clears
 * it when the session dies, so "this goal has 1 holder" stays true forever and
 * reads as healthy for a goal nobody has touched in five days. Row presence is
 * not liveness — that is the whole bug, and it is why this sweep resolves every
 * holder through the shared oracle instead of counting rows.
 *
 * WHY TICK-DRIVEN, AND WHY THAT IS THE POINT. The sibling failure that motivated
 * this (blender-steward-heartbeat-2026-08-11 D-005) is a recovery mechanism with
 * a CIRCULAR DEPENDENCY: the heartbeat meant to relaunch a dead steward executes
 * its runs by claiming a work-item, and when the steward is dead there is nobody
 * alive to claim one. It therefore cannot recover the exact failure it exists
 * for. A `managedSetInterval` in the operator host has no such dependency — it is
 * alive precisely when the agents it watches are not. Do not "improve" this into
 * something an agent has to claim.
 *
 * Design notes:
 *  - `managedSetInterval` (never a bare setInterval) — visible in
 *    schedule:inventory, category 'watchdog', like its system-health siblings.
 *  - Runtime gate: FLAGS.GOAL_LIVENESS_WATCHDOG (default ON — flip OFF at
 *    /admin/features; no ad-hoc env boolean per lint:env-feature-gates).
 *  - Liveness comes from `resolveSessionStates` (the ONE oracle behind
 *    coord:presence / fleet:status / leader-brief). Hand-rolling a heartbeat
 *    comparison here would reintroduce exactly the per-surface divergence
 *    presence-derivation-unification-2026-07-17 removed.
 *  - REPORTS by default. Explicit `launch_settings.autoStart` is the one
 *    exception: the readiness leg dispatches through the existing activation
 *    primitive, so an opted-in goal is not stranded waiting for an offer.
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — cluster-safe, no new state surface.
 *
 * P-005 (goal-dag-shared-substrate-2026-08-18): the same sweep also reads each
 * active goal's DAG readiness (derived on read, D-006) and reports — never acts
 * on — two more conditions:
 *  - BECAME-READY: a goal with blocked-by edges whose blockers are now all
 *    satisfied, with nobody alive on it. Readiness at goal level is an
 *    ACTIVATION gate; becoming ready produces a surfaced OFFER by default.
 *    A goal explicitly opted into `launch_settings.autoStart` is dispatched
 *    through the existing activation primitive (P-020); otherwise a human or
 *    the parent goal's agent decides to start it.
 *  - PREMISE-INVALIDATED: a goal with a KILLED goal-blocker (D-002 — killed
 *    invalidates the dependent's premise and never silently unblocks). Fired
 *    regardless of holder liveness: a live holder needs the review too.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getGoalTransitionExecutor } from '@papercusp/agent-mcp';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import {
  goalReadiness,
  blockerStatusKey,
  readGoalBlockedByEdges,
  resolveBlockerStatuses,
  type GoalBlockerEndpoint,
  type GoalBlockerView,
  type GoalReadiness,
} from '@papercusp/agent-mcp/goal-deps';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
  GOAL_LIVENESS_SWEEP_STATUSES,
  GOAL_PORTFOLIO_IDLE_AFTER_MS,
  resolveGoalActivity,
  resolveGoalHolderWedge,
} from '../goals/activity';
import {
  readGoalPortfolioThroughput,
  type GoalPortfolioThroughputRead,
} from '../goals/portfolio-throughput';
import type { GoalHolders } from '../goals/holder';
import {
  parseGoalLaunchSettings,
  type GoalLaunchSettings,
  type ParsedGoalLaunchSettings,
} from '../goal-launch-settings';
import { resolveGoalHolderPolicy } from '../goal-launch-settings-shared';
import { startGoalById, type StartGoalByIdResult } from '../goals/start-goal-by-id';
import {
  launchGoalHolderSession,
  neutralizeGoalHolderSession,
} from '../harness/routines/goal-holder-launch-action';
import {
  setMode,
  type GoalModeElectionExpectation,
  type GoalModeElectionReceipt,
} from '../modes/store';
import { notifyGoalHolderHandoff } from '../goals/holder-handoff';
import { refreshControlAnchorAfterMutation } from '../agent-tools/coordination/control-anchor';
import { appendGoalWriteAudit } from '../goals/write-audit';
import {
  confirmFlapRestart,
  decideFlapDamping,
  initialFlapDampingState,
  type FlapDampingState,
} from '../supervision/flap-damping';
import {
  holderIsRekickable,
  readGoalHolderRows,
  readGoalHolderAuthority,
  resolveGoalHoldersFromRows,
  resolveHolderLiveness,
  type GoalHolderAuthority,
  type GoalHolderRow,
} from '../goals/holder';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import {
  readGoalHolderFirstTurnAttestation,
  type GoalHolderFirstTurnAttestation,
} from '../goals/holder-attestation';
import {
  assessGoalHolderLaunchCapacityForGoal,
  formatCapacityUntil,
  type GoalHolderLaunchCapacityVerdict,
} from '../goals/holder-launch-capacity';

/**
 * P-001: `holderCountsAsAlive` moved to `../goals/holder`, which is now the ONE
 * definition of "who holds this goal and is any of them alive". Re-exported here
 * because this file was its original home and the drain-fleet sibling imports it
 * from this path; both now resolve to the shared implementation rather than the
 * watchdog owning a rule the product surfaces had no access to.
 */
export { holderCountsAsAlive } from '../goals/holder';

export const GOAL_LIVENESS_SWEEP_INTERVAL_MS = 10 * 60_000;
/** P-009: holder recovery is its own faster actor and never rides the report cadence. */
export const GOAL_HOLDER_RESPAWN_INTERVAL_MS = 60_000;
/** P-003: durable, per-goal ceiling on unattended holder launches. */
export const GOAL_HOLDER_RESPAWN_RATE_LIMIT = 6;
export const GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS = 60 * 60_000;
/**
 * WI-2140573 finding 5: while the account(s) a holder launch would land on are
 * measured unable to serve, recovery is DEFERRED — no re-kick, no damping
 * restart, no rate-cap slot, no launch. The deferral is logged on entry and
 * then at most once per this interval, so a days-long usage wall is one line
 * every ten minutes rather than one per 60-second tick.
 */
export const GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS = 10 * 60_000;
/**
 * A measured USAGE WALL escalates on the first deferred tick (it lasts until the
 * provider window resets — hours to days — and only the owner can add
 * capacity). A RATE PAUSE is bounded and usually clears in minutes, so it
 * escalates only once a deferral episode has outlasted this budget.
 */
export const GOAL_HOLDER_CAPACITY_DEFER_ESCALATE_MS = 10 * 60_000;

/**
 * WI-2140573 finding 5b (measured 2026-09-02 06:16–08:52Z): consecutive `clear`
 * verdicts an OPEN deferral episode must observe before ordinary recovery
 * resumes. The pool reading flaps — one account flickers serviceable for a
 * single tick, or a stale reading yields `unknown` — and a single non-deferred
 * tick used to close the episode and pay a launch that died at kickoff
 * (06:29:16Z: "1 of 7 can serve right now" → launch → 0 responses). A wall
 * that has genuinely lifted reads `clear` on every tick, so requiring two costs
 * one tick of latency and nothing else.
 */
export const GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS = 2;
/**
 * WI-2140573 (measured 2026-09-01): a `lost` holder whose PROCESS is still up
 * (`holderIsRekickable`) is WOKEN with a retry brief before any launch is paid.
 * Re-kicks to one holder are spaced by the interval and capped at the max;
 * only a holder that stays lost past that budget reaches the launch path.
 * Sized against the measured failure: codex gives up a dead sampling stream
 * in ~16s, and the upstream "high demand" outage that killed seven kickoffs
 * in a row lasted ~95 minutes — three re-kicks over ten minutes recover the
 * short blips for free and turn the long outage from one launch per ~11 min
 * into one per ~25 min without touching the hourly launch cap.
 */
export const GOAL_HOLDER_REKICK_INTERVAL_MS = 5 * 60_000;
export const GOAL_HOLDER_REKICK_MAX = 3;
/** Give a new elected holder time to complete its first turn before recovery. */
export const GOAL_HOLDER_FIRST_TURN_GRACE_MS = 15 * 60_000;

/**
 * How long a goal may show no live holder before it is called abandoned.
 *
 * This threshold is what separates "between sessions" from "dark". A goal is a
 * long-lived intent worked across many sessions, so an instantaneous gap is
 * NORMAL and alarming on it would make this watchdog noise. Six hours sits well
 * inside the signal without touching the normal case: the four goals that
 * motivated this file had been dark for 2 to 5 DAYS, and a legitimate handoff
 * gap on an actively-pursued goal is minutes to an hour or two.
 */
export const GOAL_LIVENESS_GRACE_MS = 6 * 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-liveness-watchdog',
  ownerLabel: 'system · goal liveness',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One sweepable goal, reduced to what the verdict needs. */
export interface GoalRowLike {
  goalId: string;
  workspaceId: string;
  title: string;
  /** ms epoch of the goal row's last update. */
  updatedAtMs: number;
  /**
   * The goal's administrative status (P-005, D-009).
   *
   * OPTIONAL, and that is deliberate rather than lazy. The sweep's own read
   * already scopes to `GOAL_LIVENESS_SWEEP_STATUSES` in SQL, so supplying it
   * here is a SECOND, in-memory guard against the same mistake — a caller that
   * hands this classifier goals it selected some other way (a test, a future
   * P-004 read-side surface) cannot silently lose the paused exemption. Absent
   * means "the caller scoped it", which is exactly today's behaviour.
   */
  status?: string | null;
  /** Harness passed to launch-su when this goal earns automatic holder recovery. */
  installSlug?: string | null;
  /** Parsed, schema-valid launch settings; invalid stored JSON is fail-dark as null. */
  launchSettings?: GoalLaunchSettings | null;
  /**
   * Durable proof this goal was successfully started at least once.
   *
   * `startGoalById` stamps metadata.agentOwnerId only AFTER the GOAL-mode
   * attachment succeeds. The value is therefore not a liveness source and may
   * name an old holder, but its presence distinguishes a started goal whose
   * holder row was later lost from an installed-only stub that nobody started.
   */
  startedHolderOwnerId?: string | null;
  /** P-011 (work-on-everything): goals.standing — TRUE for a stewardship goal. */
  standing?: boolean | null;
}

/**
 * One `agent_modes` goal-mode row pointing at a goal.
 *
 * P-001: this is now an ALIAS of the shared `GoalHolderRow` rather than a
 * parallel shape — a second structural definition of "a holder row" is how the
 * liveness join came to exist here and nowhere else.
 */
export type GoalHolderLike = GoalHolderRow;

/**
 * Why a goal is being reported.
 *
 * `overlap` is the P-002 effective-holder health failure: multiple live rows
 * remain after the elected successor's explicit handoff window (or were never
 * named by one). It shares the existing escalation/dedup surface rather than
 * creating a parallel monitor.
 */
export type GoalLivenessReason = 'unheld' | 'abandoned' | 'overlap';

export interface GoalLivenessAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  reason: GoalLivenessReason;
  /** Most recent evidence anyone touched this goal (ms epoch). */
  lastEvidenceMs: number;
  darkMs: number;
  /** Holders and the verdict each resolved to, for the escalation body. */
  holders: { ownerId: string; sessionState: string }[];
}

/**
 * PURE: classify one goal. Returns null when the goal is healthy OR when the
 * evidence is insufficient to call it dark.
 *
 * THE CONSERVATIVE RULE, stated explicitly because it is the difference between a
 * useful watchdog and a nuisance: a holder for whom the oracle returned NO
 * verdict is UNKNOWN, not dead. `resolveSessionStates` omits an entry when its
 * wakeability fetch degraded, so treating a missing entry as death would turn a
 * transient DB hiccup into a wave of false abandonment alarms across every goal
 * at once. An unresolvable holder therefore suppresses the alert entirely — this
 * is `resolveGoalHolders`' `liveness: 'unknown'` verdict, which the shared module
 * keeps distinct from `'lost'` for exactly this reason (P-001).
 */
export function classifyGoalLiveness(
  goal: GoalRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  nowMs: number,
  graceMs: number = GOAL_LIVENESS_GRACE_MS,
): GoalLivenessAlert | null {
  // P-005 / D-009: the ADMINISTRATIVE short-circuit, before liveness is
  // consulted at all. A deliberately paused goal has no live holder BY DESIGN —
  // the pause fan-out disarms exactly those sessions' loops — so classifying it
  // on liveness alone would render a stop as a crash and alarm on a hold
  // somebody chose. Same rule as `isAdministrativelyPaused` one layer down.
  const activity = resolveGoalActivity({ status: goal.status });
  if (activity.deliberatelyPaused || activity.terminal) return null;

  const resolved = resolveGoalHoldersFromRows(
    goal.goalId,
    goal.workspaceId,
    holders,
    verdicts,
    nowMs,
  );
  if (resolved.overlap.status === 'violation') {
    const overlapSince =
      resolved.overlap.expiresAtMs ?? resolved.elected?.setAtMs ?? goal.updatedAtMs;
    return {
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      title: goal.title,
      reason: 'overlap',
      lastEvidenceMs: overlapSince,
      darkMs: Math.max(0, nowMs - overlapSince),
      holders: resolved.allLive.map((holder) => ({
        ownerId: holder.ownerId,
        sessionState: holder.sessionState ?? 'unknown',
      })),
    };
  }
  // 'held' → someone is on it. 'unknown' → at least one holder is unresolvable,
  // which is not evidence of death. Only 'unheld' / 'lost' are reportable.
  if (resolved.liveness === 'held' || resolved.liveness === 'unknown') return null;
  const mine = resolved.holders;

  const lastEvidenceMs = Math.max(goal.updatedAtMs, ...mine.map((h) => h.setAtMs), 0);
  const darkMs = nowMs - lastEvidenceMs;
  if (!Number.isFinite(darkMs) || darkMs < graceMs) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    reason: resolved.liveness === 'unheld' ? 'unheld' : 'abandoned',
    lastEvidenceMs,
    darkMs,
    holders: mine.map((h) => ({
      ownerId: h.ownerId,
      sessionState: h.sessionState ?? 'unknown',
    })),
  };
}

/* ── P-005: the readiness leg ─────────────────────────────────────────────── */

export type GoalReadinessAlertKind = 'became-ready' | 'premise-invalidated';

export interface GoalReadinessAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  kind: GoalReadinessAlertKind;
  /** The blockers relevant to the verdict (invalidating ones for premise-invalidated; all for became-ready). */
  blockers: GoalBlockerView[];
  /**
   * P-020: set ONLY when this goal opted into `launch_settings.autoStart`, the
   * watchdog attempted the dispatch, and it did not take (a refusal from the
   * primitive, or a launch failure). The offer escalation then carries WHY the
   * automatic path declined, so the human triaging it starts from the reason
   * instead of rediscovering it.
   */
  autoStartFailure?: string;
}

/** The holder-liveness fold `resolveGoalHoldersFromRows` produces for one goal. */
export type GoalHolderLivenessFold = 'held' | 'unheld' | 'lost' | 'unknown';

/**
 * PURE: classify one goal's DAG readiness into a report, or null.
 *
 * Rules (D-002/D-003):
 *  - No edges ⇒ nothing to say for an ordinary goal: a goal that never
 *    declared prerequisites was always startable, so "became ready" would be
 *    noise for every plain goal. An explicit `launch_settings.autoStart` opt-in
 *    is the exception; its synthetic empty readiness is an actionable launch
 *    signal.
 *  - PREMISE-INVALIDATED wins over everything: a killed blocker needs review
 *    whether or not somebody is on the goal, so holder liveness is ignored.
 *  - BECAME-READY only when every blocker is satisfied AND nobody is alive on
 *    the goal ('unheld' / 'lost'). 'held' means it is being worked — no offer
 *    needed; 'unknown' suppresses, the same conservative rule as the liveness
 *    leg (an unresolvable holder is not evidence of absence).
 */
export function classifyGoalReadiness(
  goal: GoalRowLike,
  readiness: GoalReadiness | undefined,
  holderLiveness: GoalHolderLivenessFold,
): GoalReadinessAlert | null {
  if (
    !readiness ||
    (readiness.blockers.length === 0 && goal.launchSettings?.autoStart !== true)
  ) {
    return null;
  }
  if (readiness.premiseInvalidated) {
    return {
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      title: goal.title,
      kind: 'premise-invalidated',
      blockers: readiness.blockers.filter((b) => b.verdict === 'invalidating'),
    };
  }
  if (readiness.actionable && (holderLiveness === 'unheld' || holderLiveness === 'lost')) {
    return {
      goalId: goal.goalId,
      workspaceId: goal.workspaceId,
      title: goal.title,
      kind: 'became-ready',
      blockers: readiness.blockers,
    };
  }
  return null;
}

/** PURE: classify a whole batch. Exported for tests and for a future read-side surface. */
export function scanGoalLiveness(
  goals: readonly GoalRowLike[],
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  nowMs: number,
  graceMs: number = GOAL_LIVENESS_GRACE_MS,
): GoalLivenessAlert[] {
  const out: GoalLivenessAlert[] = [];
  for (const g of goals) {
    const alert = classifyGoalLiveness(g, holders, verdicts, nowMs, graceMs);
    if (alert) out.push(alert);
  }
  return out;
}

function formatDark(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export interface GoalLivenessSweepDeps {
  readGoals: () => Promise<{ goals: GoalRowLike[]; holders: GoalHolderLike[] }>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  escalate: (alert: GoalLivenessAlert) => Promise<void>;
  /**
   * P-005: each goal's DAG readiness, keyed `workspaceId:goalId` (the
   * `blockerStatusKey` colon convention). Ordinary goals with NO edges may be
   * absent; explicit `launchSettings.autoStart` goals are included with a
   * synthetic empty readiness result.
   */
  readReadiness: (goals: readonly GoalRowLike[]) => Promise<Map<string, GoalReadiness>>;
  escalateReadiness: (alert: GoalReadinessAlert) => Promise<void>;
  /**
   * The wedge leg's measurement: agent-origin tool calls made by each goal's
   * LIVE holders since they picked it up, keyed `workspaceId:goalId`.
   *
   * A goal ABSENT from the returned map is `not-measured` and is suppressed —
   * so a degraded read costs silence, never a wave of false wedge alarms.
   */
  readHolderProductivity: (holds: readonly GoalLiveHold[]) => Promise<Map<string, number>>;
  escalateWedge: (alert: GoalWedgeAlert) => Promise<void>;
  /** Grace before a held-but-silent holder is reportable. */
  wedgeGraceMs: number;
  /**
   * P-002's measurement: per-goal PORTFOLIO throughput, keyed `workspaceId:goalId`.
   *
   * Takes the ALREADY-FOLDED holders so the leg does not re-resolve liveness the
   * sweep has just resolved — one derivation, and no chance of the two disagreeing
   * between the wedge leg's verdict and this one within a single tick.
   *
   * Absent from the returned map ⇒ `not-measured` ⇒ suppressed, exactly like the
   * wedge leg's productivity read.
   */
  readPortfolioThroughput: (
    holders: ReadonlyMap<string, GoalHolders>,
  ) => Promise<Map<string, GoalPortfolioThroughputRead>>;
  escalatePortfolioIdle: (alert: GoalPortfolioIdleAlert) => Promise<void>;
  /** How long a live holder may place nothing before the goal is reportable. */
  portfolioIdleAfterMs: number;
  /**
   * P-020: the goal-activation primitive, dispatched for a `became-ready` goal
   * that opted in via `launch_settings.autoStart` (D-006 — every trigger leg
   * converges on the ONE primitive; this leg never spawns by hand). Bound over
   * `sql` by the default wiring; injectable for tests.
   */
  startGoal: (input: {
    workspaceId: string;
    goalId: string;
    launcherOwnerId: string;
  }) => Promise<StartGoalByIdResult>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;
}

/** The `readReadiness` map key. Colon-composite, same convention as `blockerStatusKey`. */
export function goalReadinessKey(g: Pick<GoalRowLike, 'workspaceId' | 'goalId'>): string {
  return `${g.workspaceId}:${g.goalId}`;
}

/* ── the WEDGE leg — held, alive, and producing nothing ───────────────────── */

/**
 * One live hold, as the productivity read needs it: who, on which goal, since
 * when. `since` is the clock the call count is measured from — a holder is only
 * answerable for calls made after it picked the goal up.
 */
export interface GoalLiveHold {
  workspaceId: string;
  goalId: string;
  ownerId: string;
  setAtMs: number;
}

export interface GoalWedgeAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  /** The LIVE holders the verdict was measured across. */
  holders: { ownerId: string; sessionState: string }[];
  /** Agent-origin calls summed across those holders since the earliest hold. */
  agentOriginCalls: number;
  /** Grace clock: elapsed since the MOST RECENT hold began. */
  heldForMs: number;
}

/**
 * PURE: is this HELD goal's holder alive-but-not-working?
 *
 * The gap this closes: `classifyGoalLiveness` returns null the moment a goal
 * resolves `held`, so a holder that booted, failed its first turn, and has sat
 * there ever since is indistinguishable from one doing the work. Both are
 * "held", and held was the end of the enquiry. That is how a goal spent hours
 * reporting healthy while producing nothing (EI-21578742955425881).
 *
 * TWO CONSERVATIVE CHOICES, both of which suppress rather than alarm:
 *
 *  1. `agentOriginCalls` is summed since the EARLIEST hold, while the grace runs
 *     from the MOST RECENT one. Maximum opportunity to have produced a call,
 *     minimum elapsed grace — so a freshly-added holder re-arms the window and a
 *     goal is never called wedged on the strength of a predecessor's silence.
 *  2. An ABSENT measurement is `not-measured`, never zero. A degraded
 *     productivity read must report nothing rather than report everyone wedged;
 *     collapsing those two is the failure the verdict's `reason` exists to keep
 *     apart.
 */
export function classifyGoalWedge(
  goal: GoalRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  agentOriginCallsByGoal: ReadonlyMap<string, number>,
  nowMs: number,
  graceMs: number = GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
): GoalWedgeAlert | null {
  // Same administrative short-circuit as the liveness leg: a deliberately
  // paused goal is not producing work BY DESIGN.
  const activity = resolveGoalActivity({ status: goal.status });
  if (activity.deliberatelyPaused || activity.terminal) return null;

  const resolved = resolveGoalHoldersFromRows(
    goal.goalId,
    goal.workspaceId,
    holders,
    verdicts,
  );
  // A wedge is by definition something that happens to somebody who IS there;
  // every other fold is already described correctly by the liveness leg.
  if (resolved.liveness !== 'held' || resolved.live.length === 0) return null;

  const measured = agentOriginCallsByGoal.get(goalReadinessKey(goal));
  const heldForMs = nowMs - Math.max(...resolved.live.map((h) => h.setAtMs));

  const verdict = resolveGoalHolderWedge({
    liveness: resolved.liveness,
    productivity:
      measured === undefined ? null : { agentOriginCalls: measured, heldForMs },
    graceMs,
  });
  if (!verdict.wedged) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    holders: resolved.live.map((h) => ({
      ownerId: h.ownerId,
      sessionState: h.sessionState ?? 'unknown',
    })),
    agentOriginCalls: measured ?? 0,
    heldForMs,
  };
}

/* ── the PORTFOLIO-IDLE leg — held, working, and placing nothing ──────────────
 *
 * Runs where the WEDGE leg stops. That leg asks "has this holder ever produced
 * an agent-origin call", so a steward that reads and reports forever answers
 * `has-produced-work` and the enquiry ends — which is how a goal ran 4+ hours
 * and $109 with a MONEY ceiling as the first objector.
 *
 * ── ⚠ WHY A HOST LEG AND NOT JUST THE SUBSCRIPTION ──────────────────────────
 *
 * P-002 registers `goal.portfolioThroughput`, so any agent can now
 * `state:subscribe` to this condition. That capability is real and is the point
 * — but a subscription needs a SUBSCRIBER, and the one party guaranteed not to
 * arm it is the idle steward itself. Relying on it would rebuild the circular
 * dependency this file's own docblock was written against: "the heartbeat meant
 * to relaunch a dead steward executes its runs by claiming a work-item, and when
 * the steward is dead there is nobody alive to claim one."
 *
 * A `managedSetInterval` in the operator host has no such dependency. It is
 * awake precisely when the agent it is judging is not doing its job.
 *
 * ── REPORT-ONLY, LIKE ITS SIBLINGS ──────────────────────────────────────────
 *
 * It never kills or respawns. Respawn is actively WRONG here and this is the one
 * leg where that is unambiguous: the holder is alive and working, so a
 * replacement inherits the same instructions and does the same thing. The repair
 * is a conversation about whether the goal should still be running, which is a
 * decision this sweep is not entitled to make.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface GoalPortfolioIdleAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  /** Minutes since the goal's holders last placed anything. */
  idleMinutes: number;
  /** The threshold crossed, so the alert carries its own scale. */
  idleAfterMinutes: number;
  /** Portfolio acts in the rate window — usually 0, and 0 is the interesting case. */
  actsInWindow: number;
  /** The last thing this goal actually placed, if anything, and when. */
  lastActTool: string | null;
  lastActAtMs: number | null;
  /** The live holders the verdict was measured across. */
  holders: { ownerId: string; sessionState: string }[];
}

/**
 * PURE: is this HELD goal's steward working but placing nothing?
 *
 * Mirrors `classifyGoalWedge` deliberately — same administrative short-circuit,
 * same held-only precondition, same "absent measurement suppresses" rule — so
 * the two legs cannot drift into disagreeing about which goals they may judge.
 *
 * The VERDICT itself is not recomputed here: it arrives already folded on the
 * throughput reading, from the one resolver the cell also reads. This function
 * decides only whether the goal is ELIGIBLE to be judged and shapes the alert.
 */
export function classifyGoalPortfolioIdle(
  goal: GoalRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  throughputByGoal: ReadonlyMap<string, GoalPortfolioThroughputRead>,
  nowMs: number,
): GoalPortfolioIdleAlert | null {
  void nowMs;
  // A deliberately paused goal places nothing BY DESIGN, and a terminal one is
  // over. Same short-circuit, same reason, as every other leg in this file.
  const activity = resolveGoalActivity({ status: goal.status });
  if (activity.deliberatelyPaused || activity.terminal) return null;

  const resolved = resolveGoalHoldersFromRows(goal.goalId, goal.workspaceId, holders, verdicts);
  // Placing nothing is only a finding about somebody who is THERE. An absent
  // steward is `unheld`/`lost` — a staffing problem the liveness leg already
  // reports, with a different repair.
  if (resolved.liveness !== 'held' || resolved.live.length === 0) return null;

  const reading = throughputByGoal.get(goalReadinessKey(goal));
  // ABSENT ⇒ not-measured ⇒ silence. A degraded throughput read must never
  // become a wave of "every goal is idle", which is the same conservative rule
  // the wedge leg's productivity map follows.
  if (!reading || !reading.idle || reading.idleMinutes == null) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    idleMinutes: reading.idleMinutes,
    idleAfterMinutes: reading.idleAfterMinutes,
    actsInWindow: reading.actsInWindow,
    lastActTool: reading.lastActTool,
    lastActAtMs: reading.lastActAtMs,
    holders: resolved.live.map((h) => ({
      ownerId: h.ownerId,
      sessionState: h.sessionState ?? 'unknown',
    })),
  };
}

/**
 * The default escalation. Names the CELL, so the recipient can re-read the value
 * rather than trusting the number in this message — the whole reason P-002
 * registered one (a transcribed reading has rotted by the time anyone acts on
 * it).
 */
async function defaultEscalatePortfolioIdle(alert: GoalPortfolioIdleAlert): Promise<void> {
  const last =
    alert.lastActAtMs == null
      ? 'It has placed NOTHING since it was picked up.'
      : `Its last portfolio act was \`${alert.lastActTool}\`, ${alert.idleMinutes} minutes ago.`;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is HELD and WORKING but has placed nothing for ${alert.idleMinutes}m ` +
      `(threshold ${alert.idleAfterMinutes}m)`,
    body:
      `"${alert.title}" — ${alert.holders.length} live holder(s). ${last} ` +
      `Portfolio acts in the last hour: ${alert.actsInWindow}. Threshold: ${alert.idleAfterMinutes}m.\n\n` +
      `This is NOT a wedged or dead holder — the session is alive and making tool calls. ` +
      `It is a steward that is reading and reporting without creating, placing or steering any work.\n\n` +
      `  • Do NOT respawn it. Respawn repairs a DEAD session; this one is alive, and a ` +
      `replacement inherits the same instructions and does the same thing.\n` +
      `  • Decide whether the goal should still be running, then either give the steward ` +
      `something placeable or wind the goal down.\n\n` +
      `Re-read before acting — this number is already stale: ` +
      `state:read { cell: 'goal.portfolioThroughput', as: '${alert.goalId}' }`,
    meta: {
      dedupKind: 'goal-portfolio-idle',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:portfolio-idle`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      idleMinutes: alert.idleMinutes,
      idleAfterMinutes: alert.idleAfterMinutes,
      actsInWindow: alert.actsInWindow,
      lastActTool: alert.lastActTool,
      holders: alert.holders,
    },
  });
}

/** The default measurement — one resolver call per HELD goal, holders threaded in. */
function makeReadPortfolioThroughput(
  sql: Sql,
  idleAfterMs: number,
): GoalLivenessSweepDeps['readPortfolioThroughput'] {
  return async (holdersByGoal) => {
    const out = new Map<string, GoalPortfolioThroughputRead>();
    for (const [key, holders] of holdersByGoal) {
      try {
        out.set(
          key,
          await readGoalPortfolioThroughput(sql, {
            workspaceId: holders.workspaceId,
            goalId: holders.goalId,
            idleAfterMs,
            holders,
          }),
        );
      } catch (e) {
        // Per-goal failure is per-goal SILENCE, not a dead sweep: omitting the
        // key makes exactly this goal `not-measured` while the rest still report.
        console.warn(
          `[goal-liveness-watchdog] portfolio throughput read failed for ${key} (non-fatal): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return out;
  };
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_LIVENESS_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

function makeReadGoals(sql: Sql): GoalLivenessSweepDeps['readGoals'] {
  return async () => {
    // The status predicate is the SHARED declaration (P-005, D-009), not a bare
    // literal: a paused goal is exempt from this sweep on purpose, and that rule
    // now lives in one place that the in-memory classifier reads too.
    const goalRows = await sql<
      {
        id: string;
        workspace_id: string;
        title: string;
        status: string;
        install_slug: string | null;
        launch_settings: unknown;
        started_holder_owner_id: string | null;
        standing: boolean;
        updated_ms: string;
      }[]
    >`
      SELECT id, workspace_id, title, status, install_slug, launch_settings,
             metadata ->> 'agentOwnerId' AS started_holder_owner_id, standing,
             (extract(epoch FROM updated_at) * 1000)::bigint AS updated_ms
        FROM harness_shared.goals
       WHERE status = ANY(${[...GOAL_LIVENESS_SWEEP_STATUSES]}::text[])`;
    // Every goal-mode row in one read, via the canonical holder read (P-001);
    // joined in memory so a goal with NO holder row is still visible (an inner
    // join would silently drop the `unheld` case, which is one of the two
    // conditions this watchdog exists to report).
    const holders = await readGoalHolderRows(sql);
    const problems: LaunchSettingsProblem[] = [];
    const goals = goalRows.map((r) => {
      const parsed = parseGoalLaunchSettings(r.launch_settings, `goal ${r.id} launch_settings`);
      if (parsed.error != null || parsed.unknownKeys.length > 0) {
        problems.push({ goalId: r.id, workspaceId: r.workspace_id, title: r.title, parsed });
      }
      return {
        goalId: r.id,
        workspaceId: r.workspace_id,
        title: r.title,
        status: r.status,
        installSlug: r.install_slug,
        launchSettings: parsed.settings,
        startedHolderOwnerId: r.started_holder_owner_id,
        standing: r.standing,
        updatedAtMs: Number(r.updated_ms),
      };
    });
    // AFTER the map, and never thrown: a refused escalation must not cost the
    // sweep its read — the sweep is what keeps the holder alive.
    await Promise.all(
      problems.map((p) =>
        escalateLaunchSettingsProblem(p).catch((e: unknown) => {
          console.warn(
            `[goal-liveness-watchdog] could not escalate launch_settings problem on '${p.goalId}': ` +
              `${e instanceof Error ? e.message : String(e)} — ${p.parsed.error ?? `unknown keys ${p.parsed.unknownKeys.join(', ')}`}`,
          );
        }),
      ),
    );
    return { goals, holders };
  };
}

interface LaunchSettingsProblem {
  goalId: string;
  workspaceId: string;
  title: string;
  parsed: ParsedGoalLaunchSettings;
}

/**
 * WI-2140573 finding 2. A launch_settings document the reader could not honour
 * used to be one `console.warn` — "holder respawn stays disabled" — on a host
 * nobody tails, while the goal's safety net was silently OFF. It is now an
 * escalation, in two shapes:
 *
 *  - INVALID (a bad value): nothing the owner declared is in force; the goal
 *    resolves to the DEFAULT holder policy. A blocker — on the one goal that
 *    opted into `holder.onLoss='respawn'`, this is the respawner disarmed.
 *  - UNKNOWN KEYS ONLY: the lenient read put every known key in force and
 *    stripped the rest. Usually a key written by a NEWER schema than this
 *    host's bundle runs (deploy / restart the reader — measured live when
 *    `roles.goal.compactionLimit` landed before bg-host knew it), else a typo.
 *    Advisory, but loud: a key that binds nothing must never read as set.
 *
 * Dedup is openEscalation's (dedupKind, subjectSignature); the unknown-key
 * signature carries the SORTED key set, so a new unknown key re-escalates
 * while the same set stays one open item.
 */
async function escalateLaunchSettingsProblem(p: LaunchSettingsProblem): Promise<void> {
  const keys = [...p.parsed.unknownKeys].sort();
  if (p.parsed.error != null) {
    await openEscalation(WATCHDOG_IDENTITY, {
      severity: 'blocker',
      summary:
        `Goal '${p.goalId}' launch_settings is INVALID — nothing it declares is in force ` +
        `(holder respawn safety net OFF)`,
      body:
        `"${p.title}": ${p.parsed.error}\n\n` +
        (keys.length ? `Unknown keys stripped before the re-parse (NOT the cause): ${keys.join(', ')}\n\n` : '') +
        `Until the document parses, this goal resolves to the DEFAULT holder policy — its declared ` +
        `holder.onLoss, ceilings and launch profiles bind nothing. Repair it with ` +
        `goals:update { launchSettings } (the write boundary validates), or clear it back to "none declared".`,
      meta: {
        dedupKind: 'goal-launch-settings-invalid',
        subjectSignature: `${p.workspaceId}:${p.goalId}:launch-settings-invalid`,
        goalId: p.goalId,
        goalWorkspaceId: p.workspaceId,
        error: p.parsed.error,
        unknownKeys: keys,
      },
    });
    return;
  }
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${p.goalId}' launch_settings carries ${keys.length} key(s) this host does not recognise ` +
      `and IGNORES: ${keys.join(', ')}`,
    body:
      `"${p.title}": every KNOWN key is in force (lenient read); the keys above bind NOTHING on this host.\n\n` +
      `Most likely one of:\n` +
      `  • the key was written by a NEWER launch-settings schema than this host's bundle runs — ` +
      `deploy / restart the reader (dev:pipeline_position { path: 'packages/operator-core/lib/goal-launch-settings.ts' }) ` +
      `and this clears on its own;\n` +
      `  • a typo — repair it with goals:update { launchSettings } (the write boundary refuses unknown keys).\n\n` +
      `Do NOT treat the setting as configured until this escalation closes: that is exactly the ` +
      `"reads as set while doing nothing" state the strict schema exists to prevent.`,
    meta: {
      dedupKind: 'goal-launch-settings-unknown-keys',
      subjectSignature: `${p.workspaceId}:${p.goalId}:unknown-keys:${keys.join(',')}`,
      goalId: p.goalId,
      goalWorkspaceId: p.workspaceId,
      unknownKeys: keys,
    },
  });
}

/**
 * P-005 default `readReadiness`: derived on read per D-006, batched per
 * workspace (edges in one query, then one status resolve over the union of that
 * workspace's blocker endpoints). FAIL-SOFT by design: readiness is an additive
 * leg, and a degraded DAG read must not cost the liveness sweep — it warns and
 * returns what it has.
 */
function makeReadReadiness(sql: Sql): GoalLivenessSweepDeps['readReadiness'] {
  return async (goals) => {
    const out = new Map<string, GoalReadiness>();
    const tag = sql as unknown as GoalSqlTag;
    const byWorkspace = new Map<string, GoalRowLike[]>();
    for (const g of goals) {
      const arr = byWorkspace.get(g.workspaceId) ?? [];
      arr.push(g);
      byWorkspace.set(g.workspaceId, arr);
    }
    for (const [workspaceId, wsGoals] of byWorkspace) {
      try {
        const edges = await readGoalBlockedByEdges(tag, workspaceId);
        // Plain no-edge goals stay absent so the readiness leg remains quiet;
        // an explicit autoStart opt-in earns a synthetic actionable result.
        for (const g of wsGoals) {
          if ((edges.get(g.goalId) ?? []).length === 0 && g.launchSettings?.autoStart === true) {
            out.set(goalReadinessKey(g), goalReadiness([]));
          }
        }
        const withEdges = wsGoals.filter((g) => (edges.get(g.goalId) ?? []).length > 0);
        if (withEdges.length === 0) continue;
        // One status resolve over the union — goal cardinality is tiny (D-006).
        // Use the shared endpoint type, never a hand-narrowed copy of its `kind`
        // union: restating it here is what stranded this call site when the plan
        // kind was added (P-019), and the next kind would strand it again.
        const union = new Map<string, GoalBlockerEndpoint>();
        for (const g of withEdges) {
          for (const b of edges.get(g.goalId) ?? []) union.set(blockerStatusKey(b), b);
        }
        const statuses = await resolveBlockerStatuses(tag, workspaceId, [...union.values()]);
        for (const g of withEdges) {
          const blockers = edges.get(g.goalId) ?? [];
          out.set(
            goalReadinessKey(g),
            goalReadiness(
              blockers.map((b) => ({ ...b, status: statuses.get(blockerStatusKey(b)) ?? null })),
            ),
          );
        }
      } catch (e) {
        console.warn(
          `[goal-liveness-watchdog] readiness read failed for workspace ${workspaceId} (non-fatal, leg skipped): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  };
}

async function defaultEscalate(alert: GoalLivenessAlert): Promise<void> {
  const dark = formatDark(alert.darkMs);
  if (alert.reason === 'overlap') {
    await openEscalation(WATCHDOG_IDENTITY, {
      severity: 'blocker',
      summary:
        `Goal '${alert.goalId}' has multiple live GOAL holders beyond its elected handoff ` +
        `— overlap ${dark}`,
      body:
        `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) has one ` +
        `elected effective-holder lease, but these historical/current GOAL rows are still live ` +
        `outside the successor's explicit bounded handoff: ` +
        `${alert.holders.map((holder) => `${holder.ownerId} [${holder.sessionState}]`).join(', ')}.\n\n` +
        `Only the elected lease is sovereign. Stop or exit GOAL mode on the non-elected ` +
        `session(s); do not mint another holder. The goal-holder respawner is bound to the ` +
        `elected lease and will recover it if that owner is lost.`,
      meta: {
        dedupKind: 'goal-holder-overlap',
        subjectSignature: `${alert.workspaceId}:${alert.goalId}:overlap`,
        goalId: alert.goalId,
        goalWorkspaceId: alert.workspaceId,
        reason: alert.reason,
        overlapMs: alert.darkMs,
        holders: alert.holders,
      },
    });
    return;
  }
  const holderNote =
    alert.holders.length === 0
      ? 'No goal-mode holder row exists for it at all — it was never picked up.'
      : `Its goal-mode holder(s) resolve DEAD through the shared liveness oracle: ` +
        `${alert.holders.map((h) => `${h.ownerId} [${h.sessionState}]`).join(', ')}. ` +
        `The agent_modes row survives the session that wrote it, so every count-based ` +
        `surface still reports this goal as held.`;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is status=active but ${alert.reason === 'unheld' ? 'was never picked up' : 'has no live holder'} ` +
      `— dark ${dark}`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) has ` +
      `status='active' and nothing is working it. Last evidence anyone touched it: ` +
      `${new Date(alert.lastEvidenceMs).toISOString()} (${dark} ago).\n\n` +
      `${holderNote}\n\n` +
      `Triage — pick ONE, do not leave it in this state:\n` +
      `  • Still wanted? Take it: goals:start / mode:set { mode:'goal', subject:'${alert.goalId}' }.\n` +
      `  • Finished? Close it: goals:update { status:'done' }.\n` +
      `  • Abandoned? Close it against its kill criterion: goals:update { status:'dropped' }.\n\n` +
      `This is reported, never auto-relaunched: spawning an agent against a stale goal is a ` +
      `separate authority question. The defect being fixed is that nobody NOTICED — before this ` +
      `watchdog, the GOAL layer had no detector at all (routines:list { q:'goal' } → 0 rows) and ` +
      `the detection event for a multi-day-dark goal was a human happening to ask.`,
    meta: {
      dedupKind: 'goal-liveness',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.reason}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      reason: alert.reason,
      darkMs: alert.darkMs,
      holders: alert.holders,
    },
  });
}

/** P-005: the report-only readiness escalations. Same dedup surface as the liveness leg. */
async function defaultEscalateReadiness(alert: GoalReadinessAlert): Promise<void> {
  const blockerList = alert.blockers
    .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
    .join(', ');
  const isPremise = alert.kind === 'premise-invalidated';
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: isPremise
      ? `Goal '${alert.goalId}' premise INVALIDATED — killed blocker(s): ${blockerList}`
      : `Goal '${alert.goalId}' is now ACTIONABLE — every blocker satisfied, and nobody is on it`,
    body: isPremise
      ? `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) is blocked ` +
        `by ${blockerList} — KILLED, which invalidates this goal's premise (D-002: a killed ` +
        `blocker never silently unblocks; achieving and killing a prerequisite mean opposite ` +
        `things downstream).\n\n` +
        `Review — pick ONE, deliberately:\n` +
        `  • Premise survives anyway? Remove the edge: goals:update { blockedBy } without it.\n` +
        `  • Premise is gone? Kill the dependent too: goals:update { status:'killed' }.\n` +
        `  • Retarget: rewrite this goal against the world as it now is.\n\n` +
        `Reported, never auto-resolved: the substrate flags the premise for review and a human ` +
        `or the parent goal's agent decides.`
      : `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) declared ` +
        `prerequisites and they are now ALL satisfied: ${blockerList}. No live holder is on it.\n\n` +
        (alert.autoStartFailure
          ? `This goal opted into launch_settings.autoStart (P-020), but the automatic dispatch ` +
            `did not take it: ${alert.autoStartFailure}. Start it by hand or clear the refusal.\n\n`
          : '') +
        `This is a surfaced OFFER, not a dispatch (D-003 — readiness at goal level is an ` +
        `activation gate; goals never enter a claim queue and are not auto-started unless the ` +
        `goal itself opted in via launch_settings.autoStart, P-020):\n` +
        `  • Start it: goals:start — or mode:set { mode:'goal', subject:'${alert.goalId}' } for an ` +
        `existing session. If it was filed as a stub (D-004), activation is where the full ` +
        `kickoff contract runs — kill criterion, ceiling, consult, drain fleet — against the ` +
        `world as it NOW is.\n` +
        `  • Or leave it deliberately parked / re-scope it. Either is fine; the defect this ` +
        `report prevents is the goal unblocking with nobody NOTICING.`,
    meta: {
      dedupKind: 'goal-readiness',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.kind}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      kind: alert.kind,
      blockers: alert.blockers,
    },
  });
}

/**
 * The wedge leg's measurement, from the invocation ledger.
 *
 * ⚠ `call_origin IS DISTINCT FROM 'hook'`, NOT `<> 'hook'`. The exclusion of
 * hook-origin calls is the entire signal — a session that boots and immediately
 * dies still emits hook-fired calls, so a raw count is non-zero for a holder
 * that never ran an instruction of its own (measured: raw 3, agent-origin 0).
 * But `<> 'hook'` is FALSE for a NULL origin, which would silently drop those
 * rows and undercount toward a FALSE WEDGE — the one direction this leg must
 * never err in. `IS DISTINCT FROM` counts a NULL (and the `unknown`/`ui`
 * origins the column actually carries) as work, which errs toward silence.
 */
export function makeReadHolderProductivity(
  sql: Sql,
): GoalLivenessSweepDeps['readHolderProductivity'] {
  return async (holds) => {
    const out = new Map<string, number>();
    if (holds.length === 0) return out;

    // One hold per (goal, owner); an owner is answerable only for calls made
    // after IT picked the goal up, so `since` travels per-row, not as a floor.
    //
    // WI-42466: carried as ONE json parameter, NOT as four parallel
    // `unnest($1::text[], …)` arrays. The array form threw on every real tick —
    //   TypeError: The "string" argument must be of type string or an instance
    //   of Buffer or ArrayBuffer. Received an instance of Array
    //     at Buffer.byteLength → postgres/src/bytes.js str → Bind → prepared
    //     → ParameterDescription
    // — i.e. on the PREPARED-statement path the driver bound each array
    // parameter through a scalar string serializer. The caller catches that and
    // substitutes an empty map, which by design reads as "not measured" and
    // SUPPRESSES every wedge alert, so the only detector for a held-but-idle
    // holder was dark from 05:43Z with nothing failing except a log line.
    //
    // It survived review because the unit suite mocks `sql`: a mocked tag never
    // runs the serializer, and the fixture's own client does not use the
    // prepared path, so BOTH green paths missed it. The guard is therefore an
    // integration test that calls this through `getOrgPg().sql` specifically —
    // goal-holder-productivity.integration.test.ts.
    //
    // `jsonb_to_recordset` over a single `::text::jsonb` parameter is the
    // repo's existing idiom for the same shape (work-items-admission-promoter,
    // pilot-cohort): one scalar parameter, no array binding, explicit column
    // types at the SQL boundary.
    const holdRows = holds.map((h) => ({
      owner_id: h.ownerId,
      workspace_id: h.workspaceId,
      goal_id: h.goalId,
      since: new Date(h.setAtMs).toISOString(),
    }));

    const rows = await sql<{ goal_key: string; n: string }[]>`
      WITH holds AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(holdRows)}::text::jsonb)
          AS t(owner_id text, workspace_id text, goal_id text, since timestamptz)
      )
      SELECT h.workspace_id || ':' || h.goal_id AS goal_key,
             count(ti.id) AS n
        FROM holds h
        LEFT JOIN harness_shared.tool_invocations ti
               ON ti.coord_owner_id = h.owner_id
              AND ti.workspace_id   = h.workspace_id
              AND ti.invoked_at    >= h.since
              AND ti.call_origin IS DISTINCT FROM 'hook'
       GROUP BY 1`;

    for (const r of rows) out.set(r.goal_key, Number(r.n));
    return out;
  };
}

/**
 * Report-only. NEVER auto-respawns, and that is a decision, not an omission:
 * wedge causes are CORRELATED (one throttled account pool wedges every holder
 * launched against it at once), so a detector wired to relaunch would fire N
 * respawns straight back into the same wall. Recovery stays behind the separate
 * owner-authority GOAL_HOLDER_RESPAWN flag, which is default-OFF on purpose.
 */
async function defaultEscalateWedge(alert: GoalWedgeAlert): Promise<void> {
  const held = formatDark(alert.heldForMs);
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' is HELD but its holder has produced nothing in ${held}`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) has a ` +
      `LIVE holder — ${alert.holders.map((h) => `${h.ownerId} [${h.sessionState}]`).join(', ')} — ` +
      `and ${alert.agentOriginCalls} agent-origin tool calls since it picked the goal up ` +
      `${held} ago.\n\n` +
      `Present-but-unproductive is the gap between the two things every count-based ` +
      `surface already reports: the goal is not unheld and its holder is not dead, so no ` +
      `existing check fires. Hook-origin calls are excluded deliberately — a session that ` +
      `boots and fails its first turn still emits those, which is why a raw invocation ` +
      `count reads healthy for a holder that never ran an instruction of its own.\n\n` +
      `Triage — the cause is usually upstream of the agent, so read the error before ` +
      `relaunching anything:\n` +
      `  • Check the holder's first turn for a hard refusal (a rate-limited or credit-capped ` +
      `account pool, an invalid model spec). Three separate wedges of this shape had three ` +
      `DIFFERENT causes, and none was fixed by respawning.\n` +
      `  • Capacity walled? Fix the routing; a relaunch onto the same pool wedges again.\n` +
      `  • Genuinely stuck agent? Restart the holder deliberately.\n\n` +
      `Reported, never auto-relaunched: wedge causes are correlated, so an automatic ` +
      `respawn would relaunch every wedged holder into the same wall at once.`,
    meta: {
      dedupKind: 'goal-holder-wedge',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:wedged`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      agentOriginCalls: alert.agentOriginCalls,
      heldForMs: alert.heldForMs,
      holders: alert.holders,
    },
  });
}

function sweepDeps(
  sql: Sql,
  overrides: Partial<GoalLivenessSweepDeps>,
): GoalLivenessSweepDeps {
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness: resolveHolderLiveness,
    escalate: defaultEscalate,
    readReadiness: makeReadReadiness(sql),
    escalateReadiness: defaultEscalateReadiness,
    readHolderProductivity: makeReadHolderProductivity(sql),
    escalateWedge: defaultEscalateWedge,
    wedgeGraceMs: GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
    readPortfolioThroughput: makeReadPortfolioThroughput(sql, GOAL_PORTFOLIO_IDLE_AFTER_MS),
    escalatePortfolioIdle: defaultEscalatePortfolioIdle,
    portfolioIdleAfterMs: GOAL_PORTFOLIO_IDLE_AFTER_MS,
    startGoal: (input) => startGoalById(sql, input),
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...overrides,
  };
}

/**
 * One sweep: read active goals + their holder rows, resolve every holder through
 * the liveness oracle, escalate each goal with nobody alive on it.
 *
 * A failed escalate is swallowed per-alert so one bad row cannot cost the rest of
 * the batch; the escalation-side dedup makes the next tick's retry idempotent.
 * Exported for tests.
 */
export async function runGoalLivenessSweepOnce(
  sql: Sql,
  overrides: Partial<GoalLivenessSweepDeps> = {},
): Promise<{
  scanned: number;
  escalated: number;
  readinessEscalated: number;
  autoStarted: number;
  wedgeEscalated: number;
  portfolioIdleEscalated: number;
  skipped: boolean;
}> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return {
      scanned: 0,
      escalated: 0,
      readinessEscalated: 0,
      autoStarted: 0,
      wedgeEscalated: 0,
      portfolioIdleEscalated: 0,
      skipped: true,
    };
  }

  const { goals, holders } = await deps.readGoals();
  if (goals.length === 0) {
    return {
      scanned: 0,
      escalated: 0,
      readinessEscalated: 0,
      autoStarted: 0,
      wedgeEscalated: 0,
      portfolioIdleEscalated: 0,
      skipped: false,
    };
  }

  // Only resolve holders that actually point at an active goal — the agent_modes
  // read is unfiltered by design (so `unheld` stays visible), but there is no
  // reason to pay oracle cost for rows pointing at closed goals.
  const activeKeys = new Set(goals.map((g) => `${g.workspaceId}:${g.goalId}`));
  const relevant = holders.filter((h) => activeKeys.has(`${h.workspaceId}:${h.goalId}`));
  const verdicts = await deps.resolveLiveness([...new Set(relevant.map((h) => h.ownerId))]);

  const alerts = scanGoalLiveness(goals, relevant, verdicts, deps.now(), deps.graceMs);
  let escalated = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── P-005: the readiness leg — report-only by default ────────────────────
  // ── P-020: unless the goal opted into launch_settings.autoStart ──────────
  let readinessEscalated = 0;
  let autoStarted = 0;
  const readiness = await deps.readReadiness(goals);
  for (const g of goals) {
    const fold = resolveGoalHoldersFromRows(g.goalId, g.workspaceId, relevant, verdicts);
    const alert = classifyGoalReadiness(g, readiness.get(goalReadinessKey(g)), fold.liveness);
    if (!alert) continue;
    // P-020: the per-goal opt-in that upgrades the became-ready OFFER into a
    // dispatch through the one activation primitive (D-006). The primitive owns
    // every guard under its OWN reads (not-active / already-held / readiness
    // re-check), so a stale classification here costs a refusal, never a double
    // start. premise-invalidated NEVER dispatches — a killed blocker needs
    // review (D-002), and autoStart does not change that.
    if (alert.kind === 'became-ready' && g.launchSettings?.autoStart === true) {
      try {
        const started = await deps.startGoal({
          workspaceId: g.workspaceId,
          goalId: g.goalId,
          launcherOwnerId: `${WATCHDOG_IDENTITY.ownerId}:auto-start`,
        });
        if (started.ok) {
          autoStarted += 1;
          // Dispatched — the offer is moot; the next sweep sees the goal held.
          continue;
        }
        alert.autoStartFailure = `refused: ${started.reason} — ${started.detail}`;
      } catch (e) {
        alert.autoStartFailure = `launch threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Fall through: the offer escalation now carries WHY auto-start declined.
    }
    try {
      await deps.escalateReadiness(alert);
      readinessEscalated += 1;
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] readiness escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // ── the wedge leg — HELD goals whose holders produce nothing, report-only ──
  // Runs where the liveness leg stops: `classifyGoalLiveness` returns null the
  // instant a goal resolves `held`, so without this leg "somebody is on it" is
  // the end of the enquiry and a holder that never worked reads as healthy.
  let wedgeEscalated = 0;
  const holds: GoalLiveHold[] = [];
  /**
   * The SAME fold, kept for the portfolio leg below. Both legs judge exactly the
   * held goals, and re-folding for the second one would let two verdicts within
   * one tick disagree about who is held — which is the drift the shared
   * `resolveGoalHoldersFromRows` exists to prevent in the first place.
   */
  const heldHolders = new Map<string, GoalHolders>();
  for (const g of goals) {
    const fold = resolveGoalHoldersFromRows(g.goalId, g.workspaceId, relevant, verdicts);
    if (fold.liveness !== 'held') continue;
    heldHolders.set(goalReadinessKey(g), fold);
    for (const h of fold.live) {
      holds.push({
        workspaceId: g.workspaceId,
        goalId: g.goalId,
        ownerId: h.ownerId,
        setAtMs: h.setAtMs,
      });
    }
  }

  if (holds.length > 0) {
    // A degraded measurement must cost SILENCE, not a wave of false wedges: an
    // empty map makes every goal `not-measured`, which suppresses. Same rule as
    // the readiness leg's non-fatal skip.
    let productivity = new Map<string, number>();
    try {
      productivity = await deps.readHolderProductivity(holds);
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] holder-productivity read failed (non-fatal, wedge leg skipped): ${e instanceof Error ? e.message : String(e)}`,
      );
      productivity = new Map();
    }

    for (const g of goals) {
      const alert = classifyGoalWedge(
        g,
        relevant,
        verdicts,
        productivity,
        deps.now(),
        deps.wedgeGraceMs,
      );
      if (!alert) continue;
      try {
        await deps.escalateWedge(alert);
        wedgeEscalated += 1;
      } catch (e) {
        console.warn(
          `[goal-liveness-watchdog] wedge escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ── the PORTFOLIO-IDLE leg — held, WORKING, and placing nothing (P-002) ────
  // Runs over the same held population as the wedge leg above and answers the
  // question that leg cannot: not "has this holder ever worked" but "has it
  // placed anything lately". A steward can pass the first and fail this one for
  // hours, which is exactly what $109 bought.
  let portfolioIdleEscalated = 0;
  if (heldHolders.size > 0) {
    // Same conservative rule as every other leg: a degraded read costs SILENCE.
    // An empty map leaves every goal `not-measured`, which suppresses.
    let throughput = new Map<string, GoalPortfolioThroughputRead>();
    try {
      throughput = await deps.readPortfolioThroughput(heldHolders);
    } catch (e) {
      console.warn(
        `[goal-liveness-watchdog] portfolio-throughput read failed (non-fatal, portfolio leg skipped): ${e instanceof Error ? e.message : String(e)}`,
      );
      throughput = new Map();
    }

    for (const g of goals) {
      const alert = classifyGoalPortfolioIdle(g, relevant, verdicts, throughput, deps.now());
      if (!alert) continue;
      try {
        await deps.escalatePortfolioIdle(alert);
        portfolioIdleEscalated += 1;
      } catch (e) {
        console.warn(
          `[goal-liveness-watchdog] portfolio-idle escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return {
    scanned: goals.length,
    escalated,
    readinessEscalated,
    autoStarted,
    wedgeEscalated,
    portfolioIdleEscalated,
    skipped: false,
  };
}

/* ── P-009: opt-in holder recovery ───────────────────────────────────────── */

const HOLDER_RESPAWNER_IDENTITY: AgentIdentity = {
  ownerId: 'goal-holder-respawner',
  ownerLabel: 'system · goal holder respawner',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface GoalHolderRespawnSummary {
  scanned: number;
  eligible: number;
  attempted: number;
  respawned: number;
  launchFailed: number;
  attachFailed: number;
  /** Attach threw and durable authority could not be read; no cleanup was attempted. */
  attachUnresolved: number;
  neutralizeFailed: number;
  gaveUp: number;
  /** WI-2140573: live-but-idle holders woken with a retry brief instead of relaunched. */
  rekicked: number;
  /** Elected live holders that did not attest within the first-turn grace. */
  partialFirstTurn: number;
  /**
   * WI-2140573 finding 5: lost holders whose recovery was DEFERRED this tick
   * because every account the launch would draw on is measured unable to serve
   * (usage-walled or rate-paused). Nothing was spent: no re-kick, no damping
   * restart, no rate-cap slot, no launch.
   */
  deferredCapacity: number;
  skipped: boolean;
}

/** Process-local record of ONE goal's ongoing capacity deferral episode. */
export interface GoalHolderCapacityDeferral {
  sinceMs: number;
  lastLoggedAtMs: number;
  /** The verdict reason last logged; a change re-logs immediately. */
  reason: string;
  escalated: boolean;
  /**
   * Consecutive `clear` verdicts since the last deferred tick (hysteresis —
   * GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS). An `unknown` tick holds the
   * streak (it is not evidence either way); a deferred tick resets it.
   */
  clearStreak: number;
  /**
   * The last deferred verdict's `untilMs`. Once it has passed, a non-deferred
   * reading may close the episode even without a confirmed streak, so a wall
   * whose readings go stale after it lifts cannot hold recovery forever.
   */
  untilMs: number | null;
}

/** Process-local re-kick ledger for ONE goal: attempts against the CURRENT elected holder. */
export interface GoalHolderRekickState {
  ownerId: string;
  attemptsAtMs: number[];
}

export type GoalHolderRespawnRateDecision =
  | { kind: 'reserved'; attemptsInWindow: number }
  | { kind: 'capped'; attemptsInWindow: number }
  | { kind: 'ineligible'; attemptsInWindow: 0 };

export interface GoalHolderRespawnDeps {
  readGoals: GoalLivenessSweepDeps['readGoals'];
  resolveLiveness: GoalLivenessSweepDeps['resolveLiveness'];
  flagEnabled: () => Promise<boolean>;
  launch: (goal: GoalRowLike) => Promise<{ ownerId: string; warnings: string[] }>;
  attach: (
    goal: GoalRowLike,
    ownerId: string,
    expectedLease: GoalModeElectionExpectation | null,
  ) => Promise<GoalModeElectionReceipt | null | void>;
  /** Reconcile a thrown attach against the durable election before neutralizing. */
  readAuthority: (workspaceId: string, ownerId: string) => Promise<GoalHolderAuthority>;
  neutralize: (goal: GoalRowLike, ownerId: string, reason: string) => Promise<void>;
  notifyHandoff: (workspaceId: string, election: GoalModeElectionReceipt) => Promise<unknown>;
  attestHolder?: (
    goal: GoalRowLike,
    holder: GoalHolderRow,
  ) => Promise<GoalHolderFirstTurnAttestation>;
  /** Refreshes control context after the direct respawn GOAL-mode write. */
  refreshControlAnchor?: typeof refreshControlAnchorAfterMutation;
  /** Atomically reserve one durable per-goal launch slot before a process is minted. */
  reserveRateSlot?: (goal: GoalRowLike, nowMs: number) => Promise<GoalHolderRespawnRateDecision>;
  /** Move a capped goal onto the canonical non-terminal human-attention hold. */
  pauseNeedsHuman?: (goal: GoalRowLike, attemptsInWindow: number, nowMs: number) => Promise<boolean>;
  /**
   * Converge a needs-human latch that no health-gated branch below can reach.
   * Runs for EVERY swept goal, healthy or not — that is the whole point: the
   * escalate/pause branches sit under `healthy:false`, so a holder that
   * recovers after a failed pause write strands its latch permanently.
   */
  reconcileStrandedLatch?: (
    goal: GoalRowLike,
    nowMs: number,
  ) => Promise<GoalHolderRespawnLatchReconciliation>;
  escalateGiveUp: (goal: GoalRowLike, restartsInWindow: number) => Promise<void>;
  /**
   * WI-2140573: wake a live-but-idle elected holder with a retry brief. Default
   * persists a directed message and fires the holder's always-armed inbox-wake,
   * the same delivery seam the stand-down handoff uses. Never launches.
   */
  rekick?: (
    goal: GoalRowLike,
    ownerId: string,
    attempt: number,
    attestation?: GoalHolderFirstTurnAttestation,
  ) => Promise<{ woken: number; staged: number }>;
  /** Re-kick ledger, keyed like `states`; a new elected holder starts a fresh budget. */
  rekickStates?: Map<string, GoalHolderRekickState>;
  /**
   * WI-2140573 finding 5: can a holder launched for this goal reach the model
   * at all right now? Default folds the goal's holder-role launch profile and
   * judges it against the live `accounts:status` rows. A `deferred` verdict
   * skips the whole recovery path for this tick without spending anything; a
   * thrown read is logged and treated as `unknown` (proceed), never as a wall.
   */
  assessLaunchCapacity?: (goal: GoalRowLike) => Promise<GoalHolderLaunchCapacityVerdict>;
  /** Deduped owner escalation for a deferral episode (usage wall: at once; rate pause: after the budget). */
  escalateCapacityDeferral?: (
    goal: GoalRowLike,
    verdict: Extract<GoalHolderLaunchCapacityVerdict, { kind: 'deferred' }>,
    deferredForMs: number,
  ) => Promise<void>;
  /** Deferral episodes, keyed like `states`. */
  capacityDeferrals?: Map<string, GoalHolderCapacityDeferral>;
  now: () => number;
  states: Map<string, FlapDampingState>;
}

/** Stable state identity: goal ids are only unique inside a workspace. */
export function goalHolderRespawnKey(
  goal: Pick<GoalRowLike, 'workspaceId' | 'goalId'>,
): string {
  return `${goal.workspaceId}:${goal.goalId}`;
}

/**
 * What a stranded needs-human latch should converge to. `noop` is the ordinary
 * case (no latch, or one that already carries its durable escalation stamp).
 */
export type GoalHolderRespawnLatchReconciliation =
  | { kind: 'noop' }
  | { kind: 'cleared'; attemptsInWindow: number }
  | { kind: 'escalate'; attemptsInWindow: number };

/**
 * Converge a STRANDED needs-human latch — `needsHuman:true` with no
 * `escalatedAtMs` behind it.
 *
 * WHY THIS EXISTS (measured 2026-09-20T15:52Z on goal
 * work-on-everything-fresh-grading-and-improvement-60d3a8): the capped and
 * give-up branches in the respawn sweep are reachable ONLY below
 * `decideFlapDamping({ healthy: false })`. When the pause write throws, the
 * handler clears the in-memory latch and `continue`s "so the next tick
 * retries" — but the next tick only re-enters that branch if the holder is
 * STILL judged unhealthy. That goal's holder recovered, so the branch was
 * never re-entered: `needsHuman:true` survived for 7h with no escalation
 * stamp, and `reserveGoalHolderRespawnRateSlot`'s clearing ELSE could not run
 * either (it is reached only from the same restart path). A stranded latch
 * could therefore neither escalate NOR clear. The specific throw that day was
 * an uncast `jsonb_build_object` parameter (fixed since, and guarded by the
 * NEGATIVE CONTROL in goal-holder-respawn.integration.test.ts) — but ANY
 * future throw strands a goal identically, which is what this repairs.
 *
 * It is deliberately driven by the ATTEMPT WINDOW, not by holder health, so it
 * cannot hand back a fresh safety budget early:
 *  - attempts aged out of the window (the cap no longer holds) => CLEAR, the
 *    exact semantics `reserveGoalHolderRespawnRateSlot`'s ELSE already encodes;
 *  - the cap still holds => ESCALATE, i.e. re-drive the escalate+pause the
 *    original tick intended and dropped. Bounded either way: an unrepaired
 *    latch converges within one rate window instead of latching forever.
 *
 * Idempotent by construction: a latch that already carries `escalatedAtMs`
 * does not match, so a re-drive cannot double-pause or re-stamp.
 */
export async function reconcileStrandedGoalHolderRespawnLatch(
  sql: Sql,
  goal: Pick<GoalRowLike, 'goalId' | 'workspaceId'>,
  nowMs: number,
): Promise<GoalHolderRespawnLatchReconciliation> {
  const cutoffMs = nowMs - GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS;
  // Same variadic-"any" cast discipline as the pause writer below: every bare
  // parameter inside jsonb_build_object carries a cast, or Postgres rejects the
  // whole statement at PARSE time. That failure is precisely what stranded the
  // latch this function exists to converge, so re-introducing it here would
  // disable the repair by the same mechanism it repairs.
  const [row] = await sql<Array<{ outcome: string; attempts_in_window: string }>>`
    WITH candidate AS (
      SELECT id,
             workspace_id,
             CASE WHEN jsonb_typeof(metadata) = 'object'
                  THEN metadata ELSE '{}'::jsonb END AS base_metadata
        FROM harness_shared.goals
       WHERE id = ${goal.goalId}
         AND workspace_id = ${goal.workspaceId}
         AND status = 'active'
         AND metadata #>> '{holderRespawn,needsHuman}' = 'true'
         -- STRANDED = flagged with no USABLE escalation stamp. Testing the type
         -- rather than plain IS NULL also catches an explicit JSON null or a
         -- garbage value, both as unactionable as an absent stamp.
         AND jsonb_typeof(metadata #> '{holderRespawn,escalatedAtMs}') IS DISTINCT FROM 'number'
       FOR UPDATE
    ), state AS (
      SELECT c.*,
             CASE WHEN jsonb_typeof(c.base_metadata -> 'holderRespawn') = 'object'
                  THEN c.base_metadata -> 'holderRespawn' ELSE '{}'::jsonb END AS base_state,
             CASE WHEN jsonb_typeof(c.base_metadata #> '{holderRespawn,attempts}') = 'array'
                  THEN c.base_metadata #> '{holderRespawn,attempts}' ELSE '[]'::jsonb END AS raw_attempts
        FROM candidate c
    ), pruned AS (
      SELECT s.*,
             COALESCE(
               (SELECT jsonb_agg(value ORDER BY (value #>> '{}')::numeric)
                  FROM jsonb_array_elements(s.raw_attempts) AS value
                 WHERE jsonb_typeof(value) = 'number'
                   AND (value #>> '{}')::numeric >= ${cutoffMs}::numeric),
               '[]'::jsonb
             ) AS attempts
        FROM state s
    ), decision AS (
      SELECT p.*, jsonb_array_length(p.attempts) AS attempt_count
        FROM pruned p
    ), cleared AS (
      -- A data-modifying CTE runs exactly once whether or not the primary
      -- query reads it, so the clear commits without a second round trip.
      UPDATE harness_shared.goals AS g
         SET metadata = jsonb_set(
               d.base_metadata,
               '{holderRespawn}',
               (d.base_state - 'needsHumanAtMs' - 'escalatedAtMs' - 'reason') ||
                 jsonb_build_object(
                   'attempts', d.attempts,
                   'needsHuman', false
                 ),
               true
             )
        FROM decision d
       WHERE g.id = d.id
         AND g.workspace_id = d.workspace_id
         AND d.attempt_count < ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}::int
      RETURNING g.id
    )
    SELECT CASE WHEN d.attempt_count >= ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}::int
                THEN 'escalate' ELSE 'cleared' END AS outcome,
           d.attempt_count::text AS attempts_in_window
      FROM decision d
  `;
  if (!row) return { kind: 'noop' };
  const attemptsInWindow = Number(row.attempts_in_window);
  return row.outcome === 'escalate'
    ? { kind: 'escalate', attemptsInWindow }
    : { kind: 'cleared', attemptsInWindow };
}

/**
 * Atomically reserve one launch in the goal row's durable trailing-hour ledger.
 * The reservation happens before launch so a crash or failed attach cannot
 * erase a session-minting attempt from the safety budget.
 */
export async function reserveGoalHolderRespawnRateSlot(
  sql: Sql,
  goal: Pick<GoalRowLike, 'goalId' | 'workspaceId'>,
  nowMs: number,
): Promise<GoalHolderRespawnRateDecision> {
  const cutoffMs = nowMs - GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS;
  const [row] = await sql<Array<{ allowed: boolean; attempts_in_window: string }>>`
    WITH candidate AS (
      SELECT id,
             workspace_id,
             CASE WHEN jsonb_typeof(metadata) = 'object'
                  THEN metadata ELSE '{}'::jsonb END AS base_metadata
        FROM harness_shared.goals
       WHERE id = ${goal.goalId}
         AND workspace_id = ${goal.workspaceId}
         AND status = 'active'
       FOR UPDATE
    ), state AS (
      SELECT c.*,
             CASE WHEN jsonb_typeof(c.base_metadata -> 'holderRespawn') = 'object'
                  THEN c.base_metadata -> 'holderRespawn' ELSE '{}'::jsonb END AS base_state,
             CASE WHEN jsonb_typeof(c.base_metadata #> '{holderRespawn,attempts}') = 'array'
                  THEN c.base_metadata #> '{holderRespawn,attempts}' ELSE '[]'::jsonb END AS raw_attempts
        FROM candidate c
    ), pruned AS (
      SELECT s.*,
             COALESCE(
               (SELECT jsonb_agg(value ORDER BY (value #>> '{}')::numeric)
                  FROM jsonb_array_elements(s.raw_attempts) AS value
                 WHERE jsonb_typeof(value) = 'number'
                   AND (value #>> '{}')::numeric >= ${cutoffMs}),
               '[]'::jsonb
             ) AS attempts
        FROM state s
    ), decision AS (
      SELECT p.*, jsonb_array_length(p.attempts) AS attempt_count
        FROM pruned p
    )
    UPDATE harness_shared.goals AS g
       SET metadata = jsonb_set(
             d.base_metadata,
             '{holderRespawn}',
             CASE WHEN d.attempt_count >= ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}
               THEN d.base_state || jsonb_build_object(
                 'attempts', d.attempts,
                 'limit', ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}::bigint,
                 'windowMs', ${GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS}::bigint,
                 'needsHuman', true,
                 'needsHumanAtMs', COALESCE(
                   d.base_state -> 'needsHumanAtMs',
                   to_jsonb(${nowMs}::bigint)
                 ),
                 'reason', 'hourly-respawn-cap'
               )
               ELSE (d.base_state - 'needsHumanAtMs' - 'escalatedAtMs' - 'reason') ||
                 jsonb_build_object(
                   'attempts', d.attempts || jsonb_build_array(${nowMs}::bigint),
                   'limit', ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}::bigint,
                   'windowMs', ${GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS}::bigint,
                   'needsHuman', false
                 )
             END,
             true
           ),
           -- A reservation is bookkeeping, not goal progress. Only the cap
           -- transition may refresh recency.
           updated_at = CASE
             WHEN d.attempt_count >= ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}
               THEN to_timestamp(${nowMs}::double precision / 1000.0)
             ELSE g.updated_at
           END
      FROM decision d
     WHERE g.id = d.id AND g.workspace_id = d.workspace_id
    RETURNING (d.attempt_count < ${GOAL_HOLDER_RESPAWN_RATE_LIMIT}) AS allowed,
              (d.attempt_count + CASE
                WHEN d.attempt_count < ${GOAL_HOLDER_RESPAWN_RATE_LIMIT} THEN 1 ELSE 0
              END)::text AS attempts_in_window
  `;
  if (!row) return { kind: 'ineligible', attemptsInWindow: 0 };
  const attemptsInWindow = Number(row.attempts_in_window);
  const decision: GoalHolderRespawnRateDecision = row.allowed
    ? { kind: 'reserved', attemptsInWindow }
    : { kind: 'capped', attemptsInWindow };
  await appendGoalWriteAudit(sql as unknown as GoalSqlTag, {
    workspaceId: goal.workspaceId,
    goalId: goal.goalId,
    author: HOLDER_RESPAWNER_IDENTITY.ownerId,
    writeKind: 'holder-respawn-reserve',
    actorClass: 'holder-agent-respawner',
    detail: `${decision.kind}; attemptsInWindow=${attemptsInWindow}`,
    atMs: nowMs,
  }).catch((error) => {
    console.warn(
      `[goal-liveness-watchdog] goal:write reserve audit failed for ${goal.goalId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return decision;
}

/**
 * Goals have no `needs-human` status. Their canonical non-terminal hold is
 * `paused`; this marker preserves the stronger reason while the shared stop
 * executor gates placement and disarms attributed loops.
 */
export async function pauseGoalForHolderRespawnRateCap(
  sql: Sql,
  goal: Pick<GoalRowLike, 'goalId' | 'workspaceId'>,
  attemptsInWindow: number,
  nowMs: number,
): Promise<boolean> {
  const reason =
    `Automatic holder recovery reached its safety cap (${attemptsInWindow}/` +
    `${GOAL_HOLDER_RESPAWN_RATE_LIMIT} attempts in ${GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS / 60_000} minutes); ` +
    'human review is required before this goal is resumed.';
  const pause = {
    reason,
    pausedBy: HOLDER_RESPAWNER_IDENTITY.ownerId,
    pausedAtMs: nowMs,
  };
  // EVERY bare parameter inside jsonb_build_object below MUST carry a cast. That function is
  // VARIADIC "any", so an uncast parameter has no argument type to resolve against and Postgres
  // rejects the statement at PARSE time — "could not determine data type of parameter $N" — on
  // every call, before a single row is examined. postgres.js sends type OID 0 for a JS number or
  // string (see inferType), so the cast is the only thing that supplies a type; boolean, bigint,
  // Date and sql.json() carry their own OID and are safe uncast.
  //
  // This is the THIRD occurrence of that class. WI-37757 (validate-active-routines) was the
  // first and work-items.ts refreshPlanLinkedFeatureWorkItem the second; each shipped because
  // the only test covering it mocked `sql`, which cannot observe a PARSE failure by construction.
  // sql-variadic-any-uncast-param.test.ts is the standing class guard.
  const [changed] = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.goals
       SET status = 'paused',
           updated_at = to_timestamp(${nowMs}::double precision / 1000.0),
           metadata = jsonb_set(
             jsonb_set(
               CASE WHEN jsonb_typeof(metadata) = 'object'
                    THEN metadata ELSE '{}'::jsonb END,
               '{holderRespawn}',
               (CASE WHEN jsonb_typeof(metadata -> 'holderRespawn') = 'object'
                     THEN metadata -> 'holderRespawn' ELSE '{}'::jsonb END) ||
                 ${JSON.stringify({ needsHuman: true })}::text::jsonb ||
                 jsonb_build_object(
                   'escalatedAtMs', ${nowMs}::bigint,
                   'attemptsInWindow', ${attemptsInWindow}::int
                 ),
               true
             ),
             '{pause}',
             ${JSON.stringify(pause)}::text::jsonb,
             true
           )
     WHERE id = ${goal.goalId}
       AND workspace_id = ${goal.workspaceId}
       AND status = 'active'
       AND metadata #>> '{holderRespawn,needsHuman}' = 'true'
    RETURNING id
  `;
  if (!changed) return false;

  await appendGoalWriteAudit(sql as unknown as GoalSqlTag, {
    workspaceId: goal.workspaceId,
    goalId: goal.goalId,
    author: HOLDER_RESPAWNER_IDENTITY.ownerId,
    writeKind: 'holder-respawn-pause',
    actorClass: 'holder-agent-respawner',
    detail: `needs-human pause after ${attemptsInWindow} attempts`,
    atMs: nowMs,
  }).catch((error) => {
    console.warn(
      `[goal-liveness-watchdog] goal:write pause audit failed for ${goal.goalId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const executor = getGoalTransitionExecutor();
  if (!executor) {
    throw new Error('goal moved to needs-human pause, but no goal-stop executor is installed');
  }
  const stopped = await executor({
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    status: 'paused',
    actor: HOLDER_RESPAWNER_IDENTITY.ownerId,
  });
  if ('unattributedActiveLoops' in stopped && stopped.degraded) {
    throw new Error(
      `goal moved to needs-human pause, but stop fan-out was degraded ` +
        `(${stopped.unattributedActiveLoops} unattributed loop(s) remain)`,
    );
  }
  return true;
}

/**
 * Eligibility is intentionally narrower than "has no holder".
 *
 * Only an administratively ACTIVE goal that explicitly earned the `respawn`
 * disposition may spend money. `requireLive:false` opts out, while an absent or
 * invalid launch document resolves to the safe default (`deactivate`).
 */
export function goalEligibleForHolderRespawn(goal: GoalRowLike): boolean {
  if (goal.status !== 'active') return false;
  const policy = resolveGoalHolderPolicy(goal.launchSettings);
  return policy.requireLive && policy.onLoss === 'respawn';
}

async function defaultHolderRespawnFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_HOLDER_RESPAWN, 'system');
  } catch {
    // This is an unattended spend path. Flag uncertainty is a hard no-op.
    return false;
  }
}

async function defaultEscalateHolderRespawnGiveUp(
  goal: GoalRowLike,
  restartsInWindow: number,
): Promise<void> {
  await openEscalation(HOLDER_RESPAWNER_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${goal.goalId}' holder recovery reached its hourly safety cap after ` +
      `${restartsInWindow} attempts`,
    body:
      `The goal "${goal.title}" (${goal.goalId}, workspace ${goal.workspaceId}) opted into ` +
      `holder.onLoss='respawn', but ${restartsInWindow} replacement launches fell inside the ` +
      `${GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS / 60_000}-minute durable rate window. Automatic ` +
      `recovery is stopped and the goal is moving to a needs-human pause. Inspect launch/attach ` +
      `warnings, then deliberately resume the goal after restoring a holder or changing its ` +
      `holder policy.`,
    meta: {
      dedupKind: 'goal-holder-respawn-give-up',
      subjectSignature: `${goal.workspaceId}:${goal.goalId}`,
      goalId: goal.goalId,
      goalWorkspaceId: goal.workspaceId,
      restartsInWindow,
    },
  });
}

const goalHolderRespawnStates = new Map<string, FlapDampingState>();
const goalHolderRekickStates = new Map<string, GoalHolderRekickState>();
const goalHolderCapacityDeferrals = new Map<string, GoalHolderCapacityDeferral>();

/**
 * WI-2140573 finding 5: the owner-facing record of a capacity deferral. Deduped
 * on the goal so a days-long wall is ONE escalation with a repeat count, not one
 * per tick. It names the accounts, the reset, and the three ways out — and says
 * plainly that recovery resumes on its own when capacity returns, so nobody
 * "fixes" it by respawning into the same wall.
 */
async function defaultEscalateHolderCapacityDeferral(
  goal: GoalRowLike,
  verdict: Extract<GoalHolderLaunchCapacityVerdict, { kind: 'deferred' }>,
  deferredForMs: number,
): Promise<void> {
  const now = Date.now();
  const provider = verdict.target.provider ?? 'unknown';
  const pinned = verdict.target.accountId ? `pinned account '${verdict.target.accountId}'` : `the '${provider}' pool`;
  const wall = verdict.binding === 'usage-wall' ? 'USAGE-WALLED' : 'RATE-PAUSED';
  await openEscalation(HOLDER_RESPAWNER_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${goal.goalId}' has no live holder and recovery is DEFERRED: ${pinned} is ${wall} ` +
      `until ${formatCapacityUntil(verdict.untilMs, now)}`,
    body:
      `The goal "${goal.title}" (${goal.goalId}, workspace ${goal.workspaceId}) opted into ` +
      `holder.onLoss='respawn' and its holder is lost, but every account a replacement would ` +
      `launch on (${verdict.accountIds.join(', ')} — ${pinned}, agent '${verdict.target.agent ?? 'unset'}') ` +
      `is measured unable to serve: ${verdict.reason}\n\n` +
      `A launch now would boot, send its kickoff, and die at the model layer before its first turn ` +
      `(measured 2026-09-02: nine such holders in 3.5h, each an 11-line rollout with zero assistant ` +
      `turns — "You've hit your usage limit"). So the respawner is NOT launching: no re-kick, no ` +
      `damping restart, no hourly rate-cap slot, no launch, for as long as the wall holds ` +
      `(deferred ${Math.round(deferredForMs / 60_000)} min so far). Recovery resumes AUTOMATICALLY ` +
      `on the first tick that measures capacity back (${formatCapacityUntil(verdict.untilMs, now)}).\n\n` +
      `Ways out, any one of them:\n` +
      `  • add capacity on '${provider}' (a fresh subscription / credits) — accounts:register / accounts:status;\n` +
      `  • re-point the holder: goals:update { id: '${goal.goalId}', launchSettings } with roles.goal.agent / ` +
      `model / account on a provider that has headroom (the next tick launches onto it);\n` +
      `  • wait for the window reset above — nothing else is needed.\n` +
      `Do NOT respawn by hand into the same wall; it costs a launch and a rate-cap slot and produces nothing.`,
    meta: {
      dedupKind: 'goal-holder-respawn-capacity-deferred',
      subjectSignature: `${goal.workspaceId}:${goal.goalId}:${verdict.binding}`,
      goalId: goal.goalId,
      goalWorkspaceId: goal.workspaceId,
      provider,
      accountIds: verdict.accountIds,
      binding: verdict.binding,
      untilMs: verdict.untilMs,
      deferredForMs,
    },
  });
}

/**
 * WI-2140573 default re-kick: the retry brief a live-but-idle holder needs.
 * Delivered exactly like the stand-down handoff (`notifyGoalHolderHandoff`):
 * a durable directed message the agent can re-read, plus the inbox-wake that
 * turns it into a turn. If the model upstream is still down the wake's turn
 * dies the same way the kickoff did — that is fine, it cost no launch, and the
 * next spaced attempt lands once the upstream is back.
 */
async function defaultRekickGoalHolder(
  goal: GoalRowLike,
  ownerId: string,
  attempt: number,
  attestation?: GoalHolderFirstTurnAttestation,
): Promise<{ woken: number; staged: number }> {
  if (attestation) {
    const summary = `GOAL holder first-turn recovery ${attempt}/${GOAL_HOLDER_REKICK_MAX}: ${goal.goalId}`;
    const body =
      `You are the elected holder for GOAL '${goal.goalId}', but the first-turn attestation ` +
      `remains partial after its grace period. Missing: ${attestation.missing.join(', ')}. ` +
      `Check the exact GOAL subject, arm a durable loop, write loop:checkpoint, and complete ` +
      `one successful goal-scoped portfolio act. A read or report alone does not place work. ` +
      `This is attempt ${attempt}/${GOAL_HOLDER_REKICK_MAX}; the existing respawner may ` +
      `elect a replacement if the evidence remains partial.`;
    await sendMessage(HOLDER_RESPAWNER_IDENTITY, { to: [ownerId], summary, body });
    const result = await wakeRecipients([ownerId], {
      summary, payload: { action: 'rekick', goalId: goal.goalId, attempt, max: GOAL_HOLDER_REKICK_MAX,
        missing: attestation.missing },
      source: HOLDER_RESPAWNER_IDENTITY.ownerId, workspaceId: goal.workspaceId,
    });
    return { woken: result.woken, staged: result.staged };
  }
  const summary =
    `GOAL holder re-kick ${attempt}/${GOAL_HOLDER_REKICK_MAX}: '${goal.goalId}' — you are the ` +
    `elected holder, but this session produced no output and nothing is armed to wake it`;
  const body =
    `You hold GOAL '${goal.goalId}' ("${goal.title}", workspace ${goal.workspaceId}) as its ` +
    `elected holder, but the goal-holder respawner sees a LIVE session that never completed a ` +
    `productive turn: no loop armed, no standing event await, no recent activity. The measured ` +
    `cause (2026-09-01) is a kickoff turn that died at the model layer ("We're currently ` +
    `experiencing high demand") — the agent gave up after retries and the goal brief was never ` +
    `acted on; the other is settling a turn without arming a loop.\n\n` +
    `Do now: (1) re-read the GOAL kickoff brief at the top of this session, or fetch it with ` +
    `goals:get { id: '${goal.goalId}', detail: 'full' }; (2) coord:orient; (3) loop:arm ` +
    `{ intervalSec: 60, goal: '<one line>' } so a cadence re-wakes you; (4) continue the ` +
    `goal-mode duties (create, place, arbitrate, kill — never implement). If this reaches you ` +
    `mid-work, only make sure your loop is armed.\n\n` +
    `This is re-kick ${attempt} of ${GOAL_HOLDER_REKICK_MAX}; when that budget is spent with the ` +
    `session still idle, the respawner replaces it with a fresh launch.`;
  await sendMessage(HOLDER_RESPAWNER_IDENTITY, { to: [ownerId], summary, body });
  const result = await wakeRecipients([ownerId], {
    summary,
    payload: {
      action: 'rekick',
      goalId: goal.goalId,
      attempt,
      max: GOAL_HOLDER_REKICK_MAX,
    },
    source: HOLDER_RESPAWNER_IDENTITY.ownerId,
    workspaceId: goal.workspaceId,
  });
  return { woken: result.woken, staged: result.staged };
}

function holderRespawnDeps(
  sql: Sql,
  overrides: Partial<GoalHolderRespawnDeps>,
): GoalHolderRespawnDeps {
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness: resolveHolderLiveness,
    flagEnabled: defaultHolderRespawnFlagEnabled,
    launch: async (goal) =>
      await launchGoalHolderSession({
        workspaceId: goal.workspaceId,
        goalId: goal.goalId,
        harnessSlug: goal.installSlug ?? '',
      }),
    attach: async (goal, ownerId, expectedLease) => {
      const result = await setMode({
        workspaceId: goal.workspaceId,
        ownerId,
        modeId: 'goal',
        enabled: true,
        reason: `goal-holder-respawner recovered lost holder for ${goal.goalId}`,
        setBy: HOLDER_RESPAWNER_IDENTITY.ownerId,
        ownerDirected: false,
        subject: goal.goalId,
        ...(expectedLease ? { goalElectionExpectation: expectedLease } : {}),
        sql,
      });
      if (!result.ok) {
        throw new Error(
          'error' in result && result.error
            ? result.error
            : `mode store refused GOAL attachment for ${ownerId}`,
        );
      }
      return result.goalElection ?? null;
    },
    readAuthority: async (workspaceId, ownerId) =>
      await readGoalHolderAuthority(sql, workspaceId, ownerId),
    neutralize: async (goal, ownerId, reason) => {
      await neutralizeGoalHolderSession({
        workspaceId: goal.workspaceId,
        goalId: goal.goalId,
        ownerId,
        reason,
      });
    },
    notifyHandoff: notifyGoalHolderHandoff,
    attestHolder: async (goal, holder) => await readGoalHolderFirstTurnAttestation(sql, {
      workspaceId: goal.workspaceId, goalId: goal.goalId, holder,
    }),
    reserveRateSlot: async (goal, nowMs) => await reserveGoalHolderRespawnRateSlot(sql, goal, nowMs),
    reconcileStrandedLatch: async (goal, nowMs) =>
      await reconcileStrandedGoalHolderRespawnLatch(sql, goal, nowMs),
    pauseNeedsHuman: async (goal, attemptsInWindow, nowMs) =>
      await pauseGoalForHolderRespawnRateCap(sql, goal, attemptsInWindow, nowMs),
    escalateGiveUp: defaultEscalateHolderRespawnGiveUp,
    rekick: defaultRekickGoalHolder,
    rekickStates: goalHolderRekickStates,
    assessLaunchCapacity: async (goal) => await assessGoalHolderLaunchCapacityForGoal(goal),
    escalateCapacityDeferral: defaultEscalateHolderCapacityDeferral,
    capacityDeferrals: goalHolderCapacityDeferrals,
    now: Date.now,
    states: goalHolderRespawnStates,
    ...overrides,
  };
}

/**
 * One recovery tick. This is deliberately separate from the 10-minute reporting
 * sweep: recovery has its own default-OFF authority flag, 60-second cadence and
 * state. A report-only kill-switch can therefore never accidentally arm spend.
 */
export async function runGoalHolderRespawnOnce(
  sql: Sql,
  overrides: Partial<GoalHolderRespawnDeps> = {},
): Promise<GoalHolderRespawnSummary> {
  const deps = holderRespawnDeps(sql, overrides);
  const pauseNeedsHuman = async (goal: GoalRowLike, attemptsInWindow: number): Promise<void> => {
    const paused = await (deps.pauseNeedsHuman ?? (async () => false))(
      goal, attemptsInWindow, deps.now(),
    );
    if (!paused) {
      throw new Error(`needs-human pause matched no active, flagged goal row for ${goal.goalId}`);
    }
  };
  const summary: GoalHolderRespawnSummary = {
    scanned: 0,
    eligible: 0,
    attempted: 0,
    respawned: 0,
    launchFailed: 0,
    attachFailed: 0,
    attachUnresolved: 0,
    neutralizeFailed: 0,
    gaveUp: 0,
    rekicked: 0,
    partialFirstTurn: 0,
    deferredCapacity: 0,
    skipped: false,
  };
  if (!(await deps.flagEnabled())) return { ...summary, skipped: true };
  const rekickStates = deps.rekickStates ?? new Map<string, GoalHolderRekickState>();
  const capacityDeferrals = deps.capacityDeferrals ?? new Map<string, GoalHolderCapacityDeferral>();

  const { goals, holders } = await deps.readGoals();
  summary.scanned = goals.length;
  const eligible = goals.filter(goalEligibleForHolderRespawn);
  summary.eligible = eligible.length;
  const eligibleKeys = new Set(eligible.map(goalHolderRespawnKey));

  // A goal that was paused/closed or opted out starts fresh if it later earns
  // recovery again. This also bounds the process-local map to currently eligible rows.
  for (const key of deps.states.keys()) {
    if (!eligibleKeys.has(key)) deps.states.delete(key);
  }
  for (const key of rekickStates.keys()) {
    if (!eligibleKeys.has(key)) rekickStates.delete(key);
  }
  for (const key of capacityDeferrals.keys()) {
    if (!eligibleKeys.has(key)) capacityDeferrals.delete(key);
  }
  if (eligible.length === 0) return summary;

  const relevant = holders.filter((holder) =>
    eligibleKeys.has(`${holder.workspaceId}:${holder.goalId}`),
  );
  const ownerIds = [...new Set(relevant.map((holder) => holder.ownerId))];
  const verdicts = ownerIds.length > 0
    ? await deps.resolveLiveness(ownerIds)
    : new Map<string, LivenessVerdict>();

  for (const goal of eligible) {
    const key = goalHolderRespawnKey(goal);
    const fold = resolveGoalHoldersFromRows(
      goal.goalId,
      goal.workspaceId,
      relevant,
      verdicts,
    );

    // Converge a STRANDED needs-human latch BEFORE any health gate below.
    // Every branch that can escalate or clear the latch sits under
    // `decideFlapDamping({ healthy: false })`, so a holder that RECOVERS after a
    // failed pause write would otherwise carry `needsHuman:true` forever with no
    // escalation stamp behind it, and the clearing ELSE in the reservation is
    // reached only from that same restart path. Running first is the point: a
    // recovered holder is precisely the case every branch below skips.
    try {
      const latch = await (deps.reconcileStrandedLatch ?? (async () => ({ kind: 'noop' }) as const))(
        goal,
        deps.now(),
      );
      if (latch.kind === 'escalate') {
        // The cap still holds, so re-drive the escalate+pause this goal never
        // durably received. Both halves are safe to repeat: openEscalation
        // dedups on subjectSignature, and the pause WHERE guard matches only a
        // latch that still has no escalatedAtMs.
        await deps.escalateGiveUp(goal, latch.attemptsInWindow);
        await pauseNeedsHuman(goal, latch.attemptsInWindow);
        summary.gaveUp += 1;
        continue;
      }
    } catch (error) {
      // A repair failure must never block the ordinary recovery path below --
      // and unlike the old in-memory latch, the retry is genuinely reachable
      // next tick because this runs for every swept goal regardless of health.
      console.warn(
        `[goal-holder-respawner] stranded needs-human latch reconcile failed for ${goal.goalId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // A stub that was never picked up is not a lost holder and must not be
    // auto-started. But startGoalById stamps metadata.agentOwnerId only after a
    // successful GOAL-mode attach. When that proof survives while the mode row
    // does not, this is a LOST ATTACHMENT, not an installed-only stub: send it
    // through the existing damped recovery path. Unknown is still non-actionable;
    // degraded evidence is not death.
    if (fold.liveness === 'unheld') {
      if (!goal.startedHolderOwnerId?.trim()) {
        deps.states.delete(key);
        continue;
      }
    }
    if (fold.liveness === 'unknown') continue;

    let partialFirstTurn: GoalHolderFirstTurnAttestation | null = null;
    if (fold.liveness === 'held' && fold.elected &&
        deps.now() - fold.elected.setAtMs >= GOAL_HOLDER_FIRST_TURN_GRACE_MS) {
      try {
        const attestation = await deps.attestHolder?.(goal, fold.elected);
        if (!attestation || attestation.status === 'unknown') {
          // Do not erase a partial holder's re-kick history on a transient
          // evidence outage, and never replace it on an unknown verdict.
          continue;
        }
        if (attestation?.status === 'partial') {
          partialFirstTurn = attestation;
          summary.partialFirstTurn += 1;
        }
      } catch (error) {
        // An unreadable attestation cannot justify replacing a live sovereign.
        console.warn(`[goal-holder-respawner] first-turn attestation unavailable for ${goal.goalId}: ` +
          `${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    const previous = deps.states.get(key);
    if (fold.liveness === 'held' && !partialFirstTurn) {
      // A holder that is alive again has spent nothing: a later idle spell
      // earns a fresh re-kick budget (a re-kick that WORKED is the whole point).
      rekickStates.delete(key);
      // Do not allocate state for a goal that has never flapped. Once recovery
      // happened, five continuous healthy minutes clear attempts and give-up.
      if (previous) {
        const decision = decideFlapDamping({ healthy: true, state: previous, now: deps.now() });
        deps.states.set(key, decision.nextState);
      }
      // A holder that is alive again is proof the account served: close any
      // deferral episode without a "capacity back" line (it was never lost).
      capacityDeferrals.delete(key);
      continue;
    }

    // WI-2140573 finding 5 (measured 2026-09-02): before ANY recovery is paid,
    // ask whether a launched holder could reach the model at all. When every
    // account the launch would draw on is measured unable to serve (a usage
    // wall lasting days, or a rate pause), a re-kick wakes a session into the
    // same wall, a launch mints a process that dies before its first turn, and
    // both spend budget that later blocks a launch that COULD work. So DEFER:
    // skip re-kick, damping, rate slot and launch for this tick, log on entry
    // and every GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS, escalate once per
    // episode, and let the next tick that measures capacity back resume the
    // ordinary path on its own. An unreadable or unmeasured verdict is
    // `unknown` and proceeds — this guard only stops launches CERTAIN to die.
    if (deps.assessLaunchCapacity) {
      let capacity: GoalHolderLaunchCapacityVerdict | null = null;
      try {
        capacity = await deps.assessLaunchCapacity(goal);
      } catch (error) {
        console.warn(
          `[goal-holder-respawner] launch-capacity read failed for ${goal.goalId} (proceeding as unknown): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const episode = capacityDeferrals.get(key);
      if (capacity?.kind === 'deferred') {
        const nowMs = deps.now();
        const current: GoalHolderCapacityDeferral = episode ?? {
          sinceMs: nowMs,
          lastLoggedAtMs: 0,
          reason: '',
          escalated: false,
          clearStreak: 0,
          untilMs: null,
        };
        capacityDeferrals.set(key, current);
        // A deferred reading resets the resume streak: the wall is measurably still up.
        current.clearStreak = 0;
        current.untilMs = capacity.untilMs;
        const deferredForMs = nowMs - current.sinceMs;
        if (
          current.reason !== capacity.reason ||
          nowMs - current.lastLoggedAtMs >= GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS
        ) {
          current.reason = capacity.reason;
          current.lastLoggedAtMs = nowMs;
          console.warn(
            `[goal-holder-respawner] recovery DEFERRED for ${goal.goalId}: ${capacity.binding} on ` +
              `${capacity.accountIds.join(', ')} until ${formatCapacityUntil(capacity.untilMs, nowMs)} ` +
              `(deferred ${Math.round(deferredForMs / 60_000)} min; no re-kick, no rate slot, no launch) — ` +
              `${capacity.reason}`,
          );
        }
        const escalateNow =
          !current.escalated &&
          (capacity.binding === 'usage-wall' || deferredForMs >= GOAL_HOLDER_CAPACITY_DEFER_ESCALATE_MS);
        if (escalateNow && deps.escalateCapacityDeferral) {
          try {
            await deps.escalateCapacityDeferral(goal, capacity, deferredForMs);
            current.escalated = true;
          } catch (error) {
            console.warn(
              `[goal-holder-respawner] capacity-deferral escalation failed for ${goal.goalId} (will retry): ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        summary.deferredCapacity += 1;
        continue;
      }
      if (episode) {
        // WI-2140573 finding 5b (measured 2026-09-02 06:16–08:52Z): inside an
        // OPEN episode a single non-deferred tick is not proof the wall lifted.
        // The pool reading flapped three times in two hours — `unknown` on a
        // stale reading ("no 'codex' account can serve on a fresh reading"),
        // and one account flickering serviceable for exactly one tick — and
        // each flap closed the episode, re-kicked, and at 06:29:16Z paid a
        // launch that died at kickoff with zero responses. Resume only after
        // GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS consecutive `clear`
        // readings, or once the wall's own lift time has passed. `unknown`
        // holds the streak; a deferred tick (above) resets it.
        const nowMs = deps.now();
        if (capacity?.kind === 'clear') episode.clearStreak += 1;
        const wallLifted = episode.untilMs != null && nowMs >= episode.untilMs;
        const confirmed = episode.clearStreak >= GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS;
        if (!confirmed && !wallLifted) {
          if (nowMs - episode.lastLoggedAtMs >= GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS) {
            episode.lastLoggedAtMs = nowMs;
            console.warn(
              `[goal-holder-respawner] capacity NOT confirmed for ${goal.goalId}: ` +
                `${capacity?.kind ?? 'unreadable'} reading (${episode.clearStreak}/${GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS} consecutive clear) ` +
                `after ${Math.round((nowMs - episode.sinceMs) / 60_000)} min deferred — still no re-kick, no rate slot, no launch` +
                (capacity ? ` — ${capacity.reason}` : ''),
            );
          }
          summary.deferredCapacity += 1;
          continue;
        }
        capacityDeferrals.delete(key);
        console.warn(
          `[goal-holder-respawner] capacity back for ${goal.goalId} after ` +
            `${Math.round((nowMs - episode.sinceMs) / 60_000)} min deferred ` +
            `(${wallLifted && !confirmed ? 'wall lift time passed' : `${episode.clearStreak} consecutive clear readings`}); ` +
            `ordinary recovery resumes` +
            (capacity ? ` — ${capacity.reason}` : ''),
        );
      }
    }

    if (partialFirstTurn && fold.elected) {
      const ownerId = fold.elected.ownerId;
      const carried = rekickStates.get(key);
      const ledger = carried?.ownerId === ownerId
        ? carried : { ownerId, attemptsAtMs: [] };
      const lastAtMs = ledger.attemptsAtMs.at(-1) ?? null;
      const nowMs = deps.now();
      if (lastAtMs != null && nowMs - lastAtMs < GOAL_HOLDER_REKICK_INTERVAL_MS) continue;
      if (ledger.attemptsAtMs.length < GOAL_HOLDER_REKICK_MAX) {
        rekickStates.set(key, ledger);
        const attempt = ledger.attemptsAtMs.length + 1;
        ledger.attemptsAtMs.push(nowMs);
        try {
          await (deps.rekick ?? defaultRekickGoalHolder)(goal, ownerId, attempt, partialFirstTurn);
          summary.rekicked += 1;
        } catch (error) {
          console.warn(`[goal-holder-respawner] partial first-turn re-kick ${attempt} failed for ${goal.goalId}: ` +
            `${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      // The same damping, durable launch cap, CAS election and handoff below
      // handle a holder that stayed partial through every spaced re-kick.
    }

    // WI-2140573 (measured 2026-09-01): a `lost` holder whose PROCESS is still
    // up — heartbeating, parked, wakeable, with nothing armed to wake it — is
    // not a dead process. It is a live session whose last turn produced no
    // output: a kickoff that died at the model layer under upstream "high
    // demand", or an agent that settled without arming its loop. Relaunching
    // it pays a full launch AND a rate-cap slot per attempt, and during an
    // upstream outage every replacement dies the same way — eight elections in
    // eighty minutes, with every predecessor process alive, until the hourly
    // cap paused the goal. So RE-KICK first: wake the live session with a retry
    // brief, spaced by GOAL_HOLDER_REKICK_INTERVAL_MS and capped at
    // GOAL_HOLDER_REKICK_MAX per elected holder. Only a holder that stays lost
    // past that budget — or one whose process is actually gone, which never
    // enters this branch — reaches the damped launch path below. Re-kicks never
    // touch the flap-damping state, so they cannot consume the give-up budget.
    if (fold.liveness === 'lost' && fold.elected && holderIsRekickable(fold.elected) && deps.rekick) {
      const electedOwnerId = fold.elected.ownerId;
      const carried = rekickStates.get(key);
      const ledger: GoalHolderRekickState =
        carried && carried.ownerId === electedOwnerId
          ? carried
          : { ownerId: electedOwnerId, attemptsAtMs: [] };
      if (ledger.attemptsAtMs.length < GOAL_HOLDER_REKICK_MAX) {
        const nowMs = deps.now();
        const lastAtMs = ledger.attemptsAtMs[ledger.attemptsAtMs.length - 1] ?? null;
        rekickStates.set(key, ledger);
        if (lastAtMs != null && nowMs - lastAtMs < GOAL_HOLDER_REKICK_INTERVAL_MS) {
          continue; // the previous re-kick has not had its interval to take yet
        }
        const attempt = ledger.attemptsAtMs.length + 1;
        ledger.attemptsAtMs.push(nowMs);
        try {
          const delivery = await deps.rekick(goal, electedOwnerId, attempt);
          summary.rekicked += 1;
          console.warn(
            `[goal-holder-respawner] re-kicked live-but-idle holder ${electedOwnerId} for ${goal.goalId} ` +
              `(attempt ${attempt}/${GOAL_HOLDER_REKICK_MAX}; woken=${delivery.woken} staged=${delivery.staged}); ` +
              `no launch paid`,
          );
        } catch (error) {
          console.warn(
            `[goal-holder-respawner] re-kick ${attempt}/${GOAL_HOLDER_REKICK_MAX} failed for ${goal.goalId} ` +
              `owner ${electedOwnerId} (non-fatal; the launch path takes over once the re-kick budget is spent): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      // Budget spent on this holder while it stayed idle: fall through to launch.
    }

    const decision = decideFlapDamping({
      healthy: false,
      state: previous ?? initialFlapDampingState(),
      now: deps.now(),
    });
    deps.states.set(key, decision.nextState);

    if (decision.action.kind === 'escalate-give-up') {
      try {
        await deps.escalateGiveUp(goal, decision.action.restartsInWindow);
      } catch (error) {
        // The escalation is the durable signal. If its write fails, clear only
        // the latch so the next tick retries the deduped open instead of losing it.
        deps.states.set(key, { ...decision.nextState, gaveUp: false });
        console.warn(
          `[goal-holder-respawner] give-up escalation failed for ${goal.goalId} (will retry): ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      try {
        await pauseNeedsHuman(goal, decision.action.restartsInWindow);
        summary.gaveUp += 1;
      } catch (error) {
        deps.states.set(key, { ...decision.nextState, gaveUp: false });
        console.warn(
          `[goal-holder-respawner] needs-human pause failed for ${goal.goalId} (will retry): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (decision.action.kind !== 'restart') continue;

    let rate: GoalHolderRespawnRateDecision;
    try {
      rate = await (deps.reserveRateSlot ?? (async () => ({ kind: 'reserved', attemptsInWindow: 0 }) as const))(
        goal,
        deps.now(),
      );
    } catch (error) {
      // Fail closed: when the durable budget cannot be read/updated, launching
      // would recreate the unbounded behavior this guard exists to remove.
      console.warn(
        `[goal-holder-respawner] durable rate reservation failed for ${goal.goalId} (launch skipped): ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (rate.kind === 'ineligible') continue;
    if (rate.kind === 'capped') {
      const cappedState = { ...decision.nextState, gaveUp: true };
      deps.states.set(key, cappedState);
      try {
        await deps.escalateGiveUp(goal, rate.attemptsInWindow);
      } catch (error) {
        deps.states.set(key, { ...cappedState, gaveUp: false });
        console.warn(
          `[goal-holder-respawner] give-up escalation failed for ${goal.goalId} (will retry): ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      try {
        await pauseNeedsHuman(goal, rate.attemptsInWindow);
        summary.gaveUp += 1;
      } catch (error) {
        deps.states.set(key, { ...cappedState, gaveUp: false });
        console.warn(
          `[goal-holder-respawner] needs-human pause failed for ${goal.goalId} (will retry): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    summary.attempted += 1;
    let launched: { ownerId: string; warnings: string[] };
    let election: GoalModeElectionReceipt | null | void;
    let attachError: unknown = null;
    try {
      launched = await deps.launch(goal);
    } catch (error) {
      summary.launchFailed += 1;
      console.warn(
        `[goal-holder-respawner] launch failed for ${goal.goalId} (non-fatal, damped): ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const warning of launched.warnings) {
      console.warn(`[goal-holder-respawner] ${goal.goalId}: ${warning}`);
    }

    try {
      // Launch FIRST, attach only the pre-pinned identity returned by a successful
      // launch. A failed launch can therefore never leave a phantom holder row.
      const expectedLease = fold.elected
        ? {
            ownerId: fold.elected.ownerId,
            epoch: fold.elected.goalLeaseEpoch ?? null,
          }
        : null;
      election = await deps.attach(goal, launched.ownerId, expectedLease);
    } catch (error) {
      attachError = error;
      let readback: GoalHolderAuthority;
      try {
        readback = await deps.readAuthority(goal.workspaceId, launched.ownerId);
      } catch (readbackError) {
        summary.attachFailed += 1;
        summary.attachUnresolved += 1;
        console.warn(
          `[goal-holder-respawner] attach outcome UNRESOLVED for ${goal.goalId} owner ${launched.ownerId}: ` +
            `attach returned ${error instanceof Error ? error.message : String(error)} and durable authority ` +
            `readback failed (${readbackError instanceof Error ? readbackError.message : String(readbackError)}). ` +
            `Preserving the session without counting success or neutralizing; the next tick must reconcile authority first.`,
        );
        continue;
      }

      if (
        readback.status === 'elected' &&
        readback.goalId === goal.goalId &&
        readback.electedOwnerId === launched.ownerId
      ) {
        // The election committed and only the return path threw. Preserve the
        // elected replacement; neutralizing it would recreate the lost-holder
        // condition and could let a later recovery race a healthy sovereign.
        election = readback.electedEpoch == null
          ? null
          : {
              ownerId: launched.ownerId,
              goalId: goal.goalId,
              epoch: readback.electedEpoch,
              predecessorOwnerId: fold.elected?.ownerId ?? null,
              handoffExpiresAt: readback.handoffExpiresAt,
            };
        console.warn(
          `[goal-holder-respawner] attach returned an error for ${goal.goalId}, but durable ` +
            `readback confirms ${launched.ownerId} is elected; preserving the committed holder: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        summary.attachFailed += 1;
        const reason =
          `GOAL attachment refused for ${goal.goalId} after launch: ` +
          `${error instanceof Error ? error.message : String(error)}; durable authority ` +
          `resolved ${readback.status} and did not confirm ${launched.ownerId}`;
        try {
          await deps.neutralize(goal, launched.ownerId, reason);
        } catch (neutralizeError) {
          summary.neutralizeFailed += 1;
          console.warn(
            `[goal-holder-respawner] neutralize failed for ${goal.goalId} owner ${launched.ownerId}: ` +
              `${neutralizeError instanceof Error ? neutralizeError.message : String(neutralizeError)}`,
          );
        }
        console.warn(
          `[goal-holder-respawner] attach failed for ${goal.goalId} owner ${launched.ownerId} (non-fatal, damped): ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    try {
      summary.respawned += 1;
      if (election?.predecessorOwnerId) {
        try {
          await deps.notifyHandoff(goal.workspaceId, election);
        } catch (error) {
          console.warn(
            `[goal-holder-respawner] handoff notice failed for ${goal.goalId} ` +
              `${election.predecessorOwnerId} -> ${election.ownerId} (holder committed): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // A replacement counts toward the give-up budget only after the holder attachment
      // succeeds. The decision already paced this attempt via `lastAttemptAt`; failed launch or
      // attach operations must not masquerade as confirmed restarts.
      deps.states.set(key, confirmFlapRestart(deps.states.get(key) ?? decision.nextState, deps.now()));
      // The default attach closure writes through `setMode` directly, so it
      // does not pass through the mode tool's projection refresh. Keep this
      // safety projection fail-soft: a committed holder must stay committed
      // even if its compact context cannot be persisted right now.
      try {
        await (deps.refreshControlAnchor ?? refreshControlAnchorAfterMutation)({
          ownerId: launched.ownerId,
          workspaceId: goal.workspaceId,
          origin: 'system',
          actorId: HOLDER_RESPAWNER_IDENTITY.ownerId,
          source: 'mode:set',
          ownerDirected: false,
          sql,
        });
      } catch {
        // The shared refresh is fail-soft by contract; preserve that contract
        // for injected implementations as well.
      }
    } catch (error) {
      // Election is already confirmed at this point. Notification/control
      // projection failures must never neutralize a sovereign holder.
      console.warn(
        `[goal-holder-respawner] confirmed holder post-attach work failed for ${goal.goalId} owner ${launched.ownerId}: ` +
          `${error instanceof Error ? error.message : String(error)}` +
          `${attachError ? ` (attach had returned: ${attachError instanceof Error ? attachError.message : String(attachError)})` : ''}`,
      );
    }
  }

  return summary;
}

/* ── work-on-everything-goal-2026-08-23 P-011: the operator-boot arm ──────────
 *
 * Retirement doc open loss #3 (`agent-insights/mug-kettle-cup-tier-is-retired`):
 * the Mug was minted BY THE SYSTEM, so the system recovered from the su
 * population reaching zero; now the owner restarts it by hand. The doc's own
 * verdict is that this "should be a choice rather than a discovery" — and this
 * actor IS that choice, armed only by the owner (dark owner-authority flag
 * STANDING_GOAL_BOOT_ARM).
 *
 * Deliberately a THIN reuse of the P-009 respawner engine, not a new actor:
 * same eligibility floor (active + requireLive + onLoss='respawn' — respawn
 * stays EARNED per goal-live-holder-guarantee D-001), same 'unheld' exclusion
 * (install ≠ start, D-002), same 'unknown' conservatism, same flap damping,
 * same launch/attach seams, same escalation stack (work-on-everything D-008:
 * NO bespoke wedged-steward surface). The deltas are exactly three:
 *  1. SCOPE — standing goals only (`goals.standing = true`).
 *  2. LIFETIME — a bounded boot window (first pass ~60s after start, then
 *     every 60s, self-stop after 10 passes). The window, not a single t=0
 *     pass, because a holder hard-killed WITH the box can still read alive
 *     until its presence heartbeat goes stale; one immediate pass would miss
 *     it forever, while a bounded window catches the verdict settling.
 *  3. DEFERENCE — a hard no-op while GOAL_HOLDER_RESPAWN is ON: the runtime
 *     60s respawner already recovers every respawn-policy goal (standing
 *     included), and running both invites a same-tick double launch.
 */

/** P-011 eligibility: the P-009 floor, narrowed to standing goals. */
export function standingGoalEligibleForBootArm(goal: GoalRowLike): boolean {
  return goal.standing === true && goalEligibleForHolderRespawn(goal);
}

async function defaultBootArmFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    if (!(await getFlag(FLAGS.STANDING_GOAL_BOOT_ARM, 'system'))) return false;
    // DEFER while the runtime respawner is armed — it owns recovery then.
    if (await getFlag(FLAGS.GOAL_HOLDER_RESPAWN, 'system')) return false;
    return true;
  } catch {
    // Unattended spend path — flag uncertainty is a hard no-op.
    return false;
  }
}

export const STANDING_GOAL_BOOT_ARM_INTERVAL_MS = 60_000;
export const STANDING_GOAL_BOOT_ARM_MAX_PASSES = 10;

/**
 * NEVER the runtime respawner's map: each pass prunes damping keys outside its
 * own eligible set, and the boot pass's standing-only set is narrower — sharing
 * would erase the runtime actor's give-up latches every boot pass.
 */
const bootArmStates = new Map<string, FlapDampingState>();

/**
 * One boot-arm pass. The P-009 engine under boot-arm gating and scope.
 *
 * The standing filter wraps WHATEVER `readGoals` is in effect — the default or
 * an injected one — so the scope cannot be bypassed by dependency injection
 * and is unit-testable without PG.
 */
export async function runStandingGoalBootArmOnce(
  sql: Sql,
  overrides: Partial<GoalHolderRespawnDeps> = {},
): Promise<GoalHolderRespawnSummary> {
  const deps: Partial<GoalHolderRespawnDeps> = {
    flagEnabled: defaultBootArmFlagEnabled,
    states: bootArmStates,
    ...overrides,
  };
  const read = deps.readGoals ?? makeReadGoals(sql);
  deps.readGoals = async () => {
    const { goals, holders } = await read();
    return { goals: goals.filter((g) => g.standing === true), holders };
  };
  return await runGoalHolderRespawnOnce(sql, deps);
}

let bootArmTimer: ManagedHandle | null = null;

/**
 * Start P-011's bounded boot window. Idempotent; self-stops after
 * `maxPasses` fires. Both flags are re-read per pass, so arming or disarming
 * mid-window takes effect on the next pass.
 */
export function startStandingGoalBootArm(
  sql: Sql,
  opts: { intervalMs?: number; maxPasses?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? STANDING_GOAL_BOOT_ARM_INTERVAL_MS;
  const maxPasses = opts.maxPasses ?? STANDING_GOAL_BOOT_ARM_MAX_PASSES;
  if (bootArmTimer) bootArmTimer.stop();
  bootArmStates.clear();
  let passes = 0;
  let sweeping = false;
  bootArmTimer = managedSetInterval(
    'standing-goal-boot-arm',
    intervalMs,
    () => {
      if (sweeping) return;
      passes += 1;
      if (passes > maxPasses) {
        bootArmTimer?.stop();
        bootArmTimer = null;
        return;
      }
      sweeping = true;
      void runStandingGoalBootArmOnce(sql)
        .catch((error) => {
          console.warn(
            `[standing-goal-boot-arm] pass failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // Same classification as its siblings: the trigger is elapsed time after
    // boot with no live holder — absence has no publisher to subscribe to.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}

let watchdogTimer: ManagedHandle | null = null;
let holderRespawnerTimer: ManagedHandle | null = null;

/**
 * Start the goal-liveness watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.GOAL_LIVENESS_WATCHDOG (checked per tick).
 */
export function startGoalLivenessWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_LIVENESS_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-liveness-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalLivenessSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-liveness-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'timeout-reaper'. The trigger is ELAPSED TIME with no holder — a goal going
    // quiet emits nothing, and absence-over-a-deadline has no publisher to subscribe to.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}

/** Start P-009's independently gated, idempotent holder-recovery timer. */
export function startGoalHolderRespawner(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_HOLDER_RESPAWN_INTERVAL_MS;
  if (holderRespawnerTimer) holderRespawnerTimer.stop();
  let sweeping = false;
  holderRespawnerTimer = managedSetInterval(
    'goal-holder-respawner',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      void runGoalHolderRespawnOnce(sql)
        .catch((error) => {
          console.warn(
            `[goal-holder-respawner] sweep failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
