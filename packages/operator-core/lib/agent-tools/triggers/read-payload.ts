import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readTriggerPlanRunPayload } from '../../external-triggers/plan-run-payload';
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
    'Read the external event that triggered one plan run — the inbound Gmail message, Slack mention, or calendar event — resolved server-side from planRunId.',
  guidance: {
    when: 'An external-trigger plan item tells you to read the triggering message. Pass payload.plan_run.runId as planRunId; the message is not embedded in the plan inputs.',
    notWhen:
      'A run that did not originate from an external trigger, or to browse other runs — this returns only the event for the planRunId you name, inside your own workspace.',
    chaining:
      'triggers:read-payload → compose the response → mail:reply / slack:respond-in-thread with the SAME planRunId.',
    seeAlso: ['triggers:status (binding + run health)', 'mail:reply { planRunId } (the write half)'],
  },
  args: z
    .object({
      planRunId: z.number().int().positive(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('trigger_payload_workspace_required');
    const result = await readTriggerPlanRunPayload(ctx.tx!, workspaceId, args.planRunId);
    return { data: { ok: true, ...result } };
  },
});
