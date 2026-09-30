/**
 * The `system:goal-start` routine action — one scheduled activation of an
 * EXISTING goal. The goal-level mirror of `system:plan-run` (plan-run-action.ts).
 *
 * Plan: work-on-everything-goal-2026-08-23 (P-020, D-006 ruling 3 — the schedule
 * leg). A goal's materialized routine (materialize-goal-schedule.ts) fires this
 * with `payload_template = { goalId, harnessSlug }`. It dispatches the ONE
 * goal-activation primitive (`startGoalById`) — never a hand-rolled spawn — so
 * every guard rides along for free.
 *
 * Replay/overlap safety IS the primitive's guard set: a replayed or overlapping
 * fire finds the goal already held (or not active) and REFUSES, so a routine
 * replay can never double-spawn a holder. Refusals are therefore RESULTS here —
 * logged, never thrown: a scheduled fire onto a held/paused/closed goal is the
 * guard working, not a routine failure for the engine to retry.
 */
import { getOrgPg } from '@papercusp/db-org';
import { startGoalById, type StartGoalByIdResult } from '../../goals/start-goal-by-id';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

/** launched_by / launcherOwnerId label for a scheduled goal activation. */
export const GOAL_START_LAUNCHER = 'system:goal-start';

export interface GoalStartActionDeps {
  /** The activation primitive — injectable for tests, `startGoalById` in production. */
  startGoal: (
    sql: Parameters<typeof startGoalById>[0],
    input: { workspaceId: string; goalId: string; launcherOwnerId: string },
  ) => Promise<StartGoalByIdResult>;
}

const DEFAULT_DEPS: GoalStartActionDeps = { startGoal: startGoalById };

export interface GoalStartActionResult {
  started: boolean;
  goalId: string;
  /** The pre-pinned holder identity, when the activation took. */
  ownerId?: string;
  /** The primitive's refusal reason, when it declined (logged, not thrown). */
  refusal?: string;
}

export async function runGoalStartAction(
  ctx: SystemActionCtx,
  deps: GoalStartActionDeps = DEFAULT_DEPS,
): Promise<GoalStartActionResult> {
  const raw = ctx.payloadTemplate?.goalId;
  const goalId = typeof raw === 'string' ? raw.trim() : '';
  // A routine with no goal target is a materialization bug, not a goal state —
  // throw so the fire records failed and the defect is visible.
  if (!goalId) throw new Error('system:goal-start requires payload_template.goalId');

  const sql = getOrgPg().sql;
  const res = await deps.startGoal(sql, {
    workspaceId: ctx.workspaceId,
    goalId,
    launcherOwnerId: GOAL_START_LAUNCHER,
  });
  if (res.ok) {
    for (const warning of res.warnings) {
      console.warn(`[goal-start] ${goalId}: ${warning}`);
    }
    console.log(`[goal-start] ${goalId}: holder ${res.ownerId} launched`);
    return { started: true, goalId, ownerId: res.ownerId };
  }
  console.warn(`[goal-start] ${goalId}: refused (${res.reason}) — ${res.detail}`);
  return { started: false, goalId, refusal: res.reason };
}

// `scheduling: 'on-demand'` (EI-18752496371939475): there is no standing `system:goal-start`
// row to seed. Rows are materialized per goal schedule by `materialize-goal-schedule.ts` when
// an owner arms one (goals:set-schedule → goals:arm-schedule), so a workspace with no armed
// goal schedules legitimately has zero rows and must not be reported as dead code.
registerSystemAction(
  'goal-start',
  async (ctx) => {
    await runGoalStartAction(ctx);
  },
  { scheduling: 'on-demand' },
);
