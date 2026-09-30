/**
 * Canonical adapters from existing policy writers into agent-obligations-v1.
 * No SQL, liveness derivation, scorecard interpretation, or new persistence
 * belongs here: callers pass the authoritative writer outputs unchanged.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 (P-003, D-010/D-011).
 */
import {
  defineAgentObligation,
  evaluateAgentObligations,
  goalPlanPlacementChangedKey,
  planAcceptanceChangedKey,
  type AgentObligation,
  type AgentObligationAgenda,
  type AgentObligationEvidence,
  type AgentObligationMeasurementFailure,
} from './agent-obligations';
import type { GoalLaunchRefusal, GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief, GoalPotPlacementAuthority } from './goal-launch-settings';
import { goalPlanningPortfolioFingerprint, type GoalPlanningReview } from './goal-planning-review';
import type { GoalPlanFleetAlert } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import type { PlanAcceptanceGateCode, PlanAcceptanceGateVerdict } from './plan-acceptance-gate';
import { advanceGoalPlacementProgress, goalPlacementProgressScopeKey } from './goal-placement-progress';
import type { ExactPlanAdmission, ExactPlanAdmissionReason } from './agent-tools/plans/plan-admission-preflight';

export const PLAN_PLACEMENT_OBLIGATION_REVISION = 'goal-plan-placement-v5';
export const OWNER_REPORT_OBLIGATION_REVISION = 'goal-owner-report-v1';
export const INDEPENDENT_VERIFICATION_OBLIGATION_REVISION = 'plan-independent-verification-v1';
export const OWNER_DIRECTIVE_OBLIGATION_REVISION = 'owner-directive-disposition-v1';
export const WAITING_ON_OBLIGATION_REVISION = 'waiting-on-progress-v1';

interface ProviderBase {
  workspaceId: string;
  ownerId: string;
  observedAt: string;
  sourceGeneration: string;
}

interface ProviderUnknown {
  status: 'unknown';
  failure: AgentObligationMeasurementFailure;
}

interface ProviderKnown<T> {
  status: 'known';
  value: T;
}

export type ProviderRead<T> = ProviderKnown<T> | ProviderUnknown;

export interface GoalPlanningProviderInput extends ProviderBase {
  goalId: string;
  read: ProviderRead<{
    portfolio: GoalPortfolioBrief | null;
    review: GoalPlanningReview | null;
    reviewIntervalMs: number;
    /** Canonical sovereignty reads for candidate harnesses, never inferred from a plan link. */
    authorities: Record<string, GoalPotPlacementAuthority>;
  }>;
}

/** A review selects the next planning action; it never grants launch or ownership authority. */
export function goalPlanningObligation(input: GoalPlanningProviderInput): AgentObligation {
  const common = {
    ruleId: 'goal-planning-needed', ruleRevision: 'goal-planning-needed-v2', family: 'planning-needed' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId },
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority('modes/registry:goal+scout_ticks.goalReview', 'goal-planning-needed-v2'),
    priority: 'normal' as const, causalRank: 2, sourceGeneration: input.sourceGeneration,
    episode: input.sourceGeneration, applicableDemand: 0, evidence: [] as AgentObligationEvidence[],
    clearsWhen: { id: 'current-evidenced-goal-review', summary: 'A current evidence-backed goal review addresses uncovered needs; actual plan execution remains a separate obligation.', evidenceKind: 'state' as const, sourceRef: 'scout_ticks.detail.goalReview+GoalPortfolioBrief' },
  };
  const unknown = (failure: AgentObligationMeasurementFailure) => defineAgentObligation({
    ...common, title: 'Goal planning evidence is unavailable', status: 'unknown', reason: failure.detail,
    action: { kind: 'inspect', summary: failure.retry }, measurementFailure: failure,
  });
  if (input.read.status === 'unknown') return unknown(input.read.failure);
  const { portfolio, review, reviewIntervalMs, authorities } = input.read.value;
  if (!portfolio || portfolio.goal.id !== input.goalId || portfolio.degradedReasons.some((r) => /portfolio read failed/i.test(r))) {
    return unknown({ code: 'goal-planning-portfolio-unavailable', detail: 'Canonical goal scope or portfolio is unavailable.', retry: 'Refresh the canonical goal portfolio; do not infer that there is no demand.' });
  }
  if (['paused', 'achieved', 'killed'].includes(portfolio.goal.status ?? '')) return defineAgentObligation({
    ...common, title: 'Goal planning is inactive', status: 'not-applicable', reason: `Goal is ${portfolio.goal.status}.`,
  });
  if (portfolio.goal.status !== 'active') return unknown({ code: 'goal-planning-lifecycle-unresolved', detail: 'The goal lifecycle is unresolved.', retry: 'Resolve the goal lifecycle before planning work.' });
  const fingerprint = goalPlanningPortfolioFingerprint(portfolio);
  const nowMs = Date.parse(input.observedAt);
  const reviewedMs = review ? Date.parse(review.reviewedAt) : NaN;
  if (!Number.isFinite(reviewIntervalMs) || reviewIntervalMs <= 0 || !Number.isFinite(nowMs)) {
    return unknown({ code: 'goal-review-cadence-unavailable', detail: 'The review cadence or observation time is unavailable.', retry: 'Refresh the canonical reporting cadence before assessing review age.' });
  }
  const current = review?.goalId === input.goalId && review.portfolioFingerprint === fingerprint &&
    Number.isFinite(reviewedMs) && reviewedMs <= nowMs && nowMs - reviewedMs < reviewIntervalMs;
  if (!current) {
    const frontier = portfolio.goal.standing && portfolio.worklist.every((p) => p.placement.state === 'terminal');
    return defineAgentObligation({ ...common, title: 'Review uncovered goal needs', status: 'due',
      episode: `review:${fingerprint}:${review?.reviewedAt ?? 'none'}`,
      reason: 'No current scoped review covers these planning inputs and this reporting interval. Adopt/revise/create-start/drain/route scoped work, or record an evidenced no-new-plan result with blender:ideate-pass-record.',
      action: { kind: 'inspect', targetRef: `goal:${input.goalId}`, recoveryRef: 'coord:orient',
        summary: `${frontier ? 'Review the standing goal frontier' : 'Review uncovered goal outcomes'}; staff executable plans first, then record a supported planning disposition.` },
    });
  }
  const measured = { ...common, evidence: [evidence(
    `goal-review:${input.goalId}:${input.ownerId}:${review.reviewedAt}`, review.reviewedAt, fingerprint,
    `Recorded assessment: ${review.rationale}; cited references: ${review.evidenceRefs.join(', ')}`,
    'current scoped review recorded; not proof of the cited facts, launched workers or achieved outcomes',
  )],
    episode: `review:${fingerprint}:${review.reviewedAt}`, lastSatisfiedAt: review.reviewedAt };
  if (review.disposition === 'existing-plans-sufficient' || review.disposition === 'no-eligible-work') {
    if (review.uncoveredOutcome) return unknown({ code: 'goal-review-conflicting-disposition', detail: 'The no-new-plan disposition also names an uncovered outcome.', retry: 'Resolve the contradictory review evidence before treating planning as satisfied.' });
    return defineAgentObligation({ ...measured, title: 'Current review requires no new plan', status: 'satisfied',
      reason: review.rationale, changeSignal: { nextDeadlineAt: new Date(reviewedMs + reviewIntervalMs).toISOString(), cancellationRef: `goal:${input.goalId}` },
    });
  }
  const guards = 'Preserve proposal lineage; recheck scope, budget, admission and ownership at mutation time, and use CAS for worklist changes. A review is not a worker claim.';
  if (review.disposition === 'adopt-plan' || review.disposition === 'revise-plan') {
    for (const ref of review.planRefs) {
      const match = /^plan:([^/]+)\/(.+)$/.exec(ref);
      const authority = match ? authorities[match[1]!] : undefined;
      if (!authority) return unknown({ code: 'goal-planning-authority-unavailable', detail: `Ownership is unmeasured for ${ref}.`, retry: 'Read canonical goal-pot placement authority; do not adopt based only on a link.' });
      if (!authority.allowed) return defineAgentObligation({ ...measured, title: 'Route work to its existing goal', status: 'due', applicableDemand: 1,
        reason: `Route ${ref} to ${authority.ownerGoalId}, the active goal owning its harness. ${guards}`,
        action: { kind: 'report', targetRef: ref, recoveryRef: 'coord:orient', summary: 'Route this work to its current goal owner; do not adopt or duplicate its execution.' },
      });
    }
    return defineAgentObligation({ ...measured, title: 'Reuse the existing plan', status: 'due', applicableDemand: 1,
      reason: `${review.rationale} Plans: ${review.planRefs.join(', ')}. ${guards}`,
      action: { kind: 'continue', targetRef: review.planRefs[0], recoveryRef: 'coord:orient', summary: `${review.disposition === 'adopt-plan' ? 'Adopt' : 'Revise'} the existing plan, not a clone; verify ownership, CAS, budget and admission, then staff executable work.` },
    });
  }
  return defineAgentObligation({ ...measured, title: 'Address the uncovered goal need', applicableDemand: 1,
    status: review.disposition === 'blocked' ? 'blocked' : 'due',
    reason: `${review.rationale}${review.uncoveredOutcome ? ` Uncovered outcome: ${review.uncoveredOutcome}` : ''} ${guards}`,
    action: { kind: review.disposition === 'blocked' ? 'repair' : review.disposition === 'route-work' ? 'report' : 'continue',
      targetRef: `goal:${input.goalId}`, recoveryRef: 'coord:orient', summary: review.disposition === 'plan-needed'
        ? 'Reuse or write/start a goal-local plan; delegate to an independent fleet and verify real claims.'
        : review.disposition === 'blocked'
          ? 'Advance or escalate the evidenced planning blocker; recheck launch and ownership gates before resuming.'
          : 'Route this need to its accountable goal or to Blender for cross-goal synthesis.' },
  });
}

