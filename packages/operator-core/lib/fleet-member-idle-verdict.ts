/**
 * fleet-member-idle-verdict — the per-member "why is this one idle" oracle
 * (fleet-lead-instrumentation-audit-2026-08-09 P-023).
 *
 * P-023: "A per-member 'why is this idle' oracle: throttled / spec-mismatched / floor-blocked
 * / mid-turn / genuinely idle. Currently inferred from `lastToolCallAgeMs` plus pool state —
 * exactly the inference P-002 shows leader-brief getting wrong."
 *
 * THIS IS THE PER-MEMBER ANALOG OF `computeFleetBlockVerdict` (P-019) AND IS DELIBERATELY
 * SUBORDINATE TO IT. That subordination is the whole design, not a detail. P-002 measured the
 * fleet-level version of this bug: the brief attributed idleness to the MEMBER while the pool
 * was at `factor 0`, and every remedy it offered ("wake it to re-run scheduler:get_next") added
 * another request behind the same congestion. A per-member oracle that re-derives its own
 * answer, independently of the fleet verdict, reproduces that inversion once per member — and
 * does it with more apparent authority, because a specific per-member reason reads as better
 * evidence than a fleet-wide one.
 *
 * SO TWO OF P-023'S FIVE NAMED CAUSES ARE DELIBERATELY NOT MEMBER-LEVEL CAUSES.
 * `spec-mismatched` and `floor-blocked` are properties of the SPEC AND THE QUEUE, not of the
 * member: every member inheriting the fleet spec shares them exactly. Reporting them per-member
 * would print the same fleet-scope fact N times as though it were N independent findings, and
 * invite a leader to "fix" a member over a condition no member action can change. They resolve
 * here to `fleet-blocked`, which NAMES the dominating layer and points at `blockedAt`. A member
 * carrying its OWN bee spec is the one real exception, and is reported as unresolved rather
 * than silently attributed to the fleet's spec — see `ownSpecUnresolved`.
 *
 * PURE: no PG / IO / clock. The caller supplies the member row, the fleet verdict and the
 * freshness floor, so every branch is unit-testable.
 */

// Type-only import: erased at compile, so this cannot create a runtime cycle with
// leader-brief.ts (which imports this module back). Reusing its union rather than
// re-declaring one is the point — a second copy would drift from the arbiter it defers to.
import type { FleetBlockLayer } from './agent-tools/fleet/leader-brief';

/**
 * Why one member is not currently doing work, in the order the causes physically dominate
 * one another. Exactly one is reported — the leader's next action depends on which.
 */
export type MemberIdleCause =
  /** Not idle: holding a claim and advancing it. */
  | 'working'
  /** Not idle: taking turns right now (or mid a long local exec that emits no MCP calls). */
  | 'mid-turn'
  /** Holding a claim that is NOT advancing — the work is stranded on this member. */
  | 'stalled-holder'
  /** Idle as a CONSEQUENCE of a fleet-level block — pool, spec, floors or a pause. */
  | 'fleet-blocked'
  /** This member specifically has backed off a provider wall. */
  | 'throttled'
  /** The session is gone or going: ended / draining / suspect. */
  | 'session-ending'
  /** Alive but nothing will ever wake it: no armed loop and no pending wake. */
  | 'no-self-wake'
  /** Intentionally parked on a live events:await; the event, not a loop, will wake it. */
  | 'parked-awaiting-event'
  /** About to compact, so it is not going to pick anything up first. */
  | 'context-exhausted'
  /** Everything upstream is healthy, work is claimable, and it still took nothing. */
  | 'genuinely-idle';

/**
 * A held claim whose last productive call is older than this is not safely described as
 * advancing merely because housekeeping calls or a healthy loop keep its generic liveness
 * signals fresh. Keep this threshold aligned with the leader brief's spinning detector.
 */
export const PRODUCTIVE_STALL_BUDGET_MS = 30 * 60_000;

