/**
 * plans:set-run-status — manually transition a plan run's status.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-016). The manual half of
 * the run-status lifecycle: a human (or agent) sets a settled run to
 * `archived` (set aside — still resumable), `done` (deliberately
 * concluded), or `idle` (un-archive / reopen). The automatic
 * transitions — the launch/resume turn settle and the orphan + idle
 * sweep (`sweepPlanRuns`) — are machine-driven and not reachable here.
 *
 * A `running` run is mid-turn and is rejected (`run_busy`): a manual
 * restatus would race the turn's own settle.
 *
 * Not to be confused with `plans:set-status`, which flips a plan
 * *item* (`P-NNN`) status — this verb is about *run* lifecycle.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { canManuallyRestatusRun, getPlanRun, setPlanRunStatus } from './runs';

const argsSchema = z.object({
  runId: z
    .number()
    .int()
    .positive()
    .describe('Id of the plan run to restatus (from plans:runs).'),
  status: z
    .enum(['archived', 'done', 'idle'])
    .describe(
      "New status: 'archived' (set aside — still resumable), 'done' " +
        "(deliberately concluded), or 'idle' (un-archive / reopen).",
    ),
});

type RunStatusArgs = z.infer<typeof argsSchema>;

function err(fields: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(fields) }],
  };
}

export default defineTool({
  name: 'plans:set-run-status',
  description:
    "Manually transition a plan run's status — archive it (set aside, still resumable), mark it done (deliberately concluded), or set it idle (un-archive / reopen). A run that is currently running is rejected. Distinct from plans:set-status, which is for plan items.",
  guidance: {
    when: 'You want to archive a finished run, mark a run done, or un-archive one — a deliberate lifecycle change a human/agent makes.',
    notWhen:
      'The run is mid-turn (let it settle, or resume it). Flipping a plan *item* status is plans:set-status. Continuing a run is plans:resume.',
    chaining: 'plans:runs → plans:set-run-status { runId, status }.',
    seeAlso: [
      'plans:runs (find the runId)',
      'plans:run-transcript (inspect the run before changing status)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  async handler(args: RunStatusArgs, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const run = await getPlanRun(args.runId);
    if (!run) return err({ error: 'not_found', runId: args.runId });

    if (!canManuallyRestatusRun(run.status)) {
      return err({
        error: 'run_busy',
        runId: args.runId,
        status: run.status,
        message:
          'the run is currently running — wait for the turn to finish ' +
          '(an orphaned run is auto-failed by the sweep after 30 min)',
      });
    }

    await setPlanRunStatus(args.runId, args.status);
    ctxAny.metadata?.({
      runId: args.runId,
      from: run.status,
      to: args.status,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            runId: args.runId,
            status: args.status,
            previousStatus: run.status,
          }),
        },
      ],
    };
  },
  args: argsSchema,
});
