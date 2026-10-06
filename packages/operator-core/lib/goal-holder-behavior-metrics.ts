/**
 * Goal-holder behavior metrics and ratings for one exact observation window.
 *
 * Plan goal-holder-plans-ideation-truthful-reports-2026-10-03: P-001 (measure) and
 * P-013 (the WOE rubric must fail on the failures witnessed 2026-10-01..03). Before this
 * module, a WOE grader rated plan authorship, ideation, report truthfulness, loop
 * liveness and nudge efficacy from impression, and the 00:53Z-02:13Z card for holder
 * su-9e72a11f left 11 criteria unknown while the holder wrote 0 plans over 31 unplanned
 * goal items, reported COST as "not measured per goal", and had 2 of 5 loop fires
 * suppressed. Every number here comes from a canonical ledger, so the scorecard
 * instrument seam (scorecards.ts resolveScorecardInstrumentSnapshots) can refuse a
 * rating the measurement contradicts.
 *
 * The holder is the scorecard subject (the agent_modes goal-lease holder). Never read
 * goals.metadata.agentOwnerId for it: that field named su-6aab097a while su-9e72a11f
 * held lease epoch 18.
 *
 * SQL is injected (`deps.sql`) so this module does not import @papercusp/db-org itself;
 * the parsing and rating halves are pure and unit-tested.
 */
import type { Sql } from 'postgres';
import {
  costCitesMeasuredSpend,
  costLineIsUnmeasured,
  GOAL_OWNER_REPORT_FIELD,
  goalSpendFromGoalRow,
  walledEntries,
  type GoalOwnerReportTruthSummary,
  type GoalReportMeasuredSpend,
} from './goal-owner-report';

// The classifiers live with the report contract (the send gate refuses on the same
// definitions, P-005); re-exported so existing importers keep one source.
export { costLineIsUnmeasured, walledEntries };
import {
  GOAL_DAY_MIN_CANDIDATES,
  GOAL_REVIEW_CLUSTER_MIN_ITEMS,
  GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS,
} from './goal-planning-review';
import { readGoalHolderRows } from './goals/holder';

/** v2 (WI-10006542): ownerReports COST is judged against measured goal spend, never by wording. */
export const GOAL_HOLDER_METRICS_VERSION = 2 as const;

/**
 * Source tag of the authoritative goal spend rollup. Literal here because this module never
 * imports @papercusp/db-org (SQL is injected); pinned equal to GOAL_SPEND_SNAPSHOT_SOURCE by
 * goal-holder-behavior-metrics.test.ts.
 */
export const GOAL_SPEND_ROLLUP_SOURCE = 'goal-lineage-rollup' as const;
/** Ideation is judged per goal-day: the 24h ending at the window end. */
export const GOAL_DAY_MS = 86_400_000;
/** More than this many suppressed loop fires per hour of lease fails liveness. */
export const LOOP_SUPPRESSION_MAX_PER_HOUR = 1;
/** Share of settled timed reminders that must have fired or been discharged. */
export const NUDGE_EFFECTIVE_SHARE_MIN = 0.5;

export const HOLDER_BEHAVIOR_CRITERIA = [
  'holder-plan-authorship',
  'ideation-yield',
  'owner-report-truthfulness',
  'stewardship-loop-liveness',
  'nudge-efficacy',
] as const;
export type HolderBehaviorCriterion = (typeof HOLDER_BEHAVIOR_CRITERIA)[number];

/** Instrument key each WOE criterion binds (criterion.instrumentKey). */
export const HOLDER_BEHAVIOR_INSTRUMENT_KEYS: Readonly<Record<HolderBehaviorCriterion, string>> = Object.freeze({
  'holder-plan-authorship': 'woe.holder-plan-authorship',
  'ideation-yield': 'woe.ideation-yield',
  'owner-report-truthfulness': 'woe.owner-report-truthfulness',
  'stewardship-loop-liveness': 'woe.stewardship-loop-liveness',
  'nudge-efficacy': 'woe.nudge-efficacy',
});

export function holderBehaviorCriterionForInstrument(key: string): HolderBehaviorCriterion | null {
  const hit = (Object.entries(HOLDER_BEHAVIOR_INSTRUMENT_KEYS) as [HolderBehaviorCriterion, string][]).find(
    ([, instrument]) => instrument === key,
  );
  return hit ? hit[0] : null;
}

export interface GoalHolderWindow {
  workspaceId: string;
  goalId: string;
  holderOwnerId: string;
  windowStart: string;
  windowEnd: string;
}

export interface GoalReviewRow {
  invokedAt: string;
  disposition: string | null;
  /** goalReview.coverage (P-009); absent on reviews filed before it existed. */
  coverage: unknown;
  ideasFiled: unknown;
  /** Open goal-stamped items with no plan at the moment of the review. */
  unplannedAtReview: number;
  /** Whether the graded holder filed this review. Ideas count for the goal whoever filed
   *  them; review quality counts only against the holder who wrote the review, so a new
   *  holder does not inherit a predecessor's reviews for the rest of the goal-day
   *  (WI-10005920). Absent means the holder's own review. */
  byHolder?: boolean;
}

export interface OwnerReportRow {
  ts: string;
  cost: string | null;
  ownerWalled: string | null;
  /**
   * The COST verdict the send-time truth gate stamped on this report (stamp.truth.cost, P-005).
   * Absent/null when the stamp carries no truth summary (older stamps, reference-form reports).
   */
  truthCost?: GoalOwnerReportTruthSummary['cost'] | null;
}

const TRUTH_COSTS: ReadonlySet<string> = new Set<GoalOwnerReportTruthSummary['cost']>([
  'cited-measured',
  'goal-spend-unmeasured',
  'unread',
]);
const isTruthCost = (value: string | null): value is GoalOwnerReportTruthSummary['cost'] =>
  value != null && TRUTH_COSTS.has(value);