export interface MemberIdleVerdict {
  cause: MemberIdleCause;
  /** Why THIS cause, phrased so a leader can check it against the member row. */
  reason: string;
  /** The one action that addresses it. `null` when the correct action is to do nothing. */
  remedy: string | null;
  /**
   * Set when `cause` is 'fleet-blocked': the layer from `blockedAt` that dominates. Carried so
   * the per-member row cannot drift from the fleet verdict it defers to.
   */
  dominatedBy?: FleetBlockLayer;
  /**
   * True when this member carries its OWN claim spec, which was not previewed. Its
   * spec/floor position is therefore UNKNOWN rather than the fleet's — stated, never
   * rounded to the fleet's answer.
   */
  ownSpecUnresolved?: boolean;
}

/** The member-row fields this verdict reads. A subset of leader-brief's row, by design. */
export interface MemberIdleInput {
  sessionState?: string | null;
  /** Held claims. > 0 with `stalled` false means it is working. */
  load?: number | null;
  stalled?: boolean | null;
  /** ms since ANY tool call; null = never (still booting). */
  lastToolCallAgeMs?: number | null;
  /** ms since the last non-housekeeping tool call; null/undefined = no productive history. */
  productiveToolCallAgeMs?: number | null;
  /** A local command is still running; settled-call ages cannot classify it as stalled. */
  longCallInFlight?: unknown;
  contextPressure?: string | null;
  /** Present when the member has backed off a provider wall. */
  throttled?: unknown;
  /**
   * The member's loop mode, or null when the roster resolved no loop for it. Paired with
   * `nextFireAt` this is the documented signature for "nothing will ever wake this member"
   * (EI-18730414627683753, where a leader had to read exactly these two fields BY HAND to
   * catch a member that had gone permanently dormant). Deliberately NOT a `loopArmed`
   * boolean: that field is not plumbed to this layer, and a stale armed-loop row reads true
   * for a warm-dead session anyway (EI-14702 / WI-6639).
   */
  loopMode?: string | null;
  /** A scheduled next fire, if any. */
  nextFireAt?: string | null;
  /**
   * Active event keys derived from the same parked-await read exposed by fleet:assignments and
   * events:status. A non-empty list is a real self-wake mechanism even when no engine loop is
   * armed, so it must not be classified as `no-self-wake`.
   */
  parkedOn?: readonly unknown[] | null;
  /** True when the member has its own bee-level claim spec rather than inheriting the fleet's. */
  hasOwnSpec?: boolean | null;
}

export interface FleetIdleContext {
  /** The arbitrated fleet verdict, or null when the fleet is not blocked at any layer. */
  blockedAtLayer?: FleetBlockLayer | null;
  /**
   * How fresh a tool call must be to count as "mid-turn", in ms. Supplied rather than baked
   * in so it stays one knob shared with the caller's own staleness rules.
   */
  midTurnFreshnessMs: number;
}

const ENDING_STATES = new Set(['ended', 'draining', 'suspect', 'recorded']);

/**
 * Decide why one member is idle.
 *
 * ORDERING IS PHYSICAL DOMINANCE, NOT SEVERITY — the same rule `computeFleetBlockVerdict`
 * documents. Each earlier cause makes every later one unobservable rather than merely less
 * important: a member mid-turn cannot be judged idle at all; a member starved of inference
 * capacity reads as idle at every downstream layer; a floor cannot be seen to withhold work
 * from a member that never got a turn.
 */
