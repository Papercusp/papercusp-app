/**
 * Shared goal-gap review contract for the existing su-ideate tick ledger.
 * A review is an agent-authored assessment, not execution authority or proof
 * of a worker claim. The server pins the goal/portfolio it reviewed.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GoalPortfolioBrief } from './goal-launch-settings';

export const GOAL_PLANNING_REVIEW_VERSION = 1 as const;
export const GOAL_PLANNING_DISPOSITIONS = [
  'existing-plans-sufficient', 'plan-needed', 'adopt-plan', 'revise-plan',
  'route-work', 'blocked', 'no-eligible-work',
] as const;

/**
 * P-003 / P-009 (goal-holder-plans-ideation-truthful-reports-2026-10-03). A
 * no-new-plan review must SHOW its work: each recurring need it found, the goal
 * work-items it spans, and the plan covering it. Measured 2026-10-01..03: 18 of
 * 24 goal reviews said existing-plans-sufficient and no holder wrote a plan, so
 * the planning nudge was cleared by an assertion nobody could check.
 */
export const GOAL_REVIEW_CLUSTER_MIN_ITEMS = 3;
export const GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS = ['existing-plans-sufficient', 'no-eligible-work'] as const;

/**
 * P-004 / D-001 (goal-holder-plans-ideation-truthful-reports-2026-10-03). A GOAL's
 * ideation must YIELD: at least this many evaluated new candidates (an idea filed
 * through Blender, or a plan proposed for the goal) per goal-day. One pass may file
 * zero; the goal-day may not. The WOE `ideation-yield` grade and the review receipt
 * share this threshold so the holder is told exactly what the grader will count.
 */
export const GOAL_DAY_MIN_CANDIDATES = 1;

/** The goal-day candidate count returned on a recorded goal review (P-004). */
export interface GoalDayIdeationYield {
  goalId: string;
  /** Start of the goal-day: the 24h ending when the review was recorded. */
  since: string;
  /** Plans proposed for this goal in the goal-day (plans:new stamped with its goal). */
  plansNew: number;
  /** Ideas this goal's reviews report filing in the goal-day, this pass included. */
  ideasFiled: number;
  candidates: number;
  /** True while the goal-day still has fewer than GOAL_DAY_MIN_CANDIDATES candidates. */
  owed: boolean;
  message: string;
}

export function goalDayIdeationYield(input: {
  goalId: string;
  since: string;
  plansNew: number;
  /** Ideas reported by reviews already in the ledger (the current call is not yet). */
  priorIdeasFiled: number;
  thisPassIdeasFiled: number;
}): GoalDayIdeationYield {
  const plansNew = Math.max(0, Math.floor(input.plansNew));
  const ideasFiled = Math.max(0, Math.floor(input.priorIdeasFiled)) + Math.max(0, Math.floor(input.thisPassIdeasFiled));
  const candidates = plansNew + ideasFiled;
  const owed = candidates < GOAL_DAY_MIN_CANDIDATES;
  const message = owed
    ? `${candidates} evaluated new candidate(s) for goal ${input.goalId} in the goal-day since ${input.since}; ` +
      `a GOAL owes at least ${GOAL_DAY_MIN_CANDIDATES} per goal-day. File an idea (improvements:capture or ` +
      'blender:route-idea) or propose a plan (plans:new), grounded in curation:state-of-pot, rubrics:trend and ' +
      "blender:ideation-feedback { scope:'mine' }, then record it."
    : `${candidates} evaluated candidate(s) for goal ${input.goalId} in the goal-day since ${input.since} ` +
      `(plans ${plansNew}, ideas ${ideasFiled}).`;
  return { goalId: input.goalId, since: input.since, plansNew, ideasFiled, candidates, owed, message };
}
const PLAN_REF = /^plan:[^/\s]+\/\S+$/;

export const goalReviewCoverageEntrySchema = z.object({
  need: z.string().trim().min(1).max(1000),
  itemRefs: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  planRef: z.string().trim().max(500).regex(PLAN_REF).optional(),
  justification: z.string().trim().min(1).max(2000).optional(),
}).strict();
export type GoalReviewCoverageEntry = z.infer<typeof goalReviewCoverageEntrySchema>;

export interface GoalReviewCoverageGap {
  need: string;
  itemCount: number;
  kind: 'cluster-without-plan' | 'unjustified-uncovered-need';
}

/** Deterministic coverage verdict shared by the write-side refusal and the planning obligation. */
export function goalReviewCoverageGaps(coverage: readonly GoalReviewCoverageEntry[]): GoalReviewCoverageGap[] {
  const gaps: GoalReviewCoverageGap[] = [];
  for (const entry of coverage) {
    if (entry.planRef) continue;
    const itemCount = new Set(entry.itemRefs).size;
    if (itemCount >= GOAL_REVIEW_CLUSTER_MIN_ITEMS) gaps.push({ need: entry.need, itemCount, kind: 'cluster-without-plan' });
    else if (!entry.justification) gaps.push({ need: entry.need, itemCount, kind: 'unjustified-uncovered-need' });
  }
  return gaps;
}

