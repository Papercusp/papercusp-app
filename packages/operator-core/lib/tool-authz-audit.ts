/**
 * Tool resource-authorization audit sink (RFC tooldef-auth Phase 1b host wiring).
 *
 * tooldef's dispatcher emits an `AuthAuditEvent` for every `authorize` allow, deny,
 * AND `GateBypass.policy` bypass via the optional `deps.auditAuth` seam. This is the
 * Papercusp host impl of that seam: an append-only write to
 * `harness_shared.tool_authz_log` (migration 090).
 *
 * Fire-and-forget by convention — callers `void recordToolAuthzEvent(...)` (see
 * `projected-tool-deps.ts` → `PROJECTED_DEPS.auditAuth`) so PG latency never blocks the
 * dispatch path. The whole point of the design is that a privileged bypass is logged,
 * not silent; a swallowed write still console.warns so the gap is visible in dev.
 *
 * Deliberately NOT routed into `auth-audit.ts` `recordAuthEvent`: that log is
 * login-scoped (kind ∈ login/password/logout). Resource-authz decisions are a distinct
 * security stream (tool/action/resource/gate), so they get their own table.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { AuthAuditEvent } from '@papercusp/agent-mcp';

export async function recordToolAuthzEvent(event: AuthAuditEvent): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.tool_authz_log
        (ts, workspace_id, principal_slug, tool, action,
         resource_type, resource_id, decision, gate, reason)
      VALUES (
        to_timestamp(${event.ts} / 1000.0),
        ${event.principal?.workspaceId ?? null},
        ${event.principal?.slug ?? null},
        ${event.tool},
        ${event.action},
        ${event.resource?.type ?? null},
        ${event.resource?.id ?? null},
        ${event.decision},
        ${event.gate},
        ${event.reason ?? null}
      )
    `;
  } catch (err) {
     
    console.warn('[tool-authz-audit] write failed:', (err as Error).message);
  }
}
