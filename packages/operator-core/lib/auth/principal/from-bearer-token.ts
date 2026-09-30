/**
 * Agent bearer-token → Principal resolver.
 *
 * Reads `Authorization: Bearer <token>` and resolves it against
 * `harness_shared.token_index` via `resolveBearer` — the path that
 * admits `kind: 'system'` (operator self / background sweepers) and
 * `kind: 'pi'` (shell-launched agents) callers.
 *
 * This is distinct from `from-superuser-token.ts` (the desktop-local
 * `~/.papercusp/superuser-token` file, loopback-gated) — that token is
 * NOT in `token_index`. The two resolvers are mutually exclusive in
 * practice: a given bearer is either the superuser file token or a
 * `token_index` row, never both.
 *
 * Added in Phase E2 (endpoint-unification-2026-05-21) so `requirePrincipal`
 * covers the agent-bearer path. Before this, agent bearers only resolved
 * through the projected-tool HTTP catchall's bespoke `resolveBearer`
 * call — `requirePrincipal()` (and therefore every `defineTool`) was
 * blind to them.
 */

import type { Principal } from '@papercusp/agent-mcp';
import { resolveBearer } from '@papercusp/agent-mcp';

export async function principalFromBearerToken(headers: Headers): Promise<Principal | null> {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return null;
  return resolveBearer(token);
}
