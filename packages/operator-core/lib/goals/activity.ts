/**
 * goal activity — the ONE place that folds a goal's ADMINISTRATIVE status
 * together with its HOLDER LIVENESS, so a deliberately paused goal can never be
 * reported as one that lost its holder
 * (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
 *
 * ── THE DISTINCTION, AND WHY IT NEEDS A HOME ────────────────────────────────
 *
 * `holder.ts` answers "is anybody alive on this goal?" and returns four values
 * (held / unheld / lost / unknown). It deliberately knows nothing about the
 * goal's status, because liveness is not status.
 *
 * But a goal that is DELIBERATELY PAUSED has no live holder BY DESIGN — the
 * pause fan-out disarms exactly those sessions' loops — so feeding its liveness
 * straight into a consumer produces `lost`: a stop rendered as a crash. That is
 * the lesson `unit-reconciler.ts`'s `isAdministrativelyPaused` (WI-5378)
 * already encodes one layer down: a disabled or masked unit is read from a
 * PERSISTED administrative marker, never inferred from the fact that nothing is
 * running, because from the outside a deliberate stop and a crash are identical.
 *
 * Today that exemption exists in exactly one place, as a bare `status =
 * 'active'` literal in the liveness watchdog's SQL, with no comment. P-004
 * derives goal activity from this same liveness for every read-side surface,
 * and every one of them would have to remember the exemption independently —
 * the precise D-003 shape: not hard to write, easy to forget, silent when
 * forgotten. So the rule lives here once, and the status short-circuits BEFORE
 * liveness is ever consulted.
 *
 * ── WHY `unknown` STILL WINS OVER `lost` ────────────────────────────────────
 *
 * Nothing here weakens `holder.ts`'s conservative rule. `unknown` (at least one
 * holder the oracle could not resolve) passes through unchanged, because a
 * degraded oracle fetch must never read as abandonment. This module only ever
 * ADDS reasons not to say `lost`.
 */
// From the SHARED module, not `goal-launch-settings.ts`: that one statically
// imports `@papercusp/db-org`, and this fold is pure + synchronous, so it must
// not drag the store into every consumer at load.
import {
  resolveGoalHolderPolicy,
  type GoalHolderPolicyInput,
  type ResolvedGoalHolderPolicy,
} from '../goal-launch-settings-shared';
import type { GoalHolderLiveness } from './holder';
// The wedge RULE is subject-agnostic and lives in ONE place (`agent-wedge.ts`),
// because the same condition is asked of fleet members and of any launched
// session, not only of goal holders. This module keeps the goal-shaped
// vocabulary and delegates the decision.
import {
  AGENT_PRODUCTIVITY_GRACE_MS,
  resolveAgentWedge,
  type AgentPresence,
} from '../agent-wedge';

/**
 * The statuses a holder-liveness judgement is entitled to be made about.
 *
 * ONE declaration, so the sweep's SQL predicate and the in-memory
 * classification cannot disagree — the drift shape `stop-seam.ts`'s
 * `STOPPING_STATUSES` was introduced to kill (`achieved` was a first-class
 * `GOAL_STATUSES` member while being invisible to the stop fan-out, WI-37832).
 *
 * Narrow on purpose: `paused` is excluded because the pause is deliberate, and
 * `achieved`/`killed` because the goal is over. Nothing else is a goal anyone
 * should still be holding.
 */
export const GOAL_LIVENESS_SWEEP_STATUSES: readonly string[] = ['active'];

/**
 * What a goal's activity actually is, once status and liveness are folded.
 *
 * The first two values come from the STATUS and are administrative facts; the
 * last four are `holder.ts`'s liveness verdict passed through. They are kept in
 * one union deliberately: a consumer that has to switch on two separate fields
 * is a consumer that can forget one of them.
 */
