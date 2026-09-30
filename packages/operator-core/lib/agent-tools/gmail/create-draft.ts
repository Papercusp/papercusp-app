import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { draftResponseToGmailTriggerPlanRun } from '../../external-triggers/gmail-flagship';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'gmail:create-draft',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Create a Gmail draft reply for one completed external-trigger plan run. The server resolves recipient, thread, reply headers, and OAuth credential from planRunId; this tool never sends mail.',
  guidance: {
    when: 'A Gmail-triggered plan item asks you to draft a response to the originating inbound message. Read payload.plan_run.runId and pass it with the draft body.',
    notWhen:
      'Sending email, composing unrelated mail, or a run that did not originate from ext:gmail:message.received. This tool cannot redirect the recipient or thread.',
    chaining:
      'After created:true or alreadyCreated:true, complete the plan-run work item with draftId and messageId as evidence. A human reviews/sends the draft in Gmail.',
  },
  args: z
    .object({
      planRunId: z.number().int().positive(),
      text: z.string().trim().min(1).max(100_000),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('gmail_draft_workspace_required');
    const result = await draftResponseToGmailTriggerPlanRun(ctx.tx!, workspaceId, args.planRunId, args.text);
    return { data: { ok: true, ...result } };
  },
});
