/** POST /workspace-hosts/provision — start or resume one durable GCP host provision. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  isWorkspaceHostCanaryIdentityLabelKey,
  workspaceHostCanaryIdentityLabels,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  isWorkspaceHostOperationAcceptance,
  startWorkspaceHostProvisioningWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostProvisioningInput,
} from '../../../dbos/workspace-host-provision-workflow';
import { workspaceHostAuditUrl } from '../../../workspace-host/admission-window';
import { dbosStarted } from '../../../dbos/bootstrap';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  readWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
} from '../../../workspace-host/observability-store';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  validateWorkspaceHostCanaryAdmission,
  type WorkspaceHostCanaryAdmission,
} from '../../../workspace-host/provisioning-runner';
import {
  defaultWorkspaceHostRequestForwarder,
  type WorkspaceHostRequestForwarder,
} from '../../../workspace-host/controller-forwarding';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

interface ProvisionBody {
  connectionId?: unknown;
  name?: unknown;
  desired?: unknown;
  operationId?: unknown;
  /** Declares the run together with its pre-creation economic admission evidence. */
  canary?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface WorkspaceHostProvisionRouteDependencies {
  activeWorkspaceId: () => string;
  provisioningAvailable: () => boolean;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  startProvisioning: (
    input: StartWorkspaceHostProvisioningInput,
  ) => ReturnType<typeof startWorkspaceHostProvisioningWorkflow>;
  forwardRequest?: WorkspaceHostRequestForwarder;
  /**
   * Whether the caller may provision `hostId` at all. Absent = any host (the operator's own
   * loopback surface). A tenant surface must supply it: provisioning writes the host row with
   * control-plane privilege, so a caller-chosen id would mint unbounded hosts and could
   * re-point ANOTHER tenant's host row at the caller's connection (D-397).
   */
  authorizeHost?: (hostId: string) => Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostProvisionRouteDependencies = {
  activeWorkspaceId,
  provisioningAvailable: dbosStarted,
  readConnection: readWorkspaceHostConnection,
  startProvisioning: startWorkspaceHostProvisioningWorkflow,
};

export function createWorkspaceHostProvisionRoute(
  dependencies: WorkspaceHostProvisionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/provision',
    auth: 'loopback',
    async handler(req) {
      let body: ProvisionBody;
      try {
        body = (await req.json()) as ProvisionBody;
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      if (!isRecord(body)) return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });

      const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!SAFE_ID.test(connectionId)) {
        return Response.json({ ok: false, error: 'invalid connectionId' }, { status: 400 });
      }
      if (!name || name.length > 160) {
        return Response.json(
          { ok: false, error: 'name must be a non-empty string of at most 160 characters' },
          { status: 400 },
        );
      }
      if (!isRecord(body.desired)) {
        return Response.json({ ok: false, error: 'desired must be an object' }, { status: 400 });
      }
      const requestedDesired = body.desired as unknown as WorkspaceHostDesiredSpec;
      if (typeof requestedDesired.hostId !== 'string' || !SAFE_ID.test(requestedDesired.hostId)) {
        return Response.json({ ok: false, error: 'invalid desired.hostId' }, { status: 400 });
      }
      if (typeof requestedDesired.target !== 'string' || !requestedDesired.target.trim()) {
        return Response.json({ ok: false, error: 'desired.target must be a non-empty string' }, { status: 400 });
      }
      if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return Response.json({ ok: false, error: 'invalid operationId' }, { status: 400 });
      }
      let canaryRunId: string | undefined;
      if (body.canary !== undefined) {
        const declared = isRecord(body.canary) ? body.canary.runId : undefined;
        if (typeof declared !== 'string' || !SAFE_ID.test(declared)) {
          return Response.json(
            { ok: false, error: 'canary must be an object whose runId is a valid identifier' },
            { status: 400 },
          );
        }
        canaryRunId = declared;
      }
      // IDENTITY is operator-written, never caller-written. The destroy gate treats these three
      // labels as proof that this host belongs to a named canary run, so a caller that could hand
      // them in could manufacture exactly the provenance the gate exists to demand. Declaring
      // `canary.runId` is the only way to get them, and they are synthesized below.
      const requestedLabels = isRecord(requestedDesired.labels)
        ? (requestedDesired.labels as Record<string, string>)
        : undefined;
      const callerIdentityLabels = Object.keys(requestedLabels ?? {}).filter(isWorkspaceHostCanaryIdentityLabelKey);
      if (callerIdentityLabels.length > 0) {
        return Response.json(
          {
            ok: false,
            error: 'workspace-host provisioning request rejected',
            problems: callerIdentityLabels.map(
              (key) => `desired.labels must not set '${key}'; declare canary.runId and the operator writes it`,
            ),
          },
          { status: 422 },
        );
      }
      // Before the controller forward as well: the forwarded body reaches a loopback route that
      // trusts it completely.
      if (dependencies.authorizeHost && !(await dependencies.authorizeHost(requestedDesired.hostId))) {
        return Response.json({ ok: false, error: 'workspace_host_not_bound' }, { status: 403 });
      }
      if (!dependencies.provisioningAvailable()) {
        try {
          const forwarded = await (dependencies.forwardRequest ?? defaultWorkspaceHostRequestForwarder)(
            '/api/workspace-hosts/provision',
            body,
          );
          if (forwarded) return forwarded;
        } catch {
          // A controller transport failure is reported through the same typed 503
          // admission response as an undiscovered controller.
        }
        return Response.json(
          { ok: false, error: 'workspace-host provisioning workflow is unavailable on this operator' },
          { status: 503 },
        );
      }

      const workspaceId = dependencies.activeWorkspaceId();
      const stored = await dependencies.readConnection(workspaceId, connectionId);
      if (!stored) {
        return Response.json({ ok: false, error: 'workspace-host connection not found' }, { status: 404 });
      }
      if (stored.status !== 'connected') {
        return Response.json(
          {
            ok: false,
            error: 'workspace-host connection is not ready',
            status: stored.status,
            ...(stored.statusDetail ? { detail: stored.statusDetail } : {}),
          },
          { status: 409 },
        );
      }
      if (stored.target !== requestedDesired.target) {
        return Response.json({ ok: false, error: 'connection target does not match desired.target' }, { status: 422 });
      }
      if (requestedDesired.target !== 'gcp') {
        return Response.json(
          {
            ok: false,
            error: 'workspace-host provisioning target is not implemented',
            target: requestedDesired.target,
          },
          { status: 501 },
        );
      }
      // The control query deliberately masks credential references. Rebind the
      // stored raw reference and connection metadata server-side so a browser
      // never has to round-trip either secret-adjacent identity or stale config.
      const requestedProvider = isRecord(requestedDesired.provider) ? requestedDesired.provider : {};
      const desired = {
        ...requestedDesired,
        // A declared canary run is bound into the persisted spec HERE, at provision, from values
        // the operator resolved itself — the run the caller declared and this operator's own
        // workspace. That binding is what makes the host destroyable through the product route
        // later; a host provisioned without it can only ever be retired out of band.
        ...(canaryRunId
          ? {
              labels: {
                ...(requestedLabels ?? {}),
                ...workspaceHostCanaryIdentityLabels({ runId: canaryRunId, workspaceId }),
              },
            }
          : {}),
        credentials: {
          ...(isRecord(requestedDesired.credentials) ? requestedDesired.credentials : {}),
          cloudCredentialRef: stored.connection.cloudCredentialRef,
        },
        provider: {
          ...requestedProvider,
          ...(stored.connection.provider ?? {}),
        },
      } as WorkspaceHostDesiredSpec;

      try {
        const canary = body.canary as WorkspaceHostCanaryAdmission | undefined;
        validateWorkspaceHostCanaryAdmission({ workspaceId, desired, connection: stored.connection, canary });
        const result = await dependencies.startProvisioning({
          workspaceId,
          connectionId,
          name,
          desired,
          connection: { ...stored.connection, scope: desired.scope },
          ...(canary ? { canary } : {}),
          ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
        });
        if (isWorkspaceHostOperationAcceptance(result)) {
          // Still queued or running after the admission window (EI-23712230399040759): 202 with
          // the operation id to follow on the host timeline, never a request held for minutes.
          const auditUrl = workspaceHostAuditUrl(result.hostId);
          return Response.json(
            {
              ok: true,
              status: 'accepted',
              operationId: result.operationId,
              hostId: result.hostId,
              auditUrl,
              message: 'Workspace-host provision accepted; follow the host timeline for progress',
            },
            { status: 202, headers: { location: auditUrl } },
          );
        }
        const response = {
          ok: result.status !== 'failed',
          status: result.status,
          operationId: result.operationId,
          hostId: result.hostId,
          planId: result.plan.planId,
          resources: result.checkpoints.map((checkpoint) => ({
            logicalKey: checkpoint.logicalKey,
            state: checkpoint.state,
            attempts: checkpoint.attempts,
          })),
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        };
        return Response.json(response, {
          status: result.status === 'succeeded' ? 201 : result.status === 'in-progress' ? 202 : 500,
        });
      } catch (error) {
        if (error instanceof WorkspaceHostProvisioningConflictError) {
          return Response.json(
            { ok: false, error: 'workspace host already has a provisioning operation in progress' },
            { status: 409 },
          );
        }
        if (error instanceof WorkspaceHostProvisioningConnectionError) {
          return Response.json(
            { ok: false, error: 'workspace-host connection validation failed', problems: error.problems },
            { status: 409 },
          );
        }
        if (error instanceof WorkspaceHostProvisioningRequestError) {
          return Response.json(
            { ok: false, error: 'workspace-host provisioning request rejected', problems: error.problems },
            { status: 422 },
          );
        }
        return Response.json(
          { ok: false, error: 'workspace-host provisioning failed; see the host timeline for details' },
          { status: 500 },
        );
      }
    },
  });
}

export default createWorkspaceHostProvisionRoute();