export type GoalActivity =
  /** A persisted, deliberate hold. No live holder is EXPECTED, not a fault. */
  | 'paused'
  /** achieved / killed — the goal is over; holders are irrelevant. */
  | 'terminal'
  /** At least one holder resolves positively alive. */
  | 'held'
  /** No goal-mode row exists at all — never picked up. */
  | 'unheld'
  /** Rows exist, all resolved, none alive — dropped mid-flight. */
  | 'lost'
  /** At least one holder could not be resolved. NOT evidence of death. */
  | 'unknown';

export interface GoalActivityVerdict {
  activity: GoalActivity;
  /** A persisted administrative pause is in force. */
  deliberatelyPaused: boolean;
  /** The goal is over (achieved / killed). */
  terminal: boolean;
  /**
   * The holder liveness this verdict used, or null when the STATUS decided the
   * answer and liveness was never consulted. Null is the honest reading of
   * "we did not ask" — distinct from having asked and got `unknown`.
   */
  liveness: GoalHolderLiveness | null;
}

/**
 * Is this goal DELIBERATELY paused? The goal-level analogue of the unit
 * reconciler's `isAdministrativelyPaused` (WI-5378), and the reason P-005
 * exists: there, a `disabled`/`masked` unit is read from a PERSISTED
 * administrative marker rather than inferred from the fact that nothing is
 * running, because a deliberate stop and a crash look identical from the
 * outside. A goal is no different.
 *
 * Takes the raw status string rather than `GoalStatus` so a caller holding an
 * unvalidated column value (every SQL read) can ask without a cast.
 *
 * LIVES HERE, not in `agent-mcp`'s `pause-record.ts` where P-005 first wrote it
 * (which now re-exports it, so P-005's callers are unchanged). The move is
 * structural, not cosmetic: this module is operator-core's cheapest PURE fold,
 * and reaching for the predicate through the agent-mcp package BARREL pulled
 * that entire index into every consumer of it — a cycle
 * (`sync-resolver → activity → @papercusp/agent-mcp → goals/get → …`) for a
 * one-line string comparison. Plan D-011.
 */
export function isGoalAdministrativelyPaused(status: string | null | undefined): boolean {
  return status === 'paused';
}

/**
 * Terminal per the goal partition (`GOAL_TERMINAL_STATUSES`, mirrored here as a
 * string test so a raw column value needs no cast).
 */
function isTerminal(status: string | null | undefined): boolean {
  return status === 'achieved' || status === 'killed';
}

/**
 * PURE: fold a goal's status and holder liveness into one verdict.
 *
 * ORDER IS THE WHOLE POINT. Status is consulted FIRST and short-circuits:
 *
 *   1. `paused`  — a deliberate hold. Returns `paused` and never looks at
 *      liveness, so no amount of dead holders can turn it into `lost`.
 *   2. terminal  — the goal is over. Same short-circuit, for the same reason.
 *   3. otherwise — the liveness verdict, unchanged.
 *
 * `liveness` is optional so a caller that has already short-circuited on status
 * (the sweep's SQL predicate does exactly that) can ask without paying for an
 * oracle round-trip it does not need. Omitting it on an ACTIVE goal yields
 * `unknown` — we were not told, so we do not know — never `lost`.
 */
export function resolveGoalActivity(input: {
  status: string | null | undefined;
  liveness?: GoalHolderLiveness | null;
}): GoalActivityVerdict {
  if (isGoalAdministrativelyPaused(input.status)) {
    return { activity: 'paused', deliberatelyPaused: true, terminal: false, liveness: null };
  }
  if (isTerminal(input.status)) {
    return { activity: 'terminal', deliberatelyPaused: false, terminal: true, liveness: null };
  }
  const liveness = input.liveness ?? null;
  return {
    activity: liveness ?? 'unknown',
    deliberatelyPaused: false,
    terminal: false,
    liveness,
  };
}

