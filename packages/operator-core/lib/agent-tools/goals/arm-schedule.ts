/**
 * goals:arm-schedule — arm (or pause) a goal's authored activation schedule.
 * The goal-level mirror of plans:arm-schedule / plans:disarm-schedule.
 *
 * Plan: work-on-everything-goal-2026-08-23 (P-020, D-006 ruling 3).
 *
 * Authoring (goals:set-schedule) does NOT arm; this does — it re-reads the
 * stored recurrence off the materialized routine, recomputes the next fire, and
 * activates it so the engine fires `system:goal-start` on cadence. Autonomy-
 * gated the same way plan schedule arming is (the schedule-arm category).
 * `disarm: true` pauses the armed schedule (routine kept — it IS the storage).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  armGoalSchedule,
  deactivateGoalSchedule,
} from '../../harness/routines/materialize-goal-schedule';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

const argsSchema = z.object({
  harness: harnessArg,
  goalId: z.string().min(1).describe('The goal whose authored schedule to arm (or pause).'),
  disarm: z
    .boolean()
    .optional()
    .describe('true = pause the armed schedule instead (routine kept for re-arming).'),
});

export default defineTool({
  name: 'goals:arm-schedule',
  description:
    "Arm a goal's authored schedule so it starts firing system:goal-start on its cadence (goals:set-schedule authors but does not arm). disarm:true pauses it. Autonomy-gated (schedule-arm category).",
  guidance: {
    when: 'Activating a schedule you already authored with goals:set-schedule — or pausing it (disarm:true).',
    notWhen: 'Authoring/editing the cadence (goals:set-schedule). Starting the goal once, now (goals:start).',
    chaining: 'goals:set-schedule → goals:arm-schedule → the routine fires system:goal-start on cadence.',
    seeAlso: ['goals:set-schedule (author the schedule to arm; schedule:null clears it)'],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (!(await getFlag(FLAGS.GOAL_SCHEDULES, 'system'))) {
      return errorOut('feature_disabled', 'the papercusp-goal-schedules flag is off');
    }
    const scoped = harnessScopedCtx(args.harness, ctx);
    const workspaceId =
      scoped.workspaceId && scoped.workspaceId !== '*' ? scoped.workspaceId : activeWorkspaceId();
    if (!workspaceId) return errorOut('no_workspace', 'no concrete workspace in scope');
    const harnessSlug = scoped.harnessSlug !== '*' ? scoped.harnessSlug : null;
    if (!harnessSlug) return errorOut('no_harness', 'pass a CONCRETE `harness`');
    await assertGoalWriteAuthorityForCaller(scoped, workspaceId, scoped.tx as never);

    if (args.disarm) {
      const paused = await deactivateGoalSchedule(harnessSlug, args.goalId);
      if (!paused) return errorOut('not_scheduled', 'no materialized schedule to disarm — author one with goals:set-schedule');
      return out({ ok: true, goalId: args.goalId, armed: false });
    }

    const res = await armGoalSchedule({ workspaceId, harnessSlug, goalId: args.goalId });
    if (!res.ok) {
      return errorOut('not_scheduled', 'author a schedule with goals:set-schedule first');
    }
    return out({ ok: true, goalId: args.goalId, armed: true, routineId: res.routineId, nextFireAt: res.nextFireAt });
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
