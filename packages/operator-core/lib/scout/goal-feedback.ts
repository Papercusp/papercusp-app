/**
 * goal-feedback.ts — goal-local planning → Blender's EXISTING feedback surfaces
 * (goal-brief-to-claimed-plan-work-2026-09-23 P-009, D-005 / D-007).
 *
 * Blender and goal holders may both originate plans (D-005). Blender-origin work
 * already lands in `scout_routed_ideas` when it is routed, so its outcome is learned
 * from the routed artifact's terminal state (outcome-feedback.ts). A plan a goal
 * holder creates with `plans:new` was stamped with `harness_plans.goal_id`
 * (migration 791) but got NO routed-idea row, so it never received an outcome, never
 * appeared in the goal portfolio's `blender_pending` count, and the goal-gap review
 * that justified it never reached `addresses_pattern_refs` — the column
 * observation-consumption and recurrence-escalation read to learn which findings an
 * idea addressed.
 *
 * This module closes that gap by REUSING the existing rows; it adds no ledger,
 * table or column (D-007):
 *
 * - origin: a goal-local plan gets one insert-only `origin:'su-ideate'` row
 *   (rail `plan`, `created_by` = the holder). The goal link is the plan's own
 *   `goal_id`; it is never copied into a second place.
 * - dedup + attribution: when ANY row already routes the same plan ref (a Blender
 *   `scout` row, an earlier capture, another goal's origin), nothing is written.
 *   Adopting, revising or routing someone else's plan never re-attributes it.
 * - recurring findings: each later goal review naming a goal-local plan unions its
 *   work-item / rubric evidence refs into that plan's own row, so repeated findings
 *   accumulate on the idea that answers them. Rows this module did not create are
 *   never touched.
 */
import { getOrgPg } from '@papercusp/db-org';

import type { GoalPlanningReview } from '../goal-planning-review';
import { recordRoutedIdea } from './routed-ledger';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export type GoalPlanFeedbackAction =
  /** A new goal-local origin row was written. */
  | 'recorded'
  /** This module's own row gained review evidence refs. */
  | 'evidence-linked'
  /** This module's own row already carries every evidence ref. */
  | 'unchanged'
  /** Another row already routes this plan — its attribution is preserved, nothing written. */
  | 'existing-attribution'
  /** The plan was not created under this goal — not goal-local, nothing written. */
  | 'not-goal-local'
  | 'plan-not-found'
  | 'invalid-ref';

export interface GoalPlanFeedbackResult {
  planRef: string;
  action: GoalPlanFeedbackAction;
  /** The row that owns the plan's attribution, when one exists. */
  ideaId?: string;
  origin?: string;
}

/** Deterministic, so a retried or concurrent record converges on one row. */
export function goalLocalPlanIdeaId(goalId: string, harnessSlug: string, planSlug: string): string {
  return `goal-plan:${goalId}:${harnessSlug}/${planSlug}`;
}

/**
 * Keep only evidence refs in the vocabulary `addresses_pattern_refs` already uses:
 * `wi:<work-item id>` and `rubric:<ref>`. Bare EI-/WI-/F- ids and `work-item:` refs
 * are normalised to `wi:`; free text, session turns and URLs are dropped because no
 * reader of that column can resolve them.
 */
export function patternRefsFromEvidence(refs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    const wi = /^(?:wi:|work-item:)?((?:EI|WI|F)-\d+)$/.exec(ref);
    if (wi) {
      out.add(`wi:${wi[1]}`);
      continue;
    }
    if (/^rubric:\S+$/.test(ref)) out.add(ref);
  }
  return [...out];
}

/** `plan:<slug>` or `plan:<harness>/<slug>`. */
export function parsePlanRef(ref: string): { harnessSlug?: string; planSlug: string } | null {
  const m = /^plan:(?:([^/\s]+)\/)?([^/\s]+)$/.exec(ref.trim());
  if (!m) return null;
  return { ...(m[1] ? { harnessSlug: m[1] } : {}), planSlug: m[2]! };
}

interface PlanRow {
  harness_slug: string;
  plan_slug: string;
  goal_id: string | null;
  title: string | null;
}

