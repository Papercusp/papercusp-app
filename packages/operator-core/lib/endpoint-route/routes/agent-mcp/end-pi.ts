/**
 * POST /api/agent-mcp/end-pi — end a pi session.
 * Ported from app/api/agent-mcp/end-pi/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { endPiSession } from '@papercusp/agent-mcp/provisioning';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/end-pi',
  auth: 'loopback',
  async handler(req) {
    const { sessionId } = (await req.json()) as { sessionId: string };
    if (!sessionId) {
      return Response.json({ error: 'sessionId required' }, { status: 400 });
    }
    await endPiSession(activeWorkspaceId(), sessionId);
    return Response.json({ ok: true });
  },
});
