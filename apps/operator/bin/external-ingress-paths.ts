/**
 * WI-10004174 — what the external-ingress listener serves.
 *
 * The external-ingress listener (`PAPERCUSP_EXTERNAL_INGRESS_PORT`, external-app-access P-004)
 * is the port a user's own tunnel points at. It used to serve the whole app, so every
 * `auth:'public'` route (reachable without credentials because only the local machine could
 * reach the loopback listener) became reachable from the internet through the tunnel.
 *
 * A remote MCP client needs exactly three things: the discovery documents, the OAuth endpoints,
 * and the MCP resource. This module is that list and nothing else. Every other path answers 404
 * on the external-ingress listener. Exact paths only, never a prefix, so a new route under an
 * allowed directory is not exposed by accident.
 *
 * The path constants come from the one discovery map (connected-apps/mcp-oauth-discovery.ts),
 * so the host's well-known mapping and this list cannot drift apart.
 */
import {
  MCP_OAUTH_BASE,
  MCP_OAUTH_WELL_KNOWN,
  MCP_RESOURCE_PATH,
} from '@papercusp/operator-core/lib/connected-apps/mcp-oauth-discovery';

/** The OAuth route verbs a remote client uses (routes/connected-apps/oauth.ts). */
const OAUTH_VERBS = ['protected-resource', 'authorization-server', 'register', 'authorize', 'continue', 'token'] as const;

export const EXTERNAL_INGRESS_SERVED_PATHS: ReadonlySet<string> = new Set([
  ...Object.keys(MCP_OAUTH_WELL_KNOWN),
  ...OAUTH_VERBS.map((verb) => `${MCP_OAUTH_BASE}/${verb}`),
  MCP_RESOURCE_PATH,
]);

/** Whether the external-ingress listener serves this request path. A trailing slash is ignored. */
export function isServedOnExternalIngress(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return EXTERNAL_INGRESS_SERVED_PATHS.has(normalized);
}

/** The refusal for any other path: a plain 404, so the listener does not advertise what exists. */
export function notServedOnExternalIngress(): Response {
  return Response.json(
    {
      error: {
        code: 'not_served_on_external_ingress',
        message: 'This address serves only the MCP endpoint and its OAuth sign-in.',
      },
    },
    { status: 404 },
  );
}
