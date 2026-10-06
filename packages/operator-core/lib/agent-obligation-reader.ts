/**
 * One bounded, read-only assembly path for the obligation agenda consumed by
 * turn-start orientation and fleet:leader-brief.
 *
 * Canonical policy writers stay canonical: this module only schedules their
 * reads, turns failures into explicit ProviderRead unknowns, and evaluates the
 * shared contract. It owns no queue, reminder, liveness or acceptance state.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  agentObligationSourceGeneration,
  projectAgentObligationAgenda,
  type AgentObligationAgenda,
  type AgentObligationProjection,
} from './agent-obligations';
import {
  buildAgentObligationAgenda,
  selectGoalPlacementPlan,
  type ConsultReconciliationProviderInput,
  type ConsultReconciliationRow,
  type WaitingOnObligationRow,
  type WaitingOnProviderInput,
  type IndependentVerificationProviderInput,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
  type OwnerReportProviderInput,
  type PlanPlacementProviderInput,
  type GoalPlanningProviderInput,
} from './agent-obligation-providers';
import { goalPlanningPortfolioFingerprint, parseGoalPlanningReview, type GoalPlanningReview } from './goal-planning-review';
import type { GoalPotPlacementAuthority } from './goal-launch-settings';
import { GOAL_OWNER_REPORT_MAX_SILENCE_MS, GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS } from './system-health/goal-owner-report-watchdog';
import type { GoalLaunchResolution, GoalPortfolioBrief } from './goal-launch-settings';
import type { PlanClosureGateFields } from './goals/plan-closure-observations';
import type { GoalPlanFleetObservation } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import type { GoalPlacementProgressState } from './goal-placement-progress';
import { fleetSlugFromName } from './agent-fleets-store';
import type { FleetStaffingRow } from './fleet/fleet-staffing-read';
import type { ExactPlanAdmission } from './agent-tools/plans/plan-admission-preflight';

export const AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS = 900;

/**
 * The cost bound on how many plans one turn-start read raises an acceptance
 * obligation for. It predates P-026 (it capped the declared plan context alone);
 * D-012 item 2 widened that context to the delegated goal worklist and
 * deliberately reused this bound rather than inventing a second one.
 */
export const PLAN_CONTEXT_MAX = 8;

export interface AgentObligationReaderDeps {
  goalSubject: (workspaceId: string, ownerId: string) => Promise<string | null>;
  planSlugs: (workspaceId: string, ownerId: string) => Promise<string[]>;
  goalPortfolio: (workspaceId: string, goalId: string) => Promise<GoalPortfolioBrief | null>;
  goalPlacementProgress: (workspaceId: string, ownerId: string, goalId: string, planRefs: string[]) =>
    Promise<Record<string, GoalPlacementProgressState | null>>;
  goalPlanning: (workspaceId: string, ownerId: string, goalId: string) => Promise<{
    review: GoalPlanningReview | null;
    authorities: Record<string, GoalPotPlacementAuthority>;
  }>;
  goalLaunch: (input: {
    workspaceId: string;
    ownerId: string;
    fleetSlug: string | null;
    count: number;
  }) => Promise<GoalLaunchResolution>;
  planAdmission: (input: {
    workspaceId: string;
    ownerId: string;
    harnessSlug: string;
    planSlug: string;
    fleetSlug: string;
    requestedSeats: number;
  }) => Promise<ExactPlanAdmission>;
  planFleet: (workspaceId: string, goalId: string) => Promise<GoalPlanFleetObservation>;
  ownerReport: (
    workspaceId: string,
    ownerId: string,
    goalId: string,
    nowMs: number,
  ) => Promise<GoalOwnerReportObligation | null>;
  /**
   * The plan's PERSISTED canonical acceptance-gate verdict (D-039, WI-10004673). Never
   * runs the gate: inline, it cost 1.0–1.8s of main-thread CPU per agenda read and
   * lagged bg-host's event loop past every 900ms budget here. A stale or absent
   * observation rejects — an `unknown` read — and starts the single-flight background
   * re-evaluation that refreshes it.
   */
  planAcceptance: (workspaceId: string, planSlug: string) => Promise<PlanClosureGateFields>;
  /**
   * Undispositioned owner directives (`pending` + `open`) for this workspace.
   *
   * Unlike every other source here this is NOT gated on an active goal: an
   * owner directive binds a session whether or not it holds a goal, and gating
   * it would reproduce the measured hole this plan exists to close — a class
   * that is read, populated, and then never reaches an agent that has no goal.
   */
  ownerDirectives: (workspaceId: string, ownerId: string) => Promise<OwnerDirectiveObligationRow[]>;
  /**
   * What this session is parked on: active awaits + queued lock tickets (P-011).
   *
   * REQUIRED, deliberately, and for the reason recorded against
   * `OrientationDeps.openChecks` (EI-23953846527835643): an OPTIONAL dep is
   * exactly what lets a class land declared, registered and probe-covered while
   * production populates NOTHING, because the family-coverage guard supplies the
   * obligations itself and so proves the RENDER path while staying structurally
   * blind to a missing RESOLVER. Required means a reader-less landing fails to
   * typecheck instead of rendering silence forever.
   *
   * Like `ownerDirectives` and unlike every goal-scoped source here, this is NOT
   * gated on an active goal: a session parks on an event whether or not it holds
   * one, and gating it would reproduce the same measured hole.
   */
  waitingOn: (workspaceId: string, ownerId: string) => Promise<WaitingOnObligationRow[]>;
  /**
   * Consults this session opened under `latency_contract:'proceed'` and has not
   * reconciled (EI-23764501791910357). A `proceed` consult lets the requester act
   * on an ASSUMPTION; this is the read that makes "reconcile it when the reply
   * lands" an obligation with a terminal state instead of an honour-system line.
   *
   * REQUIRED for the same reason as `waitingOn`: an optional dep lets the family land
   * declared and probe-covered while production populates nothing. NOT gated on an
   * active goal — any session can open a `proceed` consult.
   */
  consultReconciliations: (workspaceId: string, ownerId: string) => Promise<ConsultReconciliationRow[]>;
  /**
   * P-005 / D-030 step 6: staffing of every active fleet this owner leads. REQUIRED
   * for the same reason as `waitingOn`. Not gated on an active goal: any session can
   * lead a fleet. An empty array means the owner leads no active fleet.
   */
  fleetStaffing: (workspaceId: string, ownerId: string) => Promise<FleetStaffingRow[]>;
}

