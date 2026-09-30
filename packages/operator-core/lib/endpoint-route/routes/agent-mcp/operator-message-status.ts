/**
 * GET /api/agent-mcp/operator-message-status?ids=… — batch message status.
 * Ported from app/api/agent-mcp/operator-message-status/route.ts. `auth: 'public'`.
 */
import { readMessageStatuses } from '../../../operator-message-status';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-message-status',
  auth: 'public',
  async handler(req) {
    const idsParam = new URL(req.url).searchParams.get('ids') ?? '';
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return Response.json({ rows: [] });
    const rows = await readMessageStatuses(ids);
    return Response.json({ rows });
  },
});
