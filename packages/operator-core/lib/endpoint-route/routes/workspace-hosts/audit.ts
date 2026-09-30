/** Download one workspace host's redacted durable audit bundle. */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { exportWorkspaceHostAudit } from '../../../workspace-host/observability-store';

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export default defineTool({
  method: 'GET',
  path: '/workspace-hosts/:workspaceId/audit',
  auth: 'loopback',
  async handler(_req, ctx) {
    const hostId = String(ctx.params.workspaceId ?? '').trim();
    if (!HOST_ID.test(hostId)) {
      return Response.json({ error: 'invalid workspace host id' }, { status: 400 });
    }

    const audit = await exportWorkspaceHostAudit(activeWorkspaceId(), hostId);
    if (!audit) return Response.json({ error: 'workspace host not found' }, { status: 404 });

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(audit, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="papercusp-workspace-host-${hostId}-audit-${stamp}.json"`,
      },
    });
  },
});