interface ReadOutcome<T> {
  value: T;
  degraded: boolean;
  reason?: string;
  elapsedMs: number;
}

async function boundedRead<T>(
  label: string,
  work: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<ReadOutcome<T>> {
  const result = await withBoundedTimeout(work, {
    fallback,
    timeoutMs,
    label: `agent-obligations:${label}`,
  });
  return {
    value: result.value,
    degraded: result.degraded,
    ...(result.degraded ? { reason: result.errorMessage ?? result.reason ?? 'unavailable' } : {}),
    elapsedMs: result.elapsedMs,
  };
}

function stablePortfolio(portfolio: GoalPortfolioBrief | null): unknown {
  if (!portfolio) return null;
  // Reporting has its own obligation provider. Its derived draft embeds the
  // portfolio read time, so hashing it would make unchanged placement demand
  // appear new on every read and defeat warm-context delivery deduplication.
  const { assembledAt: _observationClock, reporting: _reporting, ...stable } = portfolio;
  return stable;
}

function stableLaunch(launch: GoalLaunchResolution | null): unknown {
  if (!launch) return null;
  return {
    goalId: launch.goalId,
    settings: launch.settings,
    effective: launch.effective,
    ceilings: launch.ceilings,
    headcount: launch.headcount,
    budget: launch.budget,
    refusal: launch.refusal,
    degraded: launch.degraded,
    degradedReasons: launch.degradedReasons,
  };
}

function readFailure(label: string, outcome: ReadOutcome<unknown>): string {
  return `${label} ${outcome.reason ?? 'was unavailable'} after ${outcome.elapsedMs}ms`;
}

export interface AgentObligationAgendaRead {
  agenda: AgentObligationAgenda;
  goalId: string | null;
  planSlugs: string[];
  /** The canonical portfolio read that fed the plan-placement provider.
   *  Exposed so another read-side consumer can present the SAME snapshot
   *  without issuing a second portfolio query or rebuilding it client-side. */
  portfolio: GoalPortfolioBrief | null;
  /** The exact-plan admissions the plan-placement provider selected against, from the same
   *  snapshot as `portfolio`; null when that placement read was unknown. */
  placementAdmissions: Readonly<Record<string, ExactPlanAdmission | null>> | null;
  observedAt: string;
  elapsedMs: number;
  degradedSources: string[];
}

/**
 * Read the active definition once, then run every applicable policy source in
 * one concurrent wave. Observation clocks never enter source generations, so
 * an unchanged agenda stays deduplicable across warm turns and reappears on a
 * cold context epoch through the consumer's existing cursor boundary.
 */
export async function readAgentObligationAgenda(input: {
  workspaceId: string;
  ownerId: string;
  goalId?: string | null;
  planSlugs?: string[];
  fleetSlug?: string | null;
  launchCount?: number;
  sourceTimeoutMs?: number;
  now?: Date;
  deps?: Partial<AgentObligationReaderDeps>;
}): Promise<AgentObligationAgendaRead> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const sourceTimeoutMs = Math.max(
    1,
    Math.min(
      AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS,
      input.sourceTimeoutMs ?? AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS,
    ),
  );
  const deps = { ...defaultAgentObligationReaderDeps(), ...(input.deps ?? {}) };
  const [goalOutcome, plansOutcome] = await Promise.all([
    input.goalId !== undefined
      ? Promise.resolve<ReadOutcome<string | null>>({ value: input.goalId, degraded: false, elapsedMs: 0 })
      : boundedRead('goal-subject', deps.goalSubject(input.workspaceId, input.ownerId), null, sourceTimeoutMs),
    input.planSlugs !== undefined
      ? Promise.resolve<ReadOutcome<string[]>>({ value: input.planSlugs, degraded: false, elapsedMs: 0 })
      : boundedRead('plan-context', deps.planSlugs(input.workspaceId, input.ownerId), [], sourceTimeoutMs),
  ]);
  const goalId = goalOutcome.value;
  const ownPlanSlugs = [...new Set(plansOutcome.value.map((slug) => slug.trim()).filter(Boolean))]
    .slice(0, PLAN_CONTEXT_MAX);
  const degradedSources = [
    ...(goalOutcome.degraded ? [readFailure('goal subject', goalOutcome)] : []),
    ...(plansOutcome.degraded ? [readFailure('plan context', plansOutcome)] : []),
  ];

  const portfolioPromise = goalId
    ? boundedRead('goal-portfolio', deps.goalPortfolio(input.workspaceId, goalId), null, sourceTimeoutMs)
    : Promise.resolve<ReadOutcome<GoalPortfolioBrief | null>>({ value: null, degraded: false, elapsedMs: 0 });
  const requestedSeats = Math.max(1, Math.floor(input.launchCount ?? 1));
  const admissionPromise = portfolioPromise.then(async (portfolio) => {
    const candidates = (portfolio.value?.worklist ?? []).filter((plan) =>
      plan.placement.state === 'unplaced' && plan.placement.reconciliation.toolCall !== null,
    ).slice(0, PLAN_CONTEXT_MAX);
    const measured = await Promise.all(candidates.map(async (plan) => {
      const call = plan.placement.reconciliation.toolCall!;
      const result = await boundedRead(
        `exact-plan-admission:${plan.slug}`,
        deps.planAdmission({
          workspaceId: input.workspaceId, ownerId: input.ownerId,
          harnessSlug: call.args.harness, planSlug: call.args.plan,
          fleetSlug: fleetSlugFromName(call.args.name), requestedSeats,
        }),
        null as ExactPlanAdmission | null,
        sourceTimeoutMs,
      );
      return [plan.ref, result] as const;
    }));
    return {
      value: Object.fromEntries(measured.map(([ref, result]) => [ref, result.value])) as Record<string, ExactPlanAdmission | null>,
      degraded: measured.some(([, result]) => result.degraded),
      failures: measured.filter(([, result]) => result.degraded).map(([ref, result]) => `${ref}: ${readFailure('exact-plan admission', result)}`),
    };
  });
  // The launch resolver's fleet ceiling is scoped to a fleet. Wait for the
  // canonical portfolio to choose the action before measuring that ceiling;
  // a null fleet can silently turn a real fleet refusal into apparent headroom.
  const launchPromise = Promise.all([portfolioPromise, admissionPromise]).then(([portfolio, admissions]) => {
    const selected = portfolio.value ? selectGoalPlacementPlan(portfolio.value, admissions.value) : undefined;
    const call = selected?.placement.reconciliation.toolCall;
    if (!goalId || !call || (selected?.placement.state === 'unplaced' && !admissions.value[selected.ref]?.ready)) {
      return { value: null, degraded: false, elapsedMs: 0 } as ReadOutcome<GoalLaunchResolution | null>;
    }
    return boundedRead(
      'goal-launch',
      deps.goalLaunch({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        fleetSlug: input.fleetSlug ?? fleetSlugFromName(call.args.name),
        count: requestedSeats,
      }),
      null as GoalLaunchResolution | null,
      sourceTimeoutMs,
    );
  });
  const planningPromise = goalId
    ? boundedRead('goal-planning', deps.goalPlanning(input.workspaceId, input.ownerId, goalId),
        { review: null, authorities: {} }, sourceTimeoutMs)
    : Promise.resolve({ value: { review: null, authorities: {} }, degraded: false, elapsedMs: 0 });
  const fleetPromise = goalId
    ? boundedRead(
        'plan-fleet',
        deps.planFleet(input.workspaceId, goalId),
        {
          status: 'unknown',
          alert: null,
          applicablePlanCount: null,
        } as GoalPlanFleetObservation,
        sourceTimeoutMs,
      )
    : Promise.resolve<ReadOutcome<GoalPlanFleetObservation>>({
        value: { status: 'known', alert: null, applicablePlanCount: 0 },
        degraded: false,
        elapsedMs: 0,
      });
  const reportPromise = goalId
    ? boundedRead(
        'owner-report',
        deps.ownerReport(input.workspaceId, input.ownerId, goalId, now.getTime()),
        null,
        sourceTimeoutMs,
      )
    : Promise.resolve<ReadOutcome<GoalOwnerReportObligation | null>>({ value: null, degraded: false, elapsedMs: 0 });
  const readAcceptance = (planSlug: string) =>
    boundedRead(
      'plan-acceptance:' + planSlug,
      deps.planAcceptance(input.workspaceId, planSlug),
      null as PlanClosureGateFields | null,
      sourceTimeoutMs,
    );
  const ownAcceptancePromises = ownPlanSlugs.map(readAcceptance);
  // P-026 / D-012 item 2: the acceptance obligation covers the DELEGATED
  // worklist, not only the plan this agent declared itself on. A GOAL holder
  // that delegates plan X never declares itself on X — the fleet leader does —
  // so closure for X was previously unobservable to the holder entirely.
  //
  // The worklist slugs are knowable only AFTER the portfolio resolves, so this
  // CHAINS off `portfolioPromise` instead of awaiting it: every other read in
  // this wave still starts immediately and runs concurrently, and the one new
  // dependency edge (portfolio -> its own plans' acceptance) is intrinsic.
  const worklistAcceptancePromise = portfolioPromise.then(async (portfolioOutcome) => {
    const empty = { planSlugs: [] as string[], acceptances: [] as ReadOutcome<PlanClosureGateFields | null>[] };
    const budget = PLAN_CONTEXT_MAX - ownPlanSlugs.length;
    if (budget <= 0) return empty;
    const seen = new Set(ownPlanSlugs);
    const candidates = (portfolioOutcome.value?.worklist ?? []).filter((entry) => {
      const slug = entry.slug?.trim();
      if (!slug || seen.has(slug)) return false;
      seen.add(slug);
      // `closure: null` means the question does not arise yet (the plan is not
      // administratively complete). Per D-012 that is NEVER a reading of
      // "closed", so such a plan stays in scope.
      return entry.placement.closure?.state !== 'closed';
    });
    if (candidates.length === 0) return empty;
    // `PLAN_CONTEXT_MAX` is the pre-existing cost bound, not a new cap — but it
    // decides WHICH plans keep an obligation, so order under it is load-bearing.
    // A plan with a RESOLVED, non-closed closure is exactly P-026's population
    // (administratively complete, evidence outstanding), so it takes the budget
    // first; plans still in flight follow in worklist order.
    const slugs = [
      ...candidates.filter((entry) => entry.placement.closure !== null),
      ...candidates.filter((entry) => entry.placement.closure === null),
    ]
      .slice(0, budget)
      .map((entry) => entry.slug.trim());
    return { planSlugs: slugs, acceptances: await Promise.all(slugs.map(readAcceptance)) };
  });
  // Deliberately NOT gated on goalId: see AgentObligationReaderDeps.ownerDirectives.
  const directivesPromise = boundedRead(
    'owner-directives',
    deps.ownerDirectives(input.workspaceId, input.ownerId),
    [] as OwnerDirectiveObligationRow[],
    sourceTimeoutMs,
  );
  // Deliberately NOT gated on goalId, for the same reason as owner directives:
  // see AgentObligationReaderDeps.waitingOn.
  const waitingOnPromise = boundedRead(
    'waiting-on',
    deps.waitingOn(input.workspaceId, input.ownerId),
    [] as WaitingOnObligationRow[],
    sourceTimeoutMs,
  );
  // Not gated on goalId either: see AgentObligationReaderDeps.consultReconciliations.
  const consultsPromise = boundedRead(
    'consult-reconciliation',
    deps.consultReconciliations(input.workspaceId, input.ownerId),
    [] as ConsultReconciliationRow[],
    sourceTimeoutMs,
  );
  // Not gated on goalId either: see AgentObligationReaderDeps.fleetStaffing.
  const fleetStaffingPromise = boundedRead(
    'fleet-staffing',
    deps.fleetStaffing(input.workspaceId, input.ownerId),
    [] as FleetStaffingRow[],
    sourceTimeoutMs,
  );
  const [portfolio, admission, launch, fleet, report, ownAcceptances, worklistAcceptance, directives, waits, planning, consults, staffing] =
    await Promise.all([
      portfolioPromise,
      admissionPromise,
      launchPromise,
      fleetPromise,
      reportPromise,
      Promise.all(ownAcceptancePromises),
      worklistAcceptancePromise,
      directivesPromise,
      waitingOnPromise,
      planningPromise,
      consultsPromise,
      fleetStaffingPromise,
    ]);
  const planSlugs = [...ownPlanSlugs, ...worklistAcceptance.planSlugs];
  const acceptances = [...ownAcceptances, ...worklistAcceptance.acceptances];
  degradedSources.push(...admission.failures);
  if (directives.degraded) degradedSources.push(readFailure('owner directives', directives));
  if (waits.degraded) degradedSources.push(readFailure('waiting-on', waits));
  if (consults.degraded) degradedSources.push(readFailure('consult reconciliation', consults));
  if (staffing.degraded) degradedSources.push(readFailure('fleet staffing', staffing));
  const consultReconciliation: ConsultReconciliationProviderInput = {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    observedAt,
    // Row facts only — no observation clock — so an unchanged set of consults keeps an
    // unchanged generation across warm turns (the turn-start cursor's dedup depends on it).
    sourceGeneration: agentObligationSourceGeneration({
      consults: consults.degraded
        ? 'unknown'
        : consults.value.map((row) => [row.consultId, row.phase, row.settledAt, row.expiresAt]),
    }),
    read: consults.degraded
      ? {
          status: 'unknown',
          failure: {
            code: 'canonical-consult-reconciliation-read-failed',
            detail: readFailure('consult reconciliation', consults),
            retry: 'retry the consult_state read for this requester (latency_contract=proceed, no outcome.reconciliation)',
          },
        }
      : { status: 'known', value: consults.value },
  };
  const waitingOn: WaitingOnProviderInput = {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    observedAt,
    // Row facts only — no observation clock. An unchanged set of waits keeps an
    // unchanged generation across warm turns; a clock here would churn the
    // obligation on every read and defeat the turn-start cursor's dedup.
    sourceGeneration: agentObligationSourceGeneration({
      waits: waits.degraded
        ? 'unknown'
        : waits.value.map((row) =>
            row.kind === 'event-await'
              ? [row.kind, row.key, row.timeoutAt, row.onTimeout]
              : [row.kind, row.path, row.holder, row.holderIntent, row.holderExpiresAt],
          ),
    }),
    read: waits.degraded
      ? {
          status: 'unknown',
          failure: {
            code: 'canonical-waiting-on-read-failed',
            detail: readFailure('waiting-on', waits),
            retry: 'retry listActiveAwaits and readQueue for this owner',
          },
        }
      : { status: 'known', value: waits.value },
  };
  const ownerDirectives: OwnerDirectivesProviderInput = {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    observedAt,
    // Row facts only. `recordedAt` is the row's own created_at and `displayText`
    // its D-004 display text, so an unchanged queue keeps an unchanged generation
    // across warm turns; an observation clock here would churn every read.
    // `inheritedFromEnded` changes the row's title, so it is part of the row.
    sourceGeneration: agentObligationSourceGeneration({
      directives: directives.degraded
        ? 'unknown'
        : directives.value.map((row) => [
            row.id,
            row.state,
            row.recordedAt,
            row.displayText,
            row.capturedByHook,
            row.inheritedFromEnded === true,
          ]),
    }),
    read: directives.degraded
      ? {
          status: 'unknown',
          failure: {
            code: 'canonical-owner-directive-read-failed',
            detail: readFailure('owner directives', directives),
            retry: 'retry listOwnerDirectives for the open state',
          },
        }
      : { status: 'known', value: directives.value },
  };

  for (const [label, outcome] of [
    ['goal portfolio', portfolio],
    ['goal launch', launch],
    ['plan fleet', fleet],
    ['owner report', report],
    ['goal planning', planning],
  ] as const) {
    if (goalId && outcome.degraded) degradedSources.push(readFailure(label, outcome));
  }

  let planPlacement: PlanPlacementProviderInput | undefined;
  let goalPlanning: GoalPlanningProviderInput | undefined;
  let ownerReport: OwnerReportProviderInput | undefined;
  const scopeReadFailure = goalOutcome.degraded || plansOutcome.degraded;
  if (scopeReadFailure && !goalId) {
    const scopeGeneration = agentObligationSourceGeneration({
      ownerId: input.ownerId,
      goalSubject: goalOutcome.degraded ? 'unknown' : goalId,
      planContext: plansOutcome.degraded ? 'unknown' : planSlugs,
    });
    const detail =
      degradedSources.filter((entry) => /goal subject|plan context/.test(entry)).join('; ') ||
      'the canonical goal/plan scope was unavailable';
    planPlacement = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId: `unresolved-owner-scope:${input.ownerId}`,
      observedAt,
      sourceGeneration: scopeGeneration,
      read: {
        status: 'unknown',
        failure: {
          code: 'canonical-obligation-scope-read-failed',
          detail,
          retry: 'retry canonical goal-subject and plan-context discovery for this owner',
        },
      },
    };
  }
  if (goalId) {
    const planningStopped = portfolio.value?.goal.id === goalId &&
      ['paused', 'achieved', 'killed'].includes(portfolio.value.goal.status ?? '');
    const planningFailure = goalOutcome.degraded || portfolio.degraded || (planning.degraded && !planningStopped);
    goalPlanning = {
      workspaceId: input.workspaceId, ownerId: input.ownerId, goalId, observedAt,
      sourceGeneration: agentObligationSourceGeneration({
        portfolio: portfolio.value ? goalPlanningPortfolioFingerprint(portfolio.value) : null,
        planning: planning.degraded ? 'unknown' : planning.value,
      }),
      read: planningFailure ? { status: 'unknown', failure: {
        code: 'canonical-goal-planning-read-failed',
        detail: degradedSources.filter((entry) => /goal subject|goal portfolio|goal planning/.test(entry)).join('; ') || 'Goal planning sources unavailable.',
        retry: 'Refresh the canonical goal scope, portfolio and scoped review ledger.',
      } } : { status: 'known', value: {
        portfolio: portfolio.value, ...planning.value,
        reviewIntervalMs: portfolio.value?.goal.standing ? GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS : GOAL_OWNER_REPORT_MAX_SILENCE_MS,
      } },
    };
    const placementGeneration = agentObligationSourceGeneration({
      portfolio: stablePortfolio(portfolio.value),
      admission: Object.fromEntries(Object.entries(admission.value).map(([ref, verdict]) =>
        [ref, verdict ? { ready: verdict.ready, status: verdict.status, reason: verdict.reason,
          message: verdict.message, requestedSeats: verdict.requestedSeats,
          executableWidth: verdict.executableWidth } : 'unknown'])),
      launch: stableLaunch(launch.value),
      fleet: fleet.value,
    });
    const placementFailure =
      scopeReadFailure || portfolio.degraded || launch.degraded || fleet.degraded || fleet.value.status === 'unknown';
    const progress = placementFailure ? null : await boundedRead('goal-placement-progress',
      deps.goalPlacementProgress(input.workspaceId, input.ownerId, goalId,
        (portfolio.value?.worklist ?? []).map((plan) => plan.ref)), {}, sourceTimeoutMs);
    if (progress?.degraded) degradedSources.push(readFailure('goal placement progress', progress));
    planPlacement = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId,
      observedAt,
      sourceGeneration: placementGeneration,
      read: placementFailure
        ? {
            status: 'unknown',
            failure: {
              code: 'canonical-plan-placement-read-failed',
              detail:
                degradedSources.filter((entry) => /goal subject|plan context|goal portfolio|goal launch|plan fleet/.test(entry)).join('; ') ||
                'the canonical plan-fleet observation was unreadable',
              retry: 'refresh the portfolio, plan-fleet cohort, and exact launch resolution together',
            },
          }
        : {
            status: 'known',
            value: {
              portfolio: portfolio.value,
              admissions: admission.value,
              launch: launch.value,
              alert: fleet.value.alert,
              evidenceRef: `goal-plan-fleet-cohort:${goalId}:${placementGeneration}`,
              progress: progress?.degraded ? undefined : progress?.value,
            },
          },
    };

    // A report read and a goal read may straddle a stop transition. The
    // canonical lifecycle governs whether a recurring reporting duty applies;
    // an older due receipt must not reactivate that duty after the stop.
    const scopedGoal =
      !goalOutcome.degraded && !portfolio.degraded && portfolio.value?.goal.id === goalId
        ? portfolio.value.goal
        : null;
    const inactiveGoal =
      scopedGoal?.status === 'paused' || scopedGoal?.status === 'achieved' || scopedGoal?.status === 'killed';
    const lifecycleUnknown = !scopedGoal || (!inactiveGoal && scopedGoal.status !== 'active');
    const lifecycleFailure = 'canonical goal identity or lifecycle is unavailable for owner reporting';
    if (lifecycleUnknown) degradedSources.push(lifecycleFailure);
    const reportGeneration = agentObligationSourceGeneration({
      goalStatus: scopedGoal?.status ?? 'unknown',
      report: report.value
        ? {
            lastReportAt: report.value.lastReportAt,
            floorMin: report.value.floorMin,
            standing: report.value.standing,
            obligation: report.value.obligation,
          }
        : null,
    });
    ownerReport = {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId,
      observedAt,
      sourceGeneration: reportGeneration,
      read: inactiveGoal
        ? { status: 'known', value: null }
        : lifecycleUnknown
          ? {
              status: 'unknown',
              failure: {
                code: 'canonical-owner-report-lifecycle-unresolved',
                detail: lifecycleFailure,
                retry: 'refresh the exact goal portfolio before treating reporting as applicable',
              },
            }
          : report.degraded
        ? {
            status: 'unknown',
            failure: {
              code: 'canonical-owner-report-read-failed',
              detail: readFailure('owner report', report),
              retry: 'retry readGoalOwnerReportObligation on the three-source delivery union',
            },
          }
        : { status: 'known', value: report.value },
    };
  }

  const independentVerification: IndependentVerificationProviderInput[] = planSlugs.map((planSlug, index) => {
    const outcome = acceptances[index]!;
    if (outcome.degraded || !outcome.value) {
      degradedSources.push(readFailure(`plan acceptance ${planSlug}`, outcome));
      return {
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        planSlug,
        observedAt,
        sourceGeneration: agentObligationSourceGeneration({ planSlug, status: 'unknown' }),
        read: {
          status: 'unknown',
          failure: {
            code: 'canonical-plan-acceptance-read-failed',
            detail: readFailure(`plan acceptance ${planSlug}`, outcome),
            retry: `retry evaluatePlanAcceptanceGate for ${planSlug}`,
          },
        },
      };
    }
    const gate = outcome.value;
    const generation = agentObligationSourceGeneration({ planSlug, gate });
    return {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      planSlug,
      observedAt,
      sourceGeneration: generation,
      read: {
        status: 'known',
        value: {
          gate,
          evidenceRef: `plan-acceptance:${planSlug}:${generation}`,
          gradeable: gate.satisfied || gate.code !== 'plan_items_unfinished',
        },
      },
    };
  });

  // P-005 / D-030 step 6. Row facts only, no clock, for the same dedup reason as
  // waitingOn: an unchanged staffing picture keeps an unchanged generation.
  const fleetStaffing: NonNullable<Parameters<typeof buildAgentObligationAgenda>[0]['fleetStaffing']> = {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    observedAt,
    sourceGeneration: agentObligationSourceGeneration({
      fleetStaffing: staffing.degraded
        ? 'unknown'
        : staffing.value.map((row) => [
            row.fleetSlug,
            row.evaluation?.alert ?? null,
            row.evaluation?.current ?? null,
            row.evaluation?.target ?? null,
            row.evaluation?.held ?? null,
            row.evaluation?.notHeldBecause ?? null,
            row.evaluation?.topUpRule?.status ?? null,
            row.unknownReason ?? null,
          ]),
    }),
    read: staffing.degraded
      ? {
          status: 'unknown',
          failure: {
            code: 'canonical-fleet-staffing-read-failed',
            detail: readFailure('fleet-staffing', staffing),
            retry: 'retry fleet:leader-brief for each fleet you lead',
          },
        }
      : { status: 'known', value: staffing.value },
  };

  return {
    agenda: buildAgentObligationAgenda(
      {
        planPlacement,
        goalPlanning,
        ownerReport,
        independentVerification,
        ownerDirectives,
        waitingOn,
        consultReconciliation,
        fleetStaffing,
      },
      observedAt,
    ),
    goalId,
    planSlugs,
    portfolio: portfolio.value,
    placementAdmissions: planPlacement?.read.status === 'known' ? planPlacement.read.value.admissions ?? null : null,
    observedAt,
    elapsedMs: Date.now() - startedAt,
    degradedSources,
  };
}

