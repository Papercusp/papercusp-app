/**
 * goal-drain-fleet-watchdog (EI-20581099901890760, half 2) — alarm on an ACTIVE,
 * live-held goal that lacks the standing drain fleet the GOAL contract requires.
 *
 * SIBLING of goal-liveness-watchdog, deliberately NOT folded into it (ruling by
 * its author, msg msvb6ydv-0000): that sweep asks "is ANYONE alive working this
 * goal?" and goes silent the moment a live holder exists. This one asks the
 * question that starts exactly there: "this goal IS held — is it held CORRECTLY?"
 * The GOAL contract (modes/registry.ts, mode 'goal') requires ONE STANDING DRAIN
 * FLEET PER GOAL, always maintained: the drain fleet is the cheap correct route
 * that makes never-implement livable (one work_items:create instead of
 * self-editing). In the measured run that motivated this pair (WI-39348,
 * su-b9e0ec11, 2026-08-16), the drain fleet was never established, and the only
 * editing window of the run was also its lowest-supervision window — the exact
 * failure the contract predicts. Prose didn't hold; this instrument replaces it.
 *
 * EXACTLY ONE CLASSIFIER SPEAKS PER GOAL. This one fires ONLY on a goal with a
 * POSITIVELY-alive holder (verdict present and alive). Unheld / abandoned /
 * unresolved-holder goals are the sibling's territory or are suppressed — never
 * double-alarmed from here.
 *
 * THE CONSERVATIVE RULE, inherited from the sibling because it is the trap in
 * this area: an entity the oracle returned NO verdict for is UNKNOWN, not dead.
 * `resolveSessionStates` omits an entry when its wakeability fetch degrades, so
 * reading omission as death would turn one transient DB hiccup into a false
 * alarm on every goal at once. Unknown suppresses — here that applies BOTH to
 * goal holders (no positive alive ⇒ silent) and to drain-fleet members (any
 * member unresolved ⇒ the fleet's liveness is unknown ⇒ silent).
 *
 * Design notes:
 *  - `managedSetInterval`, category 'watchdog' — visible in schedule:inventory.
 *  - Runtime gate: FLAGS.GOAL_DRAIN_FLEET_WATCHDOG (default ON; kill-switch at
 *    /admin/features) — independent of the sibling's flag so either sweep can be
 *    silenced without losing the other.
 *  - Declaration surface: `goals:update { drainFleet }` → goals.metadata.drainFleet
 *    (the fleet slug). Grace window after goal creation covers kickoff — the
 *    contract requires the fleet AT kickoff, not before it.
 *  - REPORTS + EMITS for every goal; RE-ESTABLISHES the fleet for a STANDING one.
 *    The escalation carries the remedy; the `goal:drain-dead:<goalId>` event is
 *    what a goal agent parks on (events:await) so a dead drain fleet wakes it
 *    instead of waiting to be noticed. Until WI-2140699 this file deliberately
 *    never launched ("an authority question"). Measured 2026-09-01 (card 4,
 *    EI-22089613547454936, goal work-on-everything-070565): the rail fired twice
 *    (15:50Z, 19:21Z), the cold-carry holder never awaited the event, and the
 *    standing goal ran with ZERO live drain members for 3.5h+. The contract says
 *    the fleet is ALWAYS maintained and `goals:start` already spawns it with no
 *    agent action (P-001 automint) — so for a STANDING, live-held goal the
 *    authority to re-establish it is the same authority that minted it. The
 *    relaunch leg (`decideGoalDrainFleetRelaunch` + `relaunchDrainFleet`) reuses
 *    the mint (rows) and the launch-su door (process) the holder respawner uses,
 *    behind a durable per-goal ledger `goals.metadata.drainRespawn`
 *    { deadSinceMs, attempts[], limit, windowMs, needsHuman } mirroring
 *    `holderRespawn`: a dead/missing fleet must be seen dead for
 *    GOAL_DRAIN_FLEET_DEAD_GRACE_MS before one relaunch, at most
 *    GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT per rolling window, and a spent budget
 *    flips needsHuman (escalated once, deduped) until a human clears it or the
 *    fleet comes back alive by hand — the ledger self-clears on 'alive'. Outcome
 *    (non-standing) goals keep the report-only posture: their holder decides.
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — cluster-safe, no new state surface.
 *  - PLAN-FLEET LEG (goal-plan-fleet-obligation-detector-2026-08-27, D-002:
 *    widen this sweep, don't fork one). The same live-held goals are also
 *    judged on their STARTED plans: leg A = a plan with open items and no live
 *    fleet whose claim spec targets it; leg B = a live targeting fleet holding
 *    zero live claims on it. One verdict per goal (A beats B), unknown
 *    suppresses. Delivered as a deduped escalation (dedupKind
 *    'goal-plan-fleet-obligation'), the shared goal:plan-placement key plus a
 *    leg-specific key (goal:plan-fleet-missing / goal:plan-fleet-unclaimed), and
 *    — on a newly opened escalation only — a message + wake to the holders.
 */
import type { Sql } from 'postgres';
import { goalPlanPlacementChangedKey } from '../agent-obligations';

import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import { listCouplingsFor, peerOf } from '../coord/couplings';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
// P-001: holder rows, the alive predicate and the oracle fold all come from the
// ONE goal-holder module. This file used to import the predicate from its
// sibling watchdog, which is how the rule ended up owned by system-health and
// absent from every product surface.
import {
  holderCountsAsAlive,
  readGoalHolderRows,
  resolveHolderLiveness,
  type GoalHolderRow as GoalHolderLike,
} from '../goals/holder';
import {
  DEFAULT_CLAIM_SPEC,
  claimSpecFilterPositivelyTargets as claimSpecFilterConstrainsField,
  validateClaimSpec,
  type ClaimSpec,
  type FilterNode,
} from '../scheduler/claim-spec';

export const GOAL_DRAIN_FLEET_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long after goal creation a missing drainFleet declaration stays silent.
 *
 * The contract front-loads the drain fleet into kickoff, and the measured
 * exemplar run completed its whole kickoff gate (kill criterion, tripwires,
 * launchSettings) well inside an hour. One hour of grace covers a legitimate
 * kickoff without letting "I'll set it up later" quietly become never — the
 * failure mode this file exists to catch was a 162-minute run that never did.
 */
export const GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS = 60 * 60_000;

/**
 * WI-2140699: how long a STANDING goal's declared drain fleet must be observed
 * dead/missing (durably, `metadata.drainRespawn.deadSinceMs`) before the
 * watchdog relaunches it. One sweep interval: the first dead sweep stamps the
 * clock, the next one acts — a member that is merely booting slowly, or a
 * fleet mid-re-establishment by its holder, is never doubled.
 */
export const GOAL_DRAIN_FLEET_DEAD_GRACE_MS = GOAL_DRAIN_FLEET_SWEEP_INTERVAL_MS;

/**
 * WI-2140699: the relaunch safety budget — attempts per rolling window, kept in
 * the goal row so it survives a bg-host restart (the holder respawner's exact
 * shape, `reserveGoalHolderRespawnRateSlot`). Three is the sweep cadence's
 * ceiling anyway (10-min grace ⇒ at most one attempt per 20 min); a budget spent
 * inside the hour means every launch died on arrival, which is a human problem.
 */
export const GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT = 3;
export const GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS = 60 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'goal-drain-fleet-watchdog',
  ownerLabel: 'system · goal drain fleet',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One `status='active'` goal, reduced to what THIS verdict needs. */
export interface GoalDrainRowLike {
  goalId: string;
  workspaceId: string;
  title: string;
  /** ms epoch of the goal row's creation — anchors the kickoff grace window. */
  createdAtMs: number;
  /** metadata->>'drainFleet': the declared standing drain fleet's slug, if any. */
  drainFleet: string | null;
  /** goals.standing — TRUE for a stewardship goal. Only these earn the relaunch leg. */
  standing?: boolean | null;
  /** goals.install_slug — the harness a relaunched drain member is launched under. */
  installSlug?: string | null;
  /** metadata->'drainRespawn': the durable relaunch ledger (WI-2140699). */
  drainRespawn?: GoalDrainRespawnLedgerLike | null;
}

/** The slice of `goals.metadata.drainRespawn` the verdict reads. */
export interface GoalDrainRespawnLedgerLike {
  /** ms epoch the fleet was FIRST seen dead/missing in the current episode; null = not dead. */
  deadSinceMs: number | null;
  /** The relaunch budget was spent — automatic relaunch is off until a human clears it. */
  needsHuman: boolean;
}

/**
 * The drain-fleet WORKER leg's liveness verdict, resolved per declared fleet.
 * `unknown` exists so a degraded read suppresses rather than false-alarms.
 */
export type DrainFleetLiveness = 'alive' | 'dead' | 'not-found' | 'unknown';

/**
 * P-014: a live fleet LEADER is supervision, not proof that a drain WORKER is
 * pulling goal work. Exclude the registry leader from the worker population.
 * One positively-live worker proves worker coverage; if none is live, an
 * unresolved worker keeps the verdict unknown rather than inventing death.
 */
export function classifyDrainWorkerLiveness(
  leaderOwnerId: string | null,
  memberOwnerIds: readonly string[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
): DrainFleetLiveness {
  const workers = [...new Set(memberOwnerIds)].filter((ownerId) => ownerId !== leaderOwnerId);
  if (workers.length === 0) return 'dead';
  let unresolved = false;
  for (const ownerId of workers) {
    const verdict = verdicts.get(ownerId);
    if (!verdict) unresolved = true;
    else if (holderCountsAsAlive(verdict)) return 'alive';
  }
  return unresolved ? 'unknown' : 'dead';
}

/** A drain fleet is ready only with a distinct live leader, a recorded holder
 * coupling, and a positively live worker. Unknown leader evidence suppresses
 * recovery instead of treating a degraded read as death. */
export function classifyDelegatedDrainFleetLiveness(
  holderOwnerId: string | null,
  leaderOwnerId: string | null,
  coupled: boolean,
  memberOwnerIds: readonly string[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
): DrainFleetLiveness {
  if (!leaderOwnerId || leaderOwnerId === holderOwnerId) return 'dead';
  const leader = verdicts.get(leaderOwnerId);
  if (!leader) return 'unknown';
  if (!holderCountsAsAlive(leader) || !coupled) return 'dead';
  return classifyDrainWorkerLiveness(
    leaderOwnerId, memberOwnerIds.filter((id) => id !== holderOwnerId), verdicts,
  );
}

export type GoalDrainReason =
  | 'no-drain-fleet-declared'
  | 'drain-fleet-not-found'
  | 'drain-fleet-dead'
  | 'drain-fleet-not-goal-scoped';

/**
 * D-005 (goal-mode-design-intent-hardening-2026-08-16): the declared fleet's
 * claim-spec verdict. Before this leg landed, the watchdog verified only that
 * the declared fleet EXISTS and LIVES — a pot-wide fleet satisfied it, and a
 * pot-wide "drain lane" is exactly the shape the owner overruled: it drains
 * everything, so it guarantees nothing about THIS goal's filed work.
 * `unknown` exists for the same reason as everywhere else in this file: a
 * degraded spec read suppresses rather than false-alarms.
 *
 * `goal-cohort-starved` (EI-23748092951882673) is the fourth verdict, and it
 * exists because D-005's obligation and the scheduler's own starvation guard
 * were armed AGAINST EACH OTHER. The lane is genuinely not goal-scoped — that
 * much is a true positive — but the ONLY remedy the obligation implies is a
 * `goal`-pinned claim spec, and `goal_id` is NULL on ~99.9% of rows, so pinning
 * it collapses the claimable pool (measured on this very fleet: 4430 -> 13 of
 * 4444) and `evaluateCollapseGuard` correctly REFUSES the write. The documented
 * way past that refusal is `confirmCollapse:true` — which would actually starve
 * the fleet. So the system steered a conscientious agent toward the damaging
 * action by following instructions, every 10-minute sweep, forever.
 *
 * The rule this verdict encodes: THE WATCHDOG MUST NOT DEMAND A WRITE THE
 * SCHEDULER WOULD REFUSE. Both sides now consult one oracle, so the obligation
 * fires exactly when its remedy is legal and is silent when it is not. It is
 * NOT a suppression of D-005: a fleet whose goal HAS a populated cohort still
 * alarms, because there the pinned write succeeds.
 */
export type DrainFleetSpecScope = 'goal-scoped' | 'not-goal-scoped' | 'goal-cohort-starved' | 'unknown';

/**
 * PURE: does this filter node constrain EVERY admitted row to the goal?
 *
 * The positive `{field:'goal', op:'='|'in'}` leaf is the only thing that
 * counts, per the WI-37711 trap the claim-spec grammar documents: `goal` is a
 * NULLABLE column, so a `not`/`!=` leaf silently excludes every unstamped row
 * in the SQL compiler — a negated goal leaf is therefore NEVER goal-scoping.
 * Combinators: an `all` is scoped when ANY branch is (AND narrows); an `any`
 * only when EVERY branch is (OR widens past the goal otherwise).
 */
export function claimSpecFilterConstrainsGoal(filter: unknown, goalId: string): boolean {
  return claimSpecFilterConstrainsField(filter, 'goal', goalId);
}

/** PURE: `claimSpecFilterConstrainsGoal` lifted to a whole stored spec. */
export function claimSpecIsGoalScoped(spec: unknown, goalId: string): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const view = (spec as { view?: { filter?: unknown } }).view;
  return claimSpecFilterConstrainsGoal(view?.filter, goalId);
}

/** PURE: the plan-fleet counterpart of `claimSpecIsGoalScoped`. */
export function claimSpecIsPlanScoped(spec: unknown, planSlug: string): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const view = (spec as { view?: { filter?: unknown } }).view;
  return claimSpecFilterConstrainsField(view?.filter, 'plan', planSlug);
}