/** How one delivered report's COST stands against the goal's measured spend. */
export type OwnerReportCostVerdict =
  | 'cited-measured'
  | 'goal-spend-unmeasured'
  | 'measured-spend-not-cited'
  | 'unverified';

export interface GoalHolderBehaviorMetrics {
  version: typeof GOAL_HOLDER_METRICS_VERSION;
  window: GoalHolderWindow;
  planAuthorship: {
    plansNew: number;
    plansStarted: number;
    planFleetLaunches: number;
    /** Open (at window end) goal-stamped work items with no source plan. Context only: a
     *  count of singletons is not a cluster, so it never decides the rating (WI-10005920). */
    unplannedOpenGoalItems: number;
    /** Unplanned clusters of 3+ related goal items open at window end (findUnplannedClusters,
     *  the detector the goal liveness watchdog nudges from). */
    unplannedClusters: number;
    /** Of those, clusters that existed for more than 2 reporting cycles at window end (D-002). */
    overdueUnplannedClusters: number;
    /** Clusters already overdue at window START (same detector and age rule, read as of the
     *  start). Without this, a cluster the holder dissolved mid-window left no trace and the
     *  criterion read "not exercised" (WI-10005965). */
    overdueClustersAtStart: number;
    /** Of the start-overdue clusters, those that no longer formed a cluster at window end, by
     *  fate (classifyDissolvedCluster). */
    dissolvedOverdueClusters: Record<DissolvedClusterFate, number>;
    /** Of the end-overdue clusters, those with a watchdog nudge filed at least one reporting
     *  cycle before window end. A fail over un-nudged clusters may be system-attributable
     *  (WI-10005942). */
    overdueClustersNudged: number;
  };
  ideation: {
    since: string;
    plansNew: number;
    ideasFiled: number;
    reviews: number;
    noNewPlanReviews: number;
    /** No-new-plan reviews filed while 3+ goal items had no plan. */
    noNewPlanReviewsOverUnplannedCluster: number;
    /** Reviews whose coverage map names a 3+ item need with no planRef and no justification. */
    reviewsWithUncoveredClusterNeed: number;
  };
  ownerReports: {
    reports: number;
    /** COST cited the goal's measured spend. */
    costCitedMeasured: number;
    /** The goal's spend was measured but COST did not cite it (a false or missing figure). */
    costNotMeasured: number;
    /** The platform had no measured goal spend, so an unmeasured COST was the truthful answer. */
    costGoalSpendUnmeasured: number;
    /** No send-time truth summary and no goal spend read: COST truth not established. */
    costUnverified: number;
    walledEntries: number;
    /** Walled entries that are only work-item ids: they name no owner action. */
    bareWalledEntries: number;
  };
  loop: {
    deliveredFires: number;
    suppressedFires: number;
    windowHours: number;
  };
  nudges: {
    timedReminders: number;
    fired: number;
    cancelled: number;
    cancelledWithReason: number;
    dischargedCancels: number;
    /** Untimed obligation watches (plan:/goal: keys) cancelled in the window with no reason. */
    watchChurnWithoutReason: number;
  };
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

function countIdeas(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return 0;
}

/** A coverage entry naming 3+ items with neither a covering plan nor a justification. */
export function coverageHasUncoveredClusterNeed(coverage: unknown): boolean {
  if (!Array.isArray(coverage)) return false;
  return coverage.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const items = Array.isArray(record.itemRefs) ? record.itemRefs.length : 0;
    const planRef = typeof record.planRef === 'string' && record.planRef.trim();
    const justification = typeof record.justification === 'string' && record.justification.trim();
    return items >= GOAL_REVIEW_CLUSTER_MIN_ITEMS && !planRef && !justification;
  });
}

export function summarizeGoalReviews(rows: readonly GoalReviewRow[]): Omit<
  GoalHolderBehaviorMetrics['ideation'],
  'since' | 'plansNew'
> {
  const noNewPlan = new Set<string>(GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS);
  let ideasFiled = 0;
  let noNewPlanReviews = 0;
  let noNewPlanReviewsOverUnplannedCluster = 0;
  let reviewsWithUncoveredClusterNeed = 0;
  for (const row of rows) {
    ideasFiled += countIdeas(row.ideasFiled);
    if (row.byHolder === false) continue;
    const isNoNewPlan = row.disposition !== null && noNewPlan.has(row.disposition);
    if (isNoNewPlan) {
      noNewPlanReviews += 1;
      if (row.unplannedAtReview >= GOAL_REVIEW_CLUSTER_MIN_ITEMS && !Array.isArray(row.coverage)) {
        // A legacy review without a coverage map cannot show the unplanned items are
        // covered, so "existing plans suffice" over 3+ unplanned items is unsupported.
        noNewPlanReviewsOverUnplannedCluster += 1;
      }
    }
    if (coverageHasUncoveredClusterNeed(row.coverage)) reviewsWithUncoveredClusterNeed += 1;
  }
  return {
    ideasFiled,
    reviews: rows.length,
    noNewPlanReviews,
    noNewPlanReviewsOverUnplannedCluster,
    reviewsWithUncoveredClusterNeed,
  };
}

/**
 * COST verdict for one delivered report, by the send-time truth gate's own rule
 * (checkGoalOwnerReportTruth) and never by the COST line's wording (WI-10006542: the
 * lexical `costLineIsUnmeasured` scored "unknown; coverage=no-ceiling" as measured and
 * "spend remains unknown ... unmeasured" as a failure for the same unmeasured goal spend).
 * The stamp's truth summary wins (it was measured at send time); a stamp without one is
 * judged against `spend`, the goal's spend read at grading time; no spend read leaves the
 * report unverified.
 */
