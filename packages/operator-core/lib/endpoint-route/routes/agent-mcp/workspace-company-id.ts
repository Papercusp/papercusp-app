/**
 * GET/PUT /api/agent-mcp/workspace/company-id — Paperclip companyId.
 * Ported from app/api/agent-mcp/workspace/company-id/route.ts. `auth: 'public'`.
 */
import {
  activeWorkspaceId,
  setCompanyId,
  companyIdFor,
} from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/workspace/company-id',
  auth: 'public',
  async handler() {
    const workspaceId = activeWorkspaceId();
    return Response.json({
      workspaceId,
      companyId: companyIdFor(workspaceId),
    });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/workspace/company-id',
  auth: 'loopback',
  async handler(req) {
    const { companyId } = (await req.json()) as { companyId: string | null };
    const workspaceId = activeWorkspaceId();
    setCompanyId(workspaceId, companyId);
    return Response.json({ workspaceId, companyId });
  },
});

export default [get, put];
