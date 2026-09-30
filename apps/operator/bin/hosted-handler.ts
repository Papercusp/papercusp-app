/** Restricted same-origin HTTP host for the hosted control-plane profile. */

import { Hono } from "hono";
import { withHostedServiceContext } from "@papercusp/db-org";
import {
  createHostedRuntime,
  readHostedRuntimeConfiguration,
  type HostedRuntimeDependencies,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-runtime";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { resolveHostedSecretRef } from "@papercusp/operator-core/lib/auth/hosted/secret-ref";
import { createSpaRoutes } from "./host-spa";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { authenticateHostedConnectorSocket } from "@papercusp/operator-core/lib/endpoint-route/routes/hosted-workspace-connector";
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceAttachRequest,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-session";
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
  /**
   * Monthly app-relay usage (P-007, D-006). Production passes the Postgres store
   * (migration 1254); the in-memory default is for tests and hosts without one.
   */
  appRelayUsage?: HostedAppRelayUsageStore;
  appRelayLimits?: AppRelayLimits;
}

export function createHostedHandler(
  plane: AssembledHostedControlPlane,
  spa: Hono,
  options: HostedHandlerOptions = {},
): HostedHandler {
  const app = new Hono();
  const gateway = plane.components.connectorGateway;
  // P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29): the broker pings
  // every relay socket and reports what it sees; `heartbeat_at` is what the CLI's
  // `reachable` and terminal gate read, so a dead link stops reading as connected.
  const sessionBroker = new HostedWorkspaceSessionBroker({
    onConnectorLiveness: (binding, alive) => {
      if (!gateway) return;
      void gateway.recordLiveness(binding, alive, (error) => {
        console.warn(
          `[hosted-relay] could not record connector liveness (${alive ? "alive" : "gone"}) for ${binding.customerWorkspaceId} gen ${binding.generation}:`,
          error instanceof Error ? error.message : error,
        );
      });
    },
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
    usage: options.appRelayUsage ?? new InMemoryHostedAppRelayUsageStore(),
    rate: new AppRelayRateLimiter(appRelayLimits.requestsPerMinute),
    limits: appRelayLimits,
  };
  app.all("/api/workspaces/:workspaceId/agent-tools/*", (context) => handleHostedAppRelay(context.req.raw, appRelay));
  app.all("/api/workspaces/:workspaceId/mcp", (context) => handleHostedAppRelay(context.req.raw, appRelay));

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
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const untrack = gateway.track(authenticated.binding, (reason) => websocket.close(4001, reason));
        websocket.once("close", untrack);
        if (authenticated.role === "connector") sessionBroker.attachConnector(authenticated.binding, websocket);
        // P-013: which desktop a viewer wants rides on the upgrade query, alongside
        // the ticket. The TICKET authorizes the workspace; the id selects within it —
        // consistent with D-025 ruling 2, which records that the connector binding is
        // the authorization boundary and that no second, weaker per-user filter is
        // applied to what a viewer may see.
        else sessionBroker.attachBrowser(authenticated.binding, websocket, readAttachRequest(fetchRequest));
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
  // counts it in Postgres, as the hosted service role (migrations 1254 + 1255).
  return createHostedHandler(plane, spa, {
    appRelayUsage: new PostgresHostedAppRelayUsageStore(dependencies.runService ?? withHostedServiceContext),
  });
}
