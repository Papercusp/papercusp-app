/**
 * Materialize a scheduled PLAN's authored schedule into a `harness_shared.routines`
 * row — the plan-level mirror of blueprint/materialize-triggers.ts.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7b).
 *
 * A scheduled plan (the TEMPLATE) carries its authored recurrence in the
 * `harness_plans.schedule` column (D-004). Arming the schedule (the autonomy-gated
 * flow, Phase 3) calls this to project the plan onto the EXISTING routines engine:
 * one `plan-schedule-<templateSlug>` routine whose `target_role` is `system:plan-run`
 * and whose `trigger_config` is the schedule (cron OR the rrule set). The shipped
 * DBOS routinesTick then claims a due row (claim.ts, RRULE-aware as of 7a) and fires
 * `system:plan-run` (7c) — exactly how blueprint triggers fire `system:blueprint-run`.
 * Plan ⟂ scheduler: one declarative seam onto the existing engine, not a 2nd scheduler.
 *
 * upsertRoutine only auto-derives next_fire_at from a cron string, so we compute the
 * FIRST fire here via computeNextFire (cron OR rrule) and pass it as the explicit
 * nextFireAt override. This also expresses a ONE-SHOT (a dragged-onto-a-day
 * `scheduled_at`): no recurrence in the schedule ⇒ next_fire_at = scheduledAt and
 * claim.ts deactivates the row after it fires once.
 */
import type { Sql } from 'postgres';
import { deleteRoutine, getOrgPg, upsertRoutine, setRoutineActive } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFire, type ScheduleTrigger } from './schedule-next';
import { computeNextFireAt } from './cron';

/** The system action a plan-schedule routine fires (registered in 7c). */
export const PLAN_RUN_ACTION = 'system:plan-run';
/** The on-demand operation action used by operation-backed schedules (P-016). */
export const BLUEPRINT_OPERATION_ACTION = 'system:blueprint-operation';

export interface BlueprintOperationRoutineTarget {
  harnessSlug: string;
  operationId: string;
  input?: Record<string, unknown>;
}

/** Stable per-plan routine name (the upsert key under the harness install slug). */
export function planScheduleRoutineName(templateSlug: string): string {
  return `plan-schedule-${templateSlug}`;
}

export interface MaterializePlanScheduleInput {
  workspaceId?: string;
  /** Harness the plan lives in — the routine's install_slug. */
  harnessSlug: string;
  /** The TEMPLATE plan slug (payload + routine name). */
  templateSlug: string;
  /** Authored recurrence set (rrule|cron + policy). Omit for a pure one-shot. */
  schedule?: ScheduleTrigger | null;
  /** Registered operation target. Omit to preserve the legacy system:plan-run path. */
  operation?: BlueprintOperationRoutineTarget | null;
  /** One-shot fire time (drag-onto-a-day). When set with no recurrence, the routine
   *  fires once at this instant then deactivates (claim.ts one-shot path). */
  scheduledAt?: Date | null;
  /** Overlap policy (D-014); the arming flow passes plan.schedule.concurrency. Default 'skip'. */
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
  /** Seed active (armed). Arming flow passes true; default true. */
  active?: boolean;
  /** Test seam. */
  sql?: Sql;
}

/**
 * Upsert the plan-schedule routine. Idempotent on (install_slug, name) — re-arming
 * the same plan upserts the one row. Returns the routine id + the computed next fire.
 */
export async function materializePlanSchedule(
  input: MaterializePlanScheduleInput,
): Promise<{ id: string; nextFireAt: Date | null }> {
  const sql = input.sql ?? getOrgPg().sql;
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const schedule = input.schedule ?? undefined;
  const operation = input.operation ?? undefined;
  const triggerConfig: Record<string, unknown> = schedule ? { ...schedule } : {};
  // ArmPlanSchedule carries the operation alongside the recurrence in the
  // authored schedule JSON. It belongs in payload_template, not in the cadence
  // parser's trigger_config.
  delete triggerConfig.operation;

  // First fire: an explicit one-shot time, else the schedule's next occurrence
  // (rrule or cron). Null ⇒ nothing to schedule (e.g. an already-expired rule).
  const next = input.scheduledAt ?? computeNextFire(schedule, new Date());

  const row = await upsertRoutine(
    sql,
    {
      workspaceId,
      installSlug: input.harnessSlug,
      name: planScheduleRoutineName(input.templateSlug),
      triggerKind: 'cron', // time-scheduled / next_fire_at-driven (cron OR rrule), per listDueCronRoutines
      triggerConfig,
      targetRole: operation ? BLUEPRINT_OPERATION_ACTION : PLAN_RUN_ACTION,
      payloadTemplate: operation
        ? {
            templateSlug: input.templateSlug,
            harnessSlug: input.harnessSlug,
            operationHarnessSlug: operation.harnessSlug,
            operationId: operation.operationId,
            input: operation.input ?? {},
          }
        : { templateSlug: input.templateSlug, harnessSlug: input.harnessSlug },
      concurrency: input.concurrency ?? 'skip',
      active: input.active ?? true,
      nextFireAt: next, // explicit override — upsertRoutine only auto-derives from cron
    },
    computeNextFireAt,
  );
  return { id: row.id, nextFireAt: row.nextFireAt };
}

/**
 * Disarm a plan's schedule — deactivate its routine (un-schedule / pause). The row is
 * kept (history + quick re-arm); a hard delete is the un-schedule-permanently path.
 */
export async function deactivatePlanSchedule(
  harnessSlug: string,
  templateSlug: string,
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  return setRoutineActive(sql, harnessSlug, planScheduleRoutineName(templateSlug), false);
}

/**
 * Permanently remove a plan's materialized schedule routine. Unlike disarming,
 * clearing both the recurrence and one-shot leaves nothing that can be re-armed,
 * so retaining an inactive routine would expose stale schedule inventory.
 * Idempotent: false means there was no materialized row to remove.
 */
export async function deletePlanSchedule(
  harnessSlug: string,
  templateSlug: string,
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  return deleteRoutine(sql, harnessSlug, planScheduleRoutineName(templateSlug));
}