export function ownerReportCostVerdict(
  row: Pick<OwnerReportRow, 'cost' | 'truthCost'>,
  spend: GoalReportMeasuredSpend | null | undefined,
): OwnerReportCostVerdict {
  if (row.truthCost === 'cited-measured' || row.truthCost === 'goal-spend-unmeasured') return row.truthCost;
  if (!spend) return 'unverified';
  if (!spend.measured || spend.spentCents == null) return 'goal-spend-unmeasured';
  return costCitesMeasuredSpend(row.cost ?? '', spend.spentCents) ? 'cited-measured' : 'measured-spend-not-cited';
}

export function summarizeOwnerReports(
  rows: readonly OwnerReportRow[],
  spend?: GoalReportMeasuredSpend | null,
): GoalHolderBehaviorMetrics['ownerReports'] {
  const cost: Record<OwnerReportCostVerdict, number> = {
    'cited-measured': 0,
    'goal-spend-unmeasured': 0,
    'measured-spend-not-cited': 0,
    unverified: 0,
  };
  let walled = 0;
  let bare = 0;
  for (const row of rows) {
    cost[ownerReportCostVerdict(row, spend)] += 1;
    for (const entry of walledEntries(row.ownerWalled)) {
      walled += 1;
      if (entry.bare) bare += 1;
    }
  }
  return {
    reports: rows.length,
    costCitedMeasured: cost['cited-measured'],
    costNotMeasured: cost['measured-spend-not-cited'],
    costGoalSpendUnmeasured: cost['goal-spend-unmeasured'],
    costUnverified: cost.unverified,
    walledEntries: walled,
    bareWalledEntries: bare,
  };
}

// ---------------------------------------------------------------------------
// Pure rating (thresholds pinned by goal-holder-behavior-metrics.test.ts)
// ---------------------------------------------------------------------------

export type HolderBehaviorVerdict = 'pass' | 'fail' | 'unknown';
export interface HolderBehaviorRating {
  verdict: HolderBehaviorVerdict;
  reason: string;
}

/**
 * What became of a cluster that was overdue at window START but no longer formed a cluster
 * at window END (WI-10005965):
 *  - `planned`: a member is now in a plan, or the cluster's nudge was closed `done`;
 *  - `dismissed-with-reason`: the cluster's nudge was closed `dropped` with a reason, or every
 *    dropped member carries a drop reason (the P-002 nudge contract: "if these items are NOT
 *    one cluster, close this item as dropped with the reason");
 *  - `dissolved-without-drop`: no member was dropped (work completed, or the items regrouped);
 *  - `dropped-without-reason`: members were dropped with no recorded reason and no reasoned
 *    nudge close — dropping the cluster away, which must not read as "not exercised".
 */
export type DissolvedClusterFate =
  | 'planned'
  | 'dismissed-with-reason'
  | 'dissolved-without-drop'
  | 'dropped-without-reason';

export const DISSOLVED_CLUSTER_FATES: readonly DissolvedClusterFate[] = [
  'planned',
  'dismissed-with-reason',
  'dissolved-without-drop',
  'dropped-without-reason',
];

export function emptyDissolvedClusterFates(): Record<DissolvedClusterFate, number> {
  return { planned: 0, 'dismissed-with-reason': 0, 'dissolved-without-drop': 0, 'dropped-without-reason': 0 };
}

const hasReason = (reason: string | null | undefined): boolean => (reason ?? '').trim().length > 0;

export function classifyDissolvedCluster(input: {
  /** Each member's state as read at grading time. */
  members: ReadonlyArray<{ status: string; planned: boolean; reason: string | null }>;
  /** Unplanned-cluster nudges covering this cluster, closed by window end. */
  nudges: ReadonlyArray<{ status: string; reason: string | null }>;
}): DissolvedClusterFate {
  if (input.members.some((m) => m.planned)) return 'planned';
  const reasoned = input.nudges.filter((n) => hasReason(n.reason));
  if (reasoned.some((n) => n.status === 'done')) return 'planned';
  if (reasoned.some((n) => n.status === 'dropped')) return 'dismissed-with-reason';
  const dropped = input.members.filter((m) => m.status === 'dropped');
  if (dropped.length === 0) return 'dissolved-without-drop';
  return dropped.every((m) => hasReason(m.reason)) ? 'dismissed-with-reason' : 'dropped-without-reason';
}

