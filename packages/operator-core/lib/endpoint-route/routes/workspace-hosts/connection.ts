/** POST /workspace-hosts/connection — admit and refresh one local provider connection. */
import { defineTool } from '@papercusp/agent-mcp';
import type {
  WorkspaceHostConnectionValidation,
  WorkspaceHostImage,
  WorkspaceHostProviderConnection,
  WorkspaceHostRegion,
  WorkspaceHostScope,
  WorkspaceHostSize,
} from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../../workspace-registry';
import { createConfiguredGcpWorkspaceHostProvider } from '../../../workspace-host/gcp-provider';
import { parseGcpBillingExportDescriptor } from '../../../workspace-host/gcp-api-client';
import {
  readWorkspaceHostConnection,
  upsertWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
  type WorkspaceHostConnectionInput,
} from '../../../workspace-host/observability-store';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_SERVICE_ACCOUNT = /^[^@\s]+@(?:developer|[^@\s]+\.(?:iam|developer))\.gserviceaccount\.com$/i;

interface ConnectionBody {
  action?: unknown;
  connectionId?: unknown;
  target?: unknown;
  label?: unknown;
  credentialRef?: unknown;
  projectId?: unknown;
  serviceAccountEmail?: unknown;
  billingExport?: unknown;
}

export interface WorkspaceHostConnectionInspection {
  validation: WorkspaceHostConnectionValidation;
  scopes: readonly WorkspaceHostScope[];
  regions: readonly WorkspaceHostRegion[];
  sizes: readonly WorkspaceHostSize[];
  images: readonly WorkspaceHostImage[];
}

export interface WorkspaceHostConnectionRouteDependencies {
  activeWorkspaceId: () => string;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  upsertConnection: (input: WorkspaceHostConnectionInput) => Promise<void>;
  inspectConnection: (input: {
    workspaceId: string;
    connectionId: string;
    connection: WorkspaceHostProviderConnection;
  }) => Promise<WorkspaceHostConnectionInspection>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, message: error, ...extra }, { status });
}

function safeConnectionProblem(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('service_account_key_forbidden')) {
    return 'Service-account key ADC is forbidden; use authorized-user or impersonated ADC.';
  }
  if (code.includes('cloud_credential_ref_unsupported')) {
    return 'GCP credential reference must use adc://default or gcloud://active-user.';
  }
  if (code.includes('hosted_auth_resolver_required')) {
    return 'Hosted credential references are unavailable on the local control plane.';
  }
  return 'Provider connection validation failed.';
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function workspaceHostConnectionId(target: string, label: string): string {
  return `${target}:${slug(label) || 'connection'}`;
}

/**
 * Compose the already-shipped GCP provider contract for a read-only validation
 * and catalog refresh. Other providers remain explicit 501s until their
 * connection-specific admission contracts are production-composed.
 */
export async function inspectWorkspaceHostConnection(input: {
  workspaceId: string;
  connectionId: string;
  connection: WorkspaceHostProviderConnection;
}): Promise<WorkspaceHostConnectionInspection> {
  if (input.connection.target !== 'gcp') {
    throw new Error(`workspace_host_connection_target_${input.connection.target}_unsupported`);
  }
  // This provider exists for this inspection only. Catalog discovery makes
  // several REST calls; acquire the same short-lived authority once for them.
  // A later validation creates a new provider and resolves credentials again.
  const provider = createConfiguredGcpWorkspaceHostProvider(input.connection, {
    reuseAuthWithinInstance: true,
  });
  const context = {
    workspaceId: input.workspaceId,
    requestId: `connection:${input.connectionId}`,
    connection: input.connection,
  };
  const validation = await provider.validateConnection(context);
  if (!validation.ok) {
    return { validation, scopes: [], regions: [], sizes: [], images: [] };
  }

  const scopes = await provider.listScopes(context);
  const scope = scopes[0];
  if (!scope) {
    return {
      validation: {
        ok: false,
        checkedAt: validation.checkedAt,
        warnings: validation.warnings,
        errors: ['Provider validation returned no usable project.'],
      },
      scopes: [],
      regions: [],
      sizes: [],
      images: [],
    };
  }
  const regions = await provider.listRegions({ scope }, context);
  const region = regions.find((candidate) => candidate.available) ?? regions[0];
  const query = { scope, ...(region ? { region: region.id } : {}) };
  const [sizes, images] = await Promise.all([provider.listSizes(query, context), provider.listImages(query, context)]);
  return { validation, scopes, regions, sizes, images };
}

const DEFAULT_DEPENDENCIES: WorkspaceHostConnectionRouteDependencies = {
  activeWorkspaceId,
  readConnection: readWorkspaceHostConnection,
  upsertConnection: upsertWorkspaceHostConnection,
  inspectConnection: inspectWorkspaceHostConnection,
};