/**
 * Is this goal's quiet a FAULT worth reporting, rather than something somebody
 * chose? The one predicate a watchdog / alarm / respawn path should ask.
 *
 * `unknown` is false here for the same reason `holder.ts` keeps it apart from
 * `lost`: a degraded oracle read is not evidence of abandonment.
 */
export function isGoalQuietUnexpectedly(verdict: GoalActivityVerdict): boolean {
  return verdict.activity === 'unheld' || verdict.activity === 'lost';
}

/* ────────────────────────────────────────────────────────────────────────────
 * P-004 — DETERMINISTIC DEACTIVATION
 *
 * The half `resolveGoalActivity` above deliberately does NOT decide: whether a
 * goal's quiet should stop it reading as `active`. That question needs one more
 * input — the goal's own HOLDER POLICY (P-002's `holder { requireLive }`) — and
 * folding it here keeps the whole rule in the module that already owns the
 * status/liveness fold, rather than in each read-side surface.
 *
 * DERIVED AT READ TIME, NEVER SWEPT. Nothing below writes anything. A sweep
 * that flipped `goals.status` would (a) need a writer racing every other writer
 * of that column, (b) be unable to un-flip the moment a holder came back, and
 * (c) destroy the administrative value the column is FOR — the difference
 * between "somebody paused this" and "this went quiet", which D-009 records as
 * the distinction the whole plan exists to keep. The column keeps meaning what
 * a human put in it; the derived reading answers what is actually true now.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The read-side label for a holder-required goal that is quiet unexpectedly.
 *
 * Deliberately NOT a member of `GOAL_STATUSES`: it is computed on every read and
 * MUST NEVER be written to `goals.status`. Keeping it outside the persisted
 * union is what makes that mistake a type error rather than a silent one — and
 * it is why the word is new rather than a reuse of `paused`, which already means
 * something a human chose (D-009).
 */
export const GOAL_DORMANT_STATUS = 'dormant';

export interface GoalEffectiveActivity extends GoalActivityVerdict {
  /** The goal's resolved holder policy — read-time defaults applied (D-008). */
  policy: ResolvedGoalHolderPolicy;
  /** Shorthand for `policy.requireLive`. */
  requiresLiveHolder: boolean;
  /**
   * The goal requires a live holder, is administratively `active`, and has none
   * — so it should NOT be read as active. Never true for a paused, terminal, or
   * `requireLive: false` goal, and never true on `unknown`.
   */
  deactivated: boolean;
  /**
   * The status a reader should USE in place of the raw column: the raw value,
   * or `GOAL_DORMANT_STATUS` when `deactivated`.
   */
  effectiveStatus: string | null;
}

/**
 * PURE: what a goal's status EFFECTIVELY is, once its policy and its holder
 * liveness are folded in. The one function a read-side surface should call.
 *
 * Four gates, in this order — each one a reason NOT to deactivate:
 *
 *   1. `paused` / terminal — `resolveGoalActivity`'s administrative
 *      short-circuit. Liveness is never consulted, so a deliberate hold can
 *      never be rendered as a loss.
 *   2. `requireLive: false` — the goal told us it is driven by routines rather
 *      than a held session, so "nobody is holding it" is its normal condition
 *      and not a fault. This is the opt-out D-008 requires be SAYABLE.
 *   3. status not in `GOAL_LIVENESS_SWEEP_STATUSES` — only a goal that claims to
 *      be active can stop reading as active. Reusing that constant is what keeps
 *      this in-memory rule and the sweep's SQL predicate from drifting apart.
 *   4. liveness is `held` or `unknown` — `isGoalQuietUnexpectedly`. `unknown` is
 *      the load-bearing one: a degraded oracle fetch must never deactivate a
 *      goal, or one transient DB hiccup silently empties the board.
 *
 * Omitting `liveness` yields `unknown`, so a caller that has not paid for the
 * oracle gets the SAFE answer (not deactivated) rather than a confident wrong
 * one.
 */