function policyAuthority(sourceRef: string, revision: string) {
  return { kind: 'policy' as const, sourceRef, revision };
}

function evidence(
  ref: string,
  observedAt: string,
  sourceRevision: string,
  note: string,
  effect?: string,
): AgentObligationEvidence {
  return {
    ref,
    observedAt,
    freshness: 'current',
    sourceRevision,
    note,
    ...(effect ? { effect } : {}),
  };
}

export interface PlanPlacementProviderInput extends ProviderBase {
  goalId: string;
  read: ProviderRead<{
    /** The ordered, canonical goal/worklist/placement projection. */
    portfolio: GoalPortfolioBrief | null;
    /** The exact launch-boundary resolution for the intended launch count. */
    launch: GoalLaunchResolution | null;
    /** Caller-neutral exact-plan preflight by canonical plan ref; null means unreadable. */
    admissions?: Record<string, ExactPlanAdmission | null>;
    /** The live cohort classifier corroborates the richer placement receipt. */
    alert: GoalPlanFleetAlert | null;
    /** Evidence ref for the exact joined cohort/classifier observation. */
    evidenceRef: string;
    /** Time since the last verified placement effect, when the caller can measure it. */
    ageMs?: number;
    /** Durable first-verification clocks, keyed by exact canonical plan ref. */
    progress?: Record<string, import('./goal-placement-progress').GoalPlacementProgressState | null>;
  }>;
}

type GoalPortfolioPlan = GoalPortfolioBrief['worklist'][number];

/** Use the same plan ordering for the reader's launch check and the provider's action. */
export function selectGoalPlacementPlan(
  portfolio: GoalPortfolioBrief,
  admissions?: Readonly<Record<string, ExactPlanAdmission | null>>,
): GoalPortfolioPlan | undefined {
  const actionable = portfolio.worklist.filter(
    (plan) => plan.placement.state !== 'terminal' && !plan.placement.reconciliation.consistent,
  );
  const candidates = actionable.filter((plan) =>
    plan.placement.state === 'unplaced' || plan.placement.state === 'admitting',
  );
  // An already-admitting transaction stays actionable. For a fresh launch,
  // prefer the first independently admissible plan over an earlier blocked one.
  return (admissions
    ? candidates.find((plan) => plan.placement.state === 'admitting' || admissions[plan.ref]?.ready)
    : candidates[0]) ?? candidates[0] ?? actionable[0];
}

const EXACT_PLAN_REFUSAL_GUIDANCE = {
  'plan-not-found': { status: 'unknown', summary: 'refresh the plan link and canonical worklist before deciding whether to create or adopt work' },
  'no-actionable-plan-items': { status: 'blocked', summary: 'repair the plan DAG or finish evidenced closure; do not open an idle fleet' },
  'promotion-lag': { status: 'blocked', summary: 'run the existing plans:start promotion path after its normal review and approval gates, then recheck admission' },
  'duplicate-coverage': { status: 'blocked', summary: 'reconcile duplicate promoted work-item coverage before launching' },
  'lane-unknown': { status: 'unknown', summary: 'refresh the exact-plan claim lane; unknown claimability is not an available seat' },
  'floor-diagnostics-unavailable': { status: 'unknown', summary: 'repair the claim-lane diagnostic read before naming a floor or launching' },
  'floor-gated': { status: 'blocked', summary: 'inspect the reported claim exclusions and repair the actual floor before retrying' },
  'family-disagreement': { status: 'blocked', summary: 'reconcile the promoted row family and exact-plan claim filter before retrying' },
  'insufficient-executable-width': { status: 'blocked', summary: 'reconcile occupied lanes and requested seats; launch only a separately verified executable width' },
} satisfies Record<Exclude<ExactPlanAdmissionReason, 'ready'>, { status: 'blocked' | 'unknown'; summary: string }>;

function placementNote(placement: GoalPlanPlacement): string {
  const fleet = placement.fleet
    ? `fleet=${placement.fleet.slug}; leader=${placement.fleet.leaderOwnerId ?? 'unknown'}; ` +
      `leaderLive=${placement.fleet.leaderLive}; liveMembers=${placement.fleet.liveMembers}; ` +
      `target=${placement.fleet.target ?? 'unknown'}`
    : 'fleet=none';
  const lane = placement.activeLane
    ? `lane=${placement.activeLane.itemId}; laneOwner=${placement.activeLane.ownerId}; ` +
      `laneOwnerFleet=${placement.activeLane.ownerFleet ?? 'none'}; laneHolderLive=${placement.activeLane.holderLive}`
    : 'lane=none';
  const transaction = placement.launchTransaction
    ? `launchTransaction=${placement.launchTransaction.transactionId ?? 'unknown'}:${placement.launchTransaction.state ?? 'unknown'}; ` +
      `retryOwners=${placement.launchTransaction.retryOwnerIds.join(',') || 'none'}; ` +
      `next=${placement.launchTransaction.nextAction ?? 'none'}`
    : 'launchTransaction=none';
  return (
    `placement=${placement.state}; reconciliation=${placement.reconciliation.action}; ` +
    `${fleet}; ${lane}; ${transaction}`
  );
}

function launchNote(launch: GoalLaunchResolution): string {
  const budget = launch.budget
    ? `budget=${launch.budget.spentCents ?? 'unknown'}/${launch.budget.budgetCents ?? 'undeclared'}; ` +
      `budgetSource=${launch.budget.spentCentsSource ?? 'unmarked'}; ` +
      `budgetObservedAt=${launch.budget.spentCentsAt ?? 'unknown'}`
    : 'budget=not-applicable';
  return (
    `${budget}; headcount=${launch.headcount.total}; fleetHeadcount=${launch.headcount.fleet ?? 'not-scoped'}; ` +
    `ceilings=${launch.ceilings.maxAgents ?? 'unlimited'}/${launch.ceilings.maxPerFleet ?? 'unlimited'}; ` +
    `profileKeys=${Object.keys(launch.effective).sort().join(',') || 'none'}; ` +
    `refusal=${launch.refusal?.reason ?? 'none'}; degraded=${launch.degradedReasons.join(' | ') || 'none'}`
  );
}

function placementEvidence(input: PlanPlacementProviderInput, plan?: GoalPortfolioPlan): AgentObligationEvidence[] {
  if (input.read.status === 'unknown') return [];
  const { portfolio, launch, alert, evidenceRef } = input.read.value;
  return [
    evidence(
      evidenceRef,
      input.observedAt,
      input.sourceGeneration,
      alert ? `${alert.reason}:${alert.planSlug}` : 'canonical live plan/fleet cohort has no alert',
    ),
    ...(portfolio
      ? [
          evidence(
            `goal-portfolio:${input.goalId}:${portfolio.assembledAt}`,
            portfolio.assembledAt,
            input.sourceGeneration,
            plan ? `${plan.ref}; ${placementNote(plan.placement)}` : 'canonical portfolio contains no applicable plan',
          ),
        ]
      : []),
    ...(launch
      ? [
          evidence(
            `goal-launch-resolution:${input.goalId}:${input.sourceGeneration}`,
            input.observedAt,
            input.sourceGeneration,
            launchNote(launch),
          ),
        ]
      : []),
  ];
}

function unknownPlacement(
  input: PlanPlacementProviderInput,
  args: {
    title: string;
    code: string;
    detail: string;
    retry: string;
    applicableDemand: number;
    plan?: GoalPortfolioPlan;
  },
): AgentObligationInputShape {
  return {
    title: args.title,
    episode: `unknown:${args.code}:${input.sourceGeneration}`,
    status: 'unknown',
    reason: args.detail,
    causalRank: 0,
    applicableDemand: args.applicableDemand,
    evidence: placementEvidence(input, args.plan),
    action: { kind: 'inspect', summary: args.retry, targetRef: args.plan?.ref ?? `goal:${input.goalId}` },
    measurementFailure: { code: args.code, detail: args.detail, retry: args.retry },
  };
}

