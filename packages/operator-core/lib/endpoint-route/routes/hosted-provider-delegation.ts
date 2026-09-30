/** Hosted browser routes for provider-delegation onboarding and lifecycle. */
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { isHostedPrincipal, type HostedPrincipal } from '../../auth/hosted-principal';
import type {
  HostedProviderDelegationManager,
  HostedProviderDelegationOnboardingInput,
} from '../../workspace-host/hosted-provider-delegation';

export const HOSTED_PROVIDER_DELEGATION_ROUTES = [
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/provider-delegations/onboard', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/provider-delegations/verify', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/provider-delegations/rotate', access: 'authenticated' },
  { method: 'POST', path: '/hosted/workspaces/:workspaceId/provider-delegations/revoke', access: 'authenticated' },
] as const;

const HOSTED_MANAGE_AUTH = {
  capabilities: ['cloud-connection:manage'],
  kind: ['user'],
  trust: ['verified'],
} as const;

export type HostedProviderDelegationManagerFactory = (
  principal: HostedPrincipal,
) => HostedProviderDelegationManager;

type Body = Record<string, unknown>;
const error = (code: string, status: number) => Response.json({ ok: false, error: { code } }, { status });

async function readBody(request: Request): Promise<Body | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Body : null;
  } catch {
    return null;
  }
}

function binding(ctx: RouteContext): { principal: HostedPrincipal; workspaceId: string } | Response {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) return error('hosted_principal_required', 401);
  const workspaceId = String(ctx.params.workspaceId ?? '').trim();
  if (!workspaceId || ctx.principal.selectedWorkspaceId !== workspaceId) {
    return error('workspace_binding_mismatch', 403);
  }
  return { principal: ctx.principal, workspaceId };
}

function connectionId(body: Body): string | null {
  const value = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
  return value && value.length <= 160 ? value : null;
}

function lifecycleFailure(cause: unknown): Response {
  const code = cause instanceof Error ? cause.message : 'hosted_provider_delegation_failed';
  const status = /not_found/.test(code) ? 404
    : /generation_conflict|requires_verified|is_revoked/.test(code) ? 409
      // The organization's own GCP account could not be prepared: ours to fix, retryable.
      : /identity_project|organization_account|delegation_source/.test(code) ? 503
        : 422;
  return error(code, status);
}

export function createHostedProviderDelegationRoutes(factory: HostedProviderDelegationManagerFactory) {
  const onboard = defineTool({
    method: 'POST', path: HOSTED_PROVIDER_DELEGATION_ROUTES[0].path, auth: HOSTED_MANAGE_AUTH,
    async handler(request, ctx) {
      const scoped = binding(ctx); if (scoped instanceof Response) return scoped;
      const body = await readBody(request); if (!body) return error('invalid_json', 400);
      const id = connectionId(body); if (!id) return error('invalid_connection_id', 400);
      try {
        // The manager re-binds both the organization and the GCP trusted principal from the
        // session (D-397); a body value for either never reaches the record.
        const result = await factory(scoped.principal).onboard({
          organizationId: scoped.principal.activeOrganizationId,
          workspaceId: scoped.workspaceId,
          connectionId: id,
          label: body.label,
          credentialRef: body.credentialRef,
          configuration: body.configuration,
        } as HostedProviderDelegationOnboardingInput);
        return Response.json({ ok: true, record: result.record, template: result.template }, { status: 201 });
      } catch (cause) { return lifecycleFailure(cause); }
    },
  });
  const verify = defineTool({
    method: 'POST', path: HOSTED_PROVIDER_DELEGATION_ROUTES[1].path, auth: HOSTED_MANAGE_AUTH,
    async handler(request, ctx) {
      const scoped = binding(ctx); if (scoped instanceof Response) return scoped;
      const body = await readBody(request); if (!body) return error('invalid_json', 400);
      const id = connectionId(body); if (!id) return error('invalid_connection_id', 400);
      try { return Response.json({ ok: true, record: await factory(scoped.principal).verify(scoped.workspaceId, id) }); }
      catch (cause) { return lifecycleFailure(cause); }
    },
  });
  const rotate = defineTool({
    method: 'POST', path: HOSTED_PROVIDER_DELEGATION_ROUTES[2].path, auth: HOSTED_MANAGE_AUTH,
    async handler(request, ctx) {
      const scoped = binding(ctx); if (scoped instanceof Response) return scoped;
      const body = await readBody(request); if (!body) return error('invalid_json', 400);
      const id = connectionId(body); if (!id) return error('invalid_connection_id', 400);
      try {
        const record = await factory(scoped.principal).rotate(scoped.workspaceId, id, {
          label: body.label,
          credentialRef: body.credentialRef,
          configuration: body.configuration,
        } as Omit<HostedProviderDelegationOnboardingInput, 'organizationId' | 'workspaceId' | 'connectionId' | 'generation'>);
        return Response.json({ ok: true, record });
      } catch (cause) { return lifecycleFailure(cause); }
    },
  });
  const revoke = defineTool({
    method: 'POST', path: HOSTED_PROVIDER_DELEGATION_ROUTES[3].path, auth: HOSTED_MANAGE_AUTH,
    async handler(request, ctx) {
      const scoped = binding(ctx); if (scoped instanceof Response) return scoped;
      const body = await readBody(request); if (!body) return error('invalid_json', 400);
      const id = connectionId(body); if (!id) return error('invalid_connection_id', 400);
      try { return Response.json({ ok: true, record: await factory(scoped.principal).revoke(scoped.workspaceId, id) }); }
      catch (cause) { return lifecycleFailure(cause); }
    },
  });
  return [onboard, verify, rotate, revoke] as const;
}
