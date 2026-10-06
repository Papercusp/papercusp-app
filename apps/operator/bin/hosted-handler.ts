/** Restricted same-origin HTTP host for the hosted control-plane profile. */

import { Hono } from "hono";
import { withHostedServiceContext, withWorkspace } from "@papercusp/db-org";
import {
  createHostedRuntime,
  readHostedRuntimeConfiguration,
  type HostedRuntimeDependencies,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-runtime";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { resolveHostedSecretRef } from "@papercusp/operator-core/lib/auth/hosted/secret-ref";
import { loadMembershipReportFrame } from "@papercusp/operator-core/lib/connected-apps/membership-report";
import { createSpaRoutes } from "./host-spa";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { authenticateHostedConnectorSocket } from "@papercusp/operator-core/lib/endpoint-route/routes/hosted-workspace-connector";
import type { HostedConnectorBinding } from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-connector";
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceAttachRequest,
  type HostedWorkspaceSessionBrokerOptions,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-session";
import {
  hostedDesktopAuditRow,
  isHostedDesktopAuditAction,
  recordDesktopAudit,
} from "@papercusp/operator-core/lib/desktop/desktop-audit";
import {
  AppRelayRateLimiter,
  DEFAULT_APP_RELAY_LIMITS,
  InMemoryHostedAppRelayUsageStore,
  PostgresHostedAppRelayUsageStore,
  handleHostedAppRelay,
  type AppRelayLimits,
  type HostedAppRelayDependencies,
  type HostedAppRelayUsageStore,
} from "@papercusp/operator-core/lib/workspace-host/hosted-app-relay";
import {
  InMemoryPortalOAuthStore,
  PostgresPortalOAuthStore,
  handleHostedMcpOAuth,
  isPortalMcpOAuthPath,
  type PortalMcpOAuthDependencies,
  type PortalOAuthStore,
} from "@papercusp/operator-core/lib/connected-apps/portal-mcp-oauth";
import { createHostedPrincipalResolver } from "@papercusp/operator-core/lib/auth/hosted-principal-resolver";

/** Local server-rendered namespaces that must never become SPA-looking 200s. */
export const HOSTED_FORBIDDEN_HOST_PATH_PREFIXES = [
  "/internal/docs",
  "/docs",
  "/wiki",
  "/drizzle-studio",
] as const;

/**
 * Read the P-013 desktop-attach intent off a browser upgrade.
 *
 * Every field is optional and an unrecognised value degrades to a PTY rather than
 * failing the upgrade: a browser and this control plane ship independently, so an
 * older client that sends nothing must still get its terminal. The one thing NOT
 * defaulted is `desktopSessionId` — the broker refuses a desktop channel without
 * one, because a blank viewer is a worse answer than an error.
 */
export function readAttachRequest(request: Request): HostedWorkspaceAttachRequest {
  const params = new URL(request.url).searchParams;
  // D-418 / WI-10002873: the portal backend's relay to the workspace's own
  // operator. The broker echoes `kind` on `session.bound`, so a client can tell
  // this control plane honoured it rather than degrading to a PTY.
  if (params.get("kind") === "operator-http") return { kind: "operator-http" };
  // D-002: psu started by the host. `argv` is a JSON list; anything that does not parse is
  // handed on as-is so the broker REFUSES it, instead of launching psu with no arguments.
  if (params.get("kind") === "psu") {
    const raw = params.get("argv");
    let argv: unknown = undefined;
    if (raw !== null) {
      try {
        argv = JSON.parse(raw);
      } catch {
        argv = raw;
      }
    }
    return { kind: "psu", ...(argv === undefined ? {} : { argv }) };
  }
  if (params.get("kind") !== "desktop") return {};
  const desktopSessionId = params.get("desktopSessionId")?.trim();
  return {
    kind: "desktop",
    ...(desktopSessionId ? { desktopSessionId } : {}),
    desktopMode: params.get("desktopMode") === "takeover" ? "takeover" : "watch",
  };
}

export interface HostedHandler {
  readonly plane: AssembledHostedControlPlane;
  readonly app: Hono;
  readonly handler: (request: Request) => Promise<Response>;
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>;
  /** The in-process relay. Exposed so the liveness sweep can be driven directly. */
  readonly relay: HostedWorkspaceSessionBroker;
}

export interface HostedHandlerOptions {
  /** Server-side classification; an unavailable or unrecognized row refuses the socket. */
  resolveWorkspaceHosting: (binding: HostedConnectorBinding) => Promise<'byoc' | 'papercusp' | null>;
  /** The same server-side classification when no connector is online. */
  resolveCustomerWorkspaceHosting: (customerWorkspaceId: string) => Promise<'byoc' | 'papercusp' | null>;
  /**
   * Monthly app-relay usage (P-007, D-006). Production passes the Postgres store
   * (migration 1254); the in-memory default is for tests and hosts without one.
   */
  appRelayUsage?: HostedAppRelayUsageStore;
  appRelayLimits?: AppRelayLimits;
  /**
   * The portal's MCP OAuth clients and requests (P-325, migration 1260). Production passes the
   * Postgres store; the in-memory default is for tests and hosts without one.
   */
  mcpOAuthStore?: PortalOAuthStore;
  /**
   * The control-plane workspace the principal resolver stamps (see hosted-principal-resolver.ts).
   * Without it the consent page cannot resolve a signed-in account, so it always asks to sign in.
   */
  controlPlaneWorkspaceId?: string;
  /**
   * WI-10004257: each connector's organization's removed members, sent to the machine so its
   * creator-removed connected-app alert can fire there. Production reads the portal's membership
   * tables as the hosted service role; absent sends no reports.
   */
  membershipReport?: HostedWorkspaceSessionBrokerOptions["membershipReport"];
}

/** Only a verified delegation's explicit vendor-hosting marker permits the weaker route. */
export function classifyHostedWorkspaceHosting(
  providerConfig: unknown,
  customerWorkspaceId: string,
): 'byoc' | 'papercusp' | null {
  if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) return null;
  const delegation = (providerConfig as Record<string, unknown>).hostedDelegation;
  if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) return null;
  const record = delegation as Record<string, unknown>;
  if (record.status !== 'verified' || record.workspaceId !== customerWorkspaceId || !record.configuration ||
      typeof record.configuration !== 'object' || Array.isArray(record.configuration)) return null;
  const configuration = record.configuration as Record<string, unknown>;
  const source = configuration.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  if (configuration.provider === 'gcp' && (source as Record<string, unknown>).method === 'papercusp-hosted') return 'papercusp';
  if (configuration.provider === 'aws' && configuration.papercuspHosted &&
      typeof configuration.papercuspHosted === 'object') return 'papercusp';
  return 'byoc';
}

