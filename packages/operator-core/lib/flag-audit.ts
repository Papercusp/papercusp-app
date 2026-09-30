/**
 * Append an `audit_log` row for a feature-flag flip — the single correct
 * writer for both flag-set paths (the HTTP `/api/flags/set` route + the MCP
 * `flags:set` tool).
 *
 * EI-293: flag flips were forensically invisible. The HTTP route wrote no
 * audit row at all, and the MCP tool's inline INSERT omitted the NOT-NULL
 * `id` + `workspace_id` columns (audit_log has no defaults/triggers for them),
 * so every MCP flag audit silently failed inside its best-effort try/catch —
 * 0 `flag:set` rows existed despite many flips. Flag flips reroute fleet
 * behaviour (INFERENCE_GATEWAY, OPEN_SIGNUP, ENDPOINT_AUTH_TIERS, …), so they
 * must be attributable. Fire-and-forget; never throws (mirrors process-kill's
 * audit writer — the canonical full-column shape).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export async function recordFlagAudit(
  key: string,
  enabled: boolean,
  actor: string,
  extra?: { reason?: string; backend?: string; posthogFailureReason?: string },
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `flag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        actor,
        'flag:set',
        key,
        JSON.stringify({ enabled, ...(extra ?? {}) }),
        activeWorkspaceId(),
      ],
    );
  } catch (err) {
    // Best-effort: the flip already succeeded; never block it on the audit.
     
    console.warn('[flags] audit write failed:', (err as Error)?.message);
  }
}