/**
 * PURE: the exact claim spec the `drain-fleet-not-goal-scoped` obligation asks
 * for — the incumbent lane with a positive `goal` pin ANDed on.
 *
 * This must build the SAME revision an agent obeying the alarm would write, or
 * the writability probe in {@link makeResolveFleetSpecScopes} measures
 * something nobody would ever submit and the two guards drift apart again. A
 * positive `{field:'goal', op:'='}` leaf is the only shape `claimSpecIsGoalScoped`
 * accepts (a `not`/`!=` leaf is never goal-scoping over a NULLABLE column), so
 * it is the only shape worth measuring. ANDing preserves any incumbent
 * narrowing rather than discarding the lane's existing intent.
 */
export function goalPinnedRemedySpec(incumbent: ClaimSpec, goalId: string): ClaimSpec {
  const goalLeaf: FilterNode = { field: 'goal', op: '=', value: goalId };
  const existing = incumbent.view?.filter as FilterNode | undefined;
  return {
    ...incumbent,
    view: { ...incumbent.view, filter: existing ? { all: [existing, goalLeaf] } : goalLeaf },
  };
}

export interface GoalPlanFleetTargetLike {
  fleetSlug: string;
  liveness: DrainFleetLiveness;
  /** Live (unexpired) plan-item claims held by members of this fleet. */
  liveClaimItemIds: string[];
}

export interface GoalPlanFleetCoverageLike {
  goalId: string;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** Non-terminal (`done`/`dropped` excluded) normalized plan items. */
  itemIds: string[];
  targetingFleets: GoalPlanFleetTargetLike[];
}

/** A failed canonical read is UNKNOWN, never an empty cohort. */
export type GoalPlanFleetCohort =
  | { status: 'known'; plans: GoalPlanFleetCoverageLike[] }
  | { status: 'unknown'; plans: [] };

export type GoalPlanFleetReason =
  | 'started-plan-no-live-targeting-fleet'
  | 'started-plan-targeting-fleet-zero-live-claims';

export interface GoalPlanFleetAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  reason: GoalPlanFleetReason;
  planSlug: string;
  harnessSlug: string;
  itemIds: string[];
  targetingFleets: GoalPlanFleetTargetLike[];
  liveHolders: string[];
}

/**
 * PURE: classify GOAL obligation #1 from the canonical joined cohort.
 *
 * Exactly one verdict may speak for a goal. Leg A wins deterministically over
 * Leg B when separate plans exhibit both failures. Any unresolved fleet on a
 * non-empty started plan suppresses the whole goal: that fleet may be the live
 * coverage we failed to observe, so treating UNKNOWN as absent would false-alarm.
 */
export function classifyGoalPlanFleetCoverage(
  goal: GoalDrainRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  cohort: GoalPlanFleetCohort,
): GoalPlanFleetAlert | null {
  if (cohort.status === 'unknown') return null;

  const liveHolders = holders
    .filter((h) => h.goalId === goal.goalId && h.workspaceId === goal.workspaceId)
    .filter((h) => {
      const verdict = verdicts.get(h.ownerId);
      return verdict ? holderCountsAsAlive(verdict) : false;
    })
    .map((h) => h.ownerId);
  if (liveHolders.length === 0) return null;

  const plans = cohort.plans
    .filter((p) => p.goalId === goal.goalId && p.workspaceId === goal.workspaceId)
    .filter((p) => p.itemIds.length > 0)
    .sort((a, b) => a.planSlug.localeCompare(b.planSlug));
  if (plans.some((p) => p.targetingFleets.some((f) => f.liveness === 'unknown'))) return null;

  const legA = plans.find((p) => !p.targetingFleets.some((f) => f.liveness === 'alive'));
  const legB = plans.find((p) => {
    const alive = p.targetingFleets.filter((f) => f.liveness === 'alive');
    return alive.length > 0 && !alive.some((f) => f.liveClaimItemIds.some((id) => p.itemIds.includes(id)));
  });
  const selected = legA ?? legB;
  if (!selected) return null;

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    reason:
      selected === legA ? 'started-plan-no-live-targeting-fleet' : 'started-plan-targeting-fleet-zero-live-claims',
    planSlug: selected.planSlug,
    harnessSlug: selected.harnessSlug,
    itemIds: selected.itemIds,
    targetingFleets: selected.targetingFleets,
    liveHolders,
  };
}

/**
 * Read the canonical plan-fleet obligation cohort in one fail-closed unit.
 *
 * The join deliberately uses normalized plan items and their TTL-backed claims,
 * plus current fleet membership for claim attribution. A read/validation/oracle
 * failure returns UNKNOWN for the entire leg; it never degrades to "no fleet" or
 * "zero claims". The sweep's plan-fleet leg ({@link runPlanFleetLeg}) delivers
 * the classifier's verdict as an escalation, events and a holder wake.
 */
export async function readGoalPlanFleetCohort(
  sql: Sql,
  goals: readonly GoalDrainRowLike[],
  resolveFleetLiveness: GoalDrainFleetSweepDeps['resolveFleetLiveness'],
): Promise<GoalPlanFleetCohort> {
  if (goals.length === 0) return { status: 'known', plans: [] };
  try {
    const goalIds = [...new Set(goals.map((g) => g.goalId))];
    const workspaceIds = [...new Set(goals.map((g) => g.workspaceId))];
    const planRows = await sql<
      {
        workspace_id: string;
        harness_slug: string;
        plan_slug: string;
        goal_id: string;
      }[]
    >`
      SELECT workspace_id, harness_slug, plan_slug, goal_id
        FROM harness_shared.harness_plans
       WHERE workspace_id = ANY(${workspaceIds}::text[])
         AND goal_id = ANY(${goalIds}::text[])
         AND op_status = 'started'
         AND archived = false`;
    const activeGoalKeys = new Set(goals.map((g) => fleetKey(g.workspaceId, g.goalId)));
    const relevantPlans = planRows.filter((p) => activeGoalKeys.has(fleetKey(p.workspace_id, p.goal_id)));
    if (relevantPlans.length === 0) return { status: 'known', plans: [] };

    const planSlugs = [...new Set(relevantPlans.map((p) => p.plan_slug))];
    const [itemRows, claimRows, specRows] = await Promise.all([
      sql<{ workspace_id: string; harness_slug: string; plan_slug: string; item_id: string }[]>`
        SELECT workspace_id, harness_slug, plan_slug, item_id
          FROM harness_shared.plan_items
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND plan_slug = ANY(${planSlugs}::text[])
           AND status NOT IN ('done', 'dropped')`,
      sql<{ workspace_id: string; harness_slug: string; plan_slug: string; item_id: string; owner: string }[]>`
        SELECT workspace_id, harness_slug, plan_slug, item_id, owner
          FROM harness_shared.plan_item_claims
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND plan_slug = ANY(${planSlugs}::text[])
           AND expires_ts > clock_timestamp()`,
      sql<{ workspace_id: string; bee_id: string; spec: unknown }[]>`
        SELECT workspace_id, bee_id, spec
          FROM harness_shared.cup_claim_specs
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND bee_id LIKE 'fleet:%'`,
    ]);

    const validSpecs = specRows.flatMap((row) => {
      const checked = validateClaimSpec(row.spec);
      if (!checked.ok || !checked.spec) return [];
      return [{ workspaceId: row.workspace_id, fleetSlug: row.bee_id.slice('fleet:'.length), spec: checked.spec }];
    });
    const targetPairs = relevantPlans.flatMap((plan) =>
      validSpecs
        .filter((spec) => spec.workspaceId === plan.workspace_id && claimSpecIsPlanScoped(spec.spec, plan.plan_slug))
        .map((spec) => ({ workspaceId: plan.workspace_id, fleetSlug: spec.fleetSlug })),
    );
    const uniqueTargets = [...new Map(targetPairs.map((p) => [fleetKey(p.workspaceId, p.fleetSlug), p])).values()];
    const fleetLiveness = await resolveFleetLiveness(uniqueTargets);
    const targetSlugs = [...new Set(uniqueTargets.map((p) => p.fleetSlug))];
    const memberRows =
      targetSlugs.length === 0
        ? []
        : await sql<{ workspace_id: string; fleet_slug: string; owner_id: string }[]>`
          SELECT workspace_id, fleet_slug, owner_id
            FROM harness_shared.coord_presence
           WHERE workspace_id = ANY(${workspaceIds}::text[])
             AND fleet_slug = ANY(${targetSlugs}::text[])`;

    const planKey = (workspaceId: string, harnessSlug: string, planSlug: string) =>
      `${workspaceId}\u0000${harnessSlug}\u0000${planSlug}`;
    return {
      status: 'known',
      plans: relevantPlans.map((plan) => {
        const key = planKey(plan.workspace_id, plan.harness_slug, plan.plan_slug);
        const itemIds = itemRows
          .filter((item) => planKey(item.workspace_id, item.harness_slug, item.plan_slug) === key)
          .map((item) => item.item_id);
        const targeting = validSpecs.filter(
          (spec) => spec.workspaceId === plan.workspace_id && claimSpecIsPlanScoped(spec.spec, plan.plan_slug),
        );
        return {
          goalId: plan.goal_id,
          workspaceId: plan.workspace_id,
          harnessSlug: plan.harness_slug,
          planSlug: plan.plan_slug,
          itemIds,
          targetingFleets: targeting.map((target) => {
            const members = new Set(
              memberRows
                .filter((m) => m.workspace_id === plan.workspace_id && m.fleet_slug === target.fleetSlug)
                .map((m) => m.owner_id),
            );
            return {
              fleetSlug: target.fleetSlug,
              liveness: fleetLiveness.get(fleetKey(plan.workspace_id, target.fleetSlug)) ?? 'unknown',
              liveClaimItemIds: claimRows
                .filter((claim) => planKey(claim.workspace_id, claim.harness_slug, claim.plan_slug) === key)
                .filter((claim) => members.has(claim.owner))
                .map((claim) => claim.item_id),
            };
          }),
        };
      }),
    };
  } catch {
    return { status: 'unknown', plans: [] };
  }
}

