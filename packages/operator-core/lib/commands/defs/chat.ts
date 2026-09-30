/**
 * chat.* — agent chat queries + open-pane action.
 *
 * Reflects what voice / Oracle need: list recent chats, jump to a chat
 * pane (browser-only). chat.dispatch (start a new chat) lands in PR 3
 * since it's the operator delegation pattern's main feature.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef, QueryDef } from '../types';
import { navigateClient } from '../../client-navigation';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const ListArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  role: z.string().nullable().optional().describe('Optional role filter (architect, orchestrator, ...).'),
  limit: z.number().int().min(1).max(100).default(20).describe('Max rows (default 20, cap 100).'),
});

const chatList: QueryDef<z.infer<typeof ListArgs>> = {
  id: 'chat.list',
  kind: 'query',
  description: 'List recent agent chats in a harness (optionally filter by role).',
  promptDescription:
    'Returns chats as [{id, role, title, feature_id, message_count, updated_at}], ' +
    'sorted by recency. Use to answer "what chats are open" or to find a chatId ' +
    'before chat.open-pane.',
  schema: ListArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, role, limit }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/agent-chats`);
    if (!r.ok) throw new Error(`chat.list failed: HTTP ${r.status}`);
    const d = await r.json();
    const chats = (Array.isArray(d?.chats) ? d.chats : [])
      .filter((c: any) => !role || c.role === role)
      .map((c: any) => ({
        id: c.id,
        role: c.role,
        title: c.title,
        feature_id: c.feature_id ?? null,
        message_count: Array.isArray(c.transcript) ? c.transcript.length : 0,
        updated_at: c.updated_at,
      }))
      .sort((a: any, b: any) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit);
    return { slug, count: chats.length, chats };
  },
};

const OpenPaneArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  chatId: z.string().min(1).describe('Chat id from chat.list.'),
});

const chatOpenPane: CommandDef<z.infer<typeof OpenPaneArgs>> = {
  id: 'chat.open-pane',
  kind: 'command',
  description: 'Open the chat panel in the harness dashboard for a specific chatId.',
  promptDescription:
    'Navigates the harness UI to the agent-chats panel and opens the given chat ' +
    'so the user can see the transcript. Use after chat.list to take the user to ' +
    'a specific conversation.',
  schema: OpenPaneArgs,
  agents: ['oracle', 'operator', 'palette'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  handler: async ({ slug, chatId }) => {
    if (typeof window === 'undefined') {
      // Shouldn't happen — registry gates 'required' commands at the
      // ctx.sessionId check. But guard anyway.
      throw new Error('chat.open-pane must run in the browser process');
    }
    const target = `/harness?ws=${encodeURIComponent(getWs())}&project=${encodeURIComponent(slug)}&chat=${encodeURIComponent(chatId)}`;
    navigateClient(target);
    return { slug, chatId, navigated: true };
  },
};

function getWs(): string {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get('ws') ?? 'default';
  } catch { return 'default'; }
}

register(chatList);
register(chatOpenPane);