export function resolveGoalEffectiveActivity(input: {
  status: string | null | undefined;
  launchSettings?: GoalHolderPolicyInput | null;
  liveness?: GoalHolderLiveness | null;
}): GoalEffectiveActivity {
  const verdict = resolveGoalActivity({ status: input.status, liveness: input.liveness });
  const policy = resolveGoalHolderPolicy(input.launchSettings);
  const rawStatus = input.status ?? null;

  const deactivated =
    !verdict.deliberatelyPaused &&
    !verdict.terminal &&
    policy.requireLive &&
    GOAL_LIVENESS_SWEEP_STATUSES.includes(rawStatus ?? '') &&
    isGoalQuietUnexpectedly(verdict);

  return {
    ...verdict,
    policy,
    requiresLiveHolder: policy.requireLive,
    deactivated,
    effectiveStatus: deactivated ? GOAL_DORMANT_STATUS : rawStatus,
  };
}

/**
 * Fold a goal's OWN activity into a blocker-derived `actionable`, so the
 * derived boolean can never outlive the status that determines it.
 *
 * ── WHY THIS EXISTS (EI-23738380307533850) ──────────────────────────────────
 *
 * `goalReadiness` answers exactly one question: are this goal's BLOCKERS
 * satisfied? It is a fold over the dependency edges and deliberately knows
 * nothing about the goal itself — so `views.every(...)` over an EMPTY edge list
 * returns `true`. A killed goal with no dependencies therefore read
 * `actionable: true`, and the `summary` tier, which omitted `status`, carried
 * no field that could contradict it.
 *
 * The dangerous half was never "summary carries less detail" — that is correct
 * and expected. It is that the omission flipped a boolean to its confident
 * WRONG value instead of to absent/unknown, so nothing in the payload looked
 * uncertain enough to prompt a re-read. A caller carried "8 live sibling goals"
 * as a settled premise through a goal-sovereignty decision; every one of the 8
 * was `killed`.
 *
 * Folding status in HERE — rather than only adding `status` to one tier's
 * projection — is what stops the CLASS: a new tier cannot reintroduce the bug
 * by dropping a field, because no tier computes `actionable` for itself.
 *
 * Only STATUS-determined gates belong in this fold. `deactivated` is
 * holder-liveness, not status, and every tier already emits it as its own
 * falsifiable field — so it deliberately stays out: a dormant goal is one a
 * holder can still pick up.
 */
export function goalActionable(
  blockersSatisfied: boolean,
  activity: Pick<GoalActivityVerdict, 'deliberatelyPaused' | 'terminal'>,
): boolean {
  if (activity.terminal) return false;
  if (activity.deliberatelyPaused) return false;
  return blockersSatisfied;
}