export function rateGoalHolderBehavior(
  metrics: GoalHolderBehaviorMetrics,
): Record<HolderBehaviorCriterion, HolderBehaviorRating> {
  const { planAuthorship: plans, ideation, ownerReports: reports, loop, nudges } = metrics;

  // D-002 / R-1: the trigger is an unplanned CLUSTER of 3+ related items older than 2
  // reporting cycles, never a raw count of unplanned singletons (the drain fleet's job).
  // "Written, started and staffed": a successful fleet:launch-on-plan staffs the plan and
  // its launch failsafe promotes the plan's items, so a staffed plan is a started plan.
  const planRating = ((): HolderBehaviorRating => {
    const staffed = plans.plansNew > 0 && plans.planFleetLaunches > 0;
    const did =
      `wrote ${plans.plansNew}, started ${plans.plansStarted}, staffed ${plans.planFleetLaunches} plan(s)`;
    if (plans.overdueUnplannedClusters > 0 && !staffed) {
      return {
        verdict: 'fail',
        reason:
          `${plans.overdueUnplannedClusters} unplanned cluster(s) of ${GOAL_REVIEW_CLUSTER_MIN_ITEMS}+ goal items were older ` +
          `than 2 reporting cycles and the holder ${did} in the window (a plan must be written and staffed). ` +
          `${plans.overdueClustersNudged} of them had a watchdog nudge filed at least one reporting cycle before window end` +
          (plans.overdueClustersNudged < plans.overdueUnplannedClusters
            ? '; check whether the holder could see an un-nudged cluster before attributing the miss to the holder.'
            : '.'),
      };
    }
    // WI-10005965: a cluster overdue at window start that vanished by window end is judged by
    // HOW it vanished. Dropping members with no reason is the witnessed failure in another
    // form, so it fails even when an unrelated plan was staffed.
    const fates = plans.dissolvedOverdueClusters;
    if (fates['dropped-without-reason'] > 0) {
      return {
        verdict: 'fail',
        reason:
          `${fates['dropped-without-reason']} cluster(s) overdue at window start were dissolved by dropping members ` +
          `with no recorded reason and no reasoned close of the cluster nudge (a cluster is planned, or dismissed with a reason).`,
      };
    }
    if (staffed) return { verdict: 'pass', reason: `Holder ${did}.` };
    const placed = fates.planned + fates['dismissed-with-reason'];
    if (placed > 0) {
      return {
        verdict: 'pass',
        reason:
          `Holder placed ${placed} of ${plans.overdueClustersAtStart} cluster(s) overdue at window start: ` +
          `${fates.planned} planned, ${fates['dismissed-with-reason']} dismissed with a reason; ${did}.`,
      };
    }
    if (plans.plansNew > 0) {
      return { verdict: 'unknown', reason: `Holder ${did}: written but not staffed, and no cluster was overdue.` };
    }
    return {
      verdict: 'unknown',
      reason:
        `Not exercised: ${plans.unplannedClusters} unplanned cluster(s), none older than 2 reporting cycles ` +
        `(${plans.unplannedOpenGoalItems} unplanned goal items), and no plan written.`,
    };
  })();

  const ideationRating = ((): HolderBehaviorRating => {
    const candidates = ideation.plansNew + ideation.ideasFiled;
    if (ideation.noNewPlanReviewsOverUnplannedCluster > 0 || ideation.reviewsWithUncoveredClusterNeed > 0) {
      return {
        verdict: 'fail',
        reason:
          `${ideation.noNewPlanReviewsOverUnplannedCluster} no-new-plan review(s) over 3+ unplanned goal items and ` +
          `${ideation.reviewsWithUncoveredClusterNeed} review(s) with an uncovered 3+ item need in the goal-day since ${ideation.since}.`,
      };
    }
    if (candidates >= GOAL_DAY_MIN_CANDIDATES) {
      return { verdict: 'pass', reason: `${candidates} evaluated candidate(s) (plans ${ideation.plansNew}, ideas ${ideation.ideasFiled}) in the goal-day.` };
    }
    return { verdict: 'fail', reason: `0 evaluated new candidates for the goal in the goal-day since ${ideation.since}.` };
  })();

  const reportRating = ((): HolderBehaviorRating => {
    if (reports.reports === 0) return { verdict: 'unknown', reason: 'No goal owner report in the window.' };
    if (reports.costNotMeasured > 0 || reports.bareWalledEntries > 0) {
      return {
        verdict: 'fail',
        reason:
          `${reports.costNotMeasured} of ${reports.reports} report(s) did not cite the goal's measured spend in COST; ` +
          `${reports.bareWalledEntries} of ${reports.walledEntries} walled entries named no owner action.`,
      };
    }
    if (reports.costUnverified === reports.reports) {
      return {
        verdict: 'unknown',
        reason: `COST truth unverifiable: none of ${reports.reports} report(s) carries a send-time truth summary and no goal spend was read.`,
      };
    }
    const costParts = [
      `cited the measured goal spend in ${reports.costCitedMeasured}`,
      `truthfully stated goal spend unmeasured (no measured lineage spend) in ${reports.costGoalSpendUnmeasured}`,
      ...(reports.costUnverified ? [`unverifiable in ${reports.costUnverified}`] : []),
    ];
    return {
      verdict: 'pass',
      reason:
        `${reports.reports} report(s): COST ${costParts.join(', ')}; an owner action on every walled entry ` +
        '(correction-of-false-lines is graded by hand).',
    };
  })();

  const loopRating = ((): HolderBehaviorRating => {
    const fires = loop.deliveredFires + loop.suppressedFires;
    if (fires === 0) return { verdict: 'unknown', reason: 'No loop fire in the window.' };
    const perHour = loop.windowHours > 0 ? loop.suppressedFires / loop.windowHours : loop.suppressedFires;
    if (perHour > LOOP_SUPPRESSION_MAX_PER_HOUR) {
      return {
        verdict: 'fail',
        reason: `${loop.suppressedFires} of ${fires} loop fires suppressed (${perHour.toFixed(2)}/h > ${LOOP_SUPPRESSION_MAX_PER_HOUR}/h).`,
      };
    }
    if (loop.deliveredFires === 0) return { verdict: 'fail', reason: `${fires} loop fire(s), none delivered a turn.` };
    return { verdict: 'pass', reason: `${loop.deliveredFires} delivered, ${loop.suppressedFires} suppressed loop fire(s).` };
  })();

  const nudgeRating = ((): HolderBehaviorRating => {
    const unattributed = nudges.cancelled - nudges.cancelledWithReason;
    if (nudges.timedReminders === 0 && nudges.watchChurnWithoutReason === 0) {
      return { verdict: 'unknown', reason: 'No agent-obligation reminder in the window.' };
    }
    if (unattributed > 0 || nudges.watchChurnWithoutReason > 0) {
      return {
        verdict: 'fail',
        reason:
          `${unattributed} timed reminder cancel(s) and ${nudges.watchChurnWithoutReason} obligation watch cancel(s) ` +
          'carry no cancel_reason, so delivery cannot be shown.',
      };
    }
    const settled = nudges.fired + nudges.cancelled;
    const effective = nudges.fired + nudges.dischargedCancels;
    if (settled > 0 && effective / settled < NUDGE_EFFECTIVE_SHARE_MIN) {
      return { verdict: 'fail', reason: `${effective} of ${settled} settled timed reminders fired or were discharged.` };
    }
    if (settled === 0) return { verdict: 'unknown', reason: `${nudges.timedReminders} timed reminder(s), none settled yet.` };
    return { verdict: 'pass', reason: `${effective} of ${settled} settled timed reminders fired or were discharged.` };
  })();

  return {
    'holder-plan-authorship': planRating,
    'ideation-yield': ideationRating,
    'owner-report-truthfulness': reportRating,
    'stewardship-loop-liveness': loopRating,
    'nudge-efficacy': nudgeRating,
  };
}

