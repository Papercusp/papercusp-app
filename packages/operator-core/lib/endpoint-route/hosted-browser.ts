/**
 * The explicit browser boundary for the hosted operator SPA.
 *
 * The local `/zero-harness/*` and `/workspace-hosts/*` routes are intentionally
 * not reusable internet endpoints: they rely on loopback/process-global scope.
 * This module gives the hosted static SPA a small, reviewed surface instead.
 * Authentication is still supplied by the hosted route stack; this leaf adds
 * the selected-customer-workspace binding, tenant transaction, exact-origin
 * write check, and the query allowlist.
 */
import { defineTool, type RouteContext, type RouteDefinition } from '@papercusp/agent-mcp';
import { withTenantContext, type VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { parseLastEventId, sseResponse, type SyncSseEventVocabulary } from '@papercusp/sse';
import { backfillSince, subscribe, type SyncEvent, type SubscribeHandle } from '../sync-sse';
import { isHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import type { HostedTenantContextRunner } from '../auth/hosted/service-adapters';
import {
  readWorkspaceHostConnection,
  readWorkspaceHostControl,
  readWorkspaceHostDestroyTarget,
  upsertWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
  type StoredWorkspaceHostDestroyTarget,
  type WorkspaceHostConnectionInput,
} from '../workspace-host/observability-store';
import {
  createWorkspaceHostConnectionRoute,
  inspectWorkspaceHostConnection,
  type WorkspaceHostConnectionInspection,
  type WorkspaceHostConnectionRouteDependencies,
} from './routes/workspace-hosts/connection';
import {
  createWorkspaceHostProvisionRoute,
  type WorkspaceHostProvisionRouteDependencies,
} from './routes/workspace-hosts/provision';
import {
  createWorkspaceHostActionRoute,
  type WorkspaceHostActionRouteDependencies,
} from './routes/workspace-hosts/action';
import {
  startWorkspaceHostDestroyWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  startWorkspaceHostProvisioningWorkflow,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
  type StartWorkspaceHostProvisioningInput,
} from '../dbos/workspace-host-provision-workflow';
import { dbosStarted } from '../dbos/bootstrap';
import type { HostedFirstWorkspace } from '../auth/hosted/first-workspace';

export const HOSTED_BROWSER_REST_QUERY_PATH = '/hosted/browser/rest-query' as const;
export const HOSTED_BROWSER_SSE_PATH = '/hosted/browser/sse' as const;
export const HOSTED_BROWSER_CONNECTION_PATH = '/hosted/browser/workspace-hosts/connection' as const;
export const HOSTED_BROWSER_PROVISION_PATH = '/hosted/browser/workspace-hosts/provision' as const;
export const HOSTED_BROWSER_ACTION_PATH = '/hosted/browser/workspace-hosts/action' as const;
/** The ONE hosted browser route reachable without a selected workspace (D-384). */
export const HOSTED_BROWSER_FIRST_WORKSPACE_PATH = '/hosted/browser/onboarding/first-workspace' as const;
/** Selects the organization's existing workspace for a session that holds none. */
export const HOSTED_BROWSER_SELECT_WORKSPACE_PATH = '/hosted/browser/onboarding/select-workspace' as const;

export const HOSTED_BROWSER_QUERY_NAME = 'workspaceHosts.control' as const;

/** Stable manifest consumed by the hosted runtime composition root. */
export const HOSTED_BROWSER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: HOSTED_BROWSER_REST_QUERY_PATH, access: 'authenticated' },
  { method: 'GET', path: HOSTED_BROWSER_SSE_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_CONNECTION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_PROVISION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_ACTION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_FIRST_WORKSPACE_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_SELECT_WORKSPACE_PATH, access: 'authenticated' },
] as const;