/* ────────────────────────────────────────────────────────────────────────────
 * WEDGED HOLDERS — alive, and producing nothing
 *
 * Everything above answers "is anybody there?". Nothing above answers "is that
 * somebody DOING anything", and the two are not the same question.
 *
 * `holderCountsAsAlive` (holder.ts) is a presence test: not `ended`, and not
 * `parked` with no self-wake. A holder that boots, gets an inference 429 on its
 * very first turn, and never obtains a single completion passes that test — it
 * is parked and wakeable, which is exactly what a healthy holder between turns
 * looks like. So liveness folds to `held`, `isGoalQuietUnexpectedly` is false,
 * and the respawn path (`goal-liveness-watchdog.ts`, at the `fold.liveness ===
 * 'held'` continue) never runs. The goal reads `active`, presence reads
 * `parked`, budget reads in-budget, and nothing anywhere says the goal has not
 * moved.
 *
 * Observed 2026-08-27 (EI-21578742955425881): goal `work-on-everything-070565`
 * held that state for 16 minutes with ZERO agent-origin tool calls, during a
 * workspace-wide 429 outage that put 26 distinct agents in the same condition.
 * This is the dual of the warning the su playbook already carries about
 * `heartbeatFresh: true` coexisting with a dead session — here the process is
 * genuinely alive and still not working.
 *
 * ── WHY THIS IS A SEPARATE SIGNAL AND *NOT* FOLDED INTO DEACTIVATION ────────
 *
 * The obvious move is to add `wedged` to `isGoalQuietUnexpectedly` so the
 * existing machinery picks it up for free. That is wrong, twice over:
 *
 *   1. `isGoalQuietUnexpectedly` drives `deactivated`, which drives
 *      `effectiveStatus → dormant` on every read-side surface. The cause of a
 *      wedge is overwhelmingly CORRELATED across holders (one throttled account
 *      pool wedges everyone at once), so folding it in would flip every goal in
 *      the workspace to `dormant` simultaneously on a transient capacity dip —
 *      a board-emptying event triggered by something that resolves itself.
 *      `unknown`'s exclusion from that predicate exists for the same reason,
 *      and the reasoning transfers directly.
 *   2. Deactivation's consumers ask "should this read as active?". A wedged
 *      goal genuinely IS active and held — the honest report is that it is
 *      stuck, not that nobody has it. Rendering a stuck goal as unheld would
 *      lose the distinction that makes it diagnosable.
 *
 * So: additive, reportable, and deliberately inert for the existing gates. A
 * caller that never supplies `productivity` gets precisely today's behaviour.
 *
 * ── AND WHY DETECTION IS NOT AUTOMATICALLY A RESPAWN ────────────────────────
 *
 * Respawning a wedged holder is the right repair when the wedge is local (that
 * one session is broken) and the WRONG one when the wedge is systemic (the
 * account pool is walled): killing and relaunching 26 holders into an exhausted
 * pool spends the little capacity left on relaunches that will wedge again.
 * This module therefore reports the condition and says nothing about the cure;
 * the decision to respawn belongs to a caller that can also see whether
 * capacity exists.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How long a live holder may produce NOTHING before it counts as wedged.
 *
 * Generous on purpose. The predicate below only fires on holders that have
 * NEVER produced an agent-origin call, so this is not "idle for 15 minutes" —
 * it is "has never once worked, and has now had a quarter of an hour to". A
 * holder mid-way through one long tool call has already made that call and can
 * never trip this.
 */
export const GOAL_HOLDER_PRODUCTIVITY_GRACE_MS = AGENT_PRODUCTIVITY_GRACE_MS;

/**
 * Evidence that a held goal's holder has actually DONE something.
 *
 * `agentOriginCalls` must exclude hook-origin invocations. That exclusion is
 * the entire signal: a session that boots and immediately fails still emits
 * hook-fired calls (`coord:glance`, `activity:report` on the session-start
 * hook), so a raw invocation count is non-zero for a holder that never ran a
 * single instruction of its own. In the observed case the raw count was 3 and
 * the agent-origin count was 0.
 */
export interface GoalHolderProductivity {
  /**
   * Agent-origin tool calls made by this goal's holder(s) since they picked the
   * goal up. Hook-origin calls MUST NOT be counted.
   */
  agentOriginCalls: number;
  /** How long the goal has been held, in ms — the clock the grace runs against. */
  heldForMs: number;
}

export interface GoalWedgeVerdict {
  /** The holder is alive and has never produced work past the grace window. */
  wedged: boolean;
  /**
   * Why not, when `wedged` is false — so a caller rendering "healthy" can say
   * whether that was measured or merely unmeasured. `not-measured` is the one
   * that must never be read as a clean bill of health.
   */
  reason:
    | 'wedged'
    | 'not-held'
    | 'not-measured'
    | 'has-produced-work'
    | 'within-grace';
}

/**
 * PURE: is this goal's holder alive-but-not-working?
 *
 * Only ever asked of a `held` goal — every other liveness verdict is already
 * described correctly by the folds above, and a wedge is by definition a thing
 * that happens to somebody who IS there.
 *
 * Returns `not-measured` when no productivity evidence was supplied, rather
 * than `false` with no explanation. That distinction is the point: an absent
 * measurement and a passing measurement are the same boolean and completely
 * different facts, and collapsing them is how "nothing reported a problem"
 * comes to be read as "there is no problem".
 */
