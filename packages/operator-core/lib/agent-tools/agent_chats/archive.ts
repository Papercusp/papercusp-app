/**
 * agent_chats:archive — archive (soft-delete) a chat session. Sets
 * archived_at; the chat stops appearing in default list results.
 *
 * Calls archiveChat() in lib/agent-chats-data.ts directly — same function
 * the DELETE /api/harness/:slug/agent-chats/:chatId route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { archiveChat } from '../../agent-chats-data';

export default defineTool({
  name: 'agent_chats:archive',
  guidance: {
    when: 'User says "close that chat", "archive the X conversation" — moves the chat to archived status so it stops appearing in active lists.',
    notWhen: 'For DELETING a chat, this isn\'t it — archive is reversible. For UI dismissing without changing state, ignore the request and the user can do it themselves.',
    chaining: 'Pair with `agent_chats:list` first if you need to confirm the chatId.',
    seeAlso: [
      'agent_chats:list (confirm the chatId first)',
      'agent_chats:get (inspect a chat before archiving)',
    ],
  },
  description: 'Archive (soft-delete) a chat session by id.',
  capability: 'agent_chats:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { worker: { perChunk: 5 }, operator: { perRun: 50 } },
  args: z.object({
    slug: z.string().min(1),
    chatId: z.string().min(1),
  }),
  async handler(args) {
    const result = await archiveChat(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