export interface AgentObligationBrief {
  schemaVersion: AgentObligationAgenda['schemaVersion'];
  evaluatedAt: string;
  sourceGeneration: string;
  evaluations: AgentObligationAgenda['evaluations'];
  primary: AgentObligationAgenda['primary'];
  projection: AgentObligationProjection;
  detailRef: string;
}

export function projectAgentObligationBrief(input: {
  agenda: AgentObligationAgenda;
  sink: string;
  detailRef: string;
  detail?: 'full' | 'action';
  maxEntries?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}): AgentObligationBrief {
  const projection = projectAgentObligationAgenda({
    agenda: input.agenda,
    sink: input.sink,
    mode: 'truncate',
    detail: input.detail,
    maxEntries: input.maxEntries,
    maxChars: input.maxChars,
    maxEstimatedTokens: input.maxEstimatedTokens,
  });
  return {
    schemaVersion: input.agenda.schemaVersion,
    evaluatedAt: input.agenda.evaluatedAt,
    sourceGeneration: input.agenda.sourceGeneration,
    evaluations: input.agenda.evaluations,
    primary: input.agenda.primary,
    projection,
    detailRef: input.detailRef,
  };
}

/**
 * The automatic turn-start sink's exact projection contract.
 *
 * The GUI goal cockpit calls this same function: sharing only the agenda while
 * respelling these limits would let the screen claim to show “what the agent
 * sees” while delivering a different subset after the next budget change.
 */
