/**
 * session-cursor-store.ts — the Postgres layer for the per-session lexical
 * cursor (ambient-semantic-push-2026-07-14 P-001; table: migration 609
 * harness_shared.session_cursor). Pure SQL binding — the keyword mining and
 * cursor math live in lexical-cursor.ts (where the pure-core tests are); the
 * journal→cursor composition + fail-soft wiring lives in session-cursor-io.ts.
 *
 * One row per session = its CURRENT cursor (upsert-on-session_id). The cursor
 * already decays across recent journal notes, so the latest cursor IS the
 * state — this is not a per-turn history log.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  type CursorTerm,
  type LexicalCursor,
  type TermClass,
} from './lexical-cursor';

/** The persisted sparse-vector element — exactly lexical-cursor's CursorTerm. */
export type PersistedCursorTerm = CursorTerm;

export interface SessionCursorRow {
  session_id: string;
  workspace_id: string;
  owner_id: string | null;
  harness_slug: string | null;
  turn_ts: string | null;
  note_count: number;
  term_count: number;
  terms: PersistedCursorTerm[];
  updated_at: string;
}

export interface UpsertSessionCursorInput {
  /**
   * REQUIRED (data-scoping-audit-2026-06-22 D-005 / P-007 mechanism A). See the
   * note on RecordTurnJournalInput.workspaceId — this INSERT likewise omitted
   * the column and relied on the DDL `DEFAULT 'default'`. Resolve it with
   * `requireWorkspaceId(identity, ...)`, never an inline `?? 'default'`.
   */
  workspaceId: string;
  sessionId: string;
  ownerId: string | null;
  harnessSlug: string | null;
  turnTs: Date | string | null;
  /** The cursor to persist — its `terms` (sparse vector) + `noteCount` are stored. */
  cursor: Pick<LexicalCursor, 'terms' | 'noteCount'>;
}

/**
 * Upsert one session's current cursor. Keyed by session_id: a later turn's
 * rebuild REPLACES the row (the cursor is the latest recency-decayed state, not
 * a log). `terms` goes over as `::text::jsonb` (NOT bare `::jsonb`) — postgres-js
 * JSON-encodes the string param first, so a bare cast would double-encode into a
 * jsonb string scalar instead of the queryable array (activity-pg-store gotcha).
 */
export async function upsertSessionCursor(input: UpsertSessionCursorInput): Promise<void> {
  const { sql } = getOrgPg();
  const terms = input.cursor.terms ?? [];
  const termsJson = JSON.stringify(terms);
  const turnTsIso =
    input.turnTs == null
      ? null
      : typeof input.turnTs === 'string'
        ? input.turnTs
        : input.turnTs.toISOString();
  await sql`
    INSERT INTO harness_shared.session_cursor
      (session_id, workspace_id, owner_id, harness_slug, turn_ts, note_count, term_count, terms, updated_at)
    VALUES (
      ${input.sessionId}, ${input.workspaceId}, ${input.ownerId}, ${input.harnessSlug},
      ${turnTsIso}::timestamptz, ${input.cursor.noteCount ?? 0}, ${terms.length},
      ${termsJson}::text::jsonb, now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      owner_id     = EXCLUDED.owner_id,
      harness_slug = EXCLUDED.harness_slug,
      turn_ts      = EXCLUDED.turn_ts,
      note_count   = EXCLUDED.note_count,
      term_count   = EXCLUDED.term_count,
      terms        = EXCLUDED.terms,
      updated_at   = now()
  `;
}

/** Read one session's current cursor row (null if none). */
export async function getSessionCursorRow(sessionId: string): Promise<SessionCursorRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<SessionCursorRow[]>`
    SELECT session_id, workspace_id, owner_id, harness_slug,
           turn_ts::text AS turn_ts, note_count, term_count, terms,
           updated_at::text AS updated_at
    FROM harness_shared.session_cursor
    WHERE session_id = ${sessionId}
  `;
  return rows[0] ?? null;
}