type AgentObligationInputShape = Pick<
  AgentObligation,
  | 'title'
  | 'episode'
  | 'status'
  | 'reason'
  | 'causalRank'
  | 'applicableDemand'
  | 'evidence'
  | 'action'
  | 'measurementFailure'
>;

/** Guidance never widens the authority of the launch resolver that refused. */
const LAUNCH_REFUSAL_GUIDANCE = {
  goal_budget_unmeasurable: {
    title: 'Goal budget measurement blocks placement',
    summary: 'repair the authoritative goal spend measurement and its provenance before launching; unknown spend is not available headroom; do not fabricate pot links or raise a ceiling to bypass this refusal',
  },
  goal_budget_exceeded: {
    title: 'Goal budget blocks placement',
    summary: 'report the verified budget refusal and seek owner budget direction or wind the goal down; do not increase the cap autonomously',
  },
  goal_max_agents: {
    title: 'Goal headcount ceiling blocks placement',
    summary: 'reconcile live claims and reallocate within the declared goal headcount ceiling; do not duplicate a launch or raise the ceiling to force admission',
  },
  fleet_max_agents: {
    title: 'Fleet headcount ceiling blocks placement',
    summary: 'reconcile this fleet and reallocate within the declared fleet headcount ceiling; do not duplicate a launch or raise the ceiling to force admission',
  },
} satisfies Record<GoalLaunchRefusal['reason'], { title: string; summary: string }>;

