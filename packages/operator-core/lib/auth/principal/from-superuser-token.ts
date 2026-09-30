/**
 * Superuser bearer file → Principal resolver.
 *
 * Reads `Authorization: Bearer <token>` and validates against
 * `~/.papercusp/superuser-token`. Requires the request be loopback —
 * the bearer file is desktop-local and the only valid presenter is
 * a same-host shell.
 *
 * Produces `kind: 'system'`, `authMethod: 'bearer-token'`, `trust: 'trusted'`.
 * Capabilities = wildcard — superuser shells need the full tool surface
 * (the `?superuser=1` path in agent-mcp bypasses every gate by design).
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5d).
 */

import type { Principal } from '@papercusp/agent-mcp';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../superuser-token';
import { activeWorkspaceId } from '../../workspace-registry';

export function principalFromSuperuserToken(headers: Headers): Principal | null {
  if (!isLoopbackRequest(headers)) return null;
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!isValidSuperuserBearer(token)) return null;
  return {
    kind: 'system',
    slug: 'system:superuser',
    workspaceId: activeWorkspaceId(),
    authMethod: 'bearer-token',
    trust: 'trusted',
    capabilities: new Set(['*']),
    label: 'superuser shell',
  };
}