/** One read-only, goal-scoped observation for shared obligation consumers. */
export type GoalPlanFleetObservation =
  | {
      status: 'known';
      alert: GoalPlanFleetAlert | null;
      applicablePlanCount: number;
    }
  | {
      status: 'unknown';
      alert: null;
      applicablePlanCount: null;
    };

export interface GoalPlanFleetObservationDeps {
  readGoals: GoalDrainFleetSweepDeps['readGoals'];
  resolveLiveness: GoalDrainFleetSweepDeps['resolveLiveness'];
  resolveFleetLiveness: GoalDrainFleetSweepDeps['resolveFleetLiveness'];
  readCohort: (
    goals: readonly GoalDrainRowLike[],
    resolveFleetLiveness: GoalDrainFleetSweepDeps['resolveFleetLiveness'],
  ) => Promise<GoalPlanFleetCohort>;
}

/**
 * Compose the watchdog's existing readers without running its escalation or
 * recovery side effects. This is the canonical bridge for turn/leader briefs:
 * they receive the same classifier verdict as the watchdog, not a copied SQL
 * approximation or a call to the mutating sweep.
 */
export async function readGoalPlanFleetObservation(
  sql: Sql,
  filter: { workspaceId: string; goalId: string },
  overrides: Partial<GoalPlanFleetObservationDeps> = {},
): Promise<GoalPlanFleetObservation> {
  const resolveLiveness = overrides.resolveLiveness ?? resolveHolderLiveness;
  const deps: GoalPlanFleetObservationDeps = {
    readGoals: overrides.readGoals ?? makeReadGoals(sql),
    resolveLiveness,
    resolveFleetLiveness: overrides.resolveFleetLiveness ?? makeResolveFleetLiveness(sql, resolveLiveness),
    readCohort:
      overrides.readCohort ??
      ((goals, resolveFleetLiveness) => readGoalPlanFleetCohort(sql, goals, resolveFleetLiveness)),
  };
  try {
    const { goals, holders } = await deps.readGoals();
    const goal = goals.find(
      (candidate) => candidate.goalId === filter.goalId && candidate.workspaceId === filter.workspaceId,
    );
    if (!goal) return { status: 'known', alert: null, applicablePlanCount: 0 };
    const relevantHolders = holders.filter(
      (holder) => holder.goalId === filter.goalId && holder.workspaceId === filter.workspaceId,
    );
    const verdicts = await deps.resolveLiveness([...new Set(relevantHolders.map((holder) => holder.ownerId))]);
    const cohort = await deps.readCohort([goal], deps.resolveFleetLiveness);
    if (cohort.status === 'unknown') return { status: 'unknown', alert: null, applicablePlanCount: null };
    const applicablePlanCount = cohort.plans.filter((plan) => plan.itemIds.length > 0).length;
    return {
      status: 'known',
      alert: classifyGoalPlanFleetCoverage(goal, relevantHolders, verdicts, cohort),
      applicablePlanCount,
    };
  } catch {
    return { status: 'unknown', alert: null, applicablePlanCount: null };
  }
}

// ── goal-plan-fleet-obligation-detector P-002: delivering the plan-fleet verdict ──

/**
 * PURE: the leg-specific parkable key for a plan-fleet alert (D-003: each leg
 * emits a DISTINCT event). A holder that only cares that a started plan lost
 * its fleet parks on `goal:plan-fleet-missing:<goalId>`; one that launched a
 * fleet and wants to hear it is not pulling parks on
 * `goal:plan-fleet-unclaimed:<goalId>`. The shared obligation key
 * (`goal:plan-placement:<goalId>`) fires alongside either.
 */
export function goalPlanFleetLegEventKey(alert: Pick<GoalPlanFleetAlert, 'goalId' | 'reason'>): string {
  return alert.reason === 'started-plan-no-live-targeting-fleet'
    ? `goal:plan-fleet-missing:${alert.goalId}`
    : `goal:plan-fleet-unclaimed:${alert.goalId}`;
}

/** Bound on the id lists an event payload carries; the counts stay exact. */
export const GOAL_PLAN_FLEET_EVENT_MAX_IDS = 25;

/**
 * PURE: the evidence a plan-fleet event carries — plan, targeting fleets (with
 * the claim spec each was selected by), their live claims, and the holders the
 * verdict rests on. Everything a woken holder needs to act without re-deriving
 * the cohort; id lists are capped, their counts are not.
 */
export function goalPlanFleetEventPayload(alert: GoalPlanFleetAlert) {
  const cap = (ids: readonly string[]) => ids.slice(0, GOAL_PLAN_FLEET_EVENT_MAX_IDS);
  return {
    goalId: alert.goalId,
    reason: alert.reason,
    planSlug: alert.planSlug,
    harnessSlug: alert.harnessSlug,
    openItemCount: alert.itemIds.length,
    openItemIds: cap(alert.itemIds),
    targetingFleets: alert.targetingFleets.map((f) => ({
      fleetSlug: f.fleetSlug,
      liveness: f.liveness,
      // cup_claim_specs.bee_id — the spec whose positive plan leaf made this fleet a target.
      claimSpecRef: `fleet:${f.fleetSlug}`,
      liveClaimCount: f.liveClaimItemIds.length,
      liveClaimItemIds: cap(f.liveClaimItemIds),
    })),
    liveHolders: alert.liveHolders,
  };
}

/**
 * PURE: the escalation dedup subject. The plan is part of the subject: when one
 * plan is repaired and a different plan of the same goal still fails, that is a
 * new actionable condition, not a repeat of the old one.
 */
export function goalPlanFleetSubjectSignature(
  alert: Pick<GoalPlanFleetAlert, 'workspaceId' | 'goalId' | 'reason' | 'planSlug'>,
): string {
  return `${alert.workspaceId}:${alert.goalId}:${alert.reason}:${alert.planSlug}`;
}

/** PURE: the remedy text shared by the escalation and the holder message. */
export function goalPlanFleetRemedy(alert: GoalPlanFleetAlert): string {
  const fleets = alert.targetingFleets.map((f) => `'${f.fleetSlug}' (${f.liveness})`).join(', ');
  if (alert.reason === 'started-plan-no-live-targeting-fleet') {
    return (
      `Started plan '${alert.planSlug}' (${alert.harnessSlug}) has ${alert.itemIds.length} open item(s) and ` +
      (alert.targetingFleets.length === 0
        ? 'NO fleet whose claim spec targets it'
        : `no LIVE fleet whose claim spec targets it (targeting: ${fleets})`) +
      `, so nothing will ever claim its work. Remedy — re-read your obligation agenda (it carries the exact, ` +
      `admission-checked launch), then either launch a plan fleet (fleet:launch-on-plan { plan: ` +
      `'${alert.planSlug}' }), point an existing live lane at it (scheduler:set_claim_spec with a positive ` +
      `{ field:'plan', op:'=', value:'${alert.planSlug}' } leaf), or stop the plan if it is no longer wanted.`
    );
  }
  return (
    `Started plan '${alert.planSlug}' (${alert.harnessSlug}) has ${alert.itemIds.length} open item(s) and ` +
    `live fleet(s) whose claim spec targets it (${fleets}), but those fleets hold ZERO live claims on its ` +
    `items. That is a spec-scope or pickup failure, not a missing fleet: launching another fleet will not ` +
    `help. Remedy — check that the spec's other filter leaves admit these items (scheduler:preview_spec_delta ` +
    `{ fleet, proposed } lists what a corrected revision would admit), that the items are claimable (not ` +
    `blocked by unfinished dependencies), and that the members are taking turns (fleet:status); then wake ` +
    `a member to scheduler:get_next.`
  );
}

export interface GoalDrainAlert {
  goalId: string;
  workspaceId: string;
  title: string;
  drainFleet: string | null;
  reason: GoalDrainReason;
  /** The positively-alive holders that make this goal "held" (owner ids). */
  liveHolders: string[];
  /** goals.standing — decides report-only vs. relaunch posture (WI-2140699). */
  standing: boolean;
}

/** Key a fleet-liveness map the same way the fleets table is keyed. */
export function fleetKey(workspaceId: string, fleetSlug: string): string {
  return `${workspaceId}:${fleetSlug}`;
}

/**
 * PURE: classify one goal. Returns null when the goal is healthy, when it is not
 * positively held alive (the sibling watchdog's territory), or when the evidence
 * is insufficient to call the drain fleet dark.
 */
export function classifyGoalDrainFleet(
  goal: GoalDrainRowLike,
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  fleetLiveness: ReadonlyMap<string, DrainFleetLiveness>,
  /** D-005: per-GOAL claim-spec scope verdicts (keyed by goalId — the pair being
   *  judged is (goal, its declared fleet), and two goals may declare one fleet). */
  specScopes: ReadonlyMap<string, DrainFleetSpecScope>,
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
): GoalDrainAlert | null {
  const mine = holders.filter((h) => h.goalId === goal.goalId && h.workspaceId === goal.workspaceId);
  // POSITIVE liveness required: a holder with no verdict is unknown, and unknown
  // never promotes to "held" here — if nobody is provably working the goal, the
  // drain-fleet question is moot and the liveness sibling owns the alarm.
  const liveHolders = mine
    .filter((h) => {
      const v = verdicts.get(h.ownerId);
      return v ? holderCountsAsAlive(v) : false;
    })
    .map((h) => h.ownerId);
  if (liveHolders.length === 0) return null;

  const base = {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    title: goal.title,
    drainFleet: goal.drainFleet,
    liveHolders,
    standing: goal.standing === true,
  };

  if (goal.drainFleet === null) {
    const sinceCreation = nowMs - goal.createdAtMs;
    if (!Number.isFinite(sinceCreation) || sinceCreation < graceMs) return null;
    return { ...base, reason: 'no-drain-fleet-declared' };
  }

  const verdict = fleetLiveness.get(fleetKey(goal.workspaceId, goal.drainFleet)) ?? 'unknown';
  if (verdict === 'unknown') return null;
  if (verdict !== 'alive') {
    return {
      ...base,
      reason: verdict === 'not-found' ? 'drain-fleet-not-found' : 'drain-fleet-dead',
    };
  }
  // ALIVE — the pre-D-005 verdict stopped here, which let a pot-wide fleet
  // pass. Held correctly now also means SCOPED correctly: the lane's claim
  // spec must positively constrain admitted rows to THIS goal. Unknown (a
  // degraded spec read) suppresses, same as every other leg.
  const scope = specScopes.get(goal.goalId) ?? 'unknown';
  // ONLY 'not-goal-scoped' alarms. The other two verdicts SUPPRESS, for different
  // reasons: 'unknown' per the file-wide conservative rule (a degraded read is not
  // evidence), and 'goal-cohort-starved' (EI-23748092951882673) because the
  // obligation's only remedy is a write the scheduler's starvation guard refuses —
  // alarming there steers the reader toward confirmCollapse:true, which is the
  // actual harm. See DrainFleetSpecScope.
  if (scope === 'not-goal-scoped') return { ...base, reason: 'drain-fleet-not-goal-scoped' };
  return null;
}

