/**
 * agent_chats:create — open a new chat session in a harness for a given
 * role (optionally bound to a feature_id). Streaming message exchange
 * stays on the dedicated SSE route.
 *
 * Calls createChat() in lib/agent-chats-data.ts directly — same function
 * the POST /api/harness/:slug/agent-chats route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createChat } from '../../agent-chats-data';

export default defineTool({
  name: 'agent_chats:create',
  description:
    'Open a new chat session for a role in a harness; optionally bind it to a feature_id.',
  capability: 'agent_chats:write',
  guidance: {
    when: 'User says "ask the architect to ...", "have the worker do ...", or you\'re routing a request to a role-scoped agent. Step 1 of the two-step dispatch flow.',
    notWhen: 'For replying in the user\'s direct chat, just speak — don\'t spin up a new agent chat. For reaching another AGENT, use `coord:send`. For spawning a one-shot agent process (not a long-running chat), use `<spawn>` / `orchestrator.spawn`.',
    chaining: 'Pair with `agent_chats:send_message` immediately (step 2 of the dispatch flow), then `ui:dispatch` with `/harness/<slug>?chat=<chatId>` so the user can watch the conversation.',
    seeAlso: [
      'agent_chats:send_message (step 2 — send the first message)',
      'agent_chats:list (resume an existing chat instead of creating)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { worker: { perChunk: 5 }, operator: { perRun: 50 } },
  args: z.object({
    slug: z.string().min(1),
    role: z.string().min(1),
    feature_id: z.string().optional(),
    title: z.string().optional(),
  }),
  async handler(args) {
    const result = await createChat(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