function connectionInput(
  workspaceId: string,
  connectionId: string,
  label: string,
  connection: WorkspaceHostProviderConnection,
  inspection: WorkspaceHostConnectionInspection,
): WorkspaceHostConnectionInput {
  const connected = inspection.validation.ok;
  // WI-1743793: a transport-class failure proves nothing about the connection, so it must NOT be
  // recorded as 'invalid' — that verdict is sticky, and every later lifecycle action is refused
  // against a connection that was never actually disproved. 'degraded' says "last inspection could
  // not reach the provider" without condemning it.
  const status = connected ? 'connected' : inspection.validation.retryable ? 'degraded' : 'invalid';
  return {
    workspaceId,
    id: connectionId,
    target: connection.target,
    label,
    credentialRef: connection.cloudCredentialRef.ref,
    provider: connection.provider,
    status,
    ...(connected && inspection.validation.identity?.trim()
      ? { authenticatedIdentity: inspection.validation.identity.trim() }
      : {}),
    statusDetail: connected
      ? inspection.validation.warnings.join('; ') || undefined
      : inspection.validation.errors.join('; ') || 'Provider validation failed.',
    lastValidatedAt: inspection.validation.checkedAt,
    scopes: connected ? inspection.scopes.map(({ kind: _kind, ...scope }) => scope) : [],
    regions: connected
      ? inspection.regions
          .filter((region) => region.available)
          .map(({ id, label: regionLabel, zones }) => ({ id, label: regionLabel, ...(zones?.length ? { zones } : {}) }))
      : [],
    sizes: connected
      ? inspection.sizes
          .filter((size) => size.available)
          .map(({ id, label: sizeLabel, cpuCount, memoryMiB }) => ({
            id,
            label: sizeLabel,
            vcpu: cpuCount,
            memoryGiB: memoryMiB / 1024,
          }))
      : [],
    images: connected
      ? inspection.images
          .filter((image) => !image.deprecated)
          .map(({ id, label: imageLabel, version }) => ({ id, label: imageLabel, ...(version ? { version } : {}) }))
      : [],
    // GCP provisioning owns a deterministic private network when selected.
    // Existing-network discovery is intentionally not faked by the provider-neutral contract.
    networks: connected ? [{ id: 'managed', label: 'Papercusp-managed private network' }] : [],
  };
}

export function createWorkspaceHostConnectionRoute(
  dependencies: WorkspaceHostConnectionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/connection',
    auth: 'loopback',
    async handler(req) {
      let body: ConnectionBody;
      try {
        body = (await req.json()) as ConnectionBody;
      } catch {
        return requestError('invalid json', 400);
      }
      if (!isRecord(body)) return requestError('body must be an object', 400);

      const action = typeof body.action === 'string' ? body.action : '';
      if (action !== 'connect' && action !== 'validate-connection') {
        return requestError('workspace-host connection action is not implemented', 501, {
          action: action || null,
        });
      }

      const workspaceId = dependencies.activeWorkspaceId();
      let connectionId: string;
      let label: string;
      let connection: WorkspaceHostProviderConnection;

      if (action === 'connect') {
        const target = typeof body.target === 'string' ? body.target.trim() : '';
        label = typeof body.label === 'string' ? body.label.trim() : '';
        const credentialRef = typeof body.credentialRef === 'string' ? body.credentialRef.trim() : '';
        const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
        const serviceAccountEmail = typeof body.serviceAccountEmail === 'string' ? body.serviceAccountEmail.trim() : '';
        if (target !== 'gcp') {
          return requestError('workspace-host connection target is not implemented', 501, { target: target || null });
        }
        if (!label || label.length > 160) {
          return requestError('label must be a non-empty string of at most 160 characters', 400);
        }
        if (!credentialRef || credentialRef.length > 500) {
          return requestError('credentialRef must be a non-empty reference', 400);
        }
        if (!GCP_PROJECT_ID.test(projectId)) return requestError('invalid GCP projectId', 400);
        if (!GCP_SERVICE_ACCOUNT.test(serviceAccountEmail)) {
          return requestError('invalid GCP runtime serviceAccountEmail', 400);
        }
        let billingExport;
        if (body.billingExport !== undefined) {
          try {
            billingExport = parseGcpBillingExportDescriptor(body.billingExport);
          } catch {
            return requestError('invalid GCP billingExport descriptor', 400);
          }
        }
        connectionId = workspaceHostConnectionId(target, label);
        connection = {
          target,
          cloudCredentialRef: { kind: 'cloud', ref: credentialRef },
          scope: { kind: 'project', id: projectId },
          provider: { projectId, serviceAccountEmail, ...(billingExport ? { billingExport } : {}) },
        };
      } else {
        connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
        if (!SAFE_ID.test(connectionId)) return requestError('invalid connectionId', 400);
        const stored = await dependencies.readConnection(workspaceId, connectionId);
        if (!stored) return requestError('workspace-host connection not found', 404);
        if (stored.target !== 'gcp') {
          return requestError('workspace-host connection target is not implemented', 501, {
            target: stored.target,
          });
        }
        label = stored.label ?? stored.id;
        connection = stored.connection;
      }

      let inspection: WorkspaceHostConnectionInspection;
      try {
        inspection = await dependencies.inspectConnection({ workspaceId, connectionId, connection });
      } catch (error) {
        const problem = safeConnectionProblem(error);
        inspection = {
          validation: {
            ok: false,
            checkedAt: new Date().toISOString(),
            warnings: [],
            errors: [problem],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        };
      }

      // "The provider answered" is not authenticated connection identity. A successful
      // validation must name the non-secret principal it proved; otherwise the controller could
      // later mutate resources without being able to show which authority was admitted.
      if (inspection.validation.ok && !inspection.validation.identity?.trim()) {
        inspection = {
          validation: {
            ok: false,
            checkedAt: inspection.validation.checkedAt,
            warnings: inspection.validation.warnings,
            errors: ['Provider validation did not return an authenticated identity.'],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        };
      }

      await dependencies.upsertConnection(connectionInput(workspaceId, connectionId, label, connection, inspection));
      if (!inspection.validation.ok) {
        const problems = inspection.validation.errors;
        return requestError(problems[0] ?? 'Provider connection validation failed.', 422, {
          connectionId,
          problems,
        });
      }
      return Response.json({
        ok: true,
        status: 'connected',
        connectionId,
        authenticatedIdentity: inspection.validation.identity,
        message: action === 'connect' ? `${label} connected and validated` : `${label} connection validated`,
      });
    },
  });
}

export default createWorkspaceHostConnectionRoute();