export function projectAgentTurnStartObligationBrief(agenda: AgentObligationAgenda): AgentObligationBrief {
  return projectAgentObligationBrief({
    agenda,
    sink: 'turn-start',
    detailRef: 'coord:orient for the complete obligation agenda',
    // Real provider explanations can exceed this sink's entire 400-char slot.
    // Deliver the complete action here; the recovery reader retains every field.
    detail: 'action',
    maxEntries: 3,
    // The whole orientation remains capped at 600 chars. Keep this slice
    // strict so obligations cannot crowd out direct messages or held work.
    maxChars: 400,
    maxEstimatedTokens: 100,
  });
}

export const AGENT_GOAL_MODE_STATE_SCHEMA_VERSION = 'agent-goal-mode-state-v1' as const;

/** One read-only server projection shared by the goal agent and its GUI. */
export interface AgentGoalModeState {
  schemaVersion: typeof AGENT_GOAL_MODE_STATE_SCHEMA_VERSION;
  status: 'known' | 'degraded' | 'unknown';
  ownerId: string | null;
  observedAt: string;
  portfolio: GoalPortfolioBrief | null;
  obligations: AgentObligationBrief | null;
  degradedReasons: string[];
  unknown?: {
    code: 'no-canonical-goal-holder' | 'goal-mode-state-read-failed';
    detail: string;
    retry: string;
  };
}

