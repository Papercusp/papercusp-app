import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { replyToCanonicalChat } from '../../capability-verbs/chat';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'chat:reply',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply in the thread of one chat message the owner already has, named by its canonical messageId. You supply TEXT ONLY: the server resolves channel and thread from the stored message, so this tool cannot post somewhere else or read the token. Provider-neutral (Slack today).',
  guidance: {
    when: 'The owner asks you to answer a specific chat message or thread. Locate it with personal:search and pass the externalId it returns.',
    notWhen:
      'Posting into a channel you name yourself — that is chat:post, which checks the destination. Not for email (mail:reply).',
    chaining: 'personal:search → externalId → chat:reply. Report the echoed channelId/threadId as evidence.',
  },
  args: z
    .object({
      messageId: z.string().trim().min(1).max(512),
      text: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('chat_reply_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:slack']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await replyToCanonicalChat(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        messageId: args.messageId,
        text: args.text,
        agentOwnerId: disclosureSubject(ctx),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});