export function planPlacementObligation(input: PlanPlacementProviderInput): AgentObligation {
  const scope = { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId };
  const common = {
    ruleId: 'goal-plan-placement',
    ruleRevision: PLAN_PLACEMENT_OBLIGATION_REVISION,
    family: 'plan-placement' as const,
    scope,
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority(
      'goal-launch-settings+system-health/goal-drain-fleet-watchdog',
      PLAN_PLACEMENT_OBLIGATION_REVISION,
    ),
    priority: 'high' as const,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      // P-026 / D-012: placement consistency USED to be the whole clear condition,
      // which is what made a delegated plan count as progress the moment an agent
      // was put on it. Closure is now the clear condition; placement is a step
      // toward it, never a substitute for it.
      id: 'goal-plan-closure-evidenced-and-launch-admissible',
      summary:
        'every non-terminal goal worklist plan has a consistent independently led placement, an admissible launch boundary, ' +
        'and — once it claims to be finished — evidenced closure rather than merely completed items',
      evidenceKind: 'state' as const,
      sourceRef:
        'GoalPortfolioBrief.worklist[].placement+resolvePlanClosure+resolveGoalLaunch+classifyGoalPlanFleetCoverage',
    },
    changeSignal: {
      event: goalPlanPlacementChangedKey(input.goalId),
      cancellationRef: `goal:${input.goalId}`,
    },
    boundary: {
      boundary: 'fleet:launch-on-plan',
      refusalCode: 'goal-plan-placement-prerequisite',
      enforcement: 'required' as const,
      // resolveGoalLaunch intentionally fails open on unreadable ceilings while
      // reporting degradation. Admission and operation must preserve that same
      // policy rather than creating a stricter second launch gate here.
      unknown: 'allow-with-warning' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Plan placement evidence is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      causalRank: 0,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'readGoalPlanFleetCohort' },
      measurementFailure: input.read.failure,
    });
  }
  const { portfolio, launch, alert } = input.read.value;
  let { ageMs } = input.read.value;
  if (!portfolio) {
    return defineAgentObligation({
      ...common,
      title: 'No active goal portfolio currently needs plan placement',
      episode: `no-portfolio:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical portfolio reader found no goal row in scope',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }

  if (portfolio.goal.id !== input.goalId) {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal portfolio scope does not match',
        code: 'goal-portfolio-scope-mismatch',
        detail: `portfolio goal ${portfolio.goal.id} differs from requested goal ${input.goalId}`,
        retry: 're-read the portfolio for the requested goal before planning placement',
        applicableDemand: 0,
      }),
    });
  }
  const goalStatus = portfolio.goal.status;
  if (goalStatus === 'paused' || goalStatus === 'achieved' || goalStatus === 'killed') {
    return defineAgentObligation({
      ...common,
      // Historical relationships remain readable; they cannot arm a wake
      // that asks a stopped goal's holder to resume placement.
      changeSignal: undefined,
      title: `Goal ${input.goalId} is ${goalStatus}`,
      episode: `inactive:${goalStatus}:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical goal lifecycle does not authorize plan placement',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }
  if (goalStatus !== 'active') {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal lifecycle is unresolved',
        code: 'goal-lifecycle-unresolved',
        detail: `canonical goal status is ${goalStatus ?? 'unknown'}`,
        retry: 'resolve the canonical goal lifecycle before planning placement',
        applicableDemand: 0,
      }),
    });
  }

  const applicablePlans = portfolio.worklist.filter((plan) => plan.placement.state !== 'terminal');
  // Preserve canonical worklist ordering among feasible next actions. A
  // blocked earlier plan is not a prerequisite for an independent later one.
  // Retain the blocker as the fallback when no placement can advance.
  const selected = selectGoalPlacementPlan(portfolio, input.read.value.admissions);
  const progressPlan = selected ?? applicablePlans[0];
  let progressStalledAt: string | null = null;
  let repairExhausted = false;
  if (progressPlan && input.read.value.progress) {
    const state = input.read.value.progress[progressPlan.ref];
    const view = advanceGoalPlacementProgress({
      scopeKey: goalPlacementProgressScopeKey({ workspaceId: input.workspaceId, ownerId: input.ownerId,
        goalId: input.goalId, planRef: progressPlan.ref }), previous: state ?? null, now: input.observedAt,
    });
    if (selected && view.status === 'unknown') {
      return defineAgentObligation({
        ...common,
        scope: { ...scope, planSlug: selected.slug },
        ...unknownPlacement(input, {
          title: `Placement progress for ${selected.slug} is unavailable`,
          code: 'goal-placement-progress-invalid',
          detail: view.reason ?? 'the stored progress receipt is invalid',
          retry: 'inspect and repair the scoped progress receipt before treating another launch as progress',
          applicableDemand: applicablePlans.length,
          plan: selected,
        }),
      });
    }
    ageMs = view.status === 'known' ? view.ageMs ?? undefined : undefined;
    progressStalledAt = selected && view.stalled ? view.state.stalledAt : null;
    repairExhausted = !!progressStalledAt && view.state.repairOpportunities === 2;
  }
  const portfolioReadFailure = portfolio.degradedReasons.find((reason) => /portfolio read failed/i.test(reason));
  if (portfolioReadFailure) {
    return defineAgentObligation({
      ...common,
      ...unknownPlacement(input, {
        title: 'Goal portfolio placement state is unavailable',
        code: 'goal-portfolio-read-degraded',
        detail: portfolioReadFailure,
        retry: 're-read GoalPortfolioBrief before inferring plan demand or placement',
        applicableDemand: applicablePlans.length,
      }),
    });
  }

  if (applicablePlans.length === 0) {
    return defineAgentObligation({
      ...common,
      title: 'No non-terminal goal plan currently needs placement',
      episode: `none:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical worklist is empty or every worklist plan is terminal',
      causalRank: 0,
      applicableDemand: 0,
      evidence: placementEvidence(input),
    });
  }

  if (alert) {
    const alertPlan = portfolio.worklist.find((plan) => plan.slug === alert.planSlug);
    if (!alertPlan || alertPlan.placement.reconciliation.consistent || alertPlan.placement.state === 'terminal') {
      const observed = alertPlan
        ? `${alert.planSlug} is ${alertPlan.placement.state}/${alertPlan.placement.reconciliation.action}`
        : `${alert.planSlug} is absent from the canonical goal worklist`;
      return defineAgentObligation({
        ...common,
        ...unknownPlacement(input, {
          title: 'Canonical plan-placement writers disagree',
          code: 'plan-placement-writer-conflict',
          detail: `the live cohort emitted ${alert.reason}, but ${observed}`,
          retry: 'refresh GoalPortfolioBrief and the goal plan-fleet cohort in one evaluation window',
          applicableDemand: applicablePlans.length,
          plan: alertPlan,
        }),
      });
    }
  }

  if (!selected) {
    const covered = applicablePlans.map((plan) =>
      evidence(
        `goal-plan-placement:${plan.ref}:${portfolio.assembledAt}`,
        portfolio.assembledAt,
        input.sourceGeneration,
        placementNote(plan.placement),
        'live independently led fleet, live lane holder, and consistent placement observed',
      ),
    );
    return defineAgentObligation({
      ...common,
      title: 'Goal worklist plans have live independent placement',
      // assembledAt is an observation clock, not a policy generation. Keeping
      // it out of identity prevents an unchanged satisfied placement from
      // becoming a brand-new obligation episode on every turn.
      episode: `covered:${input.sourceGeneration}`,
      status: 'satisfied',
      reason: 'every non-terminal worklist plan is working or independently led with a consistent canonical receipt',
      causalRank: 0,
      applicableDemand: applicablePlans.length,
      evidence: [...placementEvidence(input, applicablePlans[0]), ...covered],
      ...(ageMs == null ? {} : { ageMs }),
    });
  }

  const placement = selected.placement;
  const toolCall = placement.reconciliation.toolCall;
  const needsLaunch = toolCall !== null;
  if (placement.state === 'unplaced' && needsLaunch && input.read.value.admissions) {
    const admission = input.read.value.admissions[selected.ref];
    if (!admission) return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Exact-plan admission for ${selected.slug} is unavailable`,
        code: 'exact-plan-admission-unavailable',
        detail: 'the exact-plan preflight for the selected action was not measured',
        retry: 'refresh caller-neutral exact-plan admission for this plan and requested seat count',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
    if (!admission.ready) {
      const guidance = admission.reason === 'ready' ? null : EXACT_PLAN_REFUSAL_GUIDANCE[admission.reason];
      if (!guidance) return defineAgentObligation({
        ...common,
        scope: { ...scope, planSlug: selected.slug },
        ...unknownPlacement(input, {
          title: `Exact-plan admission for ${selected.slug} is inconsistent`,
          code: 'exact-plan-admission-inconsistent', detail: admission.message,
          retry: 're-read the typed preflight verdict before selecting an action',
          applicableDemand: applicablePlans.length, plan: selected,
        }),
      });
      const admissionEvidence = evidence(
        `exact-plan-admission:${selected.ref}:${input.sourceGeneration}`, input.observedAt,
        input.sourceGeneration, `${admission.reason}: ${admission.message}`,
      );
      return defineAgentObligation({
        ...common,
        title: `Repair exact-plan admission for ${selected.slug}`,
        scope: { ...scope, planSlug: selected.slug },
        episode: `admission:${selected.ref}:${admission.reason}:${input.sourceGeneration}`,
        status: guidance.status,
        reason: admission.message,
        causalRank: 0,
        applicableDemand: applicablePlans.length,
        evidence: [...placementEvidence(input, selected), admissionEvidence],
        action: { kind: guidance.status === 'unknown' ? 'inspect' : 'repair',
          summary: guidance.summary, targetRef: selected.ref },
        ...(guidance.status === 'unknown' ? { measurementFailure: {
          code: `exact-plan-admission-${admission.reason}`, detail: admission.message,
          retry: guidance.summary,
        } } : {}),
        ...(ageMs == null ? {} : { ageMs }),
      });
    }
  }
  if (needsLaunch && (!launch || launch.goalId !== input.goalId)) {
    return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Launch feasibility for ${selected.slug} is unavailable`,
        code: 'goal-launch-resolution-missing',
        detail: launch
          ? `resolveGoalLaunch returned goal ${launch.goalId ?? 'none'} for placement goal ${input.goalId}`
          : 'the placement requires a launch but no resolveGoalLaunch receipt was supplied',
        retry: 'run resolveGoalLaunch for the exact fleet/count immediately before placement',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
  }

  if (needsLaunch && launch?.degraded) {
    const detail = launch.degradedReasons.join('; ') || 'resolveGoalLaunch reported degraded evidence';
    return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Launch evidence for ${selected.slug} is degraded`,
        code: 'goal-launch-resolution-degraded',
        detail,
        retry: 'refresh budget provenance, headcount, and resolveGoalLaunch before treating placement as due',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
  }

  if (needsLaunch && launch?.refusal) {
    const refusal = launch.refusal;
    const guidance = Object.hasOwn(LAUNCH_REFUSAL_GUIDANCE, refusal.reason)
      ? LAUNCH_REFUSAL_GUIDANCE[refusal.reason] : undefined;
    if (!guidance) return defineAgentObligation({
      ...common,
      scope: { ...scope, planSlug: selected.slug },
      ...unknownPlacement(input, {
        title: `Launch refusal for ${selected.slug} is unsupported`,
        code: 'unsupported-goal-launch-refusal',
        detail: `Unrecognized launch refusal ${refusal.reason}: ${refusal.message}`,
        retry: 'refresh the canonical launch refusal semantics before choosing another action',
        applicableDemand: applicablePlans.length,
        plan: selected,
      }),
    });
    return defineAgentObligation({
      ...common,
      title: `${guidance.title} of ${selected.slug}`,
      scope: { ...scope, planSlug: selected.slug },
      episode: `refused:${refusal.reason}:${refusal.current}:${refusal.limit}:${refusal.requested}`,
      status: 'blocked',
      reason: refusal.message,
      causalRank: 0,
      applicableDemand: applicablePlans.length,
      evidence: placementEvidence(input, selected),
      action: {
        kind: 'repair',
        summary: guidance.summary,
        targetRef: `goal:${input.goalId}`,
      },
      ...(ageMs == null ? {} : { ageMs }),
    });
  }

  // A completed two-opportunity stall is a repair obligation. Repeating the
  // original launch would count another attempt while leaving the failure's
  // cause unknown. An admitting transaction remains in progress, and a current
  // typed launch refusal above keeps its more specific repair guidance.
  if (progressStalledAt && placement.state === 'unplaced') {
    return defineAgentObligation({
      ...common,
      title: `${repairExhausted ? 'Escalate exhausted repair' : 'Diagnose stalled goal plan placement'} for ${selected.slug}`,
      scope: { ...scope, planSlug: selected.slug },
      episode: `${repairExhausted ? 'repair-exhausted' : 'stalled'}:${selected.slug}:${progressStalledAt}`,
      status: 'due',
      reason: repairExhausted
        ? 'two additional delivered, completed, eligible repair decisions produced no verified effect'
        : 'two distinct delivered, completed, eligible decisions produced no verified placement effect',
      causalRank: 1,
      applicableDemand: applicablePlans.length,
      evidence: placementEvidence(input, selected),
      action: {
        kind: repairExhausted ? 'report' : 'repair',
        summary: repairExhausted
          ? `stop repeating the failed placement repair for ${selected.slug}; reassign the repair within existing authority or escalate its exact blocker and evidence; do not relaunch or widen budget/admission authority`
          : `inspect the canonical launch transaction, admission refusal, fleet and member claims for ${selected.slug}; repair the failed leg before retrying placement`,
        targetRef: selected.ref,
        // Retain the canonical target for receipt/admission measurement only.
        // No tool is offered: a repair must not become an executable relaunch.
        ...(!repairExhausted && toolCall?.tool === 'fleet:launch-on-plan' ? { args: toolCall.args } : {}),
      },
      ...(ageMs == null ? {} : { ageMs }),
    });
  }

  const baseAction = {
    summary: placement.reconciliation.reason,
    targetRef: selected.ref,
    ...(toolCall ? { tool: toolCall.tool, args: toolCall.args } : {}),
  };
  const isUnplaced = placement.state === 'unplaced';
  const isAdmitting = placement.state === 'admitting';
  // P-026 / D-012. This plan says it is finished and its closure is not evidenced.
  // It is `due` rather than `blocked`: nothing outside the holder is being waited
  // on, and reporting it blocked would excuse exactly the work that is owed.
  const isAwaitingClosure = placement.state === 'awaiting-closure';
  return defineAgentObligation({
    ...common,
    title: isUnplaced
      ? `Place goal plan ${selected.slug}`
      : isAdmitting
        ? `Finish verified placement of ${selected.slug}`
        : isAwaitingClosure
          ? `Close goal plan ${selected.slug} — its items are finished but closure is not evidenced`
          : `Repair goal plan placement for ${selected.slug}`,
    scope: { ...scope, planSlug: selected.slug },
    episode: `${placement.reconciliation.action}:${selected.slug}:${placement.launchTransaction?.transactionId ?? input.sourceGeneration}`,
    status: isUnplaced || isAwaitingClosure ? 'due' : isAdmitting ? 'in-progress' : 'blocked',
    reason: placement.reconciliation.reason,
    causalRank: isUnplaced ? 1 : 0,
    applicableDemand: applicablePlans.length,
    evidence: placementEvidence(input, selected),
    action: isUnplaced
      ? {
          ...baseAction,
          kind: 'delegate',
          summary: `launch the independently led fleet for ${selected.slug} with the canonical transaction arguments`,
        }
      : isAdmitting
        ? { ...baseAction, kind: 'continue', continuesCurrentWork: true }
        : isAwaitingClosure && placement.closure?.reportOutstandingOnly
          ? {
              // Every evidence leg passed; what is owed is the holder's measured
              // report. Deliberately NOT `delegate` — there is no execution left
              // to place, and offering a launch here is how placement re-becomes
              // the answer to a question about closure.
              ...baseAction,
              kind: 'report',
              summary: `record the measured closure report (effect, cost, uncertainty, residue) for ${selected.slug}`,
            }
          : {
              ...baseAction,
              kind: 'repair',
            },
    ...(ageMs == null ? {} : { ageMs }),
  });
}

export interface OwnerReportProviderInput extends ProviderBase {
  goalId: string;
  read: ProviderRead<GoalOwnerReportObligation | null>;
}

export function ownerReportObligation(input: OwnerReportProviderInput): AgentObligation {
  const common = {
    ruleId: 'goal-owner-report',
    ruleRevision: OWNER_REPORT_OBLIGATION_REVISION,
    family: 'owner-report' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId },
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority('system-health/goal-owner-report-watchdog', OWNER_REPORT_OBLIGATION_REVISION),
    priority: 'high' as const,
    causalRank: 1,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      id: 'canonical-owner-report-delivery',
      summary: 'a complete report is delivered on one of the canonical owner-facing rails',
      evidenceKind: 'delivery' as const,
      sourceRef: 'makeReadGoalModeOwners:three-source-report-union',
    },
    boundary: {
      boundary: 'goal-owner-report',
      refusalCode: 'goal-owner-report-incomplete',
      enforcement: 'required' as const,
      unknown: 'allow-with-warning' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Owner-report state is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'readGoalOwnerReportObligation' },
      measurementFailure: input.read.failure,
    });
  }
  const report = input.read.value;
  if (!report) {
    return defineAgentObligation({
      ...common,
      title: 'No active goal reporting contract applies',
      episode: `none:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'the canonical reader found no active goal-mode holder row',
      applicableDemand: 0,
      evidence: [evidence(`goal:${input.goalId}`, input.observedAt, input.sourceGeneration, 'no applicable owner row')],
    });
  }
  const reportRef = `goal-owner-report:${input.goalId}:${report.lastReportAt ?? 'baseline'}`;
  // The watchdog owns the exact reference+floor boundary. Reconstructing it
  // from rounded display minutes made an unchanged episode's deadline drift by
  // up to a minute on every read, continually replacing its durable await.
  const dueAt = report.dueAt;
  if (report.obligation === 'not-due') {
    if (!report.lastReportAt) {
      return defineAgentObligation({
        ...common,
        title: 'Owner report is not due yet',
        episode: `grace:${dueAt}`,
        status: 'not-applicable',
        reason: report.instruction,
        applicableDemand: 0,
        evidence: [evidence(reportRef, input.observedAt, input.sourceGeneration, 'inside initial reporting window')],
        changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
      });
    }
    return defineAgentObligation({
      ...common,
      title: 'Owner reporting cadence is current',
      episode: `reported:${report.lastReportAt}`,
      status: 'satisfied',
      reason: report.instruction,
      applicableDemand: 0,
      evidence: [
        evidence(
          reportRef,
          report.lastReportAt,
          input.sourceGeneration,
          'canonical owner-facing delivery',
          'owner report delivered inside the applicable cadence',
        ),
      ],
      lastSatisfiedAt: report.lastReportAt,
      changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
    });
  }
  return defineAgentObligation({
    ...common,
    title: report.obligation === 'overdue' ? 'Owner report is overdue' : 'Owner report is due now',
    episode: `due:${report.lastReportAt ?? 'baseline'}:${report.floorMin}`,
    status: 'due',
    reason: report.instruction,
    applicableDemand: 1,
    evidence: [evidence(reportRef, input.observedAt, input.sourceGeneration, report.obligation)],
    action: {
      kind: 'report',
      summary: 'send MOVED / COST / OWNER-WALLED / KILLED on a canonical owner-facing rail now',
      tool: 'coord:send',
      args: { to: ['human'] },
    },
    dueAt,
    ageMs: Math.max(0, report.ageMin * 60_000),
    changeSignal: { nextDeadlineAt: dueAt, cancellationRef: `goal:${input.goalId}` },
  });
}

/**
 * Who owns the repair for each acceptance-gate refusal code.
 *
 * generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 D-009: this was
 * TWO hand-maintained `Set<PlanAcceptanceGateCode>`s (GRADER_GAP_CODES /
 * AUTHOR_REPAIR_CODES). A code in NEITHER silently fell through to
 * `causalRank: 2` — the DOWNSTREAM-symptom tier — while usually being upstream
 * author work, so it was ranked below the very repairs that unblock it and read
 * as nobody's work. Seven of the union's 23 codes had drifted into that hole,
 * including `acceptance_bar_contract_not_ready`, the single most common real
 * acceptance stall in this repo.
 *
 * An exhaustive `Record` is the fix rather than a test: TypeScript now REFUSES TO
 * COMPILE when a code is added to `PlanAcceptanceGateCode` and left unclassified,
 * so the hole cannot reopen silently (derived-truth ladder rung 1 — derive, don't
 * hand-maintain). Adding a code here is a deliberate ownership decision, which is
 * exactly the moment it should be made.
 *
 * - `grader`    — waiting on an INDEPENDENT GRADER. `status:'due'` plus a `delegate`
 *                 action: the ONLY class that may recruit/wake a peer.
 * - `author`    — waiting on the plan's OWN author. Upstream (`causalRank: 0`), so
 *                 it outranks any downstream symptom. ALSO `status:'due'` (D-009
 *                 ruling 3) — the author can start it this second, and rendering it
 *                 `[BLOCKED]` told the one agent who could act that it could not.
 *                 Its action is `repair`, so it still NEVER recruits a peer.
 * - `unmeasured`— the gate could not MEASURE the plan (a read/lineage failure). Not
 *                 a repair anyone owns; it needs a retry or a fixed instrument, and
 *                 must not be dressed up as either party's work — so it stays
 *                 `blocked` and takes an `inspect` action, never `repair`.
 * - `not-here`  — deliberately handled EARLIER in this provider and never reaching
 *                 classification (see `gradeable` for `plan_items_unfinished`).
 *
 * ⛔ Do NOT reclassify a contract code (`acceptance_bar_*`) as `grader` to make a
 * stall look actionable. `acceptance-bar-lifecycle-evaluator.ts` deliberately keeps
 * recruitment to {acceptance_ungraded, self_graded_only} so a malformed rubric
 * cannot spawn agents, and it RENDERS that promise to the user in the refusal text
 * ("These repairs are the plan author's alone — do not recruit or wake a peer for
 * them."). Widening it here would make that rendered sentence a lie.
 */
export type PlanAcceptanceGateCodeOwnership = 'grader' | 'author' | 'unmeasured' | 'not-here';

/**
 * Exported so the guard test can DERIVE the full code population from this Record's
 * own keys (`Object.keys`) instead of hand-listing the union a second time — a
 * hand-listed copy is exactly the drift this Record was introduced to kill, and a
 * test carrying one would silently stop covering the next code anyone adds.
 */
export const GATE_CODE_OWNERSHIP: Record<PlanAcceptanceGateCode, PlanAcceptanceGateCodeOwnership> = {
  // --- waiting on an independent grader -------------------------------------
  acceptance_ungraded: 'grader',
  self_graded_only: 'grader',

  // --- waiting on the plan's own author -------------------------------------
  acceptance_rubric_missing: 'author',
  acceptance_rubric_ambiguous: 'author',
  acceptance_rubric_unvetted: 'author',
  acceptance_rubric_revision_unreadable: 'author',
  acceptance_rubric_vetted_after_grading: 'author',
  acceptance_not_recorded: 'author',
  acceptance_rejected: 'author',
  acceptance_unaudited: 'author',
  audit_coverage_stale: 'author',
  audit_citations_unresolved: 'author',
  requirement_unrealized: 'author',
  ephemeral_deliverable_unbacked: 'author',
  spec_proof_stale: 'author',
  spec_clause_unproven: 'author',
  // D-009: these four were UNCLASSIFIED and are author work. The bar-contract pair
  // in particular is the repo's most frequent acceptance stall, so leaving it at
  // the downstream rank actively mis-ordered the agenda against the fix.
  acceptance_bar_contract_not_ready: 'author',
  acceptance_bar_not_met: 'author',
  design_evidence_unsatisfied: 'author',

  // --- the gate could not measure the plan ----------------------------------
  // A failed measurement is not a repair. Ranking these as author work would send
  // someone to "fix" a plan whose state was never actually read.
  acceptance_lineage_unreadable: 'unmeasured',
  design_evidence_unavailable: 'unmeasured',
  spec_coverage_unavailable: 'unmeasured',

  // --- never reaches classification -----------------------------------------
  // `gradeable` short-circuits this to a 'not-applicable' obligation well above.
  plan_items_unfinished: 'not-here',
};

export interface IndependentVerificationProviderInput extends ProviderBase {
  planSlug: string;
  read: ProviderRead<{
    gate: PlanAcceptanceGateVerdict;
    evidenceRef: string;
    reviewAgeMs?: number;
    /** False before implementation/audit/rubric makes independent review applicable. */
    gradeable: boolean;
  } | null>;
}

export function independentVerificationObligation(input: IndependentVerificationProviderInput): AgentObligation {
  const common = {
    ruleId: 'plan-independent-verification',
    ruleRevision: INDEPENDENT_VERIFICATION_OBLIGATION_REVISION,
    family: 'independent-verification' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, planSlug: input.planSlug },
    responsibleOwnerId: input.ownerId,
    authority: policyAuthority('plan-acceptance-gate', INDEPENDENT_VERIFICATION_OBLIGATION_REVISION),
    priority: 'high' as const,
    sourceGeneration: input.sourceGeneration,
    clearsWhen: {
      id: 'admissible-independent-acceptance',
      summary: 'the current plan/rubric revision has an admissible independent grade and author verdict',
      evidenceKind: 'verdict' as const,
      sourceRef: 'evaluatePlanAcceptanceGate',
    },
    changeSignal: {
      event: planAcceptanceChangedKey(input.planSlug),
      cancellationRef: `plan:${input.planSlug}`,
    },
    boundary: {
      boundary: 'plans:ship',
      refusalCode: 'plan-independent-verification-required',
      enforcement: 'required' as const,
      unknown: 'refuse' as const,
    },
  };
  if (input.read.status === 'unknown') {
    return defineAgentObligation({
      ...common,
      title: 'Independent-verification state is unavailable',
      episode: `unknown:${input.sourceGeneration}`,
      status: 'unknown',
      reason: input.read.failure.detail,
      causalRank: 2,
      applicableDemand: 0,
      evidence: [],
      action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'evaluatePlanAcceptanceGate' },
      measurementFailure: input.read.failure,
    });
  }
  const observed = input.read.value;
  if (!observed || !observed.gradeable) {
    return defineAgentObligation({
      ...common,
      title: `Plan ${input.planSlug} is not ready for independent verification`,
      episode: `not-gradeable:${input.sourceGeneration}`,
      status: 'not-applicable',
      reason: 'implementation, completion audit, or acceptance rubric prerequisites are not complete',
      causalRank: 2,
      applicableDemand: 0,
      evidence: [evidence(`plan:${input.planSlug}`, input.observedAt, input.sourceGeneration, 'not gradeable')],
    });
  }
  const { gate, evidenceRef, reviewAgeMs } = observed;
  if (gate.satisfied) {
    return defineAgentObligation({
      ...common,
      title: `Plan ${input.planSlug} has independent acceptance`,
      episode: `accepted:${gate.rubricId ?? 'no-rubric'}:${input.sourceGeneration}`,
      status: 'satisfied',
      reason: 'the canonical ship gate is satisfied',
      causalRank: 2,
      applicableDemand: 1,
      evidence: [
        evidence(
          evidenceRef,
          input.observedAt,
          input.sourceGeneration,
          gate.gradedBy ? `graded by ${gate.gradedBy}` : 'accepted by canonical gate',
          'current admissible independent acceptance verdict observed',
        ),
      ],
      ...(reviewAgeMs == null ? {} : { ageMs: reviewAgeMs }),
    });
  }
  const code = gate.code;
  const ownership = code ? GATE_CODE_OWNERSHIP[code] : undefined;
  /**
   * D-009 ruling 3 — the TWO independent questions one `graderGap` boolean used to
   * conflate. They are not the same question, and collapsing them forced a false
   * choice: either an author-owned stall renders `[BLOCKED]` (telling the one agent
   * who CAN act that it cannot), or contract codes get reclassified as grader gaps
   * and a malformed rubric starts spawning graders. Split, both stay true.
   *
   * - `isDelegable`  — may this recruit/wake a LINEAGE-INDEPENDENT PEER? `grader` only.
   *                    This is the safety-bearing half; widening it is what
   *                    `acceptance-bar-lifecycle-evaluator.ts` promises never happens.
   * - `isActionable` — can SOMEONE act on this right now? Strictly wider: author
   *                    repair qualifies, because the plan's own author can start it
   *                    this second. This is the visibility half, and it recruits
   *                    nobody.
   *
   * `unmeasured` satisfies NEITHER: a failed measurement is not work, so it stays
   * `blocked` and takes an `inspect` action rather than being dressed up as a repair
   * the author owes (the pre-split code told them to "repair" a gate read that never
   * happened).
   */
  const isDelegable = ownership === 'grader';
  const authorRepair = ownership === 'author';
  const isActionable = isDelegable || authorRepair;
  return defineAgentObligation({
    ...common,
    title: isDelegable
      ? `Plan ${input.planSlug} needs an independent grader`
      : authorRepair
        ? `Plan ${input.planSlug} needs author repair before independent certification`
        : `Plan ${input.planSlug} cannot yet be independently certified`,
    // A plan can cycle back to the same refusal code/rubric after a revision.
    // Include the canonical source generation so a fired old episode never
    // suppresses the new revision's material-change watch.
    episode: `${code ?? 'gate-unknown'}:${gate.rubricId ?? 'no-rubric'}:${input.sourceGeneration}`,
    status: isActionable ? 'due' : 'blocked',
    reason: gate.message ?? `plan acceptance gate refused with ${code ?? 'an unknown code'}`,
    // Author-owned audit/rubric/spec repair is a prerequisite to asking an
    // independent grader to act. Keep it in the upstream tier so a downstream
    // due symptom cannot outrank the work that makes grading possible.
    causalRank: authorRepair ? 0 : 2,
    applicableDemand: 1,
    evidence: [evidence(evidenceRef, input.observedAt, input.sourceGeneration, code ?? 'gate-refused')],
    // ⛔ `isDelegable` — NOT `isActionable` — gates this branch. It is the single
    // line that decides whether a refusal may recruit a stranger, and the whole
    // point of the split is that making author work visible never widens it.
    action: isDelegable
      ? {
          kind: 'delegate',
          // review-routing-through-relevance-router-2026-09-26 D-001: the ship
          // verb IS the recruiter (it routes through the relevance router and
          // excludes implementers/author/shipper), so the action names that call
          // rather than leaving the reader to hand-pick and message a grader.
          summary: `call plans:set-plan-status → shipped for ${input.planSlug}: it routes the plan to a lineage-independent acceptance grader; never pick or message a grader yourself`,
          tool: 'plans:set-plan-status',
          args: { slug: input.planSlug, status: 'shipped' },
          targetRef: input.planSlug,
        }
      : ownership === 'author' || ownership === 'not-here'
        ? {
            kind: 'repair',
            summary: `repair ${code ?? 'the unreadable acceptance prerequisite'} before requesting a grader`,
            targetRef: input.planSlug,
            continuesCurrentWork: code === 'plan_items_unfinished',
          }
        : {
            // `unmeasured` (or a code the gate did not report): the gate never
            // READ the plan, so there is no repair to name and nobody to route to.
            kind: 'inspect',
            summary: `re-read the acceptance gate for ${input.planSlug}: ${
              code ?? 'the refusal'
            } is a failed measurement, not a repair either party owns`,
            targetRef: 'evaluatePlanAcceptanceGate',
          },
    ...(reviewAgeMs == null ? {} : { ageMs: reviewAgeMs }),
  });
}

/**
 * One undispositioned owner directive, reduced to what a class-B row needs.
 *
 * Deliberately NOT `OwnerDirectiveRow`: the obligation contract must not take a
 * dependency on the directive store's full column set, and a caller (or a test)
 * must be able to feed this provider without a database.
 *
 * Only directives this session OWNS arrive here — addressed to it, or held by it
 * through a linked work-item (P-004 / D-003 of
 * owner-directive-delivery-redesign-2026-09-22). Every other open directive
 * reaches the session as an AWARENESS line in the ownerDirectives orientation
 * class, never as a due obligation.
 */
export interface OwnerDirectiveObligationRow {
  id: number;
  /**
   * Always `open`: every owner turn is a directive awaiting disposition
   * (owner-directive-delivery-redesign-2026-09-22, D-001). Terminal states
   * (`done`/`declined`) are not obligations and must be filtered out by the
   * reader, never represented here.
   */
  state: 'open';
  /**
   * The D-004 display text (`directiveDisplayText`): the whole verbatim up to
   * the 500-char cap, else the labelled agent summary or a summary-pending note.
   * Never a cut fragment. It goes in `reason`, not the title — see below.
   */
  displayText: string;
  /** The row's own created_at — a stable row fact, never an observation clock. */
  recordedAt: string;
  recordedBy: string;
  /**
   * True when the UserPromptSubmit provenance hook captured the turn, which is
   * the only mechanism here that CLASSIFIES a turn as OWNER (interactive).
   * False means an agent asserted the owner said it via `orders:record` — real
   * evidence, but not proof, so it is represented as `owner-candidate`.
   * Conflating the two is exactly how a note-to-self becomes an owner directive.
   */
  capturedByHook: boolean;
  /**
   * True when this session holds the directive only because its addressee
   * (`recordedBy`) ENDED and this session leads that addressee's fleet (P-008 /
   * R-7 of owner-directive-delivery-redesign-2026-09-22). Absent = addressed or held.
   */
  inheritedFromEnded?: boolean;
}

export interface OwnerDirectivesProviderInput extends ProviderBase {
  read: ProviderRead<OwnerDirectiveObligationRow[]>;
}

/** The disposition verb each state is cleared by. One row per state, no default. */
const OWNER_DIRECTIVE_DISPOSITION: Record<
  OwnerDirectiveObligationRow['state'],
  { title: string; summary: string; tool: string; clearsWhen: string }
> = {
  // `summary` is spent once PER ROW in a 3-row/400-char sink, so it carries the
  // disposition VERB and nothing else.
  open: {
    title: 'Open owner directive awaits disposition',
    summary: 'carry out, then close: orders:disposition',
    tool: 'orders:disposition',
    clearsWhen: 'the row is dispositioned done or declined',
  },
};

function ownerDirectiveCommon(input: OwnerDirectivesProviderInput) {
  return {
    ruleId: 'owner-directive-disposition',
    ruleRevision: OWNER_DIRECTIVE_OBLIGATION_REVISION,
    family: 'owner-directive' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId },
    responsibleOwnerId: input.ownerId,
    // An owner directive is the highest-precedence standing obligation an agent
    // carries: it OUTRANKS the loop agenda, so it sorts ahead of every
    // policy-sourced duty rather than competing with them on priority alone.
    causalRank: 0,
    sourceGeneration: input.sourceGeneration,
  };
}

/**
 * Owner directives → class-B obligation rows (P-006 of plan
 * `turn-start-memory-two-class-2026-09-21`).
 *
 * ONE OBLIGATION PER DIRECTIVE, because each carries its own id, its own
 * disposition verb and its own recovery pointer — the uniform class-B row
 * shape. A single aggregate obligation would collapse them
 * into a count, which is the shape an agent can acknowledge without acting on
 * any individual directive.
 *
 * The rows stay `due` until dispositioned, which is what makes them re-inject
 * every turn under the P-002 discharge contract instead of clearing on delivery.
 */
export function ownerDirectiveObligations(input: OwnerDirectivesProviderInput): AgentObligation[] {
  const common = ownerDirectiveCommon(input);
  if (input.read.status === 'unknown') {
    return [
      defineAgentObligation({
        ...common,
        title: 'Owner-directive state is unavailable',
        episode: `unknown:${input.sourceGeneration}`,
        status: 'unknown',
        priority: 'high',
        authority: policyAuthority('owner-directives:listOwnerDirectives', OWNER_DIRECTIVE_OBLIGATION_REVISION),
        reason: input.read.failure.detail,
        applicableDemand: 0,
        evidence: [],
        action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'orders:list { open: true }' },
        clearsWhen: {
          id: 'owner-directive-queue-readable',
          summary: 'the open directive queue is readable again',
          evidenceKind: 'state',
          sourceRef: 'harness_shared.owner_directives',
        },
        measurementFailure: input.read.failure,
      }),
    ];
  }
  const rows = input.read.value;
  if (rows.length === 0) {
    return [
      defineAgentObligation({
        ...common,
        title: 'No undispositioned owner directive applies',
        episode: `none:${input.sourceGeneration}`,
        status: 'not-applicable',
        priority: 'normal',
        authority: policyAuthority('owner-directives:listOwnerDirectives', OWNER_DIRECTIVE_OBLIGATION_REVISION),
        reason: 'the canonical directive queue holds no open row for this workspace',
        applicableDemand: 0,
        evidence: [
          evidence(
            `owner-directives:${input.workspaceId}`,
            input.observedAt,
            input.sourceGeneration,
            'empty open queue',
          ),
        ],
        clearsWhen: {
          id: 'owner-directive-queue-empty',
          summary: 'no open directive exists',
          evidenceKind: 'state',
          sourceRef: 'harness_shared.owner_directives',
        },
      }),
    ];
  }
  const observedMs = Date.parse(input.observedAt);
  return rows.map((row) => {
    const disposition = OWNER_DIRECTIVE_DISPOSITION[row.state];
    const fullTextRef = `orders:get #${row.id}`;
    const recordedMs = Date.parse(row.recordedAt);
    const ageMs =
      Number.isFinite(observedMs) && Number.isFinite(recordedMs) ? Math.max(0, observedMs - recordedMs) : undefined;
    return defineAgentObligation({
      ...common,
      // A REMINDER, not a copy: { id, disposition verb, recovery pointer }. The
      // owner's text is deliberately NOT in the title. The turn-start sink is
      // 400 chars over 3 rows while a directive may run to 500 before D-004
      // hands it to a summary, so a text-carrying title must either be cut —
      // which D-004 forbids — or starve the sink. The full text already renders
      // in the ownerDirectives orientation class of the same block, and this
      // row re-emits on every turn it stays open, so repeating the text here is
      // the per-turn cost the owner asked to remove (directive #200).
      title: row.inheritedFromEnded
        ? `Owner directive #${row.id} passed to you: its session ${row.recordedBy} ended`
        : `Owner directive #${row.id} is yours and still open`,
      // The row id alone is the episode: the SAME undispositioned directive must
      // produce the SAME obligation id on every turn, or a warm-turn dedup would
      // read a re-render as a brand-new obligation and the row would churn.
      episode: `${row.state}:${row.id}`,
      status: 'due',
      priority: 'critical',
      authority: row.capturedByHook
        ? { kind: 'owner', sourceRef: `owner-directive:${row.id}`, turnOrigin: 'owner-typed' }
        : { kind: 'owner-candidate', sourceRef: `owner-directive:${row.id}`, turnOrigin: 'unknown' },
      reason: `owner directive #${row.id}: ${row.displayText}`,
      applicableDemand: 1,
      evidence: [
        evidence(
          `owner-directive:${row.id}`,
          row.recordedAt,
          input.sourceGeneration,
          `recorded by ${row.recordedBy}${row.capturedByHook ? ' via the provenance hook' : ' via orders:record'}`,
        ),
      ],
      action: {
        kind: 'repair',
        summary: disposition.summary,
        tool: disposition.tool,
        args: { id: row.id },
        // The RECOVERY POINTER: the rendered line carries no owner text, so
        // the verbatim turn must always be one addressable call away. Both
        // fields come from ONE expression so they cannot drift — `targetRef` is
        // the structured pointer for programmatic consumers, `recoveryRef` the
        // rendered one.
        targetRef: fullTextRef,
        recoveryRef: fullTextRef,
      },
      clearsWhen: {
        id: `owner-directive-dispositioned:${row.id}`,
        summary: disposition.clearsWhen,
        evidenceKind: 'state',
        sourceRef: `owner-directive:${row.id}`,
      },
      ...(ageMs == null ? {} : { ageMs }),
    });
  });
}

