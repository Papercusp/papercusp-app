import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readTriggerOperationPayload, readTriggerPlanRunPayload } from '../../external-triggers/plan-run-payload';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

/**
 * The READ half of the external-trigger pair, mirroring `mail:reply { planRunId }`.
 *
 * Both take only `planRunId` and resolve everything else server-side from the
 * owner-local `trigger_runs` row, so the private ingest never has to travel
 * through a federated plan-run input to reach the agent (WI-2143575).
 *
 * Deliberately source-agnostic: the envelope shape is identical for gmail,
 * slack, gcal and every future adapter, so one reader serves all of them rather
 * than one near-duplicate tool per source.
 *
 * The workspace is resolved from the caller's own context and is NOT allowed to
 * fall back to an ambient default — this returns private content, so an
 * unscoped caller is refused rather than silently answered for some workspace.
 */
export default defineTool({
  name: 'triggers:read-payload',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Read the external event that triggered one plan run or trigger-fired operation (inbound Gmail message, Slack mention, calendar event), resolved server-side from planRunId or the operation work item id.',
  guidance: {
    when: 'An external-trigger plan item or trigger-fired operation tells you to read the triggering message. Pass payload.plan_run.runId as planRunId, or your operation work item id as workItemId.',
    notWhen:
      'A run that did not originate from an external trigger, or to browse other runs — this returns only the event for the run you name, inside your own workspace.',
    chaining:
      'triggers:read-payload → compose the response → mail:reply / slack:respond-in-thread with the SAME planRunId.',
    seeAlso: ['triggers:status (binding + run health)', 'mail:reply { planRunId } (the write half)'],
  },
  args: z
    .object({
      planRunId: z.number().int().positive().optional(),
      workItemId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if ((args.planRunId === undefined) === (args.workItemId === undefined)) {
      throw new Error('trigger_payload_target_required: pass exactly one of planRunId or workItemId');
    }
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('trigger_payload_workspace_required');
    const result =
      args.planRunId !== undefined
        ? await readTriggerPlanRunPayload(ctx.tx!, workspaceId, args.planRunId)
        : await readTriggerOperationPayload(ctx.tx!, workspaceId, args.workItemId!);
    return { data: { ok: true, ...result } };
  },
});
