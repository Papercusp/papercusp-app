/**
 * MCP OAuth discovery documents (external-app-access-to-workspaces-2026-09-29 P-006).
 *
 * Pure: no database, no route module. The OAuth routes (`endpoint-route/routes/connected-apps/
 * oauth.ts`) serve these documents, and the `/api/mcp` edge (`routes/transport/mcp-auth-challenge.ts`)
 * points an unauthenticated client at them, so both must agree on every URL — hence one module.
 */

/** Where the OAuth endpoints live under the operator's API. */
export const MCP_OAUTH_BASE = '/api/connected-apps/oauth';

/** The protected resource: the MCP endpoint. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/**
 * Root well-known path → the OAuth route that serves it. MCP clients look at the ROOT: the
 * resource-suffixed RFC 9728 form for `/api/mcp` first, then the bare one, then RFC 8414. The host
 * (apps/operator/bin/host-handler.ts) maps exactly these paths; the integration test uses the same
 * map, so a client that finds the documents there finds them on a real install too.
 */
export const MCP_OAUTH_WELL_KNOWN: Readonly<Record<string, string>> = {
  [`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`]: `${MCP_OAUTH_BASE}/protected-resource`,
  '/.well-known/oauth-protected-resource': `${MCP_OAUTH_BASE}/protected-resource`,
  '/.well-known/oauth-authorization-server': `${MCP_OAUTH_BASE}/authorization-server`,
};

/**
 * The origin the client used. Behind the user's tunnel the request reaches us over plain http
 * with the public Host, and the tunnel states the scheme in X-Forwarded-Proto. Used ONLY to build
 * URLs the client already addressed — never for a trust decision (that is the loopback verdict).
 */
export function publicOriginOf(req: Request): string {
  const url = new URL(req.url);
  const proto = (req.headers.get('x-forwarded-proto') ?? '').split(',')[0]!.trim().toLowerCase();
  const scheme = proto === 'https' || proto === 'http' ? proto : url.protocol.replace(':', '');
  return `${scheme}://${url.host}`;
}

/** RFC 9728 §3.1: the metadata URL for a resource with a path inserts the path after the well-known segment. */
export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/** RFC 9728 protected-resource metadata for `/api/mcp`. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${MCP_RESOURCE_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: 'Papercusp workspace',
  };
}

/**
 * What BOTH authorization servers — this machine's and the portal's per-workspace one
 * (portal-mcp-oauth.ts) — advertise at their token endpoints. client_credentials is a service key
 * in client-credentials mode (P-016, client-credentials.ts); `private_key_jwt` assertions are
 * verified with exactly {@link CLIENT_ASSERTION_ALGORITHMS}.
 */
export const TOKEN_GRANT_TYPES_SUPPORTED = ['authorization_code', 'client_credentials'] as const;
export const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'] as const;
export const CLIENT_ASSERTION_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;

/** RFC 8414 authorization-server metadata; the issuer is this origin. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${MCP_OAUTH_BASE}/authorize`,
    token_endpoint: `${origin}${MCP_OAUTH_BASE}/token`,
    registration_endpoint: `${origin}${MCP_OAUTH_BASE}/register`,
    response_types_supported: ['code'],
    grant_types_supported: [...TOKEN_GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGORITHMS],
    authorization_response_iss_parameter_supported: true,
  };
}