/**
 * Assemble the goal cockpit's state from the same bounded canonical read and
 * exact turn-start projection the holder receives. Missing attribution and a
 * whole-read failure are explicit unknowns; a partial source failure remains a
 * degraded success with the provider-owned unknown evaluations intact.
 */
export async function readAgentGoalModeState(input: {
  workspaceId: string;
  ownerId: string | null;
  goalId: string;
  planSlugs: string[];
  now?: Date;
  sourceTimeoutMs?: number;
  deps?: Partial<AgentObligationReaderDeps>;
}): Promise<AgentGoalModeState> {
  const observedAt = (input.now ?? new Date()).toISOString();
  if (!input.ownerId) {
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: 'unknown',
      ownerId: null,
      observedAt,
      portfolio: null,
      obligations: null,
      degradedReasons: [],
      unknown: {
        code: 'no-canonical-goal-holder',
        detail: 'No canonical goal holder is attached, so an agent obligation agenda cannot be attributed.',
        retry: 'start or resume the goal, then refresh goals.detail',
      },
    };
  }

  try {
    const read = await readAgentObligationAgenda({
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      goalId: input.goalId,
      planSlugs: input.planSlugs,
      sourceTimeoutMs: input.sourceTimeoutMs,
      now: input.now,
      deps: input.deps,
    });
    const portfolioReasons = read.portfolio?.degradedReasons ?? [];
    const degradedReasons = [...new Set([
      ...read.degradedSources,
      ...portfolioReasons,
      ...(!read.portfolio ? ['canonical goal portfolio was unavailable'] : []),
    ])];
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: degradedReasons.length > 0 ? 'degraded' : 'known',
      ownerId: input.ownerId,
      observedAt: read.observedAt,
      portfolio: read.portfolio,
      obligations: projectAgentTurnStartObligationBrief(read.agenda),
      degradedReasons,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: AGENT_GOAL_MODE_STATE_SCHEMA_VERSION,
      status: 'unknown',
      ownerId: input.ownerId,
      observedAt,
      portfolio: null,
      obligations: null,
      degradedReasons: [],
      unknown: {
        code: 'goal-mode-state-read-failed',
        detail,
        retry: 'refresh goals.detail; the goal page remains read-only while this state is unknown',
      },
    };
  }
}