/** PURE: classify a whole batch. Exported for tests and future read-side surfaces. */
export function scanGoalDrainFleets(
  goals: readonly GoalDrainRowLike[],
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  fleetLiveness: ReadonlyMap<string, DrainFleetLiveness>,
  specScopes: ReadonlyMap<string, DrainFleetSpecScope>,
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
): GoalDrainAlert[] {
  const out: GoalDrainAlert[] = [];
  for (const g of goals) {
    const alert = classifyGoalDrainFleet(g, holders, verdicts, fleetLiveness, specScopes, nowMs, graceMs);
    if (alert) out.push(alert);
  }
  return out;
}

// ── WI-2140699: the relaunch leg (STANDING goals only) ─────────────────────

export type GoalDrainRelaunchIneligibility =
  /** Only a dead or missing DECLARED fleet is relaunchable — an undeclared or
   *  mis-scoped one is a holder decision, not a process to restart. */
  | 'reason-not-relaunchable'
  /** Outcome goals keep the report-only posture; their holder decides. */
  | 'not-standing'
  /** The budget was spent and a human has not cleared `drainRespawn.needsHuman`. */
  | 'needs-human';

/**
 * PURE gate: may this alert enter the relaunch leg at all? Evaluated BEFORE any
 * ledger write so an ineligible goal costs the sweep no SQL.
 */
export function goalDrainRelaunchEligibility(
  alert: Pick<GoalDrainAlert, 'reason'>,
  goal: Pick<GoalDrainRowLike, 'standing' | 'drainRespawn'>,
): { eligible: true } | { eligible: false; why: GoalDrainRelaunchIneligibility } {
  if (alert.reason !== 'drain-fleet-dead' && alert.reason !== 'drain-fleet-not-found') {
    return { eligible: false, why: 'reason-not-relaunchable' };
  }
  if (goal.standing !== true) return { eligible: false, why: 'not-standing' };
  if (goal.drainRespawn?.needsHuman === true) return { eligible: false, why: 'needs-human' };
  return { eligible: true };
}

export type GoalDrainRelaunchDecision =
  | { kind: 'wait'; deadSinceMs: number; remainingMs: number }
  | { kind: 'relaunch'; deadSinceMs: number; deadForMs: number };

/**
 * PURE timing: given the durable first-seen-dead stamp (already written by
 * `markGoalDrainFleetDead` this sweep), has the fleet been dead long enough?
 * A non-finite or future stamp is treated as "just now" — the conservative
 * reading, one more sweep of patience rather than a relaunch off a bad clock.
 */
export function decideGoalDrainFleetRelaunch(
  deadSinceMs: number,
  nowMs: number,
  graceMs: number = GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
): GoalDrainRelaunchDecision {
  const since = Number.isFinite(deadSinceMs) && deadSinceMs <= nowMs ? deadSinceMs : nowMs;
  const deadForMs = nowMs - since;
  if (deadForMs < graceMs) return { kind: 'wait', deadSinceMs: since, remainingMs: graceMs - deadForMs };
  return { kind: 'relaunch', deadSinceMs: since, deadForMs };
}

export type GoalDrainRelaunchRateDecision =
  | { kind: 'reserved'; attemptsInWindow: number }
  | { kind: 'capped'; attemptsInWindow: number }
  /** The goal row is gone / no longer active — nothing to relaunch for. */
  | { kind: 'ineligible'; attemptsInWindow: 0 };

export interface GoalDrainRelaunchResult {
  fleetSlug: string;
  /** The newly launched worker, if any. A leader/coupling repair can preserve all workers. */
  ownerId: string | null;
  warnings: string[];
  actions?: { reminted: boolean; leaderLaunched: boolean; couplingRepaired: boolean; memberLaunched: boolean };
}

