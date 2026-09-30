/** Optional pack installation through the fixed privileged initializer and durable host queue. */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { dbosStarted } from '../../../dbos/bootstrap';
import {
  startWorkspaceHostDesktopPackWorkflow,
  WorkspaceHostOperationIdentityConflictError,
  WorkspaceHostProvisioningConflictError,
} from '../../../dbos/workspace-host-provision-workflow';
import { activeWorkspaceId } from '../../../workspace-registry';
import { prepareWorkspaceHostDesktopPack } from '../../../workspace-host/initialization-admission';
import { defaultWorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
} from '../../../workspace-host/initialization-operations-resolver';

export default defineTool({
  method: 'POST', path: '/workspace-hosts/:hostId/desktop-pack', auth: 'loopback',
  async handler(req, ctx) {
    const hostId = String(ctx.params.hostId ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(hostId)) {
      return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
    }
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'operationId') ||
        (body.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(body.operationId)))) {
      return Response.json({ ok: false, error: 'desktop pack accepts only an optional operationId' }, { status: 400 });
    }
    const operationId: string = body.operationId ?? randomUUID();
    const forwarded = await defaultWorkspaceHostRequestForwarder(`/api/workspace-hosts/${hostId}/desktop-pack`, { operationId });
    if (forwarded) return forwarded;
    if (!dbosStarted()) {
      return Response.json({ ok: false, error: 'workspace-host durable controller unavailable', outcome: 'not-dispatched' }, { status: 503 });
    }
    try {
      const request = await prepareWorkspaceHostDesktopPack({
        workspaceId: activeWorkspaceId(), hostId, operationId,
        requestedAt: new Date().toISOString(), action: 'install-desktop-pack',
      });
      const result = await startWorkspaceHostDesktopPackWorkflow(request);
      const auditUrl = `/api/workspace-hosts/${hostId}/audit`;
      return Response.json({ ok: true, ...result, auditUrl }, { status: 202, headers: { location: auditUrl } });
    } catch (error) {
      if (error instanceof WorkspaceHostInitializationControllerProfileError) {
        return Response.json({ ok: false, error: 'workspace-host initialization is not configured', problems: error.problems }, { status: 503 });
      }
      if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
        return Response.json({ ok: false, error: error.message, reason: error.reason }, { status: error.reason === 'host-not-found' ? 404 : 409 });
      }
      if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
        return Response.json({ ok: false, error: error.message, target: error.target }, { status: 501 });
      }
      if (error instanceof WorkspaceHostProvisioningConflictError || error instanceof WorkspaceHostOperationIdentityConflictError) {
        return Response.json({ ok: false, error: error.message, operationId }, { status: 409 });
      }
      return Response.json({ ok: false, error: 'desktop pack admission failed; reconcile this operation before retrying', outcome: 'unknown', hostId, operationId }, { status: 500 });
    }
  },
});