// ---------------------------------------------------------------------------
// Collection (SQL)
// ---------------------------------------------------------------------------

/** plans:new counts on its invocation alone: a call that cannot write the plan throws. */
const PLAN_CANDIDATE_TOOLS = ['plans:new'] as const;

/**
 * WI-10006048: a holder also writes a plan through the ideation ledger.
 * blender:route-idea { rail:'plan' } creates the draft with createScoutPlanDraft and never
 * calls plans:new, so counting plans:new alone read holder su-a70547cc, who routed an idea
 * onto the plan rail on 2026-10-03 at 08:08Z, as having written no plan.
 *
 * A route call can still settle 'ok' without writing anything (a placeholder-draft or
 * not-found refusal, or an idempotent re-route onto an existing plan), and
 * tool_invocations stores no result, so the call counts only when the plan it created
 * exists: a harness_plans row in the same workspace created inside the call's own run.
 * invoked_at is the dispatch-settle time (EI-7040), so the call ran over
 * [invoked_at - duration_ms, invoked_at]; the slack absorbs the gap between the plan
 * transaction's now() and the JS-stamped settle time.
 */
export const ROUTE_IDEA_TOOL = 'blender:route-idea';
export const ROUTED_PLAN_CLOCK_SLACK_MS = 5_000;

/** True for an invocation (alias `t`) that wrote a plan: plans:new, or a route-idea call that created one. */
function planWritingCall(sql: Sql) {
  return sql`(
    t.tool_name IN ${sql([...PLAN_CANDIDATE_TOOLS])}
    OR (t.tool_name = ${ROUTE_IDEA_TOOL}
        AND coalesce(t.args_json ->> 'rail', 'plan') = 'plan'
        AND EXISTS (
          SELECT 1
            FROM harness_shared.harness_plans p
           WHERE p.workspace_id = t.workspace_id
             AND p.created_at BETWEEN t.invoked_at - (coalesce(t.duration_ms, 0) + ${ROUTED_PLAN_CLOCK_SLACK_MS}::int) * interval '1 millisecond'
                                  AND t.invoked_at + ${ROUTED_PLAN_CLOCK_SLACK_MS}::int * interval '1 millisecond'))
  )`;
}

/**
 * The holder's own plan calls in a window: plans written (plans:new, or a route-idea call
 * that created a plan), plans started, and fleets launched on a plan.
 */
export async function readHolderPlanToolCounts(
  window: Pick<GoalHolderWindow, 'workspaceId' | 'holderOwnerId' | 'windowStart' | 'windowEnd'>,
  deps: { sql: Sql },
): Promise<{ plansNew: number; plansStarted: number; planFleetLaunches: number }> {
  const { sql } = deps;
  const rows = await sql<{ plans_new: string; plans_started: string; fleet_launches: string }[]>`
    SELECT count(*) FILTER (WHERE ${planWritingCall(sql)})::text AS plans_new,
           count(*) FILTER (WHERE t.tool_name = 'plans:start')::text AS plans_started,
           count(*) FILTER (WHERE t.tool_name = 'fleet:launch-on-plan')::text AS fleet_launches
      FROM harness_shared.tool_invocations t
     WHERE t.workspace_id = ${window.workspaceId}
       AND t.coord_owner_id = ${window.holderOwnerId}
       AND t.invoked_at BETWEEN ${new Date(window.windowStart)} AND ${new Date(window.windowEnd)}
       AND t.status = 'ok'
       AND t.tool_name IN ${sql([...PLAN_CANDIDATE_TOOLS, ROUTE_IDEA_TOOL, 'plans:start', 'fleet:launch-on-plan'])}`;
  return {
    plansNew: Number(rows[0]?.plans_new ?? 0),
    plansStarted: Number(rows[0]?.plans_started ?? 0),
    planFleetLaunches: Number(rows[0]?.fleet_launches ?? 0),
  };
}

/** Plans written for one goal (any author) over [since, at]: the goal-day plan candidates. */
async function countGoalPlansWritten(
  input: { workspaceId: string; goalId: string; since: Date; at: Date },
  sql: Sql,
): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.tool_invocations t
     WHERE t.workspace_id = ${input.workspaceId}
       AND t.goal_id = ${input.goalId}
       AND t.status = 'ok'
       AND t.tool_name IN ${sql([...PLAN_CANDIDATE_TOOLS, ROUTE_IDEA_TOOL])}
       AND t.invoked_at BETWEEN ${input.since} AND ${input.at}
       AND ${planWritingCall(sql)}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Which goal (and workspace) a holder stewarded in a window. A scorecard subject names
 * only the holder, and the holder's agent_modes row disappears once the lease moves on,
 * so the ledger of the holder's own goal-stamped calls in the window decides; the live
 * goal lease is the fallback for a window with no goal-stamped call.
 */