export interface GoalDrainFleetSweepDeps {
  readGoals: () => Promise<{ goals: GoalDrainRowLike[]; holders: GoalHolderLike[] }>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  /** Resolve every declared drain fleet (by fleetKey) to a liveness verdict. */
  resolveFleetLiveness: (
    fleets: { workspaceId: string; fleetSlug: string; holderOwnerId?: string }[],
  ) => Promise<Map<string, DrainFleetLiveness>>;
  /** D-005: resolve each (goal, declared fleet) pair to a claim-spec scope
   *  verdict, keyed by goalId. Only consulted for ALIVE fleets. */
  resolveFleetSpecScopes: (
    pairs: { workspaceId: string; fleetSlug: string; goalId: string }[],
  ) => Promise<Map<string, DrainFleetSpecScope>>;
  escalate: (alert: GoalDrainAlert) => Promise<void>;
  /** Emit the shared placement-change key for every actionable classifier
   * result, plus the legacy drain-dead key for a declared-gone fleet. */
  emitDrainDead: (alert: GoalDrainAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;

  // ── WI-2140699 relaunch leg ──
  /** FLAGS.GOAL_DRAIN_FLEET_RELAUNCH — read once per sweep, only if some alert is eligible. */
  relaunchFlagEnabled: () => Promise<boolean>;
  /** Durable first-seen-dead stamp: returns the episode's deadSinceMs (existing or `nowMs`),
   *  or null when the goal row is no longer an active target. */
  markDrainDead: (goal: GoalDrainRowLike, nowMs: number) => Promise<number | null>;
  /** Atomically reserve one attempt in the rolling-window ledger (flips needsHuman when spent). */
  reserveRelaunchSlot: (goal: GoalDrainRowLike, nowMs: number) => Promise<GoalDrainRelaunchRateDecision>;
  /** The fleet is alive again: retire deadSinceMs + needsHuman so the next episode starts clean. */
  clearDrainLedger: (goal: GoalDrainRowLike) => Promise<void>;
  /** Mint rows (idempotent) + launch one headless member into the lane. Throws on failure. */
  relaunchDrainFleet: (alert: GoalDrainAlert, goal: GoalDrainRowLike) => Promise<GoalDrainRelaunchResult>;
  /** Tell the live holder(s) what the platform just did for them. Fail-soft. */
  notifyRelaunch: (alert: GoalDrainAlert, goal: GoalDrainRowLike, result: GoalDrainRelaunchResult) => Promise<void>;
  /** The budget is spent: ONE deduped human-facing escalation. */
  escalateRelaunchExhausted: (alert: GoalDrainAlert, attemptsInWindow: number) => Promise<void>;
  deadGraceMs: number;

  // ── goal-plan-fleet-obligation-detector P-002: the plan-fleet leg ──
  /** The canonical, fail-closed plan-fleet cohort read ({@link readGoalPlanFleetCohort}). */
  readPlanFleetCohort: (
    goals: readonly GoalDrainRowLike[],
    resolveFleetLiveness: GoalDrainFleetSweepDeps['resolveFleetLiveness'],
  ) => Promise<GoalPlanFleetCohort>;
  /** Deduped escalation; `opened:false` means an open one for the same subject was coalesced. */
  escalatePlanFleet: (alert: GoalPlanFleetAlert) => Promise<{ opened: boolean }>;
  /** The shared placement key plus the leg-specific key, both carrying the evidence payload. */
  emitPlanFleet: (alert: GoalPlanFleetAlert) => Promise<void>;
  /** Message + directed wake to the live holders — only on a NEWLY opened escalation. */
  notifyPlanFleetHolders: (alert: GoalPlanFleetAlert) => Promise<void>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return await getFlag(FLAGS.GOAL_DRAIN_FLEET_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

/** Parse `metadata->'drainRespawn'` defensively — a malformed ledger reads as "no episode". */
export function parseGoalDrainRespawnLedger(raw: unknown): GoalDrainRespawnLedgerLike | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const dead = rec.deadSinceMs;
  const deadSinceMs =
    typeof dead === 'number' && Number.isFinite(dead)
      ? dead
      : typeof dead === 'string' && dead.trim() !== '' && Number.isFinite(Number(dead))
        ? Number(dead)
        : null;
  return { deadSinceMs, needsHuman: rec.needsHuman === true };
}

function makeReadGoals(sql: Sql): GoalDrainFleetSweepDeps['readGoals'] {
  return async () => {
    const goalRows = await sql<
      {
        id: string;
        workspace_id: string;
        title: string;
        install_slug: string | null;
        standing: boolean | null;
        created_ms: string;
        drain_fleet: string | null;
        drain_respawn: unknown;
      }[]
    >`
      SELECT id, workspace_id, title, install_slug, standing,
             (extract(epoch FROM created_at) * 1000)::bigint AS created_ms,
             metadata->>'drainFleet' AS drain_fleet,
             metadata->'drainRespawn' AS drain_respawn
        FROM harness_shared.goals
       WHERE status = 'active'`;
    // P-001: the canonical holder read. Unfiltered by goal on purpose — an inner
    // join to active goals would drop the no-holder case.
    const holders = await readGoalHolderRows(sql);
    return {
      goals: goalRows.map((r) => ({
        goalId: r.id,
        workspaceId: r.workspace_id,
        title: r.title,
        createdAtMs: Number(r.created_ms),
        drainFleet: r.drain_fleet,
        standing: r.standing === true,
        installSlug: r.install_slug,
        drainRespawn: parseGoalDrainRespawnLedger(r.drain_respawn),
      })),
      holders,
    };
  };
}

/**
 * WI-2140699: stamp the episode's first-seen-dead time, idempotently. Returns
 * the stamp in force after the write (existing or `nowMs`), or null when the
 * goal is no longer an active row — the relaunch leg then does nothing.
 */
export async function markGoalDrainFleetDead(
  sql: Sql,
  goal: Pick<GoalDrainRowLike, 'goalId' | 'workspaceId'>,
  nowMs: number,
): Promise<number | null> {
  const [row] = await sql<Array<{ dead_since_ms: string | number }>>`
    UPDATE harness_shared.goals
       SET metadata = jsonb_set(
             CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
             '{drainRespawn}',
             (CASE WHEN jsonb_typeof(metadata -> 'drainRespawn') = 'object'
                   THEN metadata -> 'drainRespawn' ELSE '{}'::jsonb END) ||
               jsonb_build_object(
                 'deadSinceMs',
                 COALESCE(
                   CASE WHEN jsonb_typeof(metadata #> '{drainRespawn,deadSinceMs}') = 'number'
                        THEN metadata #> '{drainRespawn,deadSinceMs}' END,
                   to_jsonb(${nowMs}::bigint)
                 )
               ),
             true
           )
     WHERE id = ${goal.goalId}
       AND workspace_id = ${goal.workspaceId}
       AND status = 'active'
    RETURNING (metadata #>> '{drainRespawn,deadSinceMs}') AS dead_since_ms
  `;
  if (!row) return null;
  const parsed = Number(row.dead_since_ms);
  return Number.isFinite(parsed) ? parsed : nowMs;
}

/**
 * WI-2140699: atomically reserve one relaunch in the goal row's rolling-window
 * ledger — the holder respawner's `reserveGoalHolderRespawnRateSlot`, on
 * `{drainRespawn}` with the drain budget. Reserving BEFORE launching means a
 * crash mid-launch still costs the budget. A reservation also retires
 * `deadSinceMs`: the attempt resets the dead clock, so a member that fails to
 * come up is only retried after a fresh full grace, never every tick. A spent
 * budget flips `needsHuman` (the sweep escalates once, deduped) and stays
 * flipped until a human clears it or the fleet comes back alive by hand.
 */
export async function reserveGoalDrainFleetRelaunchSlot(
  sql: Sql,
  goal: Pick<GoalDrainRowLike, 'goalId' | 'workspaceId'>,
  nowMs: number,
): Promise<GoalDrainRelaunchRateDecision> {
  const cutoffMs = nowMs - GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS;
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
             CASE WHEN jsonb_typeof(c.base_metadata -> 'drainRespawn') = 'object'
                  THEN c.base_metadata -> 'drainRespawn' ELSE '{}'::jsonb END AS base_state,
             CASE WHEN jsonb_typeof(c.base_metadata #> '{drainRespawn,attempts}') = 'array'
                  THEN c.base_metadata #> '{drainRespawn,attempts}' ELSE '[]'::jsonb END AS raw_attempts
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
             '{drainRespawn}',
             CASE WHEN d.attempt_count >= ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT}
               THEN d.base_state || jsonb_build_object(
                 'attempts', d.attempts,
                 'limit', ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT}::bigint,
                 'windowMs', ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS}::bigint,
                 'needsHuman', true,
                 'needsHumanAtMs', COALESCE(
                   d.base_state -> 'needsHumanAtMs',
                   to_jsonb(${nowMs}::bigint)
                 ),
                 'reason', 'hourly-relaunch-cap'
               )
               ELSE (d.base_state - 'needsHumanAtMs' - 'reason' - 'deadSinceMs') ||
                 jsonb_build_object(
                   'attempts', d.attempts || jsonb_build_array(${nowMs}::bigint),
                   'limit', ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT}::bigint,
                   'windowMs', ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS}::bigint,
                   'needsHuman', false,
                   'lastRelaunchAtMs', ${nowMs}::bigint
                 )
             END,
             true
           )
      FROM decision d
     WHERE g.id = d.id AND g.workspace_id = d.workspace_id
    RETURNING (d.attempt_count < ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT}) AS allowed,
              (d.attempt_count + CASE
                WHEN d.attempt_count < ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT} THEN 1 ELSE 0
              END)::text AS attempts_in_window
  `;
  if (!row) return { kind: 'ineligible', attemptsInWindow: 0 };
  const attemptsInWindow = Number(row.attempts_in_window);
  return row.allowed ? { kind: 'reserved', attemptsInWindow } : { kind: 'capped', attemptsInWindow };
}

/**
 * WI-2140699: the fleet is alive again — end the episode. Retires the dead
 * clock AND the needs-human flag (a human who stood the fleet up by hand has
 * done exactly what the flag was asking for), keeps the attempts history so the
 * rolling budget still counts the launches that led here.
 */
export async function clearGoalDrainFleetLedger(
  sql: Sql,
  goal: Pick<GoalDrainRowLike, 'goalId' | 'workspaceId'>,
): Promise<void> {
  await sql`
    UPDATE harness_shared.goals
       SET metadata = jsonb_set(
             metadata,
             '{drainRespawn}',
             (metadata -> 'drainRespawn') - 'deadSinceMs' - 'needsHuman' - 'needsHumanAtMs' - 'reason',
             true
           )
     WHERE id = ${goal.goalId}
       AND workspace_id = ${goal.workspaceId}
       AND jsonb_typeof(metadata -> 'drainRespawn') = 'object'
  `;
}

/**
 * A declared fleet has worker coverage only when a current NON-LEADER member
 * resolves alive. No fleets-table row ⇒ not-found. A leader-only fleet is dead
 * as a drain lane, even if its leader is healthy and supervising nothing.
 */
export function makeResolveFleetLiveness(
  sql: Sql,
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>,
): GoalDrainFleetSweepDeps['resolveFleetLiveness'] {
  return async (fleets) => {
    const out = new Map<string, DrainFleetLiveness>();
    if (fleets.length === 0) return out;
    const slugs = [...new Set(fleets.map((f) => f.fleetSlug))];
    const fleetRows = await sql<{
      workspace_id: string; fleet_slug: string; owner: string | null;
      leader_owner_id: string | null;
    }[]>`
      SELECT f.workspace_id, f.fleet_slug, f.owner, f.leader_owner_id
        FROM harness_shared.agent_fleets f
       WHERE f.fleet_slug = ANY(${slugs}::text[])`;
    const existing = new Map(fleetRows.map((r) => [fleetKey(r.workspace_id, r.fleet_slug), r]));
    const memberRows = await sql<{ workspace_id: string; fleet_slug: string; owner_id: string }[]>`
      SELECT workspace_id, fleet_slug, owner_id
        FROM harness_shared.coord_presence
       WHERE fleet_slug = ANY(${slugs}::text[])`;
    const membersByFleet = new Map<string, string[]>();
    for (const m of memberRows) {
      const k = fleetKey(m.workspace_id, m.fleet_slug);
      const list = membersByFleet.get(k) ?? [];
      list.push(m.owner_id);
      membersByFleet.set(k, list);
    }
    const allMembers = [...new Set([
      ...memberRows.map((m) => m.owner_id),
      ...fleetRows.map((r) => r.leader_owner_id).filter((id): id is string => !!id),
    ])];
    const verdicts = allMembers.length > 0 ? await resolveLiveness(allMembers) : new Map<string, LivenessVerdict>();
    const holderIds = [...new Set(fleets.map((f) => f.holderOwnerId).filter((id): id is string => !!id))];
    const couplingRows = holderIds.length > 0
      ? await sql<{ workspace_id: string; agent_a: string; agent_b: string }[]>`
          SELECT workspace_id, agent_a, agent_b FROM harness_shared.agent_couplings
           WHERE state = 'coupled'
             AND (expires_at IS NULL OR expires_at > clock_timestamp())
             AND (agent_a = ANY(${holderIds}::text[]) OR agent_b = ANY(${holderIds}::text[]))`
      : [];
    const couplingKeys = new Set(couplingRows.map((r) => `${r.workspace_id}\0${r.agent_a}\0${r.agent_b}`));

    for (const f of fleets) {
      const k = fleetKey(f.workspaceId, f.fleetSlug);
      const fleet = existing.get(k);
      if (!fleet) {
        out.set(k, 'not-found');
        continue;
      }
      const members = membersByFleet.get(k) ?? [];
      // This resolver also serves plan-fleet coverage. Only a declared drain
      // goal supplies a holder and requires GOAL delegation/coupling.
      if (!f.holderOwnerId) {
        out.set(k, classifyDrainWorkerLiveness(fleet.leader_owner_id, members, verdicts));
        continue;
      }
      const holderOwnerId = f.holderOwnerId;
      const leaderOwnerId = fleet.leader_owner_id;
      const pair = holderOwnerId && leaderOwnerId
        ? [holderOwnerId, leaderOwnerId].sort() : null;
      const coupled = pair ? couplingKeys.has(`${f.workspaceId}\0${pair[0]}\0${pair[1]}`) : false;
      out.set(k, classifyDelegatedDrainFleetLiveness(
        holderOwnerId, leaderOwnerId, coupled, members, verdicts,
      ));
    }
    return out;
  };
}

/**
 * EI-23748092951882673: would the `goal`-pinned remedy actually be WRITABLE?
 *
 * This is the whole fix for the two-guards-armed-against-each-other conflict.
 * The watchdog used to assert "not goal-scoped => misconfigured" unconditionally.
 * But the remedy it implies is a claim-spec write, and that write goes through
 * `evaluateCollapseGuard`, which refuses a revision that collapses the claimable
 * pool. On a workspace where `goal_id` is NULL on ~99.9% of rows the pinned lane
 * is near-empty BY CONSTRUCTION, so the guard refuses — and the obligation was
 * unsatisfiable except via `confirmCollapse:true`, the override whose use is the
 * actual harm.
 *
 * So: build the exact remedy, measure it with the SAME primitive `set_claim_spec`
 * uses, and ask the SAME guard. Refused => `goal-cohort-starved` (not an
 * obligation, because it is not actionable). Accepted => `not-goal-scoped`, a
 * real obligation whose remedy will land. The two guards can no longer disagree,
 * because there is now only one oracle.
 *
 * `confirm` is hard-wired false on purpose: the question is "would this be
 * REFUSED?", never "could it be FORCED?".
 */
export interface GoalPinWritabilityProbe {
  preview: (
    spec: ClaimSpec,
    opts: { workspaceId: string; harness: string | null },
  ) => Promise<{ matched: number; pool: number }>;
  guard: (input: {
    matched: number;
    pool: number;
    previousMatched: number | null;
    previousSource: 'authored' | 'default';
    confirm: boolean;
    filter?: FilterNode;
    previousFilter?: FilterNode;
  }) => { refuse: boolean };
}

export async function resolveGoalPinWritability(
  incumbentSpec: unknown,
  goalId: string,
  workspaceId: string,
  probe?: GoalPinWritabilityProbe,
): Promise<DrainFleetSpecScope> {
  try {
    const impl: GoalPinWritabilityProbe =
      probe ??
      (await (async () => {
        const m = await import('../scheduler/spec-pool-preview');
        return {
          preview: (spec, opts) => m.previewSpecPoolEffect(spec, opts),
          guard: (input) => m.evaluateCollapseGuard(input),
        } satisfies GoalPinWritabilityProbe;
      })());
    const authored = !!incumbentSpec && typeof incumbentSpec === 'object';
    const incumbent = (authored ? incumbentSpec : DEFAULT_CLAIM_SPEC) as ClaimSpec;
    const remedy = goalPinnedRemedySpec(incumbent, goalId);
    // Mirrors set_claim_spec's `countScope`. A FLEET lane is not harness-scoped,
    // so the basis is the whole workspace (harness:null) under the neutral floors
    // previewSpecPoolEffect documents.
    const countScope = { workspaceId, harness: null };
    const candidate = await impl.preview(remedy, countScope);
    const previousMatched = authored ? (await impl.preview(incumbent, countScope)).matched : null;
    const verdict = impl.guard({
      matched: candidate.matched,
      pool: candidate.pool,
      previousMatched,
      previousSource: authored ? 'authored' : 'default',
      confirm: false,
      filter: remedy.view?.filter as FilterNode | undefined,
      previousFilter: incumbent.view?.filter as FilterNode | undefined,
    });
    return verdict.refuse ? 'goal-cohort-starved' : 'not-goal-scoped';
  } catch {
    // The file-wide conservative rule: a degraded probe is UNKNOWN and suppresses.
    // Raising an obligation we cannot show is actionable is the exact failure this
    // function exists to remove, so a failed measurement must not fall back to it.
    return 'unknown';
  }
}

/**
 * D-005: resolve each (goal, declared fleet) pair's claim-spec scope. The fleet
 * lane lives on the `fleet:<slug>` sentinel row of cup_claim_specs; NO row means
 * members inherit DEFAULT_CLAIM_SPEC (an empty view), which is truthfully a
 * pot-wide lane — not-goal-scoped, not unknown. The row is looked up first under
 * the goal's own workspace partition, then under ANY partition (WI-1564: legacy
 * writers stored under 'default'; alarming on a partition mismatch would be a
 * false positive about scope). A failed READ is 'unknown' and suppresses.
 */
function makeResolveFleetSpecScopes(sql: Sql): GoalDrainFleetSweepDeps['resolveFleetSpecScopes'] {
  return async (pairs) => {
    const out = new Map<string, DrainFleetSpecScope>();
    if (pairs.length === 0) return out;
    try {
      const { fleetSpecBeeKey } = await import('../scheduler/claim-spec-store');
      const keys = [...new Set(pairs.map((p) => fleetSpecBeeKey(p.fleetSlug)))];
      const rows = await sql<{ workspace_id: string; bee_id: string; spec: unknown }[]>`
        SELECT workspace_id, bee_id, spec
          FROM harness_shared.cup_claim_specs
         WHERE bee_id = ANY(${keys}::text[])`;
      for (const p of pairs) {
        const beeKey = fleetSpecBeeKey(p.fleetSlug);
        const row =
          rows.find((r) => r.bee_id === beeKey && r.workspace_id === p.workspaceId) ??
          rows.find((r) => r.bee_id === beeKey);
        if (claimSpecIsGoalScoped(row?.spec ?? null, p.goalId)) {
          out.set(p.goalId, 'goal-scoped');
          continue;
        }
        // EI-23748092951882673: "not goal-scoped" is only an OBLIGATION when the
        // remedy is a legal write. Ask the scheduler's own guard before alarming.
        out.set(p.goalId, await resolveGoalPinWritability(row?.spec ?? null, p.goalId, p.workspaceId));
      }
    } catch {
      out.clear();
      for (const p of pairs) out.set(p.goalId, 'unknown');
    }
    return out;
  };
}

const REASON_PROSE: Record<GoalDrainReason, string> = {
  'no-drain-fleet-declared': 'has NO standing drain fleet declared (goals metadata.drainFleet is unset)',
  'drain-fleet-not-found': 'declares a drain fleet that does not exist in agent_fleets',
  'drain-fleet-dead': 'declares a drain fleet with no live member',
  'drain-fleet-not-goal-scoped':
    'declares a LIVE drain fleet whose claim-spec lane is NOT scoped to this goal — no positive ' +
    "{field:'goal',op:'='|'in'} filter constrains what its members pull, so it drains the whole pot " +
    'and guarantees nothing about work filed under THIS goal (D-005)',
};

const SUMMARY_VERDICT: Record<Exclude<GoalDrainReason, 'no-drain-fleet-declared'>, string> = {
  'drain-fleet-not-found': 'missing',
  'drain-fleet-dead': 'dead',
  'drain-fleet-not-goal-scoped': 'not scoped to the goal (D-005)',
};

async function defaultEscalate(alert: GoalDrainAlert): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Goal '${alert.goalId}' is live-held but ${
      alert.reason === 'no-drain-fleet-declared'
        ? 'has no standing drain fleet'
        : `its drain fleet '${alert.drainFleet}' is ${SUMMARY_VERDICT[alert.reason]}`
    }`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) is ` +
      `actively held (live holder(s): ${alert.liveHolders.join(', ')}) but ` +
      `${REASON_PROSE[alert.reason]}.\n\n` +
      `The GOAL contract requires ONE STANDING DRAIN FLEET PER GOAL, always ` +
      `maintained — the drain fleet is what makes never-implement livable: the goal ` +
      `agent files work (work_items:create) and the fleet drains it, instead of the ` +
      `agent editing code itself. In the run that motivated this watchdog the drain ` +
      `fleet was never established, and the agent's only editing window was also its ` +
      `lowest-supervision window.\n\n` +
      `Remedy — the goal holder should pick ONE now:\n` +
      (alert.reason === 'drain-fleet-not-goal-scoped'
        ? `  • Scope the lane: scheduler:set_claim_spec { fleet: '${alert.drainFleet}', spec } with a ` +
          `POSITIVE { field:'goal', op:'=', value:'${alert.goalId}' } filter leaf. The positive form is ` +
          `load-bearing (WI-37711): the goal column is NULLABLE, so a not/!= leaf silently excludes ` +
          `every unstamped row — and a pot-wide lane drains everything, guaranteeing nothing about ` +
          `THIS goal's filed work.\n`
        : '') +
      `  • Stand the fleet up (fleet:create / fleet:launch-on-plan), then record it: ` +
      `goals:update { id: '${alert.goalId}', drainFleet: '<fleet-slug>' }.\n` +
      `  • Fleet exists under another slug? Fix the record: goals:update { id: '${alert.goalId}', drainFleet: '<actual-slug>' }.\n` +
      `  • Goal no longer worth a fleet? That is a kill-criterion conversation, not a ` +
      `reason to run drainless.\n\n` +
      (alert.standing && (alert.reason === 'drain-fleet-dead' || alert.reason === 'drain-fleet-not-found')
        ? `This is a STANDING goal, so the watchdog RE-ESTABLISHES the fleet itself (WI-2140699): after ` +
          `${GOAL_DRAIN_FLEET_DEAD_GRACE_MS / 60_000} min dead it re-mints the goal-scoped lane and launches one ` +
          `headless member, at most ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT} times per ` +
          `${GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS / 60_000} min (ledger: goals.metadata.drainRespawn). ` +
          `You are told when it does; a spent budget escalates to the owner instead.`
        : `Reported + event-emitted (goal:drain-dead), never auto-launched for an outcome goal: standing a ` +
          `fleet up is the goal holder's authority, noticing its absence is this watchdog's.`),
    meta: {
      dedupKind: 'goal-drain-fleet',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}:${alert.reason}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      reason: alert.reason,
      drainFleet: alert.drainFleet,
      liveHolders: alert.liveHolders,
      standing: alert.standing,
    },
  });
}

