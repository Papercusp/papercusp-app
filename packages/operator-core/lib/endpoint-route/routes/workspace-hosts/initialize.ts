/** POST initialization admission. A 202 confirms durable enqueue, never guest readiness. */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION, resolveWorkspaceHostRequestedAgents } from '@papercusp/deployment-driver';
import { dbosStarted } from '../../../dbos/bootstrap';
import {
  startWorkspaceHostInitializationWorkflow,
  WorkspaceHostOperationIdentityConflictError,
  WorkspaceHostProvisioningConflictError,
} from '../../../dbos/workspace-host-provision-workflow';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
} from '../../../workspace-host/initialization-operations-resolver';
import { prepareWorkspaceHostInitialization, WorkspaceHostInitializationRequestError } from '../../../workspace-host/initialization-admission';
import { WorkspaceHostReleaseBindingError } from '../../../workspace-host/release-stage-receipt';
import { defaultWorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface InitializeBody {
  source?: unknown;
  credentialRefs?: unknown;
  credentialDelivery?: unknown;
  publicMetadata?: unknown;
  operationId?: unknown;
  requestedAgents?: unknown;
  /** Record root-bootstrap + fixed-agent-initialization on this release's journal (WI-10002510). */
  releaseTaskId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export default defineTool({
  method: 'POST',
  path: '/workspace-hosts/:hostId/initialize',
  auth: 'loopback',
  async handler(req, ctx) {
    const hostId = String(ctx.params.hostId ?? '').trim();
    if (!HOST_ID.test(hostId)) {
      return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
    }

    let body: InitializeBody;
    try {
      body = (await req.json()) as InitializeBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
    }

    // Presence/shape only. Everything about what these values MEAN is the planner's to judge.
    const missing = (['source', 'credentialRefs', 'credentialDelivery'] as const).filter(
      (key) => !isRecord(body[key]),
    );
    if (missing.length > 0) {
      return Response.json(
        { ok: false, error: `missing or ill-typed required object field(s): ${missing.join(', ')}` },
        { status: 400 },
      );
    }
    if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(body.operationId))) {
      return Response.json({ ok: false, error: 'operationId must be a string' }, { status: 400 });
    }
    if (body.publicMetadata !== undefined && !isRecord(body.publicMetadata)) {
      return Response.json({ ok: false, error: 'publicMetadata must be an object' }, { status: 400 });
    }
    if (body.releaseTaskId !== undefined && (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId))) {
      return Response.json({ ok: false, error: 'releaseTaskId has an invalid value' }, { status: 400 });
    }

    let requestedAgents;
    try {
      requestedAgents = body.requestedAgents === undefined ? undefined : resolveWorkspaceHostRequestedAgents(body.requestedAgents);
    } catch (error) {
      return Response.json({ ok: false, error: 'initialization request rejected', detail: (error as Error).message }, { status: 422 });
    }

    const operationId = body.operationId ?? randomUUID();
    const forwarded = await defaultWorkspaceHostRequestForwarder(
      `/api/workspace-hosts/${hostId}/initialize`, { ...body, operationId },
    );
    if (forwarded) return forwarded;
    if (!dbosStarted()) {
      return Response.json({ ok: false, error: 'workspace-host durable controller unavailable', outcome: 'not-dispatched' }, { status: 503 });
    }
    try {
      const request = await prepareWorkspaceHostInitialization({
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        workspaceId: activeWorkspaceId(),
        hostId,
        operationId,
        requestedAt: new Date().toISOString(),
        source: body.source as never,
        credentialRefs: body.credentialRefs as never,
        credentialDelivery: body.credentialDelivery as never,
        ...(requestedAgents !== undefined ? { requestedAgents } : {}),
        ...(body.publicMetadata ? { publicMetadata: body.publicMetadata as Record<string, unknown> } : {}),
        ...(typeof body.releaseTaskId === 'string' ? { releaseTaskId: body.releaseTaskId } : {}),
      });
      const result = await startWorkspaceHostInitializationWorkflow(request);
      const auditUrl = `/api/workspace-hosts/${hostId}/audit`;
      return Response.json(
        { ok: true, ...result, releaseTaskId: request.releaseTaskId ?? null, auditUrl },
        { status: 202, headers: { location: auditUrl } },
      );
    } catch (error) {
      if (error instanceof WorkspaceHostReleaseBindingError) {
        return Response.json(
          { ok: false, error: error.message, reason: error.reason },
          { status: error.reason === 'task-not-found' ? 404 : 409 },
        );
      }
      if (error instanceof WorkspaceHostInitializationControllerProfileError) {
        return Response.json(
          { ok: false, error: 'workspace-host initialization is not configured', problems: error.problems },
          { status: 503 },
        );
      }
      if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
        return Response.json(
          { ok: false, error: error.message, reason: error.reason },
          { status: error.reason === 'host-not-found' ? 404 : 409 },
        );
      }
      if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
        return Response.json({ ok: false, error: error.message, target: error.target }, { status: 501 });
      }
      if (error instanceof WorkspaceHostInitializationRequestError) {
        return Response.json({ ok: false, error: 'initialization request rejected' }, { status: 422 });
      }
      if (error instanceof WorkspaceHostProvisioningConflictError || error instanceof WorkspaceHostOperationIdentityConflictError) {
        return Response.json({ ok: false, error: error.message, operationId }, { status: 409 });
      }
      return Response.json(
        {
          ok: false,
          error: 'workspace host initialization admission failed; reconcile this operation before retrying',
          outcome: 'unknown',
          operationId,
          hostId,
        },
        { status: 500 },
      );
    }
  },
});
