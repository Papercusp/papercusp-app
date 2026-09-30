/**
 * agent_chats:list — list multi-turn chat sessions for a harness slug.
 *
 * Calls listChats() in lib/agent-chats-data.ts directly — same function
 * the GET /api/harness/:slug/agent-chats route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listChats } from '../../agent-chats-data';

export default defineTool({
  name: 'agent_chats:list',
  description:
    'List multi-turn chat sessions for a harness slug (active by default; pass includeArchived=true to see all). Bounded: limit clamped 1..100, default 100; page older chats with offset. Rows are summaries (turn_count, tokens, cost, timestamps) WITHOUT the transcript body — use agent_chats:get for a chat\'s turns.',
  capability: 'agent_chats:read',
  guidance: {
    when: 'User asks "what chats have I had with X?", "show me the conversations on sheets", or you need a chatId before resuming via ui:dispatch.',
    notWhen: 'For agents (who exists), use `agents:list`. For the transcript of a SPECIFIC chat, use `agent_chats:get`.',
    chaining: 'Pair with `agent_chats:get` for detail on one chat, or `ui:dispatch` with `/harness/<slug>?chat=<chatId>` to take the user to it.',
    seeAlso: [
      'agent_chats:get (full detail on one chat)',
      'agent_chats:create (start a new chat)',
      'agent_chats:archive (archive a chat)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  async handler(args) {
    const result = await listChats(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: result.data.chats.length, chats: result.data.chats }),
        },
      ],
    };
  },
});