// ── WI-2140699: relaunch-leg defaults ────────────────────────────────────────

async function defaultRelaunchFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return await getFlag(FLAGS.GOAL_DRAIN_FLEET_RELAUNCH, 'system');
  } catch {
    // Unattended spend path: flag uncertainty is a hard no-op (same posture as
    // the holder respawner's flag read).
    return false;
  }
}

/**
 * Re-establish a standing goal's drain fleet: (1) the ROWS, idempotently —
 * `mintDrainFleetForGoal` covers 'not-found' (fleet row gone) and, on an
 * existing dead fleet, re-asserts the D-005 goal-scoped lane + the
 * `metadata.drainFleet` stamp; (2) the goal's own launch policy for the
 * `drain-fleet-member` slot — budget + headcount ceilings are enforced here
 * and a formed refusal is hard; (3) ONE headless member joining the lane
 * through `launchAgent` (the launch-su door), exactly the door
 * `launchGoalHolderSession` uses from this same bg-host process. `--fleet`
 * is what makes bootstrap-su stamp membership and auto-kick the member so it
 * pulls instead of parking (see goals:start §3.5).
 */
export async function defaultRelaunchDrainFleet(
  sql: Sql,
  alert: GoalDrainAlert,
  goal: GoalDrainRowLike,
): Promise<GoalDrainRelaunchResult> {
  const installSlug = goal.installSlug?.trim();
  if (!installSlug) {
    throw new Error(`goal ${goal.goalId} carries no install_slug to launch a drain member under`);
  }
  const holderOwnerId = alert.liveHolders[0];
  if (!holderOwnerId) throw new Error(`goal ${goal.goalId} has no live holder to own the fleet`);

  const [
    { mintDrainFleetForGoal, registerGoalDrainFleetLeader, ensureGoalDrainLeaderCoupling },
    { resolveGoalLaunchForGoal }, { launchAgent }, { composeLaunchModelSpec },
    { getFleet }, { fleetSpecBeeKey, getClaimSpec },
  ] =
    await Promise.all([
      import('../goals/drain-fleet-mint'),
      import('../goal-launch-settings'),
      import('../launch-agent'),
      import('../agent-config-constants'),
      import('../agent-fleets-store'),
      import('../scheduler/claim-spec-store'),
    ]);

  // ROWS: only a MISSING fleet is re-minted. An existing-but-dead fleet keeps
  // its registry row AND its claim spec untouched — the holder may have tuned
  // that lane by hand (measured 2026-09-01: the everything-goal's drain lane
  // was at spec revision 13, a multi-plan carve-out; re-minting would have
  // silently reset it to the bare goal leaf). Scope drift on an alive fleet is
  // the D-005 leg's report, not this leg's repair.
  const reminted = alert.reason === 'drain-fleet-not-found' || !goal.drainFleet;
  const fleetSlug =
    reminted
      ? (
          await mintDrainFleetForGoal({
            workspaceId: goal.workspaceId,
            goalId: goal.goalId,
            goalTitle: goal.title,
            agentOwnerId: holderOwnerId,
            goalTx: sql as unknown as GoalSqlTag,
          })
        ).fleetSlug
      : goal.drainFleet;
  if (!fleetSlug) throw new Error(`goal ${goal.goalId} has no drain fleet after mint`);

  const claimSpec = await getClaimSpec({ cupId: fleetSpecBeeKey(fleetSlug), workspaceId: goal.workspaceId });
  if (!claimSpecIsGoalScoped(claimSpec, goal.goalId)) {
    throw new Error(`drain fleet ${fleetSlug} has no positive goal claim-spec leaf for ${goal.goalId}`);
  }

  const warnings: string[] = [];
  const fleet = await getFleet(goal.workspaceId, fleetSlug);
  if (!fleet) throw new Error(`drain fleet ${fleetSlug} disappeared after mint`);
  let leaderOwnerId = fleet.leaderOwnerId;
  let leaderLive = false;
  let leaderLaunched = false;
  let couplingRepaired = false;
  if (leaderOwnerId && leaderOwnerId !== holderOwnerId) {
    const leaderVerdict = (await resolveHolderLiveness([leaderOwnerId])).get(leaderOwnerId);
    if (!leaderVerdict) throw new Error(`leader ${leaderOwnerId} liveness is unresolved; suppressing replacement`);
    leaderLive = holderCountsAsAlive(leaderVerdict);
  }
  if (!leaderLive) {
    const leaderPolicy = await resolveGoalLaunchForGoal({
      workspaceId: goal.workspaceId,
      goalId: goal.goalId,
      goalRole: 'drain-fleet-leader',
      fleetSlug,
      requested: {},
      launcherOwnerId: WATCHDOG_IDENTITY.ownerId,
      sql,
    });
    if (leaderPolicy.refusal) throw new Error(`launch policy refused a drain leader: ${leaderPolicy.refusal.message}`);
    const opened = await launchAgent({
      slug: installSlug,
      agent: leaderPolicy.effective.agent,
      model: composeLaunchModelSpec(leaderPolicy.effective.model, leaderPolicy.effective.effort),
      account: leaderPolicy.effective.account,
      contextSize: leaderPolicy.effective.contextSize,
      carry: leaderPolicy.effective.carry,
      compactionLimit: leaderPolicy.effective.compactionLimit,
      headless: true,
      fleet: fleetSlug,
      mode: 'auto',
      label: `goal-drain leader · ${goal.title.slice(0, 34)}`,
      kickoffPrompt:
        `You are the delegated leader of drain fleet ${fleetSlug} for goal ${goal.goalId}. ` +
        `The recorded GOAL holder is ${holderOwnerId}. Verify fleet:status names you as ` +
        `leader before steering the fleet; if a concurrent leader won, stand down. ` +
        `Preserve verified workers and supervise the goal-scoped work lane.`,
    });
    if (!opened.ok || !opened.ownerId || opened.warning) {
      throw new Error(`drain leader did not open cleanly: ${opened.error ?? opened.warning ?? 'owner id missing'}`);
    }
    const installed = await registerGoalDrainFleetLeader({
      workspaceId: goal.workspaceId, goalId: goal.goalId, fleetSlug,
      holderOwnerId, leaderOwnerId: opened.ownerId,
      declaredBy: WATCHDOG_IDENTITY.ownerId,
      expectedLeaderOwnerId: leaderOwnerId,
    });
    if (!installed.registered) throw new Error(`leader opened but registry CAS lost: ${installed.warning}`);
    leaderOwnerId = opened.ownerId;
    leaderLaunched = true;
    couplingRepaired = installed.coupled;
    if (!installed.coupled) {
      couplingRepaired = await ensureGoalDrainLeaderCoupling({
        workspaceId: goal.workspaceId, goalId: goal.goalId, fleetSlug,
        holderOwnerId, leaderOwnerId, declaredBy: WATCHDOG_IDENTITY.ownerId,
      });
      if (!couplingRepaired) throw new Error(`replacement leader ${leaderOwnerId} opened without holder coupling`);
    }
    warnings.push(...leaderPolicy.degradedReasons.map((reason) => `leader policy degraded: ${reason}`));
    if (installed.warning) warnings.push(`leader registration partial: ${installed.warning}`);
  } else if (leaderOwnerId) {
    const existingEdges = await listCouplingsFor(holderOwnerId, goal.workspaceId);
    const alreadyCoupled = existingEdges.some((edge) =>
      edge.state === 'coupled' && peerOf(edge, holderOwnerId) === leaderOwnerId);
    if (!alreadyCoupled) {
      couplingRepaired = await ensureGoalDrainLeaderCoupling({
        workspaceId: goal.workspaceId, goalId: goal.goalId, fleetSlug,
        holderOwnerId, leaderOwnerId, declaredBy: WATCHDOG_IDENTITY.ownerId,
      });
      if (!couplingRepaired) throw new Error(`coupling repair returned no edge for ${holderOwnerId} and ${leaderOwnerId}`);
    }
  }

  // A healthy worker survives a leader or coupling repair. An unresolved
  // worker suppresses duplication until the liveness oracle can decide.
  const workerRows = await sql<{ owner_id: string }[]>`
    SELECT owner_id FROM harness_shared.coord_presence
     WHERE workspace_id = ${goal.workspaceId} AND fleet_slug = ${fleetSlug}
       AND owner_id <> ${holderOwnerId} AND owner_id <> ${leaderOwnerId}`;
  const workerIds = [...new Set(workerRows.map((r) => r.owner_id))];
  if (workerIds.length > 0) {
    const workerVerdicts = await resolveHolderLiveness(workerIds);
    if (workerIds.some((id) => {
      const verdict = workerVerdicts.get(id);
      return verdict && holderCountsAsAlive(verdict);
    })) return { fleetSlug, ownerId: null, warnings,
      actions: { reminted, leaderLaunched, couplingRepaired, memberLaunched: false } };
    if (workerIds.some((id) => !workerVerdicts.has(id))) {
      throw new Error(`worker liveness unresolved for ${fleetSlug}; suppressing duplicate launch`);
    }
  }

  const resolved = await resolveGoalLaunchForGoal({
    workspaceId: goal.workspaceId,
    goalId: goal.goalId,
    goalRole: 'drain-fleet-member',
    fleetSlug,
    requested: {},
    launcherOwnerId: WATCHDOG_IDENTITY.ownerId,
    sql,
  });
  if (resolved.refusal) {
    throw new Error(`launch policy refused a drain member for ${goal.goalId}: ${resolved.refusal.message}`);
  }

  const launched = await launchAgent({
    slug: installSlug,
    agent: resolved.effective.agent,
    model: composeLaunchModelSpec(resolved.effective.model, resolved.effective.effort),
    account: resolved.effective.account,
    contextSize: resolved.effective.contextSize,
    carry: resolved.effective.carry,
    compactionLimit: resolved.effective.compactionLimit,
    headless: true,
    fleet: fleetSlug,
    label: `goal-drain · ${goal.title.slice(0, 40)}`,
  });
  if (!launched.ok || !launched.ownerId || launched.warning) {
    throw new Error(
      `launch-su did not confirm the drain worker for ${goal.goalId}: ` +
      `${launched.error ?? launched.warning ?? 'owner id missing'}`,
    );
  }
  return {
    fleetSlug,
    ownerId: launched.ownerId,
    actions: { reminted, leaderLaunched, couplingRepaired, memberLaunched: true },
    warnings: [
      ...warnings,
      ...resolved.degradedReasons.map((reason) => `launch policy degraded: ${reason}`),
    ],
  };
}

