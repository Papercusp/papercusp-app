/**
 * App key → Principal (external-app-access-to-workspaces-2026-09-29 P-002).
 *
 * The one resolver every transport uses for a `pcapp_…` bearer: the HTTP auth
 * chain (`auth/require-principal.ts`), the agent-tools catchall
 * (`endpoint-route/routes/agent-tools/catchall.ts`), and MCP
 * (`endpoint-route/routes/transport/_mcp-host.ts`).
 *
 * It is deliberately TRI-STATE, not `Principal | null`:
 *   - `null`               — no app key was presented; the caller continues
 *                            down its own chain.
 *   - `{ ok: false, … }`   — an app key WAS presented and is not valid
 *                            (malformed, unknown, wrong secret, revoked, paused,
 *                            expired). The caller must refuse the request. It
 *                            must NOT fall through to a weaker resolver — above
 *                            all not the loopback one, which would turn a bad
 *                            key relayed to a local listener into local trust
 *                            (plan D-015).
 *   - `{ ok: true, … }`    — the key's principal.
 *
 * Principal shape: `kind: 'service'` (a bearer-token external integration —
 * the kind tooldef reserves for exactly this), `authMethod: 'bearer-token'`,
 * `trust: 'verified'` (the secret was checked against the stored digest),
 * `slug: 'app:<id>'`, the key's own workspace, and the key's granted
 * capabilities. P-003 narrows what those capabilities can reach.
 */

import type { Principal } from '@papercusp/agent-mcp';
import { notifyAttentionOnce } from '../attention-notify';
import { onAppKeyUsed } from './alerts';
import { isAppKeyShaped } from './key';
import { grantedToolCapabilities, type AppScopeTool } from './scope-policy';
import {
  projectedToolScopeCatalog,
  recordAppKeyUse,
  verifyAppKey,
  type AccessTokenGrant,
  type AppKeyRefusal,
  type AppKeyRow,
} from './store';

export const APP_PRINCIPAL_SLUG_PREFIX = 'app:';

export type AppKeyPrincipalResult =
  | { ok: true; principal: Principal; app: AppKeyRow }
  | { ok: false; reason: AppKeyRefusal | 'unavailable' };

/** The bearer token from an Authorization header, or null. */
export function bearerTokenOf(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  return token || null;
}

/** True when the request presents an app key (valid or not). */
export function presentsAppKey(headers: Headers): boolean {
  return isAppKeyShaped(bearerTokenOf(headers));
}

/**
 * The Principal an app or service key row authenticates as. It names the KEY, never the person who
 * created it (`user_email` is not read): a service key belongs to the workspace and must keep
 * working after its creator leaves the organization (P-015, D-007), so no downstream check may be
 * able to tie the principal back to that person.
 */
export function principalForAppKey(
  app: AppKeyRow,
  accessToken?: AccessTokenGrant,
  catalog: () => Iterable<AppScopeTool> = () => projectedToolScopeCatalog().values(),
): Principal {
  return {
    kind: 'service',
    // A client-credentials access token (P-016) is the parent key acting through one token:
    // `app:<keyId>/<tokenId>`. The dispatch seat (./enforce.ts) splits it, checks the parent AND
    // the token's narrower scope, and every roll-up keys on the parent id before the slash.
    slug: `${APP_PRINCIPAL_SLUG_PREFIX}${app.id}${accessToken ? `${ACCESS_TOKEN_SLUG_SEPARATOR}${accessToken.id}` : ''}`,
    workspaceId: app.workspace_id,
    authMethod: 'bearer-token',
    trust: 'verified',
    // The granted tools' declared capabilities join the explicit ones (WI-10004317): the key's
    // tool allowlist is its grant, and without them tools/list and the dispatch capability gate
    // refuse every real tool a "Connect an app" key names.
    capabilities: grantedToolCapabilities(accessToken?.scopes ?? app.scopes, catalog()),
    label: app.label ?? `${app.kind === 'service' ? 'service key' : 'app'} ${app.id}`,
  };
}

/** Separates the parent key id from the access-token id in an app principal slug. */
export const ACCESS_TOKEN_SLUG_SEPARATOR = '/';

/**
 * The client address a request reports, for the "last used from" column. This
 * is DISPLAY data only — forwarding headers are caller-controlled, so it must
 * never feed an authorization decision.
 */
export function reportedClientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const candidate = forwarded || headers.get('x-real-ip')?.trim() || headers.get('cf-connecting-ip')?.trim();
  return candidate ? candidate.slice(0, 64) : null;
}

/**
 * Resolve a raw bearer token. `null` when it is not an app key at all.
 * A store failure refuses (`unavailable`) — unlike the device-JWT revocation
 * check, an app key's validity cannot be established without the row, so a
 * database error must not grant access.
 */
export async function resolveAppKeyToken(
  token: string | null | undefined,
  opts: { ip?: string | null } = {},
): Promise<AppKeyPrincipalResult | null> {
  if (!isAppKeyShaped(token)) return null;
  let verdict;
  try {
    verdict = await verifyAppKey(token);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!verdict.ok) return verdict;
  // Records the use and raises the new-app / new-location alerts it implies (P-011, R-28/R-42).
  // Off the request path and never throws.
  void onAppKeyUsed(verdict.app, opts.ip ?? null, { recordUse: recordAppKeyUse, notify: notifyAttentionOnce });
  return { ok: true, principal: principalForAppKey(verdict.app, verdict.accessToken), app: verdict.app };
}

/** Resolve the app key a request presents (see `resolveAppKeyToken`). */
export async function resolveAppKeyPrincipal(headers: Headers): Promise<AppKeyPrincipalResult | null> {
  return resolveAppKeyToken(bearerTokenOf(headers), { ip: reportedClientAddress(headers) });
}
