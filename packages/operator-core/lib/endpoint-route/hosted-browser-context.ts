/** Shared hosted browser authority checks. Kept free of product workflows so
 * read-only leaves do not import provisioning or agent execution backends. */
import type { RouteContext } from '@papercusp/agent-mcp';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import { isHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
export function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: code, message: code, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}
export type HostedPrincipalSelection = { readonly ok: true; readonly principal: HostedPrincipal } | { readonly ok: false; readonly response: Response };
export function selectedHostedPrincipal(ctx: RouteContext, controlPlaneWorkspaceId: string): HostedPrincipalSelection {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) return { ok: false, response: jsonError('hosted_principal_required', 401) };
  if (ctx.principal.workspaceId !== controlPlaneWorkspaceId) return { ok: false, response: jsonError('control_plane_binding_mismatch', 403) };
  if (!ctx.principal.selectedWorkspaceId) return { ok: false, response: jsonError('workspace_not_selected', 403) };
  return { ok: true, principal: ctx.principal };
}
export function tenantContext(principal: HostedPrincipal): VerifiedTenantServerContext {
  const selectedWorkspaceId = principal.selectedWorkspaceId;
  if (!selectedWorkspaceId) throw new Error('workspace_not_selected');
  return { principal: {
    kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: principal.userId,
    workspaceId: principal.workspaceId, userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
    selectedWorkspaceId, sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
  }, selectedWorkspace: { id: selectedWorkspaceId, organizationId: principal.activeOrganizationId } };
}
export function exactOriginOr403(request: Request, origin: string): Response | null {
  return request.headers.get('origin') === origin ? null : jsonError('cross_origin_blocked', 403);
}
export function workspaceHeaderMismatch(request: Request, principal: HostedPrincipal, controlPlaneWorkspaceId: string): Response | null {
  const supplied = request.headers.get('x-papercusp-workspace')?.trim();
  return !supplied || supplied === principal.selectedWorkspaceId || supplied === controlPlaneWorkspaceId ? null : jsonError('workspace_binding_mismatch', 403);
}