async function defaultNotifyRelaunch(
  alert: GoalDrainAlert,
  goal: GoalDrainRowLike,
  result: GoalDrainRelaunchResult,
): Promise<void> {
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  const summary =
    `Drain fleet '${result.fleetSlug}' for goal '${goal.goalId}' was RE-ESTABLISHED by the watchdog` +
    (result.ownerId ? ` (new worker ${result.ownerId})` : ' (existing workers preserved)');
  const body =
    `Your standing goal "${goal.title}" (${goal.goalId}) declared drain fleet '${result.fleetSlug}', which ` +
    `read '${alert.reason}' for longer than ${GOAL_DRAIN_FLEET_DEAD_GRACE_MS / 60_000} min. Per the GOAL ` +
    `contract (one standing drain fleet per goal, always maintained) the goal-drain-fleet watchdog ` +
    `repaired the delegated drain lane: ` +
    (result.actions
      ? [
          result.actions.reminted ? 're-minted the goal-scoped fleet' : 'preserved the fleet row and goal-scoped claim spec',
          result.actions.leaderLaunched ? 'opened a replacement leader' : 'preserved the live leader',
          result.actions.couplingRepaired ? 'repaired holder/leader coupling' : 'preserved holder/leader coupling',
          result.actions.memberLaunched ? `opened worker ${result.ownerId ?? 'unknown'}` : 'preserved live workers',
        ].join('; ')
      : result.ownerId ? `opened worker ${result.ownerId}` : 'preserved existing workers') +
    `. Nothing is expected of you beyond continuing to file work under the goal; check fleet:status ` +
    `{ fleet: '${result.fleetSlug}' } if you want to see it pull.\n\n` +
    `Posture note (WI-2140699): a refusal from ONE launch door (e.g. a cross-hive fleet:launch-on-plan ` +
    `refusal) is not a blanket no-launch verdict — this relaunch went through the ordinary ` +
    `launch-su door with the goal's own launch policy. Budget: ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT} ` +
    `relaunches per ${GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS / 60_000} min; ledger goals.metadata.drainRespawn.` +
    (result.warnings.length ? `\n\nWarnings: ${result.warnings.join('; ')}` : '');
  await sendMessage(WATCHDOG_IDENTITY, { to: alert.liveHolders, summary, body });
}

async function defaultEscalateRelaunchExhausted(alert: GoalDrainAlert, attemptsInWindow: number): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Goal '${alert.goalId}' drain-fleet relaunch reached its hourly safety cap after ` +
      `${attemptsInWindow} attempts — the lane needs a human`,
    body:
      `The standing goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) declares drain ` +
      `fleet '${alert.drainFleet}', which is ${SUMMARY_VERDICT[alert.reason as Exclude<GoalDrainReason, 'no-drain-fleet-declared'>] ?? alert.reason}. ` +
      `The watchdog relaunched a member ${attemptsInWindow} times inside the ` +
      `${GOAL_DRAIN_FLEET_RELAUNCH_RATE_WINDOW_MS / 60_000}-minute window and none stayed alive, so ` +
      `automatic relaunch is OFF for this goal (goals.metadata.drainRespawn.needsHuman = true).\n\n` +
      `Every launch dying on arrival is an upstream problem, not a retry problem — inspect the fleet's ` +
      `launch logs (fleet-logs/ under the workspace .papercusp dir), the launch-su warnings, and model/gateway ` +
      `availability. Then either stand a member up by hand (capability:terminal with --fleet ` +
      `'${alert.drainFleet}', or fleet:join) — the ledger self-clears the moment the fleet reads alive — or ` +
      `clear needsHuman on the goal's metadata.drainRespawn to re-arm automatic relaunch.`,
    meta: {
      dedupKind: 'goal-drain-fleet-relaunch-give-up',
      subjectSignature: `${alert.workspaceId}:${alert.goalId}`,
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      drainFleet: alert.drainFleet,
      attemptsInWindow,
      liveHolders: alert.liveHolders,
    },
  });
}

async function defaultEmitDrainDead(alert: GoalDrainAlert): Promise<void> {
  const { emitAwaitedEvent } = await import('../events/await/engine');
  const payload = { goalId: alert.goalId, drainFleet: alert.drainFleet, reason: alert.reason };
  const emits = [
    emitAwaitedEvent({
      key: goalPlanPlacementChangedKey(alert.goalId),
      workspaceId: alert.workspaceId,
      source: 'goal-drain-fleet-watchdog',
      payload,
      summary: `goal plan-placement classifier requires re-evaluation (${alert.reason})`,
    }),
  ];
  // Preserve the narrower public key for callers explicitly waiting on a
  // declared fleet's death. A mis-scoped/alive fleet still emits only the
  // broader placement-change signal.
  if (alert.reason === 'drain-fleet-not-found' || alert.reason === 'drain-fleet-dead') {
    emits.push(
      emitAwaitedEvent({
        key: `goal:drain-dead:${alert.goalId}`,
        workspaceId: alert.workspaceId,
        source: 'goal-drain-fleet-watchdog',
        payload,
      }),
    );
  }
  await Promise.all(emits);
}

// ── goal-plan-fleet-obligation-detector P-002: plan-fleet leg defaults ──────

const PLAN_FLEET_SUMMARY: Record<GoalPlanFleetReason, string> = {
  'started-plan-no-live-targeting-fleet': 'has no live fleet targeting it',
  'started-plan-targeting-fleet-zero-live-claims': 'has a live targeting fleet holding zero claims on it',
};

