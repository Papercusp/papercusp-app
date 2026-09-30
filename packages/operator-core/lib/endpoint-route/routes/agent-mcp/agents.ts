/**
 * GET /api/agent-mcp/agents?slug=&limit= — agents.across-workspace list.
 * Ported from app/api/agent-mcp/agents/route.ts. `auth: 'public'`.
 */
import { listAgentsAcrossWorkspace } from '../../../agents-list';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/agents',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const slug = url.searchParams.get('slug') ?? undefined;
    const limit = url.searchParams.get('limit')
      ? Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit')!, 10) || 40))
      : 40;
    const agents = await listAgentsAcrossWorkspace({ slug, limit });
    return Response.json({ agents });
  },
});