/**
 * Read recent session cursors, freshest first — the P-002 peer-read surface and
 * the P-004 collision-index feed (build the inverted index over these live
 * cursors). Filters: one owner; exclude a session (the querying session itself);
 * a freshness floor (only cursors updated since — "live" sessions). The live
 * legs that consume this land later + DEFAULT-OFF; this is the pure read.
 */
export async function recentSessionCursors(filter: {
  ownerId?: string;
  excludeSessionId?: string;
  updatedSince?: Date | string;
  limit?: number;
} = {}): Promise<SessionCursorRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sinceIso =
    filter.updatedSince == null
      ? null
      : typeof filter.updatedSince === 'string'
        ? filter.updatedSince
        : filter.updatedSince.toISOString();
  const rows = await sql<SessionCursorRow[]>`
    SELECT session_id, workspace_id, owner_id, harness_slug,
           turn_ts::text AS turn_ts, note_count, term_count, terms,
           updated_at::text AS updated_at
    FROM harness_shared.session_cursor
    WHERE TRUE
      ${filter.ownerId ? sql`AND owner_id = ${filter.ownerId}` : sql``}
      ${filter.excludeSessionId ? sql`AND session_id <> ${filter.excludeSessionId}` : sql``}
      ${sinceIso ? sql`AND updated_at > ${sinceIso}::timestamptz` : sql``}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * The FRESHEST cursor per owner across `ownerIds`, as a Map keyed by owner_id —
 * the P-002 presence-overlay read (a presence roster row is keyed by ownerId,
 * one live session per owner, so the owner's most-recently-updated cursor is the
 * one to surface). Batched (one query, DISTINCT ON) + bounded; an owner with no
 * cursor is simply absent from the map. Empty input ⇒ empty map (no query).
 */
export async function cursorsByOwner(ownerIds: string[]): Promise<Map<string, SessionCursorRow>> {
  const ids = [...new Set(ownerIds.filter((x) => typeof x === 'string' && x.length > 0))];
  const out = new Map<string, SessionCursorRow>();
  if (ids.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<SessionCursorRow[]>`
    SELECT DISTINCT ON (owner_id)
           session_id, workspace_id, owner_id, harness_slug,
           turn_ts::text AS turn_ts, note_count, term_count, terms,
           updated_at::text AS updated_at
    FROM harness_shared.session_cursor
    WHERE owner_id = ANY(${ids})
    ORDER BY owner_id, updated_at DESC
  `;
  for (const r of rows) {
    if (r.owner_id) out.set(r.owner_id, r);
  }
  return out;
}

/** Retention prune: drop cursors not updated since `olderThan`. Returns the
 *  count removed. Stale cursors are noise to the collision index. */
export async function pruneSessionCursors(olderThan: Date | string): Promise<number> {
  const { sql } = getOrgPg();
  const iso = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
  const rows = await sql<Array<{ session_id: string }>>`
    DELETE FROM harness_shared.session_cursor
    WHERE updated_at < ${iso}::timestamptz
    RETURNING session_id
  `;
  return rows.length;
}

/**
 * Reconstruct a full {@link LexicalCursor} from a stored row: the persisted
 * `terms` array rehydrates the weightByTerm / classByTerm maps the scorers and
 * the inverted index need (they are a projection of `terms`, not stored twice).
 * The inverse of what upsertSessionCursor persisted from buildCursor.
 */
export function rowToCursor(row: SessionCursorRow): LexicalCursor {
  const terms = Array.isArray(row.terms) ? row.terms : [];
  const weightByTerm = new Map<string, number>();
  const classByTerm = new Map<string, TermClass>();
  for (const t of terms) {
    if (!t || typeof t.term !== 'string') continue;
    weightByTerm.set(t.term, t.weight);
    classByTerm.set(t.term, t.termClass);
  }
  return {
    sessionId: row.session_id,
    terms,
    weightByTerm,
    classByTerm,
    noteCount: row.note_count ?? 0,
  };
}
