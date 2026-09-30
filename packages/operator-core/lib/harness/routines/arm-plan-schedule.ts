/**
 * Arm / disarm a scheduled plan — flip `schedule_active` and (de)materialize its routine.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 *
 * Authoring a schedule (plans:set-schedule) does NOT make it fire — arming does. Arming
 * is an autonomy-gated action: the capability→category map classifies plans:arm-schedule
 * as the (non-protected, never-auto-by-default) `schedule-arm` category (D-017), so the
 * Queen's dispatch gate blocks an autonomous arm (escalates to the owner) until that
 * category is graduated; the owner arms directly. This module is the MECHANISM the tool
 * calls once arming is authorized — it does not itself re-check the gate.
 *
 * `sql` is an explicit seam (admin pool in prod, the testcontainers client in tests).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  materializePlanSchedule,
  deactivatePlanSchedule,
  type BlueprintOperationRoutineTarget,
} from './materialize-plan-schedule';
import type { ScheduleTrigger } from './schedule-next';

export interface ArmPlanScheduleInput {
  sql?: Sql;
  /**
   * ⚠ REQUIRED (WI-5825). `harness_plans` is keyed on (workspace_id, harness_slug,
   * plan_slug), so the tenant must come from the PLAN — `plan.workspaceId` from a
   * plan read, or `tpl[0].workspace_id` from the template row — never from the
   * ambient `activeWorkspaceId()`. This used to be optional with an
   * `?? activeWorkspaceId()` fallback: every caller happens to pass it today, so the
   * fallback was unreached, but it left the trap armed for the next one, and a
   * mis-keyed UPDATE here matches 0 rows in silence — the plan simply never arms (or
   * never disarms) while the call returns ok. Requiring it makes the COMPILER catch
   * an omission instead. See plans/_write-scope.ts for the three shipped generations.
   */
  workspaceId: string;
  harnessSlug: string;
  templateSlug: string;
  /** The plan's authored recurrence (from the schedule column). */
  schedule?: (ScheduleTrigger & {
    concurrency?: 'queue' | 'skip' | 'cancel-prev';
    operation?: BlueprintOperationRoutineTarget;
  }) | null;
  /** The plan's one-shot time (from the scheduled_at column). */
  scheduledAt?: Date | string | null;
  /** Overlap policy (from schedule.concurrency). */
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
}

export type ArmResult =
  | { ok: true; routineId: string; nextFireAt: Date | null }
  | { ok: false; reason: 'not_scheduled' };

/**
 * Arm a plan's schedule: set schedule_active=true and materialize its routine (which
 * fires system:plan-run on the computed next_fire_at). Refuses a plan with neither a
 * recurrence nor a one-shot time (nothing to fire).
 */
export async function armPlanSchedule(input: ArmPlanScheduleInput): Promise<ArmResult> {
  if (!input.schedule && !input.scheduledAt) return { ok: false, reason: 'not_scheduled' };
  const sql = input.sql ?? getOrgPg().sql;
  const { workspaceId } = input;

  await sql`
    UPDATE harness_shared.harness_plans
       SET schedule_active = true, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.harnessSlug}
       AND plan_slug = ${input.templateSlug}
  `;

  const mat = await materializePlanSchedule({
    sql,
    workspaceId,
    harnessSlug: input.harnessSlug,
    templateSlug: input.templateSlug,
    schedule: input.schedule ?? undefined,
    operation: input.schedule?.operation,
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
    concurrency: input.concurrency ?? input.schedule?.concurrency,
    active: true,
  });
  return { ok: true, routineId: mat.id, nextFireAt: mat.nextFireAt };
}

/**
 * Disarm a plan's schedule: set schedule_active=false and deactivate its routine. The
 * authored schedule columns are kept (re-arming is one call); only firing stops.
 */
export async function disarmPlanSchedule(input: {
  sql?: Sql;
  /** ⚠ REQUIRED (WI-5825) — see {@link ArmPlanScheduleInput.workspaceId}. */
  workspaceId: string;
  harnessSlug: string;
  templateSlug: string;
}): Promise<{ ok: true }> {
  const sql = input.sql ?? getOrgPg().sql;
  const { workspaceId } = input;
  await sql`
    UPDATE harness_shared.harness_plans
       SET schedule_active = false, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.harnessSlug}
       AND plan_slug = ${input.templateSlug}
  `;
  await deactivatePlanSchedule(input.harnessSlug, input.templateSlug, { sql });
  return { ok: true };
}
