/**
 * agents:list — workspace-wide listing of agents (delegate MCP server's
 * listAgents data via the operator's PG side). Mirrors GET
 * /api/agent-mcp/agents.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listAgentsAcrossWorkspace } from '../../agents-list';

export default defineTool({
  name: 'agents:list',
  profile: 'engineer',
  description: 'List agents across the workspace (optionally filtered by harness slug). Limit clamped 1..100, default 40.',
  capability: 'agents:read',
  guidance: {
    when: 'User asks "which agents are working on X?", "what crew does sheets have?", or you need to pick the most-active matching role before calling agent_chats:create.',
    notWhen: 'For active CHAT sessions, use `agent_chats:list`. agents:list is who-exists; agent_chats:list is what-conversations.',
    chaining: 'Pair with `agent_chats:create` once you\'ve picked the role to dispatch to.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async handler(args) {
    const agents = await listAgentsAcrossWorkspace({
      slug: args.slug,
      limit: args.limit ?? 40,
    });
    return { data: { agents } };
  },
});