async function readPlan(
  sql: Sql,
  workspaceId: string,
  planSlug: string,
  harnessSlug?: string,
): Promise<PlanRow | null> {
  const rows = await sql<PlanRow[]>`
    SELECT harness_slug, plan_slug, goal_id, title
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${planSlug}
       ${harnessSlug
         // harness_plans_canonicalize_slug rewrites retired slugs on write, so a
         // ref naming a retired alias must be canonicalised the same way to match.
         ? sql`AND harness_slug = COALESCE(harness_shared.canonical_harness_slug(${harnessSlug}), ${harnessSlug})`
         : sql``}
     ORDER BY updated_at DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Ensure a goal-local plan has its origin row, or report whose attribution already
 * owns it. Verifies `harness_plans.goal_id` itself rather than trusting the caller:
 * a plan re-created over an existing slug keeps its first goal (stampPlanGoalProvenance
 * never overwrites), and that first owner's attribution must survive.
 */
export async function recordGoalLocalPlanOrigin(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  goalId: string;
  ownerId: string;
  evidenceRefs?: readonly string[];
  sql?: Sql;
}): Promise<GoalPlanFeedbackResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const planRef = `plan:${input.planSlug}`;
  const plan = await readPlan(sql, input.workspaceId, input.planSlug, input.harnessSlug);
  if (!plan) return { planRef, action: 'plan-not-found' };
  if (plan.goal_id !== input.goalId) return { planRef, action: 'not-goal-local' };

  const ideaId = goalLocalPlanIdeaId(input.goalId, plan.harness_slug, plan.plan_slug);
  const patternRefs = patternRefsFromEvidence(input.evidenceRefs ?? []);
  const existing = await sql<{ idea_id: string; origin: string | null; addresses_pattern_refs: unknown }[]>`
    SELECT idea_id, origin, addresses_pattern_refs
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${input.workspaceId}
       AND routed_ref IN (${planRef}, ${`plan:${plan.harness_slug}/${plan.plan_slug}`})
     ORDER BY routed_at ASC, idea_id ASC`;

  const foreign = existing.find((row) => row.idea_id !== ideaId);
  if (foreign) {
    return { planRef, action: 'existing-attribution', ideaId: foreign.idea_id, origin: foreign.origin ?? 'scout' };
  }

  const own = existing.find((row) => row.idea_id === ideaId);
  if (own) {
    const current = Array.isArray(own.addresses_pattern_refs)
      ? own.addresses_pattern_refs.filter((ref): ref is string => typeof ref === 'string')
      : [];
    const merged = [...new Set([...current, ...patternRefs])];
    if (merged.length === current.length) {
      return { planRef, action: 'unchanged', ideaId, origin: own.origin ?? 'su-ideate' };
    }
    await sql`
      UPDATE harness_shared.scout_routed_ideas
         SET addresses_pattern_refs = ${JSON.stringify(merged)}::text::jsonb
       WHERE workspace_id = ${input.workspaceId}
         AND idea_id = ${ideaId}`;
    return { planRef, action: 'evidence-linked', ideaId, origin: own.origin ?? 'su-ideate' };
  }

  await recordRoutedIdea({
    ideaId,
    workspaceId: input.workspaceId,
    harnessSlug: plan.harness_slug,
    lens: 'su-ideate',
    rail: 'plan',
    routedRef: planRef,
    ...(plan.title ? { title: plan.title } : {}),
    ...(patternRefs.length > 0 ? { addressesPatternRefs: patternRefs } : {}),
    origin: 'su-ideate',
    createdBy: input.ownerId,
    preserveExisting: true,
  });
  return { planRef, action: 'recorded', ideaId, origin: 'su-ideate' };
}

/**
 * Feed one recorded goal-gap review into the ledger. Only plans created under the
 * reviewed goal are written; every other named plan is reported, never modified.
 */
export async function recordGoalReviewFeedback(input: {
  workspaceId: string;
  ownerId: string;
  review: Pick<GoalPlanningReview, 'goalId' | 'planRefs' | 'evidenceRefs'>;
  sql?: Sql;
}): Promise<GoalPlanFeedbackResult[]> {
  const sql = input.sql ?? getOrgPg().sql;
  const results: GoalPlanFeedbackResult[] = [];
  for (const ref of input.review.planRefs) {
    const parsed = parsePlanRef(ref);
    if (!parsed) {
      results.push({ planRef: ref, action: 'invalid-ref' });
      continue;
    }
    const plan = await readPlan(sql, input.workspaceId, parsed.planSlug, parsed.harnessSlug);
    if (!plan) {
      results.push({ planRef: ref, action: 'plan-not-found' });
      continue;
    }
    if (plan.goal_id !== input.review.goalId) {
      results.push({ planRef: ref, action: 'not-goal-local' });
      continue;
    }
    results.push(
      await recordGoalLocalPlanOrigin({
        workspaceId: input.workspaceId,
        harnessSlug: plan.harness_slug,
        planSlug: plan.plan_slug,
        goalId: input.review.goalId,
        ownerId: input.ownerId,
        evidenceRefs: input.review.evidenceRefs,
        sql,
      }),
    );
  }
  return results;
}