async function defaultEscalatePlanFleet(alert: GoalPlanFleetAlert): Promise<{ opened: boolean }> {
  const opened = await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Goal '${alert.goalId}' is live-held but started plan '${alert.planSlug}' ${PLAN_FLEET_SUMMARY[alert.reason]}`,
    body:
      `The goal "${alert.title}" (${alert.goalId}, workspace ${alert.workspaceId}) is actively held ` +
      `(live holder(s): ${alert.liveHolders.join(', ')}).\n\n` +
      `${goalPlanFleetRemedy(alert)}\n\n` +
      `Why this alarms: a goal that STARTS a plan and never gets it claimed looks healthy on every ` +
      `count-based surface — the plan reads 'started', the holder reads live — while no work moves. ` +
      `Parkable events: ${goalPlanFleetLegEventKey(alert)} (this leg) and goal:plan-placement:${alert.goalId} ` +
      `(any placement change).`,
    meta: {
      dedupKind: 'goal-plan-fleet-obligation',
      subjectSignature: goalPlanFleetSubjectSignature(alert),
      goalWorkspaceId: alert.workspaceId,
      // carries goalId, reason, plan, fleets, claims and holders
      ...goalPlanFleetEventPayload(alert),
    },
  });
  return { opened: opened.coalesced !== true };
}

async function defaultEmitPlanFleet(alert: GoalPlanFleetAlert): Promise<void> {
  const { emitAwaitedEvent } = await import('../events/await/engine');
  const payload = goalPlanFleetEventPayload(alert);
  await Promise.all([
    emitAwaitedEvent({
      key: goalPlanPlacementChangedKey(alert.goalId),
      workspaceId: alert.workspaceId,
      source: 'goal-drain-fleet-watchdog',
      payload,
      summary: `goal plan-placement classifier requires re-evaluation (${alert.reason}: ${alert.planSlug})`,
    }),
    emitAwaitedEvent({
      key: goalPlanFleetLegEventKey(alert),
      workspaceId: alert.workspaceId,
      source: 'goal-drain-fleet-watchdog',
      payload,
      summary: `started plan '${alert.planSlug}' ${PLAN_FLEET_SUMMARY[alert.reason]}`,
    }),
  ]);
}

/**
 * The 2026-09-01 lesson (EI-22089613547454936): an event alone wakes only a
 * holder that remembered to park on it, and the cold-carry holder did not. So a
 * NEW episode also reaches the holder directly — a durable inbox message with
 * the remedy plus a directed wake. Only on a newly opened escalation: the sweep
 * runs every 10 minutes, and re-waking the holder on every tick of a condition
 * it already knows about would be noise.
 */
async function defaultNotifyPlanFleetHolders(alert: GoalPlanFleetAlert): Promise<void> {
  const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
    import('../agent-tools/coordination/messages'),
    import('../agent-tools/coordination/inbox-wake'),
  ]);
  const summary = `Goal '${alert.goalId}': started plan '${alert.planSlug}' ${PLAN_FLEET_SUMMARY[alert.reason]}`;
  await sendMessage(WATCHDOG_IDENTITY, {
    to: alert.liveHolders,
    summary,
    body: `${goalPlanFleetRemedy(alert)}\n\nEvidence: ${JSON.stringify(goalPlanFleetEventPayload(alert))}`,
  });
  await wakeRecipients(alert.liveHolders, {
    summary,
    payload: goalPlanFleetEventPayload(alert),
    source: 'goal-drain-fleet-watchdog',
    workspaceId: alert.workspaceId,
  });
}

function sweepDeps(sql: Sql, overrides: Partial<GoalDrainFleetSweepDeps>): GoalDrainFleetSweepDeps {
  const resolveLiveness = overrides.resolveLiveness ?? resolveHolderLiveness;
  return {
    readGoals: makeReadGoals(sql),
    resolveLiveness,
    resolveFleetLiveness: makeResolveFleetLiveness(sql, resolveLiveness),
    resolveFleetSpecScopes: makeResolveFleetSpecScopes(sql),
    escalate: defaultEscalate,
    emitDrainDead: defaultEmitDrainDead,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    relaunchFlagEnabled: defaultRelaunchFlagEnabled,
    markDrainDead: (goal, nowMs) => markGoalDrainFleetDead(sql, goal, nowMs),
    reserveRelaunchSlot: (goal, nowMs) => reserveGoalDrainFleetRelaunchSlot(sql, goal, nowMs),
    clearDrainLedger: (goal) => clearGoalDrainFleetLedger(sql, goal),
    relaunchDrainFleet: (alert, goal) => defaultRelaunchDrainFleet(sql, alert, goal),
    notifyRelaunch: defaultNotifyRelaunch,
    escalateRelaunchExhausted: defaultEscalateRelaunchExhausted,
    deadGraceMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
    readPlanFleetCohort: (goals, resolveFleetLiveness) => readGoalPlanFleetCohort(sql, goals, resolveFleetLiveness),
    escalatePlanFleet: defaultEscalatePlanFleet,
    emitPlanFleet: defaultEmitPlanFleet,
    notifyPlanFleetHolders: defaultNotifyPlanFleetHolders,
    ...overrides,
  };
}

export interface GoalDrainFleetSweepResult {
  scanned: number;
  escalated: number;
  skipped: boolean;
  /** WI-2140699: members launched this sweep (standing goals whose fleet stayed dead past the grace). */
  relaunched: number;
  /** WI-2140699: standing goals whose relaunch budget is spent (escalated, deduped). */
  relaunchCapped: number;
  /** P-002: goals whose plan-fleet verdict was escalated this sweep (0 when the cohort read is unknown). */
  planFleetEscalated: number;
}

/**
 * goal-plan-fleet-obligation-detector P-002: deliver the plan-fleet verdict.
 *
 * Same population and suppression as the drain leg: only goals with a
 * POSITIVELY-live holder are judged (the liveness sibling owns unheld goals), and
 * an unknown cohort suppresses the whole leg — never "no fleet"/"zero claims".
 * {@link classifyGoalPlanFleetCoverage} already guarantees ONE verdict per goal
 * (leg A beats leg B). The drain leg and this leg are different obligations with
 * different remedies (a goal-scoped standing lane vs. a fleet on a started plan),
 * so a goal can carry one of each; neither ever speaks twice for itself.
 *
 * Every failure is contained per alert, and the whole leg is fail-soft: it can
 * never cost the drain leg or the ledger-clear loop that follows it.
 */
async function runPlanFleetLeg(
  deps: GoalDrainFleetSweepDeps,
  goals: readonly GoalDrainRowLike[],
  holders: readonly GoalHolderLike[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
): Promise<number> {
  const liveHeld = goals.filter((g) =>
    holders.some((h) => {
      if (h.goalId !== g.goalId || h.workspaceId !== g.workspaceId) return false;
      const v = verdicts.get(h.ownerId);
      return v ? holderCountsAsAlive(v) : false;
    }),
  );
  if (liveHeld.length === 0) return 0;
  let cohort: GoalPlanFleetCohort;
  try {
    cohort = await deps.readPlanFleetCohort(liveHeld, deps.resolveFleetLiveness);
  } catch {
    return 0; // an injected reader that throws is the same UNKNOWN as a failed read
  }
  if (cohort.status === 'unknown') return 0;

  let escalated = 0;
  for (const goal of liveHeld) {
    const alert = classifyGoalPlanFleetCoverage(goal, holders, verdicts, cohort);
    if (!alert) continue;
    let opened = false;
    try {
      opened = (await deps.escalatePlanFleet(alert)).opened;
      escalated += 1;
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] plan-fleet escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.emitPlanFleet(alert);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] plan-fleet event emit failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!opened) continue;
    try {
      await deps.notifyPlanFleetHolders(alert);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] plan-fleet holder notify failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return escalated;
}

/**
 * WI-2140699: the relaunch leg for ONE alert. Returns what it did so the sweep
 * can count it; every failure is contained here — a bad launch never costs the
 * batch its other alerts, and the ledger reservation already charged the budget.
 */
async function runRelaunchLeg(
  deps: GoalDrainFleetSweepDeps,
  alert: GoalDrainAlert,
  goal: GoalDrainRowLike,
  relaunchFlag: () => Promise<boolean>,
): Promise<'ineligible' | 'flag-off' | 'wait' | 'relaunched' | 'capped' | 'failed'> {
  const gate = goalDrainRelaunchEligibility(alert, goal);
  if (!gate.eligible) return 'ineligible';
  if (!(await relaunchFlag())) return 'flag-off';
  const nowMs = deps.now();
  const deadSinceMs = await deps.markDrainDead(goal, nowMs);
  if (deadSinceMs === null) return 'ineligible';
  const decision = decideGoalDrainFleetRelaunch(deadSinceMs, nowMs, deps.deadGraceMs);
  if (decision.kind === 'wait') return 'wait';
  const slot = await deps.reserveRelaunchSlot(goal, nowMs);
  if (slot.kind === 'ineligible') return 'ineligible';
  if (slot.kind === 'capped') {
    try {
      await deps.escalateRelaunchExhausted(alert, slot.attemptsInWindow);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] give-up escalation failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return 'capped';
  }
  let result: GoalDrainRelaunchResult;
  try {
    result = await deps.relaunchDrainFleet(alert, goal);
  } catch (e) {
    console.warn(
      `[goal-drain-fleet-watchdog] relaunch failed for ${alert.goalId} (attempt ${slot.attemptsInWindow}/${GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT}, budget charged): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 'failed';
  }
  for (const warning of result.warnings) {
    console.warn(`[goal-drain-fleet-watchdog] relaunch ${alert.goalId}: ${warning}`);
  }
  try {
    await deps.notifyRelaunch(alert, goal, result);
  } catch (e) {
    console.warn(
      `[goal-drain-fleet-watchdog] holder notify failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return 'relaunched';
}

/**
 * One sweep. Failures are contained per-alert (a bad row cannot cost the batch);
 * escalation-side dedup makes the next tick's retry idempotent. Exported for tests.
 */
export async function runGoalDrainFleetSweepOnce(
  sql: Sql,
  overrides: Partial<GoalDrainFleetSweepDeps> = {},
): Promise<GoalDrainFleetSweepResult> {
  const deps = sweepDeps(sql, overrides);
  const none = { relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 };
  if (!(await deps.flagEnabled())) return { scanned: 0, escalated: 0, skipped: true, ...none };

  const { goals, holders } = await deps.readGoals();
  if (goals.length === 0) return { scanned: 0, escalated: 0, skipped: false, ...none };

  const activeKeys = new Set(goals.map((g) => fleetKey(g.workspaceId, g.goalId)));
  const relevant = holders.filter((h) => activeKeys.has(fleetKey(h.workspaceId, h.goalId)));
  const verdicts = await deps.resolveLiveness([...new Set(relevant.map((h) => h.ownerId))]);

  const declaredGoals = goals.filter((g): g is GoalDrainRowLike & { drainFleet: string } => g.drainFleet !== null);
  const declared = declaredGoals.map((g) => ({
    workspaceId: g.workspaceId, fleetSlug: g.drainFleet,
    holderOwnerId: relevant.find((h) => h.goalId === g.goalId && h.workspaceId === g.workspaceId &&
      !!verdicts.get(h.ownerId) && holderCountsAsAlive(verdicts.get(h.ownerId)!))?.ownerId,
  }));
  const fleetLiveness = await deps.resolveFleetLiveness(declared);

  // D-005: scope is judged only where it can change the verdict — a fleet that
  // is dead/missing/unknown already has its (more urgent, or suppressed) answer.
  const alivePairs = declaredGoals
    .filter((g) => fleetLiveness.get(fleetKey(g.workspaceId, g.drainFleet)) === 'alive')
    .map((g) => ({ workspaceId: g.workspaceId, fleetSlug: g.drainFleet, goalId: g.goalId }));
  const specScopes = await deps.resolveFleetSpecScopes(alivePairs);

  const alerts = scanGoalDrainFleets(goals, relevant, verdicts, fleetLiveness, specScopes, deps.now(), deps.graceMs);
  let escalated = 0;
  let relaunched = 0;
  let relaunchCapped = 0;
  // WI-2140699: one flag read per sweep, and only when an eligible alert exists.
  let relaunchFlagValue: Promise<boolean> | null = null;
  const relaunchFlag = () => (relaunchFlagValue ??= deps.relaunchFlagEnabled());
  const goalByKey = new Map(goals.map((g) => [fleetKey(g.workspaceId, g.goalId), g]));

  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] escalate failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.emitDrainDead(alert);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] event emit failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const goal = goalByKey.get(fleetKey(alert.workspaceId, alert.goalId));
    if (!goal) continue;
    try {
      const outcome = await runRelaunchLeg(deps, alert, goal, relaunchFlag);
      if (outcome === 'relaunched') relaunched += 1;
      else if (outcome === 'capped') relaunchCapped += 1;
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] relaunch leg failed for ${alert.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // goal-plan-fleet-obligation-detector P-002: the plan-fleet leg, on the same
  // live-held population, flag, interval and escalation dedup as the drain leg.
  let planFleetEscalated = 0;
  try {
    planFleetEscalated = await runPlanFleetLeg(deps, goals, relevant, verdicts);
  } catch (e) {
    console.warn(
      `[goal-drain-fleet-watchdog] plan-fleet leg failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // WI-2140699: a declared fleet that reads ALIVE ends any open dead episode —
  // including a needs-human hold, which a hand-restored fleet has satisfied.
  // Only a POSITIVE alive verdict clears; unknown/dead leave the ledger alone.
  for (const goal of declaredGoals) {
    const ledger = goal.drainRespawn;
    if (!ledger || (ledger.deadSinceMs === null && !ledger.needsHuman)) continue;
    if (fleetLiveness.get(fleetKey(goal.workspaceId, goal.drainFleet)) !== 'alive') continue;
    try {
      await deps.clearDrainLedger(goal);
    } catch (e) {
      console.warn(
        `[goal-drain-fleet-watchdog] ledger clear failed for ${goal.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { scanned: goals.length, escalated, skipped: false, relaunched, relaunchCapped, planFleetEscalated };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the goal-drain-fleet watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.GOAL_DRAIN_FLEET_WATCHDOG (checked per tick).
 */
export function startGoalDrainFleetWatchdog(sql: Sql, opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? GOAL_DRAIN_FLEET_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'goal-drain-fleet-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runGoalDrainFleetSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[goal-drain-fleet-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'timeout-reaper'. The alarm condition is a goal held for a WINDOW without
    // the fleet its contract requires — the absence of a fleet emits no event, so the
    // passage of time in that state is the only trigger available.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
