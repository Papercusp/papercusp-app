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

const reviewFields = z.object({
  goalId: z.string().trim().min(1).max(200),
  disposition: z.enum(GOAL_PLANNING_DISPOSITIONS),
  rationale: z.string().trim().min(1).max(4000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  planRefs: z.array(z.string().trim().max(500).regex(/^plan:\S+$/)).max(20).default([]),
  uncoveredOutcome: z.string().trim().min(1).max(4000).optional(),
}).strict();

function validateReview(value: z.infer<typeof reviewFields>, ctx: z.RefinementCtx): void {
  if (value.disposition === 'plan-needed' && !value.uncoveredOutcome) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['uncoveredOutcome'], message: 'Name the uncovered goal outcome requiring a plan.' });
  }
  if (['adopt-plan', 'revise-plan'].includes(value.disposition) && value.planRefs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planRefs'], message: 'Identify the existing plan to adopt or revise.' });
  }
}

/** Caller fields only: measured fingerprints and clocks cannot be supplied. */
export const goalPlanningReviewInputSchema = reviewFields.superRefine(validateReview);
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
