/**
 * tool-call-log-store.ts — the Postgres read for the bare tool-call log surface
 * (deterministic-context-carry-2026-07-14 P-013). Reads the tool ledger the
 * per-CLI hooks already write (harness_shared.agent_activity, migration 143);
 * the pure rendering lives in tool-call-log.ts.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ToolCallRow } from './tool-call-log';
import { resolveConcreteWorkspaceId } from './workspace-registry';

export interface ToolCallRowsFilter {
  sessionId?: string;
  ownerId?: string;
  /** Concrete workspace to read; defaults to the active request/process workspace. */
  workspaceId?: string;
  /** Only rows strictly after this ISO timestamp (a window/generation floor). */
  sinceIso?: string;
  /** Only rows at or before this ISO timestamp (a generation ceiling). */
  untilIso?: string;
  /** Newest N raw rows considered (default 1000, cap 5000) — pre/post pairs
   *  double the per-call row count, so budget ~2 rows per call. */
  limit?: number;
}

/**
 * The most recent tool-ledger rows matching the filter, returned OLDEST FIRST
 * (the order the renderer wants). At least one of sessionId/ownerId is
 * required — an unscoped read of the whole fleet ledger is never the intent.
 */
export async function toolCallRowsFor(filter: ToolCallRowsFilter): Promise<ToolCallRow[]> {
  if (!filter.sessionId && !filter.ownerId) {
    throw new Error('toolCallRowsFor: pass sessionId and/or ownerId');
  }
  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 5000);
  const workspaceId = resolveConcreteWorkspaceId(filter.workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      id: string;
      tool_name: string | null;
      phase: string | null;
      tool_use_id: string | null;
      status: string | null;
      summary: string | null;
      detail: unknown;
      kind: string | null;
      created_at: string;
    }>
  >`
    SELECT id::text AS id, tool_name, phase, tool_use_id, status, summary, detail, kind,
           created_at::text AS created_at
    FROM harness_shared.agent_activity
    WHERE kind = 'tool'
      AND workspace_id IN (${workspaceId}, '*')
      AND (${filter.sessionId ?? null}::text IS NULL OR session_id = ${filter.sessionId ?? null})
      AND (${filter.ownerId ?? null}::text IS NULL OR owner_id = ${filter.ownerId ?? null})
      AND (${filter.sinceIso ?? null}::timestamptz IS NULL OR created_at > ${filter.sinceIso ?? null}::timestamptz)
      AND (${filter.untilIso ?? null}::timestamptz IS NULL OR created_at <= ${filter.untilIso ?? null}::timestamptz)
    ORDER BY id::bigint DESC
    LIMIT ${limit}
  `;
  rows.reverse(); // newest-N window, presented oldest-first
  return rows.map((r) => ({
    id: r.id,
    toolName: r.tool_name,
    phase: r.phase,
    toolUseId: r.tool_use_id,
    status: r.status,
    summary: r.summary,
    detail: r.detail,
    kind: r.kind,
    createdAt: r.created_at,
  }));
}
