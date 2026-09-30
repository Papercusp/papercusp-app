/**
 * POST /api/dev/processes/kill — dashboard-only kill endpoint.
 *
 * The dashboard browser caller can't attach the bearer required by the
 * principal-bound `processes:kill` MCP tool; this route is its dashboard
 * path. Function-as-truth — same killProcess lib, just a different
 * transport gate.
 *
 * Ported from app/api/dev/processes/kill/route.ts. `auth: {}` — any
 * authenticated principal (the auth posture set in the Phase 3b
 * consolidate sweep). Faithful port of that posture (D3).
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { killProcess } from '../../../process-kill';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/dev/processes/kill',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let body: { pid?: number; signal?: 'SIGTERM' | 'SIGKILL' };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid json' }, { status: 400 });
    }
    if (typeof body.pid !== 'number' || body.pid <= 0) {
      return Response.json({ error: 'pid required' }, { status: 400 });
    }
    const result = await killProcess({
      pid: body.pid,
      signal: body.signal,
      actorSlug: 'system:dev-page',
      workspaceId: activeWorkspaceId(),
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  },
});