export function resolveGoalHolderWedge(input: {
  liveness: GoalHolderLiveness | null;
  productivity?: GoalHolderProductivity | null;
  graceMs?: number;
}): GoalWedgeVerdict {
  // DELEGATED to the one subject-agnostic rule. Two translations happen here and
  // nowhere else, which is the whole point of keeping this wrapper:
  //
  //  - LIVENESS → PRESENCE. `held` is the only verdict that means "somebody is
  //    there"; a null verdict is the oracle failing to answer, which stays
  //    `unknown` rather than collapsing to absence (holder.ts's conservative rule
  //    — this module only ever ADDS reasons not to cry wolf).
  //  - `not-present` → `not-held`. The goal-facing vocabulary is unchanged, so
  //    every existing consumer and test of this function is untouched by the move.
  //
  // `phase` is deliberately NOT projected outward: it discriminates a launcher
  // fault from a session fault, and a goal holder's caller has no separate repair
  // for the two. A population that does (the agent-wide sweep) reads the general
  // verdict directly instead of widening this one.
  const presence: AgentPresence =
    input.liveness === 'held' ? 'present' : input.liveness == null ? 'unknown' : 'absent';

  const { wedged, reason } = resolveAgentWedge({
    presence,
    productivity: input.productivity
      ? {
          agentOriginCalls: input.productivity.agentOriginCalls,
          presentForMs: input.productivity.heldForMs,
        }
      : null,
    graceMs: input.graceMs ?? GOAL_HOLDER_PRODUCTIVITY_GRACE_MS,
  });

  return { wedged, reason: reason === 'not-present' ? 'not-held' : reason };
}

/* ────────────────────────────────────────────────────────────────────────────
 * IDLE STEWARDS — working, and placing nothing
 * (goal-mode-drift-guards-2026-08-31 P-002)
 *
 * The wedge leg above stops one square short, and says so itself: it "only
 * fires on holders that have NEVER produced an agent-origin call, so this is
 * not 'idle for 15 minutes' — it is 'has never once worked'". A holder that
 * reads, thinks and reports is `has-produced-work`, and therefore healthy by
 * every predicate this file has offered until now.
 *
 * Measured 2026-08-31: a standing goal's steward held exactly that state for
 * 4+ hours and $109. Liveness said `held`. The wedge leg said
 * `has-produced-work`. The budget ceiling — a MONEY ceiling — was the first
 * thing in the system to object, which is the whole complaint: money is meant
 * to be the last line of defence, not the first.
 *
 * ── THE PREDICATE IS A DURATION, AND THAT IS WHY IT LIVES HERE ──────────────
 *
 * "Portfolio throughput sat at ZERO for N minutes" is a statement about a span
 * of time, and `state:subscribe` compares a value at an instant — its whole
 * vocabulary is `eq`/`gt`/`changed` against one poll's reading. Encoding the
 * duration in the SUBSCRIPTION would need a comparator that does not exist,
 * i.e. a second subscription mechanism, which P-004 of the state-plane plan
 * forbids in as many words.
 *
 * So the duration is answered HERE, by the resolver, and the subscription stays
 * an ordinary threshold on the answer. That is not a workaround; it is the
 * registry's own stated precedent, recorded twice in `cell-registrations.ts` and
 * again on `CellMateriality`: "when a declaration cannot state something
 * honestly, the fix belongs in the RESOLVER, not the declaration". A registry
 * computing `idleFor >= N` would be the registry deriving a verdict, which is
 * exactly what axis 5 forbids one level up.
 *
 * ── WHY `not-held` IS NOT `idle` ────────────────────────────────────────────
 *
 * A goal nobody holds places nothing, trivially. Reporting that as idle would
 * double-report a condition `holder.ts` already names `unheld`/`lost` and route
 * it to the wrong repair: an unheld goal needs a HOLDER, an idle one needs a
 * conversation about whether it should still be running. Every non-`held`
 * liveness therefore exits early with its own reason.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How long a live holder may place NOTHING before the goal counts as idle.
 *
 * Deliberately much SHORTER than the wedge grace, and the asymmetry is the
 * point. The wedge asks "has this session ever worked", so it must be generous
 * — a slow first turn is not a fault. This asks "has this steward placed
 * anything recently", of a holder already known to be producing calls, so the
 * evidence is continuous and waiting longer buys nothing but spend. Twenty
 * minutes is roughly two engine-loop wakes at the default cadence: enough that
 * one long deliberation cannot trip it, short enough that the answer arrives in
 * minutes rather than in the four hours it actually took.
 */
