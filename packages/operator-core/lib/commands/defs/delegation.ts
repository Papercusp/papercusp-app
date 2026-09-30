/**
 * Retired delegate-session history surface.
 *
 * `delegate_to_claude` / `delegate_to_agent` were retired on 2026-06-21.
 * Keep the delegates.list/get/search queries so old records remain readable,
 * but do not register any command that starts or resumes delegate work.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

// ─── Queries: delegates.list / delegates.get ─────────────

const ListDelegatesArgs = z.object({
  status: z.enum(['open', 'archived', 'all']).default('open').optional()
    .describe('Filter by status. Default: open.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max sessions to return (default 20, cap 50).'),
});

const claudeSessionsList: QueryDef<z.infer<typeof ListDelegatesArgs>> = {
  id: 'delegates.list',
  kind: 'query',
  description: 'List retired delegate conversation sessions for the workspace.',
  promptDescription:
    'Returns retired delegate conversation sessions as ' +
    '[{id, title, summary, lastActiveAt, turnCount, agentSessionId, status}, ...]. ' +
    "Use only to answer questions about historical delegate records. " +
    "\n\nIMPORTANT: status='open' means 'available to resume' — NOT 'currently " +
    "running'. The delegate launch/resume commands are retired. A delegate " +
    "session listed here is a historical record. Never tell the user 'the delegate is still " +
    "running' based on this list — if you want to know how recently a session " +
    "was active, use lastActiveAt. status='archived' means the user explicitly " +
    "dismissed it.",
  schema: ListDelegatesArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ status, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      // Browser-side: fetch via API endpoint to avoid pulling PG into the bundle.
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/delegates?${params}`);
      if (!r.ok) throw new Error(`delegates.list failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { listDelegatedSessions } = await import('../../delegated-tasks');
    const rows = await listDelegatedSessions({ status, limit });
    return { sessions: rows };
  },
};

const GetSessionArgs = z.object({
  id: z.string().min(1).describe('Session id (numeric or agent_session_id UUID).'),
});

const claudeSessionsGet: QueryDef<z.infer<typeof GetSessionArgs>> = {
  id: 'delegates.get',
  kind: 'query',
  description: 'Get full metadata for a single retired delegate conversation session.',
  promptDescription:
    'Returns the long-form summary + last-activity for a given session. ' +
    'Use when answering questions about historical delegate records.',
  schema: GetSessionArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ id }, ctx) => {
    if (typeof window !== 'undefined') {
      const r = await fetch(`/api/agent-mcp/delegates?id=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`delegates.get failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { getDelegatedSession } = await import('../../delegated-tasks');
    const row = await getDelegatedSession(id);
    return { session: row };
  },
};

// ─── Query: delegates.search ─────────────────────────────────────────

const SearchDelegatesArgs = z.object({
  query: z.string().min(1).describe('Free-text needle. Matches against title, summary, and the kickoff message.'),
  limit: z.number().int().min(1).max(50).default(10).optional()
    .describe('Max sessions to return (default 10).'),
});

const claudeSessionsSearch: QueryDef<z.infer<typeof SearchDelegatesArgs>> = {
  id: 'delegates.search',
  kind: 'query',
  description: 'Search retired delegate conversation sessions by free-text (title/summary/kickoff).',
  promptDescription:
    'Returns matching sessions as { sessions: [{id, title, summary, lastActiveAt, ...}, ...] }. ' +
    'Use only when the user asks about historical delegate records. Delegate resume/start is retired.',
  schema: SearchDelegatesArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ query, limit }, ctx) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      const r = await fetch(`/api/agent-mcp/delegates?${params}`);
      if (!r.ok) throw new Error(`delegates.search failed: HTTP ${r.status}`);
      return await r.json();
    }
    const { searchDelegatedSessions } = await import('../../delegated-tasks');
    const rows = await searchDelegatedSessions(query, limit);
    return { sessions: rows };
  },
};

register(claudeSessionsSearch);
register(claudeSessionsList);
register(claudeSessionsGet);