/**
 * ONE thing this session is parked on: an awaited event, or a lock ticket it is
 * queued behind. Row facts only — no observation clock, so an unchanged wait
 * keeps an unchanged `sourceGeneration` across warm turns.
 */
export type WaitingOnObligationRow =
  | {
      kind: 'event-await';
      /**
       * The awaited key, VERBATIM. Never abbreviated and never re-typed: a
       * hand-retyped key does not rendezvous, so the waiter sleeps forever —
       * which is precisely the failure this row exists to keep visible.
       */
      key: string;
      /** ISO deadline, or null when the row carries no effective deadline. */
      timeoutAt: string | null;
      /**
       * What happens at the deadline WITHOUT the event. `expire` is the
       * dangerous one: the await lapses SILENTLY and no turn is ever scheduled,
       * so a forgotten `expire` row is a session that simply stops.
       */
      onTimeout: 'wake' | 'expire';
    }
  | {
      kind: 'lock-queue';
      /** The path this session is queued for. */
      path: string;
      /** The owner holding it — who to coordinate with, not merely that someone does. */
      holder: string;
      /** The holder's declared intent, or null when it declared none. */
      holderIntent: string | null;
      /** ISO expiry of the holder's lock; null when unknown. */
      holderExpiresAt: string | null;
    };

