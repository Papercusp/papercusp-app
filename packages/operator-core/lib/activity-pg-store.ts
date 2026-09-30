/**
 * activity-pg-store.ts — the Postgres adapter for @papercusp/activity-bridge's
 * `TelemetryStore` ingest seam (papercusp-worker-integration-2026-06-04, D-003;
 * extracted to the generic lib by generalize-libs-to-generic-2026-06-05 #10).
 *
 * The generic lib normalizes a raw cross-CLI hook event → an `ActivityRecord` and
 * appends it through this store. Here we bind that seam to `harness_shared.agent_activity`
 * (migration 143): the record's host-neutral `scope` maps to the `harness_slug` column,
 * `workspaceId` defaults to '*'. The migration-143 trigger fires NOTIFY agent_activity,
 * which the /api/activity/stream SSE rides — so this INSERT is the whole "tell the fleet
 * view what each worker is doing" write.
 *
 * Read-side (activity:recent / the SSE drain) is host-shaped and stays in operator-core
 * (it returns the snake_case wire shape the fleet view consumes) — the lib's port is
 * write-only by design.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ActivityRecord, TelemetryStore } from '@papercusp/activity-bridge';

/** A Postgres-backed `TelemetryStore` over harness_shared.agent_activity. */
export function createPgTelemetryStore(): TelemetryStore {
  return {
    async append(record: ActivityRecord): Promise<{ id: string | null }> {
      // `${json}::text::jsonb` (NOT `::jsonb`) — postgres-js JSON-encodes a string
      // param first, so a bare `::jsonb` double-encodes (papercusp-worker-integration
      // gotcha; same form tui/dispatch.ts uses).
      const detailJson = record.detail ? JSON.stringify(record.detail) : null;
      const workspaceId = record.workspaceId ?? '*';
      const { sql } = getOrgPg();
      const inserted = await sql<Array<{ id: string }>>`
        INSERT INTO harness_shared.agent_activity
          (workspace_id, owner_id, agent, session_id, harness_slug, kind, tool_name, phase, tool_use_id, summary, status, detail, cwd)
        VALUES (
          ${workspaceId}, ${record.owner}, ${record.agent}, ${record.sessionId},
          ${record.scope}, ${record.kind}, ${record.toolName}, ${record.phase},
          ${record.toolUseId}, ${record.summary}, ${record.status},
          ${detailJson}::text::jsonb, ${record.cwd}
        )
        RETURNING id::text AS id
      `;
      return { id: inserted[0]?.id ?? null };
    },
  };
}