const HOSTED_VIEW_AUTH = {
  capabilities: ['workspace:view'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_OPERATE_AUTH = {
  capabilities: ['workspace:operate'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_CONNECTION_AUTH = {
  capabilities: ['cloud-connection:manage'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_FIRST_WORKSPACE_AUTH = {
  capabilities: ['cloud-connection:manage', 'workspace:operate'],
  kind: ['user'],
  trust: ['verified'],
} as const;

type AnyRoute = RouteDefinition<any>;

export interface HostedBrowserRouteDependencies {
  /** Injectable in route tests; production uses the canonical tenant wrapper. */
  readonly runTenant?: HostedTenantContextRunner;
  readonly readControl?: (workspaceId: string, tx?: Sql) => Promise<unknown[]>;
  readonly readConnection?: (
    workspaceId: string,
    connectionId: string,
    tx?: Sql,
  ) => Promise<StoredWorkspaceHostConnection | null>;
  readonly upsertConnection?: (input: WorkspaceHostConnectionInput, tx?: Sql) => Promise<void>;
  readonly inspectConnection?: WorkspaceHostConnectionRouteDependencies['inspectConnection'];
  readonly readTarget?: (
    workspaceId: string,
    hostId: string,
    tx?: Sql,
  ) => Promise<StoredWorkspaceHostDestroyTarget | null>;
  readonly provisioningAvailable?: () => boolean;
  /** The host the selected customer workspace is bound to, read under tenant RLS. */
  readonly readBoundHostId?: (
    controlPlaneWorkspaceId: string,
    customerWorkspaceId: string,
    tx?: Sql,
  ) => Promise<string | null>;
  readonly startProvisioning?: (
    input: StartWorkspaceHostProvisioningInput,
  ) => ReturnType<typeof startWorkspaceHostProvisioningWorkflow>;
  readonly startDestroy?: (
    input: StartWorkspaceHostDestroyInput,
  ) => ReturnType<typeof startWorkspaceHostDestroyWorkflow>;
  readonly startLifecycle?: (
    input: StartWorkspaceHostLifecycleInput,
  ) => ReturnType<typeof startWorkspaceHostLifecycleWorkflow>;
  readonly subscribe?: typeof subscribe;
  readonly backfillSince?: typeof backfillSince;
  /**
   * First-workspace bootstrap (D-384). Absent ⇒ the route answers 501, never a silent
   * fallback onto a workspace-scoped path.
   */
  readonly firstWorkspace?: HostedFirstWorkspace;
  /** Serializes the rotated hosted session cookie after the new workspace is selected. */
  readonly issueSessionCookie?: (sessionId: string, expiresAt: Date) => string;
}

export interface HostedBrowserRouteConfiguration {
  readonly publicOrigin: string;
  /** The fixed operator workspace, never a customer-selected workspace. */
  readonly controlPlaneWorkspaceId: string;
  readonly dependencies?: HostedBrowserRouteDependencies;
}

export interface HostedBrowserRoutes {
  readonly routes: ReadonlyArray<AnyRoute>;
  readonly allowlist: typeof HOSTED_BROWSER_ROUTE_ALLOWLIST;
}

function exactHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('hosted_browser_public_origin_must_be_an_exact_https_origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('hosted_browser_public_origin_must_be_an_exact_https_origin');
  }
  return parsed.origin;
}

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { ok: false, error: code, message: code, ...extra },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type HostedPrincipalSelection =
  | { readonly ok: true; readonly principal: HostedPrincipal }
  | { readonly ok: false; readonly response: Response };

function selectedHostedPrincipal(ctx: RouteContext, controlPlaneWorkspaceId: string): HostedPrincipalSelection {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) {
    return { ok: false, response: jsonError('hosted_principal_required', 401) };
  }
  if (ctx.principal.workspaceId !== controlPlaneWorkspaceId) {
    return { ok: false, response: jsonError('control_plane_binding_mismatch', 403) };
  }
  if (!ctx.principal.selectedWorkspaceId) {
    return { ok: false, response: jsonError('workspace_not_selected', 403) };
  }
  return { ok: true, principal: ctx.principal };
}

/**
 * The bootstrap sibling of `selectedHostedPrincipal`: identical checks EXCEPT that it
 * requires the ABSENCE of a selected workspace. It is used by exactly one route and does
 * not widen any workspace-scoped route — a principal that already holds a workspace is
 * refused here, so this door cannot be used to act beside an existing tenant binding.
 */
function bootstrapHostedPrincipal(ctx: RouteContext, controlPlaneWorkspaceId: string): HostedPrincipalSelection {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) {
    return { ok: false, response: jsonError('hosted_principal_required', 401) };
  }
  if (ctx.principal.workspaceId !== controlPlaneWorkspaceId) {
    return { ok: false, response: jsonError('control_plane_binding_mismatch', 403) };
  }
  if (ctx.principal.selectedWorkspaceId) {
    return { ok: false, response: jsonError('workspace_already_selected', 409) };
  }
  return { ok: true, principal: ctx.principal };
}

function tenantContext(principal: HostedPrincipal): VerifiedTenantServerContext {
  const selectedWorkspaceId = principal.selectedWorkspaceId;
  if (!selectedWorkspaceId) throw new Error('workspace_not_selected');
  return {
    principal: {
      kind: 'user',
      profile: 'hosted',
      authMethod: 'cookie-session',
      trust: 'verified',
      slug: principal.userId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      activeOrganizationId: principal.activeOrganizationId,
      selectedWorkspaceId,
      sessionId: principal.sessionId,
      sessionVersion: principal.sessionVersion,
    },
    selectedWorkspace: { id: selectedWorkspaceId, organizationId: principal.activeOrganizationId },
  };
}

function exactOriginOr403(request: Request, origin: string): Response | null {
  // Unlike the local CSRF helper, hosted cookie writes require an Origin even
  // for a same-site-looking request. A missing Origin is not proof of browser
  // intent and must not become a credentialed write escape hatch.
  return request.headers.get('origin') === origin ? null : jsonError('cross_origin_blocked', 403);
}

function workspaceHeaderMismatch(
  request: Request,
  principal: HostedPrincipal,
  controlPlaneWorkspaceId: string,
): Response | null {
  const supplied = request.headers.get('x-papercusp-workspace')?.trim();
  if (!supplied || supplied === principal.selectedWorkspaceId || supplied === controlPlaneWorkspaceId) return null;
  return jsonError('workspace_binding_mismatch', 403);
}

function parseQueryArgs(request: Request, selectedWorkspaceId: string): Response | null {
  const raw = new URL(request.url).searchParams.get('args') ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError('invalid_query_args', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('invalid_query_args', 400);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  // The query currently has no caller-controlled arguments. Accepting the
  // selected workspace as a redundant assertion is useful to older clients,
  // but never use it as the authority.
  if (keys.length === 0) return null;
  if (keys.length === 1 && record.workspaceId === selectedWorkspaceId) return null;
  return jsonError('query_args_not_supported', 400);
}

function eventScope(event: SyncEvent): string | undefined {
  const args = event.args;
  if (!args) return undefined;
  for (const key of [
    'customerWorkspaceId',
    'customer_workspace_id',
    'selectedWorkspaceId',
    'selected_workspace_id',
    'workspaceId',
    'workspace_id',
  ]) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Hosted SSE carries invalidation metadata only, never rows. A scoped source
 * event is forwarded only to its customer (or the fixed control-plane source);
 * an unscoped invalidation is safe because the browser must re-read through the
 * tenant transaction and no cross-tenant payload is sent over the stream.
 */
function eventBelongsTo(event: SyncEvent, principal: HostedPrincipal): boolean {
  if (event.name !== HOSTED_BROWSER_QUERY_NAME) return false;
  const scope = eventScope(event);
  return scope === undefined || scope === principal.selectedWorkspaceId || scope === principal.workspaceId;
}

function hostedInvalidatePayload(event: SyncEvent): SyncSseEventVocabulary['invalidate'] {
  return { name: event.name, tsMs: event.ts };
}

function wrapTenantRead<T>(
  principal: HostedPrincipal,
  runTenant: HostedTenantContextRunner,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return runTenant(tenantContext(principal), fn);
}

function localConnectionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  const upsertConnection = deps.upsertConnection ?? upsertWorkspaceHostConnection;
  const inspectConnection = deps.inspectConnection ?? inspectWorkspaceHostConnection;
  return createWorkspaceHostConnectionRoute({
    // Workspace-host rows keep the fixed control-plane workspace as their
    // Stage-A key.  `runTenant` below supplies the selected customer scope;
    // migration 979's hosted_app policy joins that key to the selected
    // customer workspace instead of rewriting the row key.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    upsertConnection: (input) => wrapTenantRead(principal, runTenant, (tx) => upsertConnection(input, tx)),
    inspectConnection,
  });
}

async function readCustomerWorkspaceHostId(
  controlPlaneWorkspaceId: string,
  customerWorkspaceId: string,
  tx?: Sql,
): Promise<string | null> {
  if (!tx) throw new Error('readCustomerWorkspaceHostId requires the tenant transaction');
  const rows = await tx<Array<{ workspace_host_id: string }>>`
    SELECT workspace_host_id
      FROM harness_shared.customer_workspaces
     WHERE workspace_id = ${controlPlaneWorkspaceId}
       AND id = ${customerWorkspaceId}
       AND state <> 'deleted'
  `;
  return rows[0]?.workspace_host_id ?? null;
}

function localProvisionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  const readBoundHostId = deps.readBoundHostId ?? readCustomerWorkspaceHostId;
  return createWorkspaceHostProvisionRoute({
    // Provisioning writes the same control-plane-keyed host graph.  The
    // selected tenant is enforced by the transaction/RLS context, not by
    // trusting a browser-supplied workspace id.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    provisioningAvailable: deps.provisioningAvailable ?? dbosStarted,
    // One workspace, one host (D-397): a customer may (re)provision only the host its
    // selected workspace is bound to — never mint another, never name someone else's.
    authorizeHost: async (hostId) => {
      const customerWorkspaceId = principal.selectedWorkspaceId;
      if (!customerWorkspaceId) return false;
      const bound = await wrapTenantRead(principal, runTenant, (tx) =>
        readBoundHostId(config.controlPlaneWorkspaceId, customerWorkspaceId, tx));
      return bound === hostId;
    },
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    startProvisioning: (input) =>
      (deps.startProvisioning ?? startWorkspaceHostProvisioningWorkflow)({ ...input, actorId: principal.userId }),
  });
}

function localActionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readTarget = deps.readTarget ?? readWorkspaceHostDestroyTarget;
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  return createWorkspaceHostActionRoute({
    // Lifecycle rows are likewise keyed by the fixed control-plane workspace;
    // the selected customer binding is carried only by `runTenant` + RLS.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    provisioningAvailable: deps.provisioningAvailable ?? dbosStarted,
    readTarget: (workspaceId, hostId) =>
      wrapTenantRead(principal, runTenant, (tx) => readTarget(workspaceId, hostId, tx)),
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    startDestroy: (input) =>
      (deps.startDestroy ?? startWorkspaceHostDestroyWorkflow)({ ...input, actorId: principal.userId }),
    startLifecycle: (input) =>
      (deps.startLifecycle ?? startWorkspaceHostLifecycleWorkflow)({ ...input, actorId: principal.userId }),
  });
}

function destroyPermissionDenied(request: Request, principal: HostedPrincipal): Promise<Response | null> {
  return request
    .clone()
    .json()
    .then((body: unknown) => {
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (body as Record<string, unknown>).action === 'destroy'
      ) {
        if (!principal.capabilities.has('workspace:destroy')) return jsonError('permission_missing', 403);
      }
      return null;
    })
    .catch(() => null);
}

/** Compose the five routes that are reachable by the hosted static SPA. */
export function createHostedBrowserRoutes(configuration: HostedBrowserRouteConfiguration): HostedBrowserRoutes {
  const origin = exactHttpsOrigin(configuration.publicOrigin);
  const controlPlaneWorkspaceId = configuration.controlPlaneWorkspaceId.trim();
  if (!controlPlaneWorkspaceId) throw new TypeError('hosted_browser_requires_a_control_plane_workspace_id');
  const normalizedConfiguration: HostedBrowserRouteConfiguration = {
    ...configuration,
    publicOrigin: origin,
    controlPlaneWorkspaceId,
  };
  const deps = configuration.dependencies ?? {};
  const runTenant = deps.runTenant ?? withTenantContext;
  const readControl = deps.readControl ?? readWorkspaceHostControl;
  const subscribeEvents = deps.subscribe ?? subscribe;
  const backfill = deps.backfillSince ?? backfillSince;

  const query = defineTool({
    method: 'GET',
    path: HOSTED_BROWSER_REST_QUERY_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const url = new URL(request.url);
      const name = url.searchParams.get('name');
      if (name !== HOSTED_BROWSER_QUERY_NAME) {
        return jsonError(name ? 'query_not_allowlisted' : 'missing_query_name', 400, { name });
      }
      const argsError = parseQueryArgs(request, principal.selectedWorkspaceId!);
      if (argsError) return argsError;
      const startedAt = Date.now();
      try {
        const rows = await wrapTenantRead(principal, runTenant, (tx) => readControl(controlPlaneWorkspaceId, tx));
        const completedAt = Date.now();
        return new Response(
          JSON.stringify({
            rows,
            version: String(completedAt),
            timing: {
              unit: 'ms',
              resolverStartedAtMs: startedAt,
              resolverCompletedAtMs: completedAt,
              resolverMs: Math.max(0, completedAt - startedAt),
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      } catch {
        return jsonError('hosted_query_failed', 500, { name });
      }
    },
  });

  const sse = defineTool({
    method: 'GET',
    path: HOSTED_BROWSER_SSE_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    timeoutSec: null,
    sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const lastEventId = parseLastEventId(request);
      return sseResponse<SyncSseEventVocabulary>({
        signal: request.signal,
        lastEventId,
        heartbeatMs: 15_000,
        initialHeartbeat: true,
        replay: () =>
          backfill(lastEventId ?? 0)
            .filter((event) => eventBelongsTo(event, principal))
            .map((event) => ({
              name: 'invalidate' as const,
              data: hostedInvalidatePayload(event),
              id: event.id,
            })),
        setup: async (sink) => {
          const handle: SubscribeHandle = await subscribeEvents((event) => {
            if (!eventBelongsTo(event, principal) || sink.closed) return;
            // Never forward `event.data`: a full row payload would bypass the
            // tenant transaction that protects the REST read.
            sink.event('invalidate', hostedInvalidatePayload(event), { id: event.id });
          });
          sink.onClose(handle.close);
        },
        headers: { 'cache-control': 'no-store' },
      });
    },
  });

  const connection = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_CONNECTION_PATH,
    auth: HOSTED_CONNECTION_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      return noStore(
        await localConnectionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx),
      );
    },
  });

  const provision = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_PROVISION_PATH,
    auth: HOSTED_OPERATE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      return noStore(
        await localProvisionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx),
      );
    },
  });

  const action = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_ACTION_PATH,
    auth: HOSTED_OPERATE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const permission = await destroyPermissionDenied(request, principal);
      if (permission) return permission;
      return noStore(await localActionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx));
    },
  });

  const firstWorkspace = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_FIRST_WORKSPACE_PATH,
    auth: HOSTED_FIRST_WORKSPACE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = bootstrapHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      if (!deps.firstWorkspace || !deps.issueSessionCookie) return jsonError('first_workspace_unavailable', 501);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonError('invalid_json', 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('invalid_request', 400);
      const fields = body as Record<string, unknown>;
      // Only display text, the attempt key, the hosting choice and (bring-your-own-cloud only)
      // the delegation configuration are read from the body. Tenant and identifier fields
      // (organization, workspace, host, connection, credential reference) come from the
      // verified session or are server-derived.
      const result = await deps.firstWorkspace.run({
        organizationId: principal.activeOrganizationId,
        userId: principal.userId,
        sessionId: principal.sessionId,
        sessionVersion: principal.sessionVersion,
        attemptKey: fields.attemptKey as string,
        displayName: fields.displayName as string,
        label: fields.label as string,
        hosting: fields.hosting as never,
        configuration: fields.configuration as never,
      });
      if (!result.ok) {
        return jsonError(result.code, result.status, {
          retryable: result.retryable,
          ...(result.template ? { template: result.template } : {}),
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        });
      }
      return Response.json(
        {
          ok: true,
          workspaceId: result.workspaceId,
          connectionId: result.connectionId,
          provisionOperationId: result.provisionOperationId,
        },
        {
          status: 201,
          headers: {
            'cache-control': 'no-store',
            'set-cookie': deps.issueSessionCookie(result.sessionId, result.sessionExpiresAt),
          },
        },
      );
    },
  });

  const selectWorkspace = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_SELECT_WORKSPACE_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      // Same door as first-workspace: only a session that holds NO workspace, so this can
      // never move a session off a workspace it already has.
      const selection = bootstrapHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      if (!deps.firstWorkspace || !deps.issueSessionCookie) return jsonError('first_workspace_unavailable', 501);
      // Nothing is read from the body: the organization comes from the verified session.
      const result = await deps.firstWorkspace.selectExisting({
        organizationId: principal.activeOrganizationId,
        sessionId: principal.sessionId,
        sessionVersion: principal.sessionVersion,
      });
      if (!result.ok) return jsonError(result.code, result.status, { retryable: result.retryable });
      return Response.json(
        { ok: true, workspaceId: result.workspaceId },
        {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'set-cookie': deps.issueSessionCookie(result.sessionId, result.sessionExpiresAt),
          },
        },
      );
    },
  });

  return {
    routes: [query, sse, connection, provision, action, firstWorkspace, selectWorkspace],
    allowlist: HOSTED_BROWSER_ROUTE_ALLOWLIST,
  };
}

export default createHostedBrowserRoutes;
