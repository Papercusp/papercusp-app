/**
 * GET /api/agent-mcp/decisions?limit=N — operator_decisions view read.
 * Ported from app/api/agent-mcp/decisions/route.ts. `auth: 'public'`.
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/decisions',
  auth: 'public',
  async handler(req) {
    const limit = Math.min(
      Number(new URL(req.url).searchParams.get('limit') ?? 50),
      500,
    );
    const workspaceId = activeWorkspaceId();
    const rows = await withWorkspace(workspaceId, async (tx) => {
      return await tx<
        Array<{ id: string; ts: number; actor: string; action: string; target: string; details: unknown }>
      >`
        SELECT id, ts, actor, action, target, details
          FROM harness_shared.operator_decisions
         ORDER BY ts DESC
         LIMIT ${limit}
      `;
    }).catch(() => [] as any[]);
    return Response.json({ workspaceId, rows });
  },
});
