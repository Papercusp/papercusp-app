/**
 * pending_events queue helpers (postgres.js).
 *
 * The orchestrator role reads this queue on every tick (alongside features/
 * issues/etc.) and decides which target_role to dispatch in response.
 *
 * Three sources insert events:
 *   - routine ticker (cron-due routines)
 *   - webhook handlers (POSTs to /api/routines/<id>/trigger)
 *   - API triggers (internal substrate calls)
 *   - completion-delta hooks (e.g. task→passed → notify reviewer)
 */

import type { Sql } from 'postgres';

export interface InsertEventInput {
  /**
   * Owning workspace (per-window-workspace-context P-041). pending_events is
   * RLS-scoped with a NOT-NULL `workspace_id` (migration 010) but the column
   * has no default, so every insert MUST set it — otherwise the row violates
   * the constraint and the queue can't be workspace-scoped on read.
   */
  workspaceId: string;
  installSlug: string;
  kind: 'routine' | 'webhook' | 'api' | 'completion';
  targetRole: string;
  payload?: Record<string, unknown> | null;
  dueAt?: Date | null;
  sourceId?: string | null;
}

export interface PendingEvent {
  id: string;
  installSlug: string;
  kind: string;
  targetRole: string;
  payload: Record<string, unknown> | null;
  dueAt: Date | null;
  createdAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
  sourceId: string | null;
}

export async function insertPendingEvent(sql: Sql, input: InsertEventInput): Promise<PendingEvent> {
  const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const payloadStr = input.payload ? JSON.stringify(input.payload) : null;
  const dueAtStr = input.dueAt ? input.dueAt.toISOString() : null;
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.pending_events
      (id, workspace_id, install_slug, kind, target_role, payload, due_at, source_id)
    VALUES (
      ${id},
      ${input.workspaceId},
      ${input.installSlug},
      ${input.kind},
      ${input.targetRole},
      ${payloadStr}::text::jsonb,
      ${dueAtStr}::timestamptz,
      ${input.sourceId ?? null}
    )
    RETURNING *
  `;
  return rowToEvent(rows[0]);
}

export async function listUnconsumedEvents(
  sql: Sql,
  installSlug: string,
  opts: { limit?: number; onlyDue?: boolean; workspaceId?: string } = {}
): Promise<PendingEvent[]> {
  const limit = opts.limit ?? 100;
  const dueClause = opts.onlyDue
    ? sql`AND (due_at IS NULL OR due_at <= now())`
    : sql``;
  // P-041: scope to the request workspace when supplied. install_slug is NOT
  // workspace-unique, and this is read through the RLS-bypassing admin handle,
  // so without an explicit workspace_id predicate a window would see another
  // workspace's queue for a colliding harness slug.
  const wsClause = opts.workspaceId
    ? sql`AND workspace_id = ${opts.workspaceId}`
    : sql``;

  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.pending_events
     WHERE install_slug = ${installSlug}
       AND consumed_at IS NULL
       ${wsClause}
       ${dueClause}
     ORDER BY due_at ASC NULLS FIRST, created_at ASC
     LIMIT ${limit}
  `;
  return rows.map(rowToEvent);
}

export async function consumeEvent(
  sql: Sql,
  eventId: string,
  consumedBy: string,
  workspaceId?: string,
): Promise<boolean> {
  // P-041: defense-in-depth workspace scope (event ids are globally unique, but
  // scoping the consume too means a cross-workspace id can never mark a row).
  const wsClause = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;
  const result = await sql`
    UPDATE harness_shared.pending_events
       SET consumed_at = now(), consumed_by = ${consumedBy}
     WHERE id = ${eventId} AND consumed_at IS NULL ${wsClause}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

export async function consumeEvents(
  sql: Sql,
  eventIds: string[],
  consumedBy: string,
  workspaceId?: string,
): Promise<number> {
  if (eventIds.length === 0) return 0;
  // P-041: scope to the request workspace when supplied (see listUnconsumedEvents).
  const wsClause = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;
  const result = await sql`
    UPDATE harness_shared.pending_events
       SET consumed_at = now(), consumed_by = ${consumedBy}
     WHERE id = ANY(${eventIds}::text[])
       AND consumed_at IS NULL ${wsClause}
  `;
  return Number((result as { count: number }).count ?? 0);
}

function rowToEvent(row: any): PendingEvent {
  return {
    id: row.id,
    installSlug: row.install_slug,
    kind: row.kind,
    targetRole: row.target_role,
    payload: row.payload,
    dueAt: row.due_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    sourceId: row.source_id,
  };
}
