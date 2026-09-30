/**
 * goals:set-schedule — author/update an EXISTING goal's activation SCHEDULE
 * (make it recurring, or clear it). The goal-level mirror of plans:set-schedule.
 *
 * Plan: work-on-everything-goal-2026-08-23 (P-020, D-006 ruling 3).
 *
 * Authoring does NOT arm (goals:arm-schedule is the separate, autonomy-gated
 * step) — the schedule is materialized as an INACTIVE `goal-schedule-<goalId>`
 * routine (the routine row IS the storage; goals have no schedule column — see
 * materialize-goal-schedule.ts). Pass `schedule: null` to clear (un-schedule).
 * Each armed fire dispatches `system:goal-start` → startGoalById, whose guards
 * (not-active / already-held) make an overlapping fire refuse, never double-spawn.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { validateRrule, frequencyWarning, type ScheduleTrigger } from '../../harness/routines/schedule-next';
import {
  deleteGoalSchedule,
  materializeGoalSchedule,
} from '../../harness/routines/materialize-goal-schedule';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

const scheduleSchema = z
  .object({
    kind: z.enum(['rrule', 'cron']).describe('Recurrence dialect.'),
    rrule: z.string().optional().describe('RRULE string (RFC 5545), e.g. FREQ=WEEKLY;BYDAY=MO.'),
    dtstart: z.string().optional().describe('DTSTART anchor (ISO) — required for INTERVAL/COUNT/UNTIL.'),
    tzid: z.string().optional().describe('IANA tz id for calendar-time recurrence (DST-safe).'),
    rdate: z.array(z.string()).optional().describe('Extra one-off occurrences (RDATE, ISO).'),
    exdate: z.array(z.string()).optional().describe('Excluded occurrences (EXDATE, ISO).'),
    cron: z.string().optional().describe('Cron dialect (5/6-field) — the alternate input.'),
  })
  .describe('The recurrence set. Omit/null to clear (un-schedule).');

const argsSchema = z.object({
  harness: harnessArg,
  goalId: z.string().min(1).describe('The EXISTING goal to activate on each fire.'),
  schedule: scheduleSchema.nullable().optional(),
});

export default defineTool({
  name: 'goals:set-schedule',
  needsWorkspaceTx: true,
  description:
    "Author or clear a goal's activation schedule — each armed fire starts the goal's holder via the startGoalById primitive (refusing when it is already held / not active). Validates the RRULE. Does NOT arm (goals:arm-schedule does); pass schedule:null to un-schedule.",
  guidance: {
    when: "Making an existing goal start on a cadence (RRULE or cron), editing that cadence, or clearing it.",
    notWhen:
      'Arming a saved schedule so it fires — goals:arm-schedule. Starting the goal once, now — goals:start / the startGoalById doors.',
    chaining: 'goals:set-schedule → goals:arm-schedule → the routine fires system:goal-start on cadence.',
    seeAlso: ['goals:arm-schedule (arm it after authoring — autonomy-gated)'],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sched = args.schedule;
    if (sched) {
      const wantsRrule = sched.kind === 'rrule' || (!!sched.rrule && !sched.cron);
      if (wantsRrule) {
        if (!sched.rrule) return errorOut('rrule_required', 'schedule.kind=rrule requires schedule.rrule');
        const v = validateRrule(sched.rrule);
        if (!v.ok) return errorOut('invalid_rrule', v.error);
      } else if (sched.kind === 'cron' && !sched.cron) {
        return errorOut('cron_required', 'schedule.kind=cron requires schedule.cron');
      }
    }

    const scoped = harnessScopedCtx(args.harness, ctx);
    const workspaceId =
      scoped.workspaceId && scoped.workspaceId !== '*' ? scoped.workspaceId : activeWorkspaceId();
    if (!workspaceId) return errorOut('no_workspace', 'no concrete workspace in scope');
    const harnessSlug = scoped.harnessSlug !== '*' ? scoped.harnessSlug : null;
    if (!harnessSlug) return errorOut('no_harness', 'pass a CONCRETE `harness` — the goal-schedule routine needs an install slug');

    // The goal must EXIST; its status is reported but not gated here — the
    // primitive refuses a non-active goal at fire time, and a schedule authored
    // ahead of an unpause is legitimate.
    const goals = await scoped.tx<Array<{ id: string; status: string }>>`
      SELECT id, status FROM harness_shared.goals
       WHERE workspace_id = ${workspaceId} AND id = ${args.goalId}
       LIMIT 1`;
    if (!goals[0]) return errorOut('goal_not_found', `goal '${args.goalId}' not found`);
    await assertGoalWriteAuthorityForCaller(scoped, workspaceId, scoped.tx as never);

    if (sched == null) {
      // Clearing un-authors entirely: the routine row IS the storage.
      const removed = await deleteGoalSchedule(harnessSlug, args.goalId);
      return out({ ok: true, goalId: args.goalId, scheduled: false, removed });
    }

    const res = await materializeGoalSchedule({
      workspaceId,
      harnessSlug,
      goalId: args.goalId,
      schedule: sched as ScheduleTrigger,
      active: false,
    });
    const warn = frequencyWarning(sched as ScheduleTrigger, new Date());
    return out({
      ok: true,
      goalId: args.goalId,
      goalStatus: goals[0].status,
      scheduled: true,
      armed: false,
      routineId: res.id,
      nextFireAtWhenArmed: res.nextFireAt,
      ...(warn ? { warnings: [warn] } : {}),
    });
  },
});

function out(body: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}

function errorOut(code: string, detail?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, ...(detail ? { detail } : {}) }) }],
    isError: true,
  };
}
