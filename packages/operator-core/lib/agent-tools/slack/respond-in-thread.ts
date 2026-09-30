import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { respondToSlackTriggerPlanRun } from '../../external-triggers/slack-flagship';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'slack:respond-in-thread',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply to the Slack thread that originated one completed external-trigger plan run. The server resolves source/channel/thread/credential from planRunId; callers cannot redirect the post or read the token.',
  guidance: {
    when: 'A Slack-triggered plan item asks you to respond to the originating mention. Read payload.plan_run.runId from the claimed work item and pass it with the final response text.',
    notWhen:
      'General Slack posting or a run that did not originate from an ext:slack event. This tool refuses arbitrary channel/thread coordinates.',
    chaining:
      'After posted:true or alreadyPosted:true, complete the plan-run work item with the returned messageTs as evidence.',
  },
  args: z
    .object({
      planRunId: z.number().int().positive(),
      text: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('slack_reply_workspace_required');
    const result = await respondToSlackTriggerPlanRun(ctx.tx!, workspaceId, args.planRunId, args.text);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...result }) }] };
  },
});
