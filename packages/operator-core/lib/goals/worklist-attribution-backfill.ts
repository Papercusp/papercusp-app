/**
 * Worklist -> goal attribution backfill (WI-10005246).
 *
 * WHY: the goal portfolio ladder (`goal-launch-settings.ts` `ladder_work_items` / `plans`) defines a
 * goal's membership as "every plan named by `properties.worklist`, and every work item whose
 * `source_plan_slug` is one of those plans", then flags a member with no `goal_id` as an
 * `unstamped-plan` / `unstamped-work-item` attribution issue. But `goal_id` is stamped only AT CREATE
 * (`plans:new`, `plans:launch`, `fleet:launch-on-plan` via `stampPlanGoalProvenance`, goal start). A
 * plan added to the worklist AFTER its rows already existed (the normal `goals:set-property worklist`
 * edit) therefore left those rows unstamped forever: invisible to the goal-scoped positive claim fence
 * (`work_items.goal_id`), so the drain fleet could not claim them and spend was mis-attributed
 * (measured 2026-10-02: 13 work items + 2 plans on goal 60d3a8).
 *
 * This runs inside the SAME transaction as the worklist write and closes that gap at the one place it
 * opens. Reuse: it writes the same base-table column `writeWorkItemGoalColumn` /
 * `stampPlanGoalProvenance` write; it does not add a verb or a routine.
 *
 * GUARDS (all in the WHERE clause so a concurrent writer cannot be raced):
 *  - `goal_id IS NULL` — never reparents a row that already belongs to ANY goal;
 *  - `origin IS DISTINCT FROM 'remote'` — federation-owned rows refuse field edits, so they stay a
 *    reported residue instead of being silently rewritten.
 */

import type postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

export interface WorklistRefTarget {
  harness: string | null;
  planSlug: string;
}

/**
 * `plan:<harness>/<slug>` or legacy `plan:<slug>`. Anything else (a `goal:` ref, free text, a
 * non-string) is skipped: the worklist datatype is the validator, this only extracts plan targets.
 */
export function parseWorklistPlanRef(ref: unknown): WorklistRefTarget | null {
  if (typeof ref !== 'string' || !ref.startsWith('plan:')) return null;
  const rest = ref.slice('plan:'.length).trim();
  if (!rest) return null;
  const slash = rest.indexOf('/');
  if (slash === -1) return { harness: null, planSlug: rest };
  const harness = rest.slice(0, slash).trim();
  const planSlug = rest.slice(slash + 1).trim();
  if (!harness || !planSlug) return null;
  return { harness, planSlug };
}

export interface WorklistBackfillResult {
  refs: number;
  plansStamped: string[];
  workItemsStamped: string[];
}

export async function backfillWorklistGoalAttribution(
  sql: Sql,
  args: { workspaceId: string; goalId: string; worklist: unknown },
): Promise<WorklistBackfillResult> {
  const targets = (Array.isArray(args.worklist) ? args.worklist : [])
    .map(parseWorklistPlanRef)
    .filter((t): t is WorklistRefTarget => t !== null);
  const out: WorklistBackfillResult = { refs: targets.length, plansStamped: [], workItemsStamped: [] };
  for (const target of targets) {
    const plans = await sql<Array<{ plan_slug: string }>>`
      UPDATE harness_shared.harness_plans
         SET goal_id = ${args.goalId}
       WHERE workspace_id = ${args.workspaceId}
         AND plan_slug = ${target.planSlug}
         AND (${target.harness}::text IS NULL OR harness_slug = ${target.harness})
         AND goal_id IS NULL
         AND origin IS DISTINCT FROM 'remote'
      RETURNING plan_slug`;
    for (const row of plans) out.plansStamped.push(row.plan_slug);

    const items = await sql<Array<{ feature_id: string }>>`
      UPDATE harness_shared.work_items
         SET goal_id = ${args.goalId}, updated_ts = ${Date.now()}
       WHERE workspace_id = ${args.workspaceId}
         AND source_plan_slug = ${target.planSlug}
         AND (${target.harness}::text IS NULL OR harness_slug = ${target.harness})
         AND goal_id IS NULL
         AND origin IS DISTINCT FROM 'remote'
      RETURNING feature_id`;
    for (const row of items) out.workItemsStamped.push(row.feature_id);
  }
  return out;
}