export const GOAL_PORTFOLIO_IDLE_AFTER_MS = 20 * 60_000;

/** Evidence that a goal's holders have actually PLACED something. */
export interface GoalPortfolioThroughput {
  /**
   * Successful portfolio acts (see `portfolio-acts.ts`) by this goal's holders
   * within the measurement window. Context for the verdict, never the verdict:
   * the decision is made on `idleMs`, because "sat at zero for N minutes" is a
   * question about the RECENT span, not about the window total.
   */
  actsInWindow: number;
  /**
   * Milliseconds since the last portfolio act — or, when there has never been
   * one, since the goal was first held.
   *
   * Falling back to the hold start is what makes a never-placing steward
   * measurable at all. Left null it would read `not-measured`, and a holder that
   * has placed nothing since it started is the single clearest instance of the
   * condition, not an absence of evidence about it.
   */
  idleMs: number | null;
}

export interface GoalPortfolioVerdict {
  /** Held, past the threshold, and has placed nothing in that span. */
  idle: boolean;
  /**
   * Why not, when `idle` is false — so a caller rendering "healthy" can say
   * whether that was measured. As with the wedge leg, `not-measured` is the one
   * that must never be read as a clean bill of health.
   */
  reason: 'idle' | 'not-held' | 'not-measured' | 'placing' | 'within-grace';
}

/**
 * PURE: is this goal's holder working but placing nothing?
 *
 * Order matters, and differs from the wedge fold in one deliberate way: an
 * UNRESOLVED liveness (`null`) is checked BEFORE the not-held exit. `not-held`
 * is a measured claim about the goal, and an oracle that failed to answer has
 * measured nothing — collapsing the two would let a degraded read present as a
 * finding, which is the failure `holder.ts`'s conservative rule exists to
 * prevent and that this module only ever adds reasons NOT to commit.
 */
export function resolveGoalPortfolioIdle(input: {
  liveness: GoalHolderLiveness | null;
  throughput?: GoalPortfolioThroughput | null;
  idleAfterMs?: number;
}): GoalPortfolioVerdict {
  if (input.liveness == null) return { idle: false, reason: 'not-measured' };
  if (input.liveness !== 'held') return { idle: false, reason: 'not-held' };

  const throughput = input.throughput;
  if (!throughput || throughput.idleMs == null || !Number.isFinite(throughput.idleMs)) {
    return { idle: false, reason: 'not-measured' };
  }

  const idleAfterMs = input.idleAfterMs ?? GOAL_PORTFOLIO_IDLE_AFTER_MS;
  if (throughput.idleMs < idleAfterMs) {
    // Two very different healthy states share this branch, and the caller needs
    // them apart: a steward that HAS placed work recently, versus one that is
    // simply too young to have been expected to. Reporting both as "placing"
    // would claim evidence that does not exist for the second.
    return { idle: false, reason: throughput.actsInWindow > 0 ? 'placing' : 'within-grace' };
  }
  return { idle: true, reason: 'idle' };
}