export async function resolveHolderGoalForWindow(
  input: { holderOwnerId: string; windowStart: string; windowEnd: string },
  deps: { sql: Sql },
): Promise<{ workspaceId: string; goalId: string } | null> {
  const { sql } = deps;
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  const fromCalls = await sql<{ workspace_id: string; goal_id: string }[]>`
    SELECT workspace_id, goal_id
      FROM harness_shared.tool_invocations
     WHERE coord_owner_id = ${input.holderOwnerId}
       AND invoked_at BETWEEN ${start} AND ${end}
       AND goal_id IS NOT NULL
     GROUP BY workspace_id, goal_id
     ORDER BY count(*) DESC
     LIMIT 1`;
  if (fromCalls[0]) return { workspaceId: fromCalls[0].workspace_id, goalId: fromCalls[0].goal_id };
  // The lease row through the canonical holder read (lint:no-raw-goal-holder-read). No
  // liveness fold: this asks which goal the owner held in a PAST window, not who holds it now.
  const fromLease = (await readGoalHolderRows(sql))
    .filter((row) => row.ownerId === input.holderOwnerId && row.setAtMs <= end.getTime())
    .sort((a, b) => b.setAtMs - a.setAtMs)[0];
  return fromLease ? { workspaceId: fromLease.workspaceId, goalId: fromLease.goalId } : null;
}

/**
 * P-004 (D-001): the goal-day candidate count for one goal at one instant: plans proposed
 * for the goal (plans:new, or a route-idea call that created a plan, stamped with its
 * goal_id, by any author) plus the ideas its reviews report filing. The same population collectGoalHolderBehaviorMetrics grades, so
 * the blender:ideate-pass-record receipt and the WOE ideation-yield verdict agree.
 * tool_invocations rows are written when a call settles, so a caller reading this from
 * inside its own call is not yet counted and must add its own ideas.
 */
export async function readGoalDayCandidates(
  input: { workspaceId: string; goalId: string; at: Date },
  deps: { sql: Sql },
): Promise<{ since: string; plansNew: number; ideasFiled: number }> {
  const { sql } = deps;
  const since = new Date(input.at.getTime() - GOAL_DAY_MS);
  const [plansNew, ideaRows] = await Promise.all([
    countGoalPlansWritten({ workspaceId: input.workspaceId, goalId: input.goalId, since, at: input.at }, sql),
    sql<{ ideas_filed: unknown }[]>`
      SELECT t.args_json -> 'ideasFiled' AS ideas_filed
        FROM harness_shared.tool_invocations t
       WHERE t.workspace_id = ${input.workspaceId}
         AND t.tool_name = 'blender:ideate-pass-record'
         AND t.status = 'ok'
         AND t.args_json -> 'goalReview' ->> 'goalId' = ${input.goalId}
         AND t.invoked_at BETWEEN ${since} AND ${input.at}`,
  ]);
  return {
    since: since.toISOString(),
    plansNew,
    ideasFiled: ideaRows.reduce((sum, row) => sum + countIdeas(row.ideas_filed), 0),
  };
}

/**
 * Unplanned clusters for the goal as of the window end, through the same detector and
 * age rule the goal liveness watchdog nudges from (D-002), so the WOE rating and the nudge
 * agree on what a cluster is. Imported lazily: the detector module opens the org pool and
 * the report-cadence constants live with the report watchdog, and this module's pure
 * half must stay importable without either.
 */
async function readWindowClusters(
  window: GoalHolderWindow,
  startMs: number,
  endMs: number,
  sql: Sql,
): Promise<{
  total: number;
  overdue: number;
  overdueAtStart: number;
  dissolved: Record<DissolvedClusterFate, number>;
  nudged: number;
}> {
  const [{ readUnplannedGoalClusters, overdueUnplannedClusters }, cadence] = await Promise.all([
    import('./goals/unplanned-clusters'),
    import('./system-health/goal-owner-report-watchdog'),
  ]);
  const scope = { workspaceId: window.workspaceId, goalId: window.goalId };
  // The as-of START read reuses the detector's historical mode, so plan membership is read as
  // of now: a cluster planned during the window is excluded from both reads (under-count,
  // never over-count), and the end-of-window staffed check is what credits it.
  const [read, startRead, goalRows] = await Promise.all([
    readUnplannedGoalClusters(sql, { ...scope, asOfMs: endMs }),
    readUnplannedGoalClusters(sql, { ...scope, asOfMs: startMs }),
    sql<{ standing: boolean | null }[]>`
      SELECT standing FROM harness_shared.goals
       WHERE workspace_id = ${window.workspaceId} AND id = ${window.goalId}`,
  ]);
  const cycleMs = goalRows[0]?.standing
    ? cadence.GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS
    : cadence.GOAL_OWNER_REPORT_MAX_SILENCE_MS;
  const overdueAtStart = overdueUnplannedClusters(startRead.clusters, startMs, cycleMs);
  // A start cluster sharing any member with an end cluster still stands; the end check
  // judges it. One sharing none was dissolved during the window.
  const stillClustered = new Set(read.clusters.flatMap((c) => c.memberIds));
  const dissolvedMembers = overdueAtStart
    .filter((c) => !c.memberIds.some((id) => stillClustered.has(id)))
    .map((c) => c.memberIds);
  const overdueAtEnd = overdueUnplannedClusters(read.clusters, endMs, cycleMs);
  const [dissolved, nudged] = await Promise.all([
    classifyDissolvedClusters(window, dissolvedMembers, endMs, sql),
    countNudgedClusters(window, overdueAtEnd.map((c) => c.memberIds), endMs - cycleMs, sql),
  ]);
  return {
    total: read.clusters.length,
    overdue: overdueAtEnd.length,
    overdueAtStart: overdueAtStart.length,
    dissolved,
    nudged,
  };
}