/** Read the existing delegation record, not a client-supplied hosting claim. */
export async function readHostedWorkspaceHosting(
  binding: HostedConnectorBinding,
): Promise<'byoc' | 'papercusp' | null> {
  return withWorkspace(binding.controlPlaneWorkspaceId, async (sql) => {
    const rows = await sql<Array<{ provider_config: unknown }>>`
      SELECT connection.provider_config
        FROM harness_shared.customer_workspaces AS customer
        JOIN harness_shared.workspace_hosts AS host
          ON host.workspace_id = customer.workspace_id AND host.id = customer.workspace_host_id
        JOIN harness_shared.workspace_host_connections AS connection
          ON connection.workspace_id = host.workspace_id AND connection.id = host.connection_id
       WHERE customer.workspace_id = ${binding.controlPlaneWorkspaceId}
         AND customer.id = ${binding.customerWorkspaceId}
         AND customer.organization_id = ${binding.organizationId}
         AND customer.workspace_host_id = ${binding.hostId}
         AND customer.state <> 'deleted'
       LIMIT 1
    `;
    return classifyHostedWorkspaceHosting(rows[0]?.provider_config, binding.customerWorkspaceId);
  });
}

/** Classify portal requests even when the customer's connector is offline. */
export async function readCustomerWorkspaceHosting(
  controlPlaneWorkspaceId: string,
  customerWorkspaceId: string,
): Promise<'byoc' | 'papercusp' | null> {
  return withWorkspace(controlPlaneWorkspaceId, async (sql) => {
    const rows = await sql<Array<{ provider_config: unknown }>>`
      SELECT connection.provider_config
        FROM harness_shared.customer_workspaces AS customer
        JOIN harness_shared.workspace_hosts AS host
          ON host.workspace_id = customer.workspace_id AND host.id = customer.workspace_host_id
        JOIN harness_shared.workspace_host_connections AS connection
          ON connection.workspace_id = host.workspace_id AND connection.id = host.connection_id
       WHERE customer.workspace_id = ${controlPlaneWorkspaceId}
         AND customer.id = ${customerWorkspaceId}
         AND customer.state <> 'deleted'
       LIMIT 1
    `;
    return classifyHostedWorkspaceHosting(rows[0]?.provider_config, customerWorkspaceId);
  });
}

