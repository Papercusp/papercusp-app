/**
 * tui-workbench-store — PG CRUD for the `pui` (apps/tui) workbench persistence
 * tables (migration 138): `tui_layouts`, `tui_crews`, `tui_view_state`.
 *
 * D-002 of tui-workbench-ratatui-2026-06-04. Three persisted concepts, all
 * per-user (owner_id) + workspace-scoped (activeWorkspaceId(), like
 * snapshot-index):
 *   • layout     — a named zellij pane arrangement (KDL).
 *   • crew       — a named set of agent sessions, optionally + a companion layout.
 *   • view_state — quiet UI/nav state, one row per user.
 *
 * Thin by design: the `/api/tui/*` routes (endpoint-route/routes/tui) are the
 * only caller. jsonb is written with the `::text::jsonb` cast (the repo's
 * encoding convention; raw object binding mis-encodes here).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface CrewMember {
  /** Pane slot index in the layout. */
  slot?: number;
  /** Agent kind, e.g. 'claude' | 'codex' | 'omp'. */
  agent?: string;
  /** Session id to restore via `psu --resume`. */
  resume_id?: string;
  /** Harness slug bound to the pane, if any. */
  harness?: string;
  /** Plan slug bound to the pane, if any. */
  plan?: string;
  /** Working directory for the pane, if pinned. */
  cwd?: string;
}

export interface LayoutSummary {
  name: string;
  description: string | null;
  updated_at: string;
}

export interface LayoutRow extends LayoutSummary {
  kdl: string;
  created_at: string;
}

export interface CrewSummary {
  name: string;
  description: string | null;
  layout_name: string | null;
  member_count: number;
  updated_at: string;
}

export interface CrewRow {
  name: string;
  description: string | null;
  layout_name: string | null;
  members: CrewMember[];
  created_at: string;
  updated_at: string;
}

function jsonbText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Normalise a jsonb column read: the live org PG client parses jsonb to a JS
 * value, but a `prepare:false` client (and the integration-test client) hands it
 * back as raw text — coerce both to the logical value so callers see an object.
 */
function coerceJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

// ─── view_state ────────────────────────────────────────────────────────────
/** The quiet per-user UI/nav state; `{}` if none saved yet. */
export async function getViewState(ownerId: string): Promise<Record<string, unknown>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ state: Record<string, unknown> }>>`
    SELECT state FROM harness_shared.tui_view_state
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId}
    LIMIT 1
  `;
  return coerceJson<Record<string, unknown>>(rows[0]?.state, {});
}

export async function putViewState(ownerId: string, state: Record<string, unknown>): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.tui_view_state (workspace_id, owner_id, state, updated_at)
    VALUES (${activeWorkspaceId()}, ${ownerId}, ${jsonbText(state)}::text::jsonb, now())
    ON CONFLICT (workspace_id, owner_id)
    DO UPDATE SET state = EXCLUDED.state, updated_at = now()
  `;
}

// ─── layouts ───────────────────────────────────────────────────────────────
export async function listLayouts(ownerId: string): Promise<LayoutSummary[]> {
  const { sql } = getOrgPg();
  const rows = await sql<LayoutSummary[]>`
    SELECT name, description, updated_at
    FROM harness_shared.tui_layouts
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId}
    ORDER BY updated_at DESC
  `;
  return rows;
}

export async function getLayout(ownerId: string, name: string): Promise<LayoutRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<LayoutRow[]>`
    SELECT name, kdl, description, created_at, updated_at
    FROM harness_shared.tui_layouts
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId} AND name = ${name}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function putLayout(
  ownerId: string,
  name: string,
  kdl: string,
  description?: string | null,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.tui_layouts (workspace_id, owner_id, name, kdl, description, updated_at)
    VALUES (${activeWorkspaceId()}, ${ownerId}, ${name}, ${kdl}, ${description ?? null}, now())
    ON CONFLICT (workspace_id, owner_id, name)
    DO UPDATE SET kdl = EXCLUDED.kdl, description = EXCLUDED.description, updated_at = now()
  `;
}

export async function deleteLayout(ownerId: string, name: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ name: string }>>`
    DELETE FROM harness_shared.tui_layouts
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId} AND name = ${name}
    RETURNING name
  `;
  return rows.length > 0;
}

// ─── crews ─────────────────────────────────────────────────────────────────
export async function listCrews(ownerId: string): Promise<CrewSummary[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{
    name: string;
    description: string | null;
    layout_name: string | null;
    member_count: number;
    updated_at: string;
  }>>`
    SELECT name, description, layout_name,
           jsonb_array_length(members) AS member_count, updated_at
    FROM harness_shared.tui_crews
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId}
    ORDER BY updated_at DESC
  `;
  return rows.map((r) => ({ ...r, member_count: Number(r.member_count) }));
}

export async function getCrew(ownerId: string, name: string): Promise<CrewRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<CrewRow[]>`
    SELECT name, description, layout_name, members, created_at, updated_at
    FROM harness_shared.tui_crews
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId} AND name = ${name}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { ...row, members: coerceJson<CrewMember[]>(row.members, []) };
}

export async function putCrew(
  ownerId: string,
  name: string,
  members: CrewMember[],
  layoutName?: string | null,
  description?: string | null,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.tui_crews (workspace_id, owner_id, name, members, layout_name, description, updated_at)
    VALUES (${activeWorkspaceId()}, ${ownerId}, ${name}, ${jsonbText(members)}::text::jsonb, ${layoutName ?? null}, ${description ?? null}, now())
    ON CONFLICT (workspace_id, owner_id, name)
    DO UPDATE SET members = EXCLUDED.members, layout_name = EXCLUDED.layout_name,
                  description = EXCLUDED.description, updated_at = now()
  `;
}

export async function deleteCrew(ownerId: string, name: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ name: string }>>`
    DELETE FROM harness_shared.tui_crews
    WHERE workspace_id = ${activeWorkspaceId()} AND owner_id = ${ownerId} AND name = ${name}
    RETURNING name
  `;
  return rows.length > 0;
}