export function computeMemberIdleVerdict(
  member: MemberIdleInput,
  fleet: FleetIdleContext,
): MemberIdleVerdict {
  const ownSpec = member.hasOwnSpec === true ? { ownSpecUnresolved: true } : {};
  const productiveAge = member.productiveToolCallAgeMs;
  const productiveGap =
    member.longCallInFlight == null &&
    productiveAge != null &&
    Number.isFinite(productiveAge) &&
    productiveAge > PRODUCTIVE_STALL_BUDGET_MS;

  // 1. Holding work and advancing it — not idle, and nothing to explain. A stale productive
  // call is the exception: a healthy loop/housekeeping traffic can keep `stalled` false while
  // the held claim makes no real progress, so let that case reach the member-level stall branch.
  if ((member.load ?? 0) > 0 && !member.stalled && !productiveGap) {
    return {
      cause: 'working',
      reason: `Holding ${member.load} claim(s) and advancing them.`,
      remedy: null,
      ...ownSpec,
    };
  }

  // 2. Taking turns right now. This is the branch P-023 names as the one currently inferred
  //    wrongly: a fresh tool call means the member is ACTIVE, and "idle" is simply the wrong
  //    frame. It is deliberately checked BEFORE the fleet block — a member still emitting
  //    calls is not being prevented from anything, whatever the fleet-level state.
  const age = member.lastToolCallAgeMs;
  if (age != null && age >= 0 && age < fleet.midTurnFreshnessMs && !ENDING_STATES.has(member.sessionState ?? '')) {
    return {
      cause: 'mid-turn',
      reason:
        `Last tool call ${Math.round(age / 1000)}s ago — this member is taking turns. It may also ` +
        'be mid a long local exec (a test run, a build) that emits no MCP calls until it returns; ' +
        'this signal cannot tell those apart, and neither is idle.',
      remedy: null,
      ...ownSpec,
    };
  }

  // 3. Intentionally parked on a live event await. This is a real self-wake mechanism even
  //    without an engine loop; waking it would only re-arm the same await unless the dispatch
  //    is for the event it is waiting on. A parked member may still hold a claim and look
  //    stalled in the claim snapshot, but the park is deliberate — reclaiming would destroy
  //    validated work that is correctly waiting on its declared gate.
  if ((member.parkedOn?.length ?? 0) > 0) {
    return {
      cause: 'parked-awaiting-event',
      reason:
        `Parked on ${member.parkedOn?.length} live event await(s) — the event will wake this ` +
        'member; it is intentionally waiting rather than permanently dormant.',
      remedy: 'None — wait for the parked event; waking it would re-arm the same await.',
      ...ownSpec,
    };
  }

  // 4. Holding a claim that is not advancing. ABOVE the fleet block on purpose: a stranded
  //    claim is a member-level fact the fleet-level state does not create — the work was taken
  //    BEFORE the block and is now stuck on a member that stopped. Found by running this
  //    oracle over this fleet's real rows: two members held work-items with load 1 + stalled
  //    while a pause was in force, and reporting them as merely 'fleet-blocked' hid the one
  //    thing a leader must act on — the claim needs reclaiming whatever the fleet is doing.
  if ((member.load ?? 0) > 0 && (member.stalled || productiveGap)) {
    return {
      cause: 'stalled-holder',
      reason:
        `Holding ${member.load} claim(s) that are NOT advancing. The work is stranded here, ` +
        (productiveGap
          ? `the last productive tool call was ${Math.round((productiveAge as number) / 60_000)}m ago ` +
            `(over the ${Math.round(PRODUCTIVE_STALL_BUDGET_MS / 60_000)}m budget). `
          : '') +
        'and that stays true regardless of any fleet-level block.',
      remedy: 'Reclaim the held item(s) so they return to the pool; then diagnose the member.',
      ...ownSpec,
    };
  }

  // 5. A fleet-level block dominates every member-level explanation below it. Reported as the
  //    CONSEQUENCE it is, naming the layer, so the leader acts once on the fleet rather than
  //    N times on members.
  //
  //    EXCEPT 'members' (WI-41198). That arm of FleetBlockLayer is the SENTINEL the arbiter
  //    returns when NO upstream layer is blocking — i.e. the member level is precisely where
  //    to act. Treating it as a dominating layer inverts its meaning twice over: it renders
  //    "act at the member level" as "not an independent member-level fault ... acting on this
  //    member cannot clear it", AND it swallows every branch below (throttled, session-ending,
  //    no-self-wake, parked-awaiting-event, context-exhausted, genuinely-idle) — the only
  //    causes that carry a remedy a leader can actually execute.
  //
  //    This is the rule the module header already states: fleet-blocked exists because
  //    spec-mismatched/floor-blocked are "properties of the SPEC AND THE QUEUE, not of the
  //    member". 'members' is the exact opposite of such a property.
  //
  //    Measured cost (WI-41183): 16 of 31 members in one drain fleet reported
  //    cause='fleet-blocked'/dominatedBy='members' for 3h+ while actually being DEAD sessions
  //    with no pid. The masked 'no-self-wake' branch would have named it; instead the fleet
  //    verdict's own remedy ("wake them") was followed and produced nothing. Falling through
  //    to the member-level branches IS the fix.
  if (fleet.blockedAtLayer && fleet.blockedAtLayer !== 'members') {
    return {
      cause: 'fleet-blocked',
      reason:
        `Idle as a consequence of the fleet being blocked at '${fleet.blockedAtLayer}' — not an ` +
        'independent member-level fault. Acting on this member cannot clear it, and a wake ' +
        'while the pool or the spec is the constraint adds load behind the same block.',
      remedy: "Act on blockedAt.remedy — the fleet-level layer — not on this member.",
      dominatedBy: fleet.blockedAtLayer,
      ...ownSpec,
    };
  }

  // 6. This member specifically backed off a provider wall. Below the fleet block on purpose:
  //    when the whole pool is congested that is the fleet's story, not N separate ones.
  if (member.throttled != null) {
    return {
      cause: 'throttled',
      reason:
        'Backed off a provider wall — its nextFireAt is a WAIT, not a tick. It is not stuck ' +
        'and it has not stopped.',
      remedy: 'None — wait it out. Waking it re-queues behind the same wall.',
      ...ownSpec,
    };
  }

  // 7. The session is gone or going. Checked after the blocks above because a draining member
  //    inside a paused fleet is complying, not failing.
  if (ENDING_STATES.has(member.sessionState ?? '')) {
    return {
      cause: 'session-ending',
      reason: `sessionState is '${member.sessionState}' — this session is gone or going.`,
      remedy: 'Reclaim anything it still holds; respawn only if the fleet needs the headcount.',
      ...ownSpec,
    };
  }

  // 8. Alive, but nothing is ever going to wake it. This is the one that looks identical to
  //    'genuinely-idle' in a flat brief and has the opposite remedy: an idle member with an
  //    armed loop will pick work up by itself, one without a loop never will.
  if (member.loopMode == null && !member.nextFireAt) {
    return {
      cause: 'no-self-wake',
      reason:
        'No loop and no pending wake (loopMode null, nextFireAt null) — this member cannot ' +
        're-enter on its own, so it will stay idle indefinitely regardless of what becomes ' +
        'claimable. This is the pair a leader previously had to read by hand.',
      remedy: 'coord:wake it, or have it loop:arm — a disarmed loop cannot re-arm itself.',
      ...ownSpec,
    };
  }

  // 9. About to compact — it will not pick work up before it does.
  if (member.contextPressure === 'critical') {
    return {
      cause: 'context-exhausted',
      reason: 'contextPressure is critical — it is about to compact, not about to claim.',
      remedy: 'Let it compact; do not hand it more work first.',
      ...ownSpec,
    };
  }

  // 10. The residual, and the ONLY case where waking is the right act — the same place
  //    `computeFleetBlockVerdict` puts its 'members' layer, for the same reason.
  return {
    cause: 'genuinely-idle',
    reason:
      'Alive, loop armed, no provider wall, and no fleet-level block — capacity and scope are ' +
      'fine and it still took nothing.',
    remedy: 'coord:send wake:required to re-run scheduler:get_next.',
    ...ownSpec,
  };
}

/**
 * Roll the per-member verdicts into counts a leader reads at a glance. Reported as a map so a
 * cause that never fires is ABSENT rather than a zero — a zero row invites the reader to treat
 * an unpopulated cause as a measured absence.
 */
export function summariseIdleCauses(
  verdicts: readonly MemberIdleVerdict[],
): Partial<Record<MemberIdleCause, number>> {
  const out: Partial<Record<MemberIdleCause, number>> = {};
  for (const v of verdicts) out[v.cause] = (out[v.cause] ?? 0) + 1;
  return out;
}
