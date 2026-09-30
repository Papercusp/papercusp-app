/**
 * The HTTP-level auth challenge on `/api/mcp` (external-app-access-to-workspaces-2026-09-29 P-006).
 *
 * An MCP client (Claude.ai and ChatGPT custom connectors, the MCP TypeScript SDK) discovers how to
 * sign in from exactly one signal: an HTTP 401 on its first request whose `WWW-Authenticate`
 * header names the protected-resource metadata (RFC 9728 §5.1, MCP authorization spec). Without it
 * the client never starts OAuth. The MCP host's own refusal (`unauthenticated_non_local`,
 * `connected_app_invalid_key:*` in `_mcp-host.ts`) arrives INSIDE the JSON-RPC session, too late
 * for discovery, so this runs before the transport:
 *
 *   - an app-key bearer that does not verify → 401 `error="invalid_token"` (the client drops the
 *     token and signs in again). A store failure is NOT an answer: it falls through, and the host
 *     refuses with `unavailable` as before.
 *   - an outside request with no credential at all → 401 with `resource_metadata`.
 *
 * Everything else passes through unchanged: a local caller (the desktop, psu sessions, the
 * loopback verdict of P-004), and any request that presents a credential the host resolves
 * itself (a device JWT, a PI bearer, a signed spawn URL, a valid app key). This never GRANTS
 * anything — it only refuses earlier, in the shape clients understand.
 */
import { protectedResourceMetadataUrl, publicOriginOf } from '../../../connected-apps/mcp-oauth-discovery';

export interface McpAuthChallengeDependencies {
  /** The P-004 loopback verdict: true only for a caller on this machine, not a tunnel or relay. */
  readonly isLocal: (headers: Headers) => boolean;
  /** True when the token has the app-key shape (valid or not). */
  readonly isAppKeyShaped: (token: string | null) => boolean;
  /** Verify an app key. Throws when the store cannot answer. `reason` names a refusal. */
  readonly verifyAppKey: (token: string) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * The machine code of an app-key refusal, as the MCP host names it inside the session
 * (`connected_app_invalid_key:<reason>`, `_mcp-host.ts`). The 401 below runs first, so without
 * the code there the app would only ever learn "not valid" — never that its key was revoked,
 * paused, rotated out, or that the workspace turned remote access off (P-010, R-40/R-41).
 * Reasons are identifiers; anything else is dropped so the header's quoted-string stays valid.
 */
export function appKeyRefusalCode(reason: string | undefined): string {
  const clean = (reason ?? '').replace(/[^a-z0-9_:-]/gi, '');
  return `connected_app_invalid_key:${clean || 'invalid'}`;
}

function bearerOf(headers: Headers): string | null {
  const raw = headers.get('authorization');
  if (!raw) return null;
  const token = /^bearer /i.test(raw) ? raw.slice(7).trim() : raw.trim();
  return token || null;
}

function challenge(req: Request, error: 'invalid_token' | null, description: string, code?: string): Response {
  const params = [`resource_metadata="${protectedResourceMetadataUrl(publicOriginOf(req))}"`];
  if (error) params.push(`error="${error}"`, `error_description="${description}"`);
  return Response.json(
    { error: error ?? 'unauthorized', error_description: description, ...(code ? { code } : {}) },
    { status: 401, headers: { 'www-authenticate': `Bearer ${params.join(', ')}`, 'cache-control': 'no-store' } },
  );
}

/** A 401 the client should see instead of the MCP session, or null to continue to the transport. */
export async function mcpAuthChallenge(req: Request, deps: McpAuthChallengeDependencies): Promise<Response | null> {
  const token = bearerOf(req.headers);
  if (token !== null && deps.isAppKeyShaped(token)) {
    let verdict: { ok: boolean; reason?: string };
    try {
      verdict = await deps.verifyAppKey(token);
    } catch {
      return null;
    }
    if (verdict.ok) return null;
    const code = appKeyRefusalCode(verdict.reason);
    return challenge(req, 'invalid_token', `the access token is not valid (${code})`, code);
  }
  if (token !== null) return null;
  if (new URL(req.url).searchParams.has('sig')) return null;
  if (deps.isLocal(req.headers)) return null;
  return challenge(req, null, 'sign in to use this workspace');
}