export function createHostedHandler(
  plane: AssembledHostedControlPlane,
  spa: Hono,
  options: HostedHandlerOptions,
): HostedHandler {
  const app = new Hono();
  const gateway = plane.components.connectorGateway;
  // P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29): the broker pings
  // every relay socket and reports what it sees; `heartbeat_at` is what the CLI's
  // `reachable` and terminal gate read, so a dead link stops reading as connected.
  const sessionBroker = new HostedWorkspaceSessionBroker({
    // WI-10004167: the control plane's own copy of hosted desktop viewer starts, in
    // the binding's control-plane workspace. The host writes these to its own
    // database, which the customer-acceptance receipt cannot read. Only desktop
    // starts are persisted: the broker also reports every relayed terminal frame.
    onAudit: (event) => {
      if (!isHostedDesktopAuditAction(event.action)) return;
      recordDesktopAudit(hostedDesktopAuditRow(event), {
        idPrefix: "hosted-relay-vnc",
        workspaceId: () => event.controlPlaneWorkspaceId,
        onError: (error) =>
          console.warn(
            `[hosted-relay] could not record ${event.action} for ${event.customerWorkspaceId} channel ${event.channelId ?? "?"}:`,
            error instanceof Error ? error.message : error,
          ),
      });
    },
    onConnectorLiveness: (binding, alive) => {
      if (!gateway) return;
      void gateway.recordLiveness(binding, alive, (error) => {
        console.warn(
          `[hosted-relay] could not record connector liveness (${alive ? "alive" : "gone"}) for ${binding.customerWorkspaceId} gen ${binding.generation}:`,
          error instanceof Error ? error.message : error,
        );
      });
    },
    ...(options.membershipReport ? { membershipReport: options.membershipReport } : {}),
  });

  // P-007 (external-app-access-to-workspaces-2026-09-29): outside apps call a
  // workspace's tools here, relayed over its connector. Mounted beside the socket
  // upgrade rather than in the plane's allowlist because the relay IS this broker,
  // and hosted-profile refuses catch-all paths by design. The handler refuses
  // anything but an app key, answers at once for an offline machine, and applies
  // the per-workspace limits (D-005, D-006, D-008).
  const appRelayLimits = options.appRelayLimits ?? DEFAULT_APP_RELAY_LIMITS;
  const appRelay: HostedAppRelayDependencies = {
    port: sessionBroker,
    resolveCustomerWorkspaceHosting: options.resolveCustomerWorkspaceHosting,
    usage: options.appRelayUsage ?? new InMemoryHostedAppRelayUsageStore(),
    rate: new AppRelayRateLimiter(appRelayLimits.requestsPerMinute),
    limits: appRelayLimits,
  };

  // P-325 (D-021): the portal is each hosted workspace's MCP authorization server. An MCP
  // client handed `<portal>/api/workspaces/<id>/mcp` follows the relay's 401 to this metadata,
  // registers, sends the person to the consent page (the plane's own signed-in session decides
  // who may approve), and trades the code for a key the MACHINE mints over the connector.
  // Matched by the module's own path test, ahead of the relay and the `/api/*` catch-all.
  const controlPlaneWorkspaceId = options.controlPlaneWorkspaceId?.trim();
  const resolveHostedPrincipal = controlPlaneWorkspaceId
    ? createHostedPrincipalResolver({
        controlPlaneWorkspaceId,
        sessionCookieCodec: plane.components.sessionCookieCodec,
        sessionStore: plane.components.sessionStore,
        membershipAuthority: plane.components.membershipAuthority,
      })
    : null;
  const mcpOAuth: PortalMcpOAuthDependencies = {
    store: options.mcpOAuthStore ?? new InMemoryPortalOAuthStore(),
    port: sessionBroker,
    resolveCustomerWorkspaceHosting: options.resolveCustomerWorkspaceHosting,
    resolvePrincipal: async (headers) =>
      resolveHostedPrincipal ? resolveHostedPrincipal(headers) : { ok: false, reason: "principal_resolver_unconfigured" },
  };
  app.use("*", async (context, next) => {
    if (!isPortalMcpOAuthPath(new URL(context.req.url).pathname)) return next();
    return (await handleHostedMcpOAuth(context.req.raw, mcpOAuth)) ?? new Response("Not found", { status: 404 });
  });

  app.all("/api/workspaces/:workspaceId/agent-tools/*", (context) => handleHostedAppRelay(context.req.raw, appRelay));
  app.all("/api/workspaces/:workspaceId/mcp", (context) => handleHostedAppRelay(context.req.raw, appRelay));
  // P-017 (D-032 #4): a signed webhook, relayed without an app key; the machine checks the signature.
  app.all("/api/workspaces/:workspaceId/hooks/:sourceId", (context) => handleHostedAppRelay(context.req.raw, appRelay));

  // `/api/*` terminates at the audited hosted plane. A miss stays a JSON/HTTP
  // 404 and can never fall through to the SPA shell.
  app.all("/api/*", (context) => plane.app.fetch(context.req.raw));

  // These namespaces belong to the local host's docs/page renderers. Explicit
  // 404s make their absence observable instead of returning the SPA shell.
  for (const prefix of HOSTED_FORBIDDEN_HOST_PATH_PREFIXES) {
    app.all(prefix, () => new Response("Not found", { status: 404 }));
    app.all(`${prefix}/*`, () => new Response("Not found", { status: 404 }));
  }

  // The existing operator SPA is served from the same origin, last. No local
  // host-handler, proxy, docs, process, repository, file, or PTY graph is
  // imported into this module.
  app.route("/", spa);

  const websocketServer = new WebSocketServer({ noServer: true });

  return {
    plane,
    app,
    relay: sessionBroker,
    handler: async (request) => app.fetch(request),
    async upgrade(request, socket, head) {
      if (!gateway || request.url?.split("?")[0] !== "/api/hosted/connectors/socket") return false;
      const host = request.headers.host ?? "app.papercusp.com";
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const fetchRequest = new Request(`https://${host}${request.url}`, { headers });
      const authenticated = await authenticateHostedConnectorSocket(gateway, fetchRequest);
      if (!authenticated) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return true; }
      let hosting: 'byoc' | 'papercusp' | null = null;
      try { hosting = await options.resolveWorkspaceHosting(authenticated.binding); } catch { /* fail closed */ }
      if (!hosting) { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return true; }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const untrack = gateway.track(authenticated.binding, (reason) => websocket.close(4001, reason));
        websocket.once("close", untrack);
        if (authenticated.role === "connector") sessionBroker.attachConnector({ ...authenticated.binding, hosting }, websocket);
        // P-013: which desktop a viewer wants rides on the upgrade query, alongside
        // the ticket. The TICKET authorizes the workspace; the id selects within it —
        // consistent with D-025 ruling 2, which records that the connector binding is
        // the authorization boundary and that no second, weaker per-user filter is
        // applied to what a viewer may see.
        else sessionBroker.attachBrowser({ ...authenticated.binding, hosting }, websocket, readAttachRequest(fetchRequest));
        websocketServer.emit("connection", websocket, request);
      });
      return true;
    },
  };
}

