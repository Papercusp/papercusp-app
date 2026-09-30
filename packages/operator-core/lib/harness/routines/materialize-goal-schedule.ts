/**
 * Materialize a scheduled GOAL's recurrence into a `harness_shared.routines` row —
 * the goal-level mirror of materialize-plan-schedule.ts.
 *
 * Plan: work-on-everything-goal-2026-08-23 (P-020, D-006 ruling 3 — the schedule
 * leg). One `goal-schedule-<goalId>` routine whose `target_role` is
 * `system:goal-start` and whose `trigger_config` is the authored schedule. The
 * shipped DBOS routinesTick claims a due row and fires `system:goal-start`
 * (goal-start-action.ts), which dispatches the ONE goal-activation primitive
 * (`startGoalById`) — exactly how plan schedules fire `system:plan-run`. No new
 * scheduler: one declarative seam onto the existing engine.
 *
 * STORAGE (deliberate, recorded as plan D-007): goals have NO schedule column —
 * the ROUTINE ROW is the authored schedule's storage. `goals:set-schedule`
 * materializes the row INACTIVE (authoring ≠ arming, same separation as plans);
 * `goals:arm-schedule` re-reads the stored trigger_config, recomputes the next
 * fire, and flips it active. This avoids both a goals migration and an untyped
 * metadata bag, and makes an authored-but-unarmed goal schedule visible in the
 * schedule inventory as an inactive routine.
 */
import type { Sql } from 'postgres';
import { deleteRoutine, getOrgPg, upsertRoutine, setRoutineActive } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFire, type ScheduleTrigger } from './schedule-next';
import { computeNextFireAt } from './cron';

/** The system action a goal-schedule routine fires (registered in goal-start-action.ts). */
export const GOAL_START_ACTION = 'system:goal-start';

/** Stable per-goal routine name (the upsert key under the harness install slug). */
export function goalScheduleRoutineName(goalId: string): string {
  return `goal-schedule-${goalId}`;
}

export interface MaterializeGoalScheduleInput {
  workspaceId?: string;
  /** Harness the goal lives in — the routine's install_slug. */
  harnessSlug: string;
  /** The EXISTING goal to activate on each fire (payload + routine name). */
  goalId: string;
  /** Authored recurrence set (rrule|cron + policy). */
  schedule: ScheduleTrigger;
  /** Overlap policy. Default 'skip' — startGoalById's already-held guard makes
   *  'skip' the only overlap semantics a goal fire can honor anyway. */
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
  /** Seed active (armed). Authoring passes false; arming passes true. Default false. */
  active?: boolean;
  /** Test seam. */
  sql?: Sql;
}

/**
 * Upsert the goal-schedule routine. Idempotent on (install_slug, name) —
 * re-authoring the same goal's schedule upserts the one row.
 */
export async function materializeGoalSchedule(
  input: MaterializeGoalScheduleInput,
): Promise<{ id: string; nextFireAt: Date | null }> {
  const sql = input.sql ?? getOrgPg().sql;
  const workspaceId = input.workspaceId ?? activeWorkspaceId();

  const row = await upsertRoutine(
    sql,
    {
      workspaceId,
      installSlug: input.harnessSlug,
      name: goalScheduleRoutineName(input.goalId),
      triggerKind: 'cron', // time-scheduled / next_fire_at-driven (cron OR rrule), per listDueCronRoutines
      triggerConfig: { ...input.schedule },
      targetRole: GOAL_START_ACTION,
      payloadTemplate: { goalId: input.goalId, harnessSlug: input.harnessSlug },
      concurrency: input.concurrency ?? 'skip',
      active: input.active ?? false,
      // Explicit override — upsertRoutine only auto-derives from a cron string.
      nextFireAt: computeNextFire(input.schedule, new Date()),
    },
    computeNextFireAt,
  );
  return { id: row.id, nextFireAt: row.nextFireAt };
}

export type ArmGoalScheduleResult =
  | { ok: true; routineId: string; nextFireAt: Date | null }
  | { ok: false; reason: 'not_scheduled' };

/**
 * Arm a goal's authored schedule: re-read the stored trigger_config (the routine
 * row IS the storage — see the module header), recompute the next fire, and
 * upsert active. Refuses when no schedule was ever authored for the goal.
 */
export async function armGoalSchedule(input: {
  workspaceId: string;
  harnessSlug: string;
  goalId: string;
  sql?: Sql;
}): Promise<ArmGoalScheduleResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ trigger_config: Record<string, unknown> | null }>>`
    SELECT trigger_config FROM harness_shared.routines
     WHERE workspace_id = ${input.workspaceId}
       AND install_slug = ${input.harnessSlug}
       AND name = ${goalScheduleRoutineName(input.goalId)}
     LIMIT 1`;
  const stored = rows[0]?.trigger_config;
  if (!stored || Object.keys(stored).length === 0) return { ok: false, reason: 'not_scheduled' };
  const res = await materializeGoalSchedule({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    goalId: input.goalId,
    schedule: stored as unknown as ScheduleTrigger,
    active: true,
    sql,
  });
  return { ok: true, routineId: res.id, nextFireAt: res.nextFireAt };
}

/**
 * Disarm a goal's schedule — deactivate its routine (pause). The row is kept
 * (it IS the authored schedule; deleting it would un-author, not pause).
 */
export async function deactivateGoalSchedule(
  harnessSlug: string,
  goalId: string,
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  return setRoutineActive(sql, harnessSlug, goalScheduleRoutineName(goalId), false);
}

/**
 * Permanently remove a goal's schedule. Because the routine row is the storage,
 * this un-authors the schedule entirely (goals:set-schedule { schedule: null }).
 * Idempotent: false means there was nothing to remove.
 */
export async function deleteGoalSchedule(
  harnessSlug: string,
  goalId: string,
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  return deleteRoutine(sql, harnessSlug, goalScheduleRoutineName(goalId));
}
