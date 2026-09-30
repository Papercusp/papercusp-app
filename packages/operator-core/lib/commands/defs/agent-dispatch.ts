/**
 * agent.dispatch / agent.follow-up — direct chat-with-agent commands.
 *
 * Tagged for oracle + palette but NOT operator: the voice operator
 * routes anything that touches another agent through the operator brain/work-item
 * surfaces
 * (per Plan v6 phase C — the delegate writes a smarter prompt). These
 * exist so the user can fire a known dispatch from ⌘K without paying
 * the 5-10s delegate spawn cost.
 *
 * Both go through the same agent-chats Hono endpoints the MCP tools
 * use, so behavior is consistent across paths.
 */

import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type CommandDef } from '../types';

const DispatchArgs = z.object({
  slug: z.string().describe('Harness slug (use harness.list / agents.across-workspace to find).'),
  role: z.string().describe('Agent role (architect, orchestrator, scoper, worker, validator, reviewer, debugger, …).'),
  message: z.string().min(1).describe('First message to send the agent.'),
  featureId: z.string().optional().describe('Optional feature id to scope the chat (F-001, BRIEF-BRF-12).'),
});
type DispatchArgsT = z.infer<typeof DispatchArgs>;

const FollowUpArgs = z.object({
  slug: z.string(),
  chatId: z.string(),
  message: z.string().min(1),
});
type FollowUpArgsT = z.infer<typeof FollowUpArgs>;

const dispatch: CommandDef<DispatchArgsT, { ok: true; chatId: string; slug: string; role: string }> = {
  id: 'agent.dispatch',
  kind: 'command',
  description: 'Start a chat with a role-scoped agent in a harness and send the first message.',
  promptDescription:
    'Persistent chat — the harness spawns the role-scoped Claude on demand. Returns chatId. ' +
    'Use for "ask the architect to ..." / "have the orchestrator do ..." style asks.',
  schema: DispatchArgs,
  agents: ['oracle', 'palette'],
  browser: 'optional',
  concurrent: 'queue',
  tier: 'short',
  audit: 'full',
  handler: async ({ slug, role, message, featureId }) => {
    // Default port was :3155 (retired papercup-main worktree). Use process.env.PORT
    // first (Next sets it to whatever port the server bound on), then operator base, then dev fallback.
    const base = typeof window === 'undefined'
      ? (process.env.INTERNAL_API_BASE ?? process.env.PAPERCUSP_OPERATOR_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 3055}`)
      : '';
    const r = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, feature_id: featureId, title: featureId ? `${role} · ${featureId}` : role }),
    });
    if (!r.ok) {
      throw new CommandError({
        code: 'http-error',
        message: `agent-chat create failed: HTTP ${r.status}`,
        retryable: r.status >= 500,
      });
    }
    const chat = await r.json();
    // Fire-and-forget the first message — agent's reply is persisted.
    fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chat.id)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
    }).catch(() => {});
    return { ok: true, chatId: chat.id, slug, role };
  },
};

const followUp: CommandDef<FollowUpArgsT, { ok: true; chatId: string }> = {
  id: 'agent.follow-up',
  kind: 'command',
  description: 'Append a message to an existing agent chat by id.',
  schema: FollowUpArgs,
  agents: ['oracle', 'palette'],
  browser: 'optional',
  concurrent: 'queue',
  tier: 'short',
  audit: 'full',
  handler: async ({ slug, chatId, message }) => {
    const base = typeof window === 'undefined'
      ? (process.env.INTERNAL_API_BASE ?? process.env.PAPERCUSP_OPERATOR_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 3055}`)
      : '';
    const r = await fetch(
      `${base}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: message }),
      },
    );
    if (!r.ok) {
      throw new CommandError({
        code: 'http-error',
        message: `follow-up failed: HTTP ${r.status}`,
        retryable: r.status >= 500,
      });
    }
    return { ok: true, chatId };
  },
};

register(dispatch);
register(followUp);