export function defaultAgentObligationReaderDeps(): AgentObligationReaderDeps {
  return {
    // P-005 / D-030 step 6: the brief's own headcount primitives, loaded lazily.
    fleetStaffing: async (workspaceId, ownerId) =>
      (await import('./fleet/fleet-staffing-read')).readLedFleetStaffing({ workspaceId, ownerId }),
    goalSubject: async (workspaceId, ownerId) => {
      const [{ getModes }, { goalIdFromModes }] = await Promise.all([
        import('./modes/store'),
        import('./modes/goal-session'),
      ]);
      return goalIdFromModes(await getModes(workspaceId, ownerId));
    },
    planSlugs: async (_workspaceId, ownerId) => {
      const { getSessionBrief } = await import('./session-brief');
      const brief = await getSessionBrief({ ownerId });
      return brief?.currentPlanSlug ? [brief.currentPlanSlug] : [];
    },
    goalPortfolio: async (workspaceId, goalId) => {
      const { readGoalPortfolioBrief } = await import('./goal-launch-settings');
      // Placement and planning obligations never read queue.claimable; its
      // per-id floor count alone exceeded AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS.
      return readGoalPortfolioBrief({ workspaceId, goalId, claimability: 'skip' });
    },
    goalPlacementProgress: async (workspaceId, ownerId, goalId, planRefs) =>
      (await import('./goal-placement-progress-store')).readGoalPlacementProgress({ workspaceId, ownerId, goalId, planRefs }),
    goalPlanning: async (workspaceId, ownerId, goalId) => {
      const [{ readScoutTicks }, { resolveGoalPotPlacementAuthority }] = await Promise.all([
        import('./scout/tick-ledger'), import('./goal-launch-settings'),
      ]);
      const rows = await readScoutTicks({ workspaceId, ownerId, goalId, origin: 'su-ideate', limit: 1 });
      if (!rows.length) return { review: null, authorities: {} };
      const review = parseGoalPlanningReview(rows[0]!.detail?.goalReview);
      if (!review || review.goalId !== goalId) throw new Error('Latest scoped goal review is invalid; absence is not established.');
      const harnesses = [...new Set(review.planRefs.flatMap((ref) => {
        const match = /^plan:([^/]+)\/(.+)$/.exec(ref);
        return match ? [match[1]!] : [];
      }))];
      const entries = await Promise.all(harnesses.map(async (harnessSlug) => [harnessSlug,
        await resolveGoalPotPlacementAuthority({ workspaceId, launcherGoalId: goalId, harnessSlug }),
      ] as const));
      return { review, authorities: Object.fromEntries(entries) };
    },
    goalLaunch: async ({ workspaceId, ownerId, fleetSlug, count }) => {
      const { resolveGoalLaunch } = await import('./goal-launch-settings');
      return resolveGoalLaunch({
        workspaceId,
        launcherOwnerId: ownerId,
        goalRole: 'plan-fleet-leader',
        fleetSlug,
        count,
      });
    },
    planAdmission: async ({ workspaceId, ownerId, harnessSlug, planSlug, fleetSlug, requestedSeats }) => {
      const { preflightExactPlanAdmission } = await import('./agent-tools/plans/plan-admission-preflight');
      return preflightExactPlanAdmission({
        workspaceId, actor: ownerId, harnessSlug, planSlug, fleetSlug, requestedSeats,
        // A GOAL holder's release cooldown does not apply to the different
        // independent member that will claim the fleet's exact-plan lane.
        specId: `goal-obligation-${fleetSlug}-plan`,
      });
    },
    planFleet: async (workspaceId, goalId) => {
      const [{ readGoalPlanFleetObservation }, { getOrgPg }] = await Promise.all([
        import('./system-health/goal-drain-fleet-watchdog'),
        import('@papercusp/db-org'),
      ]);
      return readGoalPlanFleetObservation(getOrgPg().sql, { workspaceId, goalId });
    },
    ownerReport: async (workspaceId, ownerId, goalId, nowMs) => {
      const [{ readGoalOwnerReportObligation }, { getOrgPg }] = await Promise.all([
        import('./system-health/goal-owner-report-watchdog'),
        import('@papercusp/db-org'),
      ]);
      return readGoalOwnerReportObligation(getOrgPg().sql, { workspaceId, ownerId, goalId }, nowMs);
    },
    planAcceptance: async (workspaceId, planSlug) => {
      // D-039: the same persisted verdict the goal portfolio's closure read serves
      // (resolveWorklistClosures). A non-fresh observation is not a verdict, so it
      // rejects with the observation's own detail rather than falling back inline.
      const { readPlanClosureObservations, refreshPlanClosureObservations } =
        await import('./goals/plan-closure-observations');
      const observation = (await readPlanClosureObservations({ workspaceId, planSlugs: [planSlug] })).get(planSlug);
      if (observation?.status === 'fresh') return observation.gate;
      if (observation?.status !== 'ambiguous') refreshPlanClosureObservations([planSlug]);
      throw new Error(observation?.detail ?? `no acceptance-gate observation was read for '${planSlug}'`);
    },
    ownerDirectives: async (workspaceId, ownerId) => {
      const [
        { listOwnerDirectives, OWNER_DIRECTIVES_RENDER_MAX_ROWS },
        { directiveDisplayText },
        { listWorkItemsByDirective, TERMINAL_WORK_ITEM_STATES },
      ] = await Promise.all([import('./owner-directives'), import('./owner-directive-display'), import('./work-items')]);
      // The `state` filter is applied in SQL, BEFORE the limit (P-005).
      // viewerOwnerId in the same SQL position: a row THIS session cleared off
      // its own agenda (P-008 / D-008) must stop being an obligation for it.
      // The fetch is the WHOLE open queue (bounded by how fast a human types,
      // D-003) because the ownership filter below runs in TS: a page limit
      // applied first would let foreign rows ahead of ours starve our own.
      const open = await listOwnerDirectives({ workspaceId, state: ['open'], viewerOwnerId: ownerId, limit: 200 });
      // P-004 / D-003: an obligation belongs only to the session the owner
      // addressed, or the one holding a live work-item on the directive. A
      // failed work-item read degrades to "addressed only" — it must never hide
      // a directive the owner addressed to this session.
      let heldByMe = new Set<number>();
      try {
        const linked = await listWorkItemsByDirective(
          workspaceId,
          open.map((row) => row.id),
        );
        heldByMe = new Set(
          linked
            .filter((item) => item.assignee === ownerId && !TERMINAL_WORK_ITEM_STATES.includes(item.state))
            .map((item) => item.directiveRef),
        );
      } catch {
        heldByMe = new Set();
      }
      // P-008 / R-7: a directive whose addressee ENDED passes to the addressee's
      // fleet leader. Fail-soft like the work-item read: a routing failure must
      // never hide the directives this session already owns.
      let inherited = new Set<number>();
      try {
        const { directivesInheritedBy } = await import('./owner-directive-routing');
        inherited = await directivesInheritedBy({ workspaceId, ownerId, open });
      } catch {
        inherited = new Set();
      }
      const rows = open
        .filter((row) => row.recordedBy === ownerId || heldByMe.has(row.id) || inherited.has(row.id))
        .slice(0, OWNER_DIRECTIVES_RENDER_MAX_ROWS);
      return rows.map((row) => ({
        id: row.id,
        state: 'open' as const,
        displayText: directiveDisplayText(row),
        recordedAt: new Date(row.createdAtMs).toISOString(),
        recordedBy: row.recordedBy,
        capturedByHook: row.capturedByHook === true,
        ...(inherited.has(row.id) && !heldByMe.has(row.id) ? { inheritedFromEnded: true } : {}),
      }));
    },
    waitingOn: async (_workspaceId, ownerId) => {
      const [{ listActiveAwaits }, { ensureBootstrap, getTxPool, readQueue }] = await Promise.all([
        import('./events/await/store'),
        import('./agent-tools/locks/su-lock-store'),
      ]);
      // Both halves are EXISTING shared primitives, never a new query:
      // `listActiveAwaits` is what events:status reads, and `readQueue` is what
      // locks:queue reads — which is also why the recovery verb on each row can
      // be handed to the agent verbatim and will show it the same rows.
      // The lock tables live in the locks package's own `papercusp_su`
      // database, so the read goes through that package's pool like every other
      // readQueue caller. The org pool has no agent_file_locks: reading it there
      // rejected this whole read, and the waiting-on section always came back empty.
      await ensureBootstrap();
      const sql = getTxPool();
      const [awaits, queue] = await Promise.all([
        listActiveAwaits(ownerId),
        // `coordinationDomain: null` reads ACROSS domains on purpose. Domain
        // scoping exists for the ENFORCEMENT path (two checkouts are two files
        // and must not serialize against each other); this is a "what is THIS
        // owner waiting on" read, where `owner` is already globally unique, so
        // scoping it to one domain would silently drop a real wait.
        readQueue(sql, { owner: ownerId, coordinationDomain: null }),
      ]);
      // `owner` filters BOTH halves of readQueue, so the owner's own read never
      // contains the lock it is queued behind. Naming that HOLDER is the whole
      // point of the lock half here (D-055 A4 — "know WHAT you are queued
      // behind, not merely THAT you are"), so each queued path gets its own read,
      // scoped to the ticket's domain and matched with the store's path-overlap
      // semantics, so a directory lock names its holder too.
      const holderOf = async (domain: string, path: string) => {
        const { active_locks } = await readQueue(sql, { coordinationDomain: domain, paths: [path] });
        return active_locks.find((lock) => lock.owner !== ownerId) ?? null;
      };
      const awaitRows: WaitingOnObligationRow[] = awaits.map((row) => ({
        kind: 'event-await' as const,
        key: row.eventKey,
        timeoutAt: row.expiresTs ? new Date(row.expiresTs).toISOString() : null,
        // A row whose behavior is not an explicit wake LAPSES with no turn.
        // Default to the dangerous reading rather than the reassuring one:
        // mislabelling an `expire` row as `wake` promises a wake that never comes.
        onTimeout: row.timeoutBehavior === 'wake' ? ('wake' as const) : ('expire' as const),
      }));
      const lockRows: WaitingOnObligationRow[] = await Promise.all(queue.waiting
        .filter((ticket) => ticket.status === 'waiting' && ticket.owner === ownerId)
        .flatMap((ticket) =>
          ticket.paths.map(async (path) => {
            const holder = await holderOf(ticket.coordination_domain, path);
            return {
              kind: 'lock-queue' as const,
              path,
              // An unresolvable holder is reported as UNKNOWN, never omitted: the
              // ticket is queued either way, and dropping the row because one
              // field could not be resolved would hide the wait itself.
              holder: holder?.owner ?? 'unknown holder',
              holderIntent: holder?.intent ?? null,
              holderExpiresAt: holder?.expires_ts
                ? new Date(holder.expires_ts).toISOString()
                : ticket.holder_expires_ts
                  ? new Date(ticket.holder_expires_ts).toISOString()
                  : null,
            };
          }),
        ));
      return [...awaitRows, ...lockRows];
    },
    consultReconciliations: async (workspaceId, ownerId) => {
      const [{ getOrgPg }, { GRADING_CASCADE_FLAVOR }] = await Promise.all([
        import('@papercusp/db-org'),
        import('./consult/grading-cascade'),
      ]);
      // The reconciliation marker lives in `consult_state.outcome` (jsonb), so there is
      // no new table: a consult with no `outcome.reconciliation` IS the debt.
      //  · Grading-cascade consults are excluded — they are a REQUEST to be graded, whose
      //    verdict flows through scorecards and the plan-shipping gate, not an assumption
      //    the requester built work on (the sweep alone opens ~80/week).
      //  · The window is the escape hatch for a debt nobody will ever settle: past it the
      //    row stops being an agenda obligation, but stays unreconciled in the table.
      //  · Answered first, then newest, capped — the agenda must stay a short list.
      const rows = (await getOrgPg().sql`
        SELECT conversation_id, state, question, origin_task_ref, expires_at,
               COALESCE(closed_at, updated_at) AS settled_at
          FROM harness_shared.consult_state
         WHERE workspace_id = ${workspaceId}
           AND requester_id = ${ownerId}
           AND latency_contract = 'proceed'
           AND (outcome -> 'reconciliation') IS NULL
           AND COALESCE(routing -> 'cascade' ->> 'flavor', '') <> ${GRADING_CASCADE_FLAVOR}
           AND COALESCE(closed_at, updated_at) > now() - make_interval(hours => ${CONSULT_RECONCILIATION_WINDOW_HOURS}::int)
         ORDER BY (state IN ('closed_answered', 'graduated')) DESC, COALESCE(closed_at, updated_at) DESC
         LIMIT ${CONSULT_RECONCILIATION_MAX_ROWS}
      `) as unknown as Array<{
        conversation_id: string;
        state: string;
        question: string | null;
        origin_task_ref: string | null;
        expires_at: Date | string | null;
        settled_at: Date | string | null;
      }>;
      const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
      return rows.map((row) => {
        const phase = consultReconciliationPhase(row.state);
        return {
          consultId: row.conversation_id,
          phase,
          assumption: row.question,
          originTaskRef: row.origin_task_ref,
          settledAt: phase === 'pending' ? null : iso(row.settled_at),
          expiresAt: iso(row.expires_at),
        };
      });
    },
  };
}

/** A `proceed` consult's debt is only collectable once, so the window bounds the agenda, not the debt. */
export const CONSULT_RECONCILIATION_WINDOW_HOURS = 72;
/** Same order of magnitude as the other per-agenda row caps; the recovery verb lists the rest. */
export const CONSULT_RECONCILIATION_MAX_ROWS = 6;

/**
 * `consult_state.state` → what the originator owes. Exported so the mapping is pinned by a
 * test: an unmapped NEW state must read as `unanswered` (the conservative reading — silence
 * is not confirmation), never as `answered`.
 */
export function consultReconciliationPhase(state: string): ConsultReconciliationRow['phase'] {
  if (state === 'routing' || state === 'awaiting_responder' || state === 'active') return 'pending';
  if (state === 'closed_answered' || state === 'graduated') return 'answered';
  return 'unanswered';
}
