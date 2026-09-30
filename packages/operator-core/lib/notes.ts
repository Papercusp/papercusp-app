/**
 * notes.ts — data access for the minimal notes app (owner-ask-batch-2026-07-06
 * P-004, WI-3265): "Build me a small notes app — something where I can jot
 * notes down and search them later. Keep it minimal."
 *
 * One `harness_shared.notes` row per note (migration 527), workspace-scoped.
 * Search is a plain ILIKE over title+body — deliberately not full-text (the
 * owner asked to keep this minimal; revisit if the note count grows large).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * List notes for the active workspace, optionally filtered by a search term
 * (case-insensitive substring match over title + body). Most-recently-updated
 * first.
 */
export async function listNotes(query?: string): Promise<NoteRow[]> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const q = query?.trim();
  const rows = q
    ? await sql<NoteRow[]>`
        SELECT id, title, body, created_at, updated_at
          FROM harness_shared.notes
         WHERE workspace_id = ${workspaceId}
           AND (title ILIKE ${`%${q}%`} OR body ILIKE ${`%${q}%`})
         ORDER BY updated_at DESC`
    : await sql<NoteRow[]>`
        SELECT id, title, body, created_at, updated_at
          FROM harness_shared.notes
         WHERE workspace_id = ${workspaceId}
         ORDER BY updated_at DESC`;
  return rows;
}

export async function createNote(input: { title?: string; body?: string }): Promise<NoteRow> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<NoteRow[]>`
    INSERT INTO harness_shared.notes (workspace_id, title, body)
    VALUES (${workspaceId}, ${input.title ?? ''}, ${input.body ?? ''})
    RETURNING id, title, body, created_at, updated_at`;
  return rows[0];
}

export async function updateNote(
  id: string,
  input: { title?: string; body?: string },
): Promise<NoteRow | null> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<NoteRow[]>`
    UPDATE harness_shared.notes
       SET title = COALESCE(${input.title ?? null}, title),
           body = COALESCE(${input.body ?? null}, body),
           updated_at = now()
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     RETURNING id, title, body, created_at, updated_at`;
  return rows[0] ?? null;
}

export async function deleteNote(id: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.notes
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     RETURNING id`;
  return rows.length > 0;
}
