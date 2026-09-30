/**
 * Loopback-only → Principal resolver.
 *
 * The legacy desktop trust path: when the Host header is local (127.0.0.1
 * or a Tauri origin), produce a `kind: 'loopback'` principal with
 * `trust: 'unverified-loopback'`. Returns null when the request isn't
 * loopback.
 *
 * This is the ONLY resolver that produces `trust: 'unverified-loopback'`.
 * Phase 8 (webapp host) bans this trust level at boot when
 * `PAPERCUSP_BIND_HOST !== '127.0.0.1'` — that's the single config-driven
 * check that makes the webapp safe.
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5e).
 */

import type { Principal } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../superuser-token';
import { activeWorkspaceId } from '../../workspace-registry';

export function principalFromLoopback(headers: Headers): Principal | null {
  if (!isLoopbackRequest(headers)) return null;
  return {
    kind: 'loopback',
    slug: 'loopback',
    workspaceId: activeWorkspaceId(),
    authMethod: 'host-loopback',
    trust: 'unverified-loopback',
    // Legacy desktop trust — every cap, but unverified at the wire layer.
    // Gates that require trust === 'trusted' will reject these.
    capabilities: new Set(['*']),
    label: 'loopback',
  };
}