export function describeGoalReviewCoverageGap(gap: GoalReviewCoverageGap): string {
  return gap.kind === 'cluster-without-plan'
    ? `Need "${gap.need}" spans ${gap.itemCount} goal work-items and maps to no plan: write one (plans:new, then plans:start) and cite it as planRef, or record disposition plan-needed.`
    : `Need "${gap.need}" has no planRef and no justification: name the covering plan, or justify handling it as a single item.`;
}

const reviewFields = z.object({
  goalId: z.string().trim().min(1).max(200),
  disposition: z.enum(GOAL_PLANNING_DISPOSITIONS),
  rationale: z.string().trim().min(1).max(4000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  planRefs: z.array(z.string().trim().max(500).regex(/^plan:\S+$/)).max(20).default([]),
  uncoveredOutcome: z.string().trim().min(1).max(4000).optional(),
  /** Required for a no-new-plan disposition at write time; optional in storage so older reviews still parse. */
  coverage: z.array(goalReviewCoverageEntrySchema).max(50).optional(),
}).strict();

function isNoNewPlanDisposition(disposition: string): boolean {
  return (GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS as readonly string[]).includes(disposition);
}

/** Write-side only: a no-new-plan review must carry a passing coverage map (P-003). */
function validateReviewInput(value: z.infer<typeof reviewFields>, ctx: z.RefinementCtx): void {
  validateReview(value, ctx);
  if (!isNoNewPlanDisposition(value.disposition)) return;
  if (!value.coverage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['coverage'],
      message: `A ${value.disposition} review must carry a coverage map: list each recurring need, the goal work-items it spans (itemRefs) and the plan covering it (planRef). Use [] only when there is no recurring need.`,
    });
    return;
  }
  goalReviewCoverageGaps(value.coverage).forEach((gap, index) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage', index], message: describeGoalReviewCoverageGap(gap) });
  });
}

function validateReview(value: z.infer<typeof reviewFields>, ctx: z.RefinementCtx): void {
  if (value.disposition === 'plan-needed' && !value.uncoveredOutcome) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['uncoveredOutcome'], message: 'Name the uncovered goal outcome requiring a plan.' });
  }
  if (['adopt-plan', 'revise-plan'].includes(value.disposition) && value.planRefs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planRefs'], message: 'Identify the existing plan to adopt or revise.' });
  }
}

/** Caller fields only: measured fingerprints and clocks cannot be supplied. */
export const goalPlanningReviewInputSchema = reviewFields.superRefine(validateReviewInput);
export type GoalPlanningReviewInput = z.infer<typeof goalPlanningReviewInputSchema>;

export const goalPlanningReviewSchema = reviewFields.extend({
  schemaVersion: z.literal(GOAL_PLANNING_REVIEW_VERSION),
  portfolioFingerprint: z.string().min(1).max(128),
  reviewedAt: z.string().datetime({ offset: true }),
}).strict().superRefine(validateReview);
export type GoalPlanningReview = z.infer<typeof goalPlanningReviewSchema>;

export interface GoalPlanningReviewContext {
  goalId: string;
  portfolioFingerprint: string;
  observedAt: string;
}

type ReviewPortfolio = {
  goal: GoalPortfolioBrief['goal'];
  worklist: ReadonlyArray<Pick<GoalPortfolioBrief['worklist'][number], 'ref' | 'status'>>;
  pending: Pick<GoalPortfolioBrief['pending'], 'blenderIdeas'>;
};

/**
 * Observation clocks, heartbeats, claim renewal and budget readings do not
 * invalidate a review every turn; launch admissibility is checked separately.
 */
export function goalPlanningPortfolioFingerprint(portfolio: ReviewPortfolio): string {
  return createHash('sha256').update(JSON.stringify({
    goal: portfolio.goal,
    plans: portfolio.worklist.map(({ ref, status }) => ({ ref, status })),
    blenderIdeas: portfolio.pending.blenderIdeas,
  })).digest('hex');
}

export function parseGoalPlanningReview(value: unknown): GoalPlanningReview | null {
  const parsed = goalPlanningReviewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reuse current mode and portfolio readers; never trust a requested goal id. */
export async function readGoalPlanningReviewContext(
  workspaceId: string,
  ownerId: string,
): Promise<GoalPlanningReviewContext | null> {
  const [{ getModes }, { goalIdFromModes }, { readGoalPortfolioBrief }] = await Promise.all([
    import('./modes/store'), import('./modes/goal-session'), import('./goal-launch-settings'),
  ]);
  const goalId = goalIdFromModes(await getModes(workspaceId, ownerId));
  if (!goalId) return null;
  const portfolio = await readGoalPortfolioBrief({ workspaceId, goalId });
  if (!portfolio || portfolio.goal.id !== goalId || portfolio.degradedReasons.some((reason) => /portfolio read failed/i.test(reason))) {
    return null;
  }
  return {
    goalId,
    portfolioFingerprint: goalPlanningPortfolioFingerprint(portfolio),
    observedAt: portfolio.assembledAt,
  };
}
