/**
 * GET /api/agent-mcp/operator-multi-workspace — other workspaces' last-scan aggregation.
 * Ported from app/api/agent-mcp/operator-multi-workspace/route.ts. `auth: 'public'`.
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { readMultiWorkspaceSnapshot } from '../../../operator-multi-workspace';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-multi-workspace',
  auth: 'public',
  async handler() {
    const snap = await readMultiWorkspaceSnapshot(activeWorkspaceId());
    return Response.json(snap);
  },
});