/**
 * How many of the end-overdue clusters had a goal liveness watchdog nudge filed at least one
 * reporting cycle before window end, i.e. early enough for the holder to act (WI-10005942).
 * A fail without one may be a detector the holder could not see yet (P-008 W1: signal 5
 * reached the holder's serving build mid-window and the nudge landed 17 min before window
 * end), so the rating names it.
 */
async function countNudgedClusters(
  window: GoalHolderWindow,
  clusters: string[][],
  cutoffMs: number,
  sql: Sql,
): Promise<number> {
  if (clusters.length === 0) return 0;
  const rows = await sql<{ member_ids: string[] | null }[]>`
    SELECT ARRAY(SELECT jsonb_array_elements_text(w.payload -> 'unplannedCluster' -> 'memberIds')) AS member_ids
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${window.workspaceId}
       AND w.goal_id = ${window.goalId}
       AND w.payload ? 'unplannedCluster'
       AND w.created_ts <= ${cutoffMs}`;
  return clusters.filter((memberIds) =>
    rows.some((row) => (row.member_ids ?? []).some((id) => memberIds.includes(id))),
  ).length;
}

/** Read each dissolved cluster's member states and covering nudge closes, then classify. */
async function classifyDissolvedClusters(
  window: GoalHolderWindow,
  clusters: string[][],
  endMs: number,
  sql: Sql,
): Promise<Record<DissolvedClusterFate, number>> {
  const fates = emptyDissolvedClusterFates();
  if (clusters.length === 0) return fates;
  const ids = [...new Set(clusters.flat())];
  // A drop's reason lands on a different column per close route: payload._completionEvidence
  // for one, terminal_completion_ref for the other, so read both.
  const [memberRows, nudgeRows] = await Promise.all([
    sql<{ feature_id: string; status: string; planned: boolean; reason: string | null }[]>`
      SELECT w.feature_id, w.status,
             (w.source_plan_slug IS NOT NULL OR EXISTS (
                SELECT 1 FROM harness_shared.coord_links pl
                 WHERE pl.workspace_id = w.workspace_id AND pl.src_ref = w.feature_id
                   AND pl.dst_kind IN ('plan_item', 'plan'))) AS planned,
             COALESCE(NULLIF(w.payload -> '_completionEvidence' ->> 'summary', ''),
                      NULLIF(w.terminal_completion_ref, '')) AS reason
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${window.workspaceId}
         AND w.feature_id = ANY(${ids}::text[])`,
    sql<{ status: string; member_ids: string[] | null; reason: string | null }[]>`
      SELECT w.status,
             ARRAY(SELECT jsonb_array_elements_text(w.payload -> 'unplannedCluster' -> 'memberIds')) AS member_ids,
             COALESCE(NULLIF(w.payload -> '_completionEvidence' ->> 'summary', ''),
                      NULLIF(w.terminal_completion_ref, '')) AS reason
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${window.workspaceId}
         AND w.goal_id = ${window.goalId}
         AND w.payload ? 'unplannedCluster'
         AND w.closed_ts IS NOT NULL
         AND w.closed_ts <= ${endMs}`,
  ]);
  const byId = new Map(memberRows.map((row) => [row.feature_id, row]));
  for (const memberIds of clusters) {
    const members = memberIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ status: row.status, planned: Boolean(row.planned), reason: row.reason }] : [];
    });
    const nudges = nudgeRows
      .filter((row) => (row.member_ids ?? []).some((id) => memberIds.includes(id)))
      .map((row) => ({ status: row.status, reason: row.reason }));
    fates[classifyDissolvedCluster({ members, nudges })] += 1;
  }
  return fates;
}

/**
 * Read every metric for one window. event_awaits and routine_loop_transitions rows for a
 * session live under workspace 'default', not the papercusp workspace, so those two reads
 * scope by the holder's (globally unique) owner id only.
 */