export async function createHostedHandlerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HostedRuntimeDependencies = {},
): Promise<HostedHandler> {
  const configuration = readHostedRuntimeConfiguration(env);
  // This process owns the full operator graph, so it is the ONE place the
  // encrypted-store secret resolver (`integration:NAME` → operator_integration_
  // credentials) is composed in. The runtime modules themselves default to the
  // generic env:/file: resolver so the portal's esbuild prebundle of
  // hosted-auth-runtime.ts never inherits operator-state-pg (EI-22091008218242870).
  const plane = await createHostedRuntime(configuration, {
    resolveSecret: resolveHostedSecretRef,
    ...dependencies,
  });
  const spa = createSpaRoutes({
    kind: "hosted",
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
  });
  // The monthly relay bandwidth cap (D-006) must survive a restart, so production
  // counts it in Postgres, as the hosted service role (migrations 1254 + 1255). So do
  // the portal's MCP OAuth clients and pending grants (migration 1260, P-325).
  const runService = dependencies.runService ?? withHostedServiceContext;
  return createHostedHandler(plane, spa, {
    resolveWorkspaceHosting: readHostedWorkspaceHosting,
    resolveCustomerWorkspaceHosting: (customerWorkspaceId) =>
      readCustomerWorkspaceHosting(configuration.controlPlaneWorkspaceId, customerWorkspaceId),
    appRelayUsage: new PostgresHostedAppRelayUsageStore(runService),
    mcpOAuthStore: new PostgresPortalOAuthStore(runService),
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
    membershipReport: (binding) => loadMembershipReportFrame(binding.organizationId, runService),
  });
}
