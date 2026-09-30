/**
 * Cookie-session → Principal resolver.
 *
 * Reads the `papercusp_session` cookie from the request's `Headers`,
 * validates against the PG session row, and produces a `Principal` with
 * `kind: 'user'`, `authMethod: 'cookie-session'`, `trust: 'verified'`.
 *
 * Returns null when there is no cookie, the cookie is expired, the user
 * is inactive, or the row is missing — every "no principal" outcome
 * resolves to null without throwing so the composite `requirePrincipal()`
 * helper can fall through to the next resolver.
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5a). The `headers`
 * parameter (added with the endpoint-route migration) makes this
 * Next-free: the session token comes from the passed `Cookie` header,
 * not `next/headers` `cookies()`.
 */

import type { Principal } from '@papercusp/agent-mcp';
import { getSessionUser } from '../../auth';

export async function principalFromCookie(headers: Headers): Promise<Principal | null> {
  const user = await getSessionUser(headers);
  if (!user) return null;
  return {
    kind: 'user',
    slug: user.id,
    workspaceId: user.workspace_id,
    authMethod: 'cookie-session',
    trust: 'verified',
    capabilities: new Set(user.capabilities),
    label: user.display_name || user.username,
  };
}
