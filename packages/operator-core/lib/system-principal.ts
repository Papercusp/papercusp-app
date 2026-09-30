/**
 * System-principal lookup — bearer + capabilities for `system:<name>`.
 *
 * The bearer lives in `harness_shared.token_index` (`kind='system'`, `harness_slug='system:<name>'`)
 * and the capability list lives in `harness_shared.system_principals`. Both
 * are written by `provisionSystemPrincipal` (packages/agent-mcp/src/provisioning.ts).
 *
 * Was previously also duplicated to `<workspace>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes. That file is now gone;
 * routes call this module instead. The bearer hash in `system_principals`
 * is preserved for audit/rotation but the routes only need the live bearer
 * which lives in `token_index`.
 *
 * Note on encryption: `token_index.token` is plaintext today. Adding
 * column-level encryption breaks the auth middleware's `WHERE token = $1`
 * lookup pattern; would require either (a) a hash index for incoming-token
 * verification + a separate ciphertext column for retrieval, or (b) a
 * different lookup model entirely. Tracked as future work.
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';

const ti = generated.tokenIndexInHarnessShared;
const sp = generated.systemPrincipalsInHarnessShared;

export interface SystemPrincipal {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

/**
 * Read the system principal for `name` ('operator' | 'oracle' | …) in the
 * given workspace (default: the active workspace). Returns null when not
 * provisioned (caller surfaces a "POST /api/agent-mcp/provision first" error
 * per established route convention).
 *
 * Pass `workspaceId` explicitly when the caller already resolved the
 * REQUEST's workspace (e.g. from its dispatch ctx) — calling this with the
 * implicit default from a context where the request ALS has expired (an SSE
 * setup, a background continuation) silently looks up the PROCESS-GLOBAL
 * workspace's principal instead (voice-persona-production-readiness P-003
 * root-cause, 2026-06-07).
 */
export async function readSystemPrincipal(
  name: string,
  workspaceId?: string,
): Promise<SystemPrincipal | null> {
  const { db } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const slug = `system:${name}`;
  const rows = await db
    .select({ token: ti.token, capabilities: sp.capabilities })
    .from(ti)
    .innerJoin(sp, and(eq(sp.workspaceId, ti.workspaceId), eq(sp.name, name)))
    .where(and(eq(ti.kind, 'system'), eq(ti.harnessSlug, slug), eq(ti.workspaceId, ws)))
    .limit(1);
  if (rows.length === 0) return null;
  return {
    bearer: rows[0].token,
    name,
    workspaceId: ws,
    capabilities: (rows[0].capabilities as string[] | null) ?? [],
  };
}
