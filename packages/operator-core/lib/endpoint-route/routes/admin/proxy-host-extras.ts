/**
 * Shared HttpToolHostExtras for the /api/admin/* in-process tool proxies
 * (admin/coordination, admin/coord, admin/plans, admin/inbox, admin/locks-queue).
 *
 * WI-5364: every proxy carried a copy-pasted `{ deps, log, validateSuperuser }`
 * with NO `runScoped` and NO `resolvePrincipalAndTx` — so the tooldef-http
 * adapter never put a DB handle on `ctx.tx`. That stayed latent for months
 * because every verb historically allowlisted on these mounts fetched its own
 * PG internally; `sessions:list` (owner-inbox-single-pane P-007) was the first
 * proxied handler to actually call `` ctx.tx`…` `` — and 500'd
 * "ctx.tx is not a function" on every conversation-popup open.
 *
 * The admin proxies always dispatch with `superuser=1` (each mount's
 * adminSearchParams forces it), so the agent-tools catchall's
 * `chooseScopedHandle` decision matrix would ALWAYS pick the admin
 * (rolbypassrls) handle for these calls. `runScoped` here is therefore the
 * behavior-identical direct form of that branch — one seam, no per-mount
 * copies to drift.
 */
import type { HttpToolHostExtras, ToolScope, UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';

export const ADMIN_PROXY_HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
  // Admin handle for every proxied call — see module doc. Typed via
  // UnifiedToolContext['tx'] so a db-org handle-type change surfaces here.
  runScoped: <T,>(
    _scope: ToolScope,
    run: (tx: UnifiedToolContext['tx']) => Promise<T>,
  ): Promise<T> => run(getOrgPg().sql),
};