export async function collectGoalHolderBehaviorMetrics(
  window: GoalHolderWindow,
  deps: { sql: Sql },
): Promise<GoalHolderBehaviorMetrics> {
  const { sql } = deps;
  const start = new Date(window.windowStart);
  const end = new Date(window.windowEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error(`invalid holder window ${window.windowStart}..${window.windowEnd}`);
  }
  const daySince = new Date(end.getTime() - GOAL_DAY_MS);
  const endMs = end.getTime();

  const [planTools, unplannedRows, reviewRows, plansNewDay, reportRows, loopRows, reminderRows, churnRows] =
    await Promise.all([
      readHolderPlanToolCounts(window, { sql }),
      sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.work_items w
         WHERE w.workspace_id = ${window.workspaceId}
           AND w.goal_id = ${window.goalId}
           AND w.lane IS DISTINCT FROM 'observation'
           AND w.source_plan_slug IS NULL
           AND w.created_ts <= ${endMs}
           AND (w.closed_ts IS NULL OR w.closed_ts > ${endMs})`,
      sql<{ invoked_at: Date; author: string | null; disposition: string | null; coverage: unknown; ideas_filed: unknown; unplanned: string }[]>`
        SELECT t.invoked_at,
               t.coord_owner_id AS author,
               t.args_json -> 'goalReview' ->> 'disposition' AS disposition,
               t.args_json -> 'goalReview' -> 'coverage' AS coverage,
               t.args_json -> 'ideasFiled' AS ideas_filed,
               (SELECT count(*)
                  FROM harness_shared.work_items w
                 WHERE w.workspace_id = t.workspace_id
                   AND w.goal_id = ${window.goalId}
                   AND w.lane IS DISTINCT FROM 'observation'
                   AND w.source_plan_slug IS NULL
                   AND w.created_ts <= (extract(epoch FROM t.invoked_at) * 1000)::bigint
                   AND (w.closed_ts IS NULL OR w.closed_ts > (extract(epoch FROM t.invoked_at) * 1000)::bigint)
               )::text AS unplanned
          FROM harness_shared.tool_invocations t
         WHERE t.workspace_id = ${window.workspaceId}
           AND t.tool_name = 'blender:ideate-pass-record'
           AND t.status = 'ok'
           AND t.args_json -> 'goalReview' ->> 'goalId' = ${window.goalId}
           AND t.invoked_at BETWEEN ${daySince} AND ${end}
         ORDER BY t.invoked_at`,
      countGoalPlansWritten({ workspaceId: window.workspaceId, goalId: window.goalId, since: daySince, at: end }, sql),
      sql<{ ts: Date; cost: string | null; owner_walled: string | null; truth_cost: string | null }[]>`
        SELECT e.ts,
               e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'cost' AS cost,
               e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'ownerWalled' AS owner_walled,
               e.body -> ${GOAL_OWNER_REPORT_FIELD} -> 'truth' ->> 'cost' AS truth_cost
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${window.workspaceId}
           AND e.body ->> 'from' = ${window.holderOwnerId}
           AND e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = ${window.goalId}
           AND e.ts BETWEEN ${start} AND ${end}
         ORDER BY e.ts`,
      sql<{ delivered: string; suppressed: string }[]>`
        SELECT count(*) FILTER (WHERE event = 'rearmed' AND actor = 'reconcile-loop-routines')::text AS delivered,
               count(*) FILTER (WHERE event = 'rearmed' AND actor = 'await-suppression')::text AS suppressed
          FROM harness_shared.routine_loop_transitions
         WHERE target_owner_id = ${window.holderOwnerId}
           AND at BETWEEN ${start} AND ${end}`,
      sql<{ total: string; fired: string; cancelled: string; with_reason: string; discharged: string }[]>`
        SELECT count(*)::text AS total,
               count(fired_at)::text AS fired,
               count(cancelled_at)::text AS cancelled,
               count(cancelled_at) FILTER (WHERE cancel_reason IS NOT NULL)::text AS with_reason,
               count(cancelled_at) FILTER (WHERE cancel_reason ILIKE '%discharg%')::text AS discharged
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${window.holderOwnerId}
           AND bound_to ->> 'kind' = 'agent-obligation'
           AND expires_ts IS NOT NULL
           AND created_at BETWEEN ${start} AND ${end}`,
      sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${window.holderOwnerId}
           AND bound_to ->> 'kind' = 'agent-obligation'
           AND expires_ts IS NULL
           AND cancelled_at BETWEEN ${start} AND ${end}
           AND cancel_reason IS NULL`,
    ]);
  // The goal's spend, read the way the send-time truth gate reads it. Only reports whose stamp
  // carries no truth summary are judged against it (at grading time, not their send time).
  const [spendRow] = await sql<{ spent: unknown; source: string | null; at: string | null; unmeasured: string | null }[]>`
    SELECT metadata -> 'spentCents' AS spent,
           metadata ->> 'spentCentsSource' AS source,
           metadata ->> 'spentCentsAt' AS at,
           NULLIF(metadata ->> 'spentCentsUnmeasuredReason', '') AS unmeasured
      FROM harness_shared.goals
     WHERE workspace_id = ${window.workspaceId} AND id = ${window.goalId}`;
  const goalSpend = spendRow ? goalSpendFromGoalRow(spendRow, GOAL_SPEND_ROLLUP_SOURCE) : null;

  const reviews = summarizeGoalReviews(
    reviewRows.map((row) => ({
      invokedAt: new Date(row.invoked_at).toISOString(),
      disposition: row.disposition,
      coverage: row.coverage,
      ideasFiled: row.ideas_filed,
      unplannedAtReview: Number(row.unplanned),
      byHolder: row.author === window.holderOwnerId,
    })),
  );
  const clusters = await readWindowClusters(window, start.getTime(), endMs, sql);
  const reminder = reminderRows[0];
  return {
    version: GOAL_HOLDER_METRICS_VERSION,
    window,
    planAuthorship: {
      ...planTools,
      unplannedOpenGoalItems: Number(unplannedRows[0]?.n ?? 0),
      unplannedClusters: clusters.total,
      overdueUnplannedClusters: clusters.overdue,
      overdueClustersAtStart: clusters.overdueAtStart,
      dissolvedOverdueClusters: clusters.dissolved,
      overdueClustersNudged: clusters.nudged,
    },
    ideation: { since: daySince.toISOString(), plansNew: plansNewDay, ...reviews },
    ownerReports: summarizeOwnerReports(
      reportRows.map((row) => ({
        ts: new Date(row.ts).toISOString(),
        cost: row.cost,
        ownerWalled: row.owner_walled,
        truthCost: isTruthCost(row.truth_cost) ? row.truth_cost : null,
      })),
      goalSpend,
    ),
    loop: {
      deliveredFires: Number(loopRows[0]?.delivered ?? 0),
      suppressedFires: Number(loopRows[0]?.suppressed ?? 0),
      windowHours: (end.getTime() - start.getTime()) / 3_600_000,
    },
    nudges: {
      timedReminders: Number(reminder?.total ?? 0),
      fired: Number(reminder?.fired ?? 0),
      cancelled: Number(reminder?.cancelled ?? 0),
      cancelledWithReason: Number(reminder?.with_reason ?? 0),
      dischargedCancels: Number(reminder?.discharged ?? 0),
      watchChurnWithoutReason: Number(churnRows[0]?.n ?? 0),
    },
  };
}