export interface WaitingOnProviderInput extends ProviderBase {
  read: ProviderRead<WaitingOnObligationRow[]>;
}

const WAITING_ON_COMMON_SOURCE = 'waiting-on:listActiveAwaits+readQueue';

function waitingOnCommon(input: WaitingOnProviderInput) {
  return {
    ruleId: 'waiting-on-progress',
    ruleRevision: WAITING_ON_OBLIGATION_REVISION,
    family: 'waiting-on' as const,
    scope: { workspaceId: input.workspaceId, ownerId: input.ownerId },
    responsibleOwnerId: input.ownerId,
    /**
     * `2` — the DOWNSTREAM tier, deliberately BELOW an owner directive (0) and
     * below every repair-shaped duty. This row cannot be discharged by acting on
     * it: the agent can only VERIFY the thing it waits on is progressing. Ranking
     * a memory aid above a repair would spend the sink's first row on the one
     * entry that changes nothing.
     */
    causalRank: 2,
    sourceGeneration: input.sourceGeneration,
  };
}

/** Truncate a holder intent to a row-sized excerpt; the recovery verb carries the rest. */
function waitingOnIntentExcerpt(intent: string | null): string | null {
  if (!intent) return null;
  const flat = intent.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

/**
 * What this session is WAITING ON → class-B obligation rows (P-011 of plan
 * `turn-start-memory-two-class-2026-09-21`).
 *
 * ⚠ EMPTY FOR MOST AGENTS, AND THAT IS THE DESIGN. An agent that is parked on
 * nothing pays one `not-applicable` row that renders no line at all, exactly like
 * the owner-directive provider's empty case. The cost is paid only by the
 * sessions where "waiting is work" actually needs remembering.
 *
 * ONE OBLIGATION PER WAIT, not one aggregate: a count ("2 waits outstanding") is
 * the shape an agent can acknowledge without ever checking whether EITHER of
 * them is still progressing — and the two halves have different recovery verbs
 * (`events:status` vs `locks:queue`), so a merged row could not carry both.
 *
 * The rows stay actionable (`blocked`) until the wait resolves, which is what
 * makes them re-inject every turn under the P-002 discharge contract instead of
 * clearing on delivery. That is the whole point: a wait has no local artifact —
 * no held item, no checkpoint, no diff — so it is the obligation a compaction
 * drops without leaving any trace that it existed.
 */
export function waitingOnObligations(input: WaitingOnProviderInput): AgentObligation[] {
  const common = waitingOnCommon(input);
  if (input.read.status === 'unknown') {
    return [
      defineAgentObligation({
        ...common,
        title: 'Waiting-on state is unavailable',
        episode: `unknown:${input.sourceGeneration}`,
        status: 'unknown',
        priority: 'normal',
        authority: policyAuthority(WAITING_ON_COMMON_SOURCE, WAITING_ON_OBLIGATION_REVISION),
        reason: input.read.failure.detail,
        applicableDemand: 0,
        evidence: [],
        action: { kind: 'inspect', summary: input.read.failure.retry, targetRef: 'events:status' },
        clearsWhen: {
          id: 'waiting-on-readable',
          summary: 'the await and lock-queue reads succeed again',
          evidenceKind: 'state',
          sourceRef: WAITING_ON_COMMON_SOURCE,
        },
        measurementFailure: input.read.failure,
      }),
    ];
  }
  const rows = input.read.value;
  if (rows.length === 0) {
    return [
      defineAgentObligation({
        ...common,
        title: 'This session is not waiting on anything',
        episode: `none:${input.sourceGeneration}`,
        status: 'not-applicable',
        priority: 'low',
        authority: policyAuthority(WAITING_ON_COMMON_SOURCE, WAITING_ON_OBLIGATION_REVISION),
        reason: 'no active await and no queued lock ticket for this owner',
        applicableDemand: 0,
        evidence: [
          evidence(
            `waiting-on:${input.ownerId}`,
            input.observedAt,
            input.sourceGeneration,
            'no active await, no queued lock ticket',
          ),
        ],
        clearsWhen: {
          id: 'waiting-on-empty',
          summary: 'this session parks on no event and no lock',
          evidenceKind: 'state',
          sourceRef: WAITING_ON_COMMON_SOURCE,
        },
      }),
    ];
  }
  return rows.map((row) =>
    row.kind === 'event-await'
      ? defineAgentObligation({
          ...common,
          // The key goes in the TITLE because the title is the only field that
          // renders at BOTH detail levels — `reason` is dropped at the narrow
          // `action` detail, which is exactly the turn-start sink where telling
          // two parked awaits apart matters most.
          title: `Awaiting ${row.key}${row.onTimeout === 'expire' ? ' (expires SILENTLY)' : ''}`,
          // The KEY alone is the episode: the same parked await must produce the
          // same obligation id on every turn, or a warm-turn dedup would read a
          // re-render as a brand-new obligation and the row would churn.
          episode: `await:${row.key}`,
          status: 'blocked',
          // `expire` outranks `wake`: at the deadline a `wake` row still gets a
          // turn, while an `expire` row lapses with no turn at all — nothing
          // else in this session will ever mention it again.
          priority: row.onTimeout === 'expire' ? 'high' : 'normal',
          authority: policyAuthority(`event-await:${row.key}`, WAITING_ON_OBLIGATION_REVISION),
          reason:
            `parked on ${row.key}` +
            (row.timeoutAt ? `, deadline ${row.timeoutAt}` : ', no deadline') +
            `, on_timeout=${row.onTimeout}`,
          applicableDemand: 1,
          evidence: [
            evidence(
              `event-await:${row.key}`,
              input.observedAt,
              input.sourceGeneration,
              `active await, on_timeout=${row.onTimeout}${row.timeoutAt ? `, deadline ${row.timeoutAt}` : ', no deadline'}`,
            ),
          ],
          action: {
            kind: 'inspect',
            // Waiting is work: the duty is to CONFIRM the emitter is progressing,
            // not to keep sleeping. `events:status` is the recovery verb.
            summary: 'confirm the emitter is progressing: events:status',
            tool: 'events:status',
            targetRef: 'events:status',
          },
          clearsWhen: {
            id: `await-resolved:${row.key}`,
            summary: 'the await fires, times out, or is cancelled',
            evidenceKind: 'state',
            sourceRef: `event-await:${row.key}`,
          },
          ...(row.timeoutAt ? { dueAt: row.timeoutAt } : {}),
        })
      : defineAgentObligation({
          ...common,
          title: `Queued on ${row.path} — held by ${row.holder}`,
          episode: `lock:${row.path}`,
          status: 'blocked',
          priority: 'normal',
          authority: policyAuthority(`lock-queue:${row.path}`, WAITING_ON_OBLIGATION_REVISION),
          reason:
            `queued behind ${row.holder} on ${row.path}` +
            (waitingOnIntentExcerpt(row.holderIntent) ? ` ("${waitingOnIntentExcerpt(row.holderIntent)}")` : '') +
            (row.holderExpiresAt ? `, holder expires ${row.holderExpiresAt}` : ''),
          applicableDemand: 1,
          evidence: [
            evidence(
              `lock-queue:${row.path}`,
              input.observedAt,
              input.sourceGeneration,
              `held by ${row.holder}${waitingOnIntentExcerpt(row.holderIntent) ? `: ${waitingOnIntentExcerpt(row.holderIntent)}` : ''}`,
            ),
          ],
          action: {
            kind: 'inspect',
            summary: 'holder, intent and expiry: locks:queue',
            tool: 'locks:queue',
            args: { paths: [row.path] },
            targetRef: 'locks:queue',
          },
          clearsWhen: {
            id: `lock-granted:${row.path}`,
            summary: 'the ticket is granted, or leaves the queue',
            evidenceKind: 'state',
            sourceRef: `lock-queue:${row.path}`,
          },
          ...(row.holderExpiresAt ? { dueAt: row.holderExpiresAt } : {}),
        }),
  );
}

export function buildAgentObligationAgenda(
  inputs: {
    planPlacement?: PlanPlacementProviderInput;
    goalPlanning?: GoalPlanningProviderInput;
    ownerReport?: OwnerReportProviderInput;
    independentVerification?: IndependentVerificationProviderInput[];
    ownerDirectives?: OwnerDirectivesProviderInput;
    waitingOn?: WaitingOnProviderInput;
  },
  evaluatedAt: string,
): AgentObligationAgenda {
  const obligations = [
    ...(inputs.planPlacement ? [planPlacementObligation(inputs.planPlacement)] : []),
    ...(inputs.goalPlanning ? [goalPlanningObligation(inputs.goalPlanning)] : []),
    ...(inputs.ownerReport ? [ownerReportObligation(inputs.ownerReport)] : []),
    ...(inputs.independentVerification ?? []).map(independentVerificationObligation),
    ...(inputs.ownerDirectives ? ownerDirectiveObligations(inputs.ownerDirectives) : []),
    ...(inputs.waitingOn ? waitingOnObligations(inputs.waitingOn) : []),
  ];
  return evaluateAgentObligations(obligations, evaluatedAt);
}
