/**
 * agents.* — cross-harness agent visibility.
 *
 * Plan v6 phase E: enumerate role-scoped agents that have recent chat
 * activity across every harness in the workspace. Same surface the
 * delegate's MCP tool exposes, also wired to palette/voice for the
 * "Operator, what agents are working in this workspace" question.
 */
import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type QueryDef } from '../types';

const Args = z.object({
  slug: z.string().optional().describe('Optional — restrict to a single harness slug.'),
  limit: z.number().int().min(1).max(100).optional().default(40),
});
type ArgsT = z.infer<typeof Args>;

interface AgentRow {
  slug: string;
  role: string;
  chat_count: number;
  last_active: string | null;
}

const acrossWorkspace: QueryDef<ArgsT, AgentRow[]> = {
  id: 'agents.across-workspace',
  kind: 'query',
  description:
    'Enumerate role-scoped agents with recent chat activity across the workspace.',
  promptDescription:
    'Returns a list of {slug, role, chat_count, last_active} sorted by recency. ' +
    'Use to answer "which agents are working on X" or to find the most-active ' +
    'matching role before dispatching. Optional slug arg restricts to one harness.',
  schema: Args,
  agents: ['oracle', 'operator', 'palette'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async (args, ctx) => {
    void ctx;
    if (typeof window !== 'undefined') {
      // Browser path — go through the agents endpoint that also serves
      // the delegate panel's data.
      const params = new URLSearchParams();
      if (args.slug) params.set('slug', args.slug);
      params.set('limit', String(args.limit ?? 40));
      const r = await fetch(`/api/agent-mcp/agents?${params.toString()}`);
      if (!r.ok) {
        throw new CommandError({
          code: 'http-error',
          message: `agents query failed: HTTP ${r.status}`,
          retryable: r.status >= 500,
        });
      }
      const data = await r.json();
      return data.agents as AgentRow[];
    }
    // Server-side path — call the same logic the endpoint uses.
    const { listAgentsAcrossWorkspace } = await import('../../agents-list');
    return listAgentsAcrossWorkspace({ slug: args.slug, limit: args.limit ?? 40 });
  },
};

register(acrossWorkspace);
