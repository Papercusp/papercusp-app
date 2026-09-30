/**
 * Display-name store — reads/writes harness_shared.agent_display_names, the
 * owner-keyed MANUAL name a human (or an agent naming itself) gave a session.
 *
 * Plan hud-session-display-names-2026-08-31, ruled by D-003. The grain is
 * load-bearing and was corrected by measurement: a name belongs to the AGENT
 * (ownerId), not to one `adv_sessions` launch row, because 77 owners hold 2–4
 * of those rows and the two readers (coord:glance for the OS title, adv-roster
 * for the HUD card) pick rows differently — so a per-row name could show one
 * thing in a tab bar and another on the card. Reading by ownerId makes that
 * divergence unrepresentable.
 *
 * Encoding contract, mirrored by the migration's CHECK: "no manual name" is the
 * ABSENCE of a row, never a blank or null `display_name`. Clearing a name
 * DELETEs. That keeps exactly one encoding of the unnamed state, so the
 * resolver (`sessionDisplayName` in agent-tools/coordination/status-display.ts)
 * never has to distinguish "" from null from missing.
 *
 * These reads sit on the statusline hot path (every glance tick) and on the HUD
 * roster, so the batch form exists to keep the roster at ONE query for its whole
 * owner set rather than one per card (R10). Callers are expected to wrap them
 * fail-open: a name is decoration, and a read hiccup must degrade to the
 * objective fallback, never to a thrown card or a blank title (R9).
 *
 * Injectable `sql` seam, like the sibling mode store: the logic stays unit
 * testable without a live Postgres.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * Longest name the store keeps.
 *
 * The resolver clips for each surface at render (a terminal title bar and a
 * card have different budgets), so this is NOT a display concern — it is the
 * bound on what one row can cost every reader on the roster's hot path. A name
 * is a handle a human types, not a document.
 */
export const AGENT_DISPLAY_NAME_MAX = 120;

/** C0 controls (tab and newline included) and DEL. */
function isPrintable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 32 && cp !== 127;
}

/**
 * The one canonical form of a submitted name, or null for "no name".
 *
 * Three things happen here rather than at each caller, because there are three
 * callers (the popup route, the `sessions:rename` agent tool, and any later
 * surface) and a per-caller copy is the drift D-003 exists to forbid:
 *
 *  - CONTROL CHARACTERS ARE STRIPPED. This name is printed into an OS terminal
 *    title through an OSC escape; the renderer already defends itself, but a
 *    stored value that needs defending is a trap for the next reader that
 *    forgets to. Whitespace runs collapse for the same reason — a card and a
 *    title bar are single-line surfaces, and an embedded newline reads as a
 *    truncated name rather than as a formatting choice.
 *  - BLANK MEANS CLEAR (R6). Null, undefined, '', '   ' and a string of control
 *    characters all normalize to null, which the writer turns into a DELETE.
 *    The table's CHECK makes a blank name unrepresentable, so a blank that
 *    reached the upsert would be a 23514 from Postgres, not a cleared name.
 *  - IT IS BOUNDED. See AGENT_DISPLAY_NAME_MAX.
 */
export function normalizeDisplayNameInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = [...raw]
    .filter(isPrintable)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > AGENT_DISPLAY_NAME_MAX
    ? cleaned.slice(0, AGENT_DISPLAY_NAME_MAX).trimEnd()
    : cleaned;
}

export interface AgentDisplayNameRow {
  ownerId: string;
  /** Always trimmed and non-empty — the table's CHECK makes anything else unrepresentable. */
  displayName: string;
  /** A coord ownerId when an agent named itself, or 'owner' when a human did. Null on legacy rows. */
  setBy: string | null;
  setAt: string | null;
}

function toRow(r: Record<string, unknown>): AgentDisplayNameRow {
  return {
    ownerId: String(r.owner_id ?? ''),
    displayName: String(r.display_name ?? ''),
    setBy: r.set_by == null ? null : String(r.set_by),
    setAt: r.set_at == null ? null : new Date(r.set_at as string).toISOString(),
  };
}

/**
 * The manual name for ONE owner, or null when the owner has none.
 *
 * Returns the bare string because that is what the resolver consumes; use
 * `getAgentDisplayNameRow` when you also need who set it and when.
 */
export async function getAgentDisplayName(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  return (await getAgentDisplayNameRow(workspaceId, ownerId, sql))?.displayName ?? null;
}

/** The full row for ONE owner (name + provenance), or null when unnamed. */
export async function getAgentDisplayNameRow(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<AgentDisplayNameRow | null> {
  if (!workspaceId || !ownerId) return null;
  const rows = await pg(sql)<Array<Record<string, unknown>>>`
    SELECT owner_id, display_name, set_by, set_at
      FROM harness_shared.agent_display_names
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     LIMIT 1`;
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Names for a WHOLE owner set in ONE query — the roster's read (R10).
 *
 * Owners with no manual name are simply absent from the map, matching the
 * table's "absence means unnamed" encoding, so a caller can hand
 * `map.get(ownerId)` straight to the resolver's `manualName`.
 */
export async function getAgentDisplayNames(
  workspaceId: string,
  ownerIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!workspaceId) return out;
  const ids = [...new Set(ownerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return out;
  const db = pg(sql);
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT owner_id, display_name, set_by, set_at
      FROM harness_shared.agent_display_names
     WHERE workspace_id = ${workspaceId} AND owner_id IN ${db(ids)}`;
  for (const r of rows) {
    const row = toRow(r);
    if (row.ownerId && row.displayName) out.set(row.ownerId, row.displayName);
  }
  return out;
}

export interface SetAgentDisplayNameResult {
  ownerId: string;
  /** The stored name, or null when the write CLEARED it. */
  displayName: string | null;
  /** True when the call removed a name rather than setting one. */
  cleared: boolean;
}

/**
 * Set — or CLEAR — one owner's manual name.
 *
 * Options object, not positionals, unlike the readers above: `name` and `setBy`
 * are both strings and adjacent, so a positional signature makes transposing
 * them a silent wrong write that typechecks. The readers have no such pair.
 *
 * Clearing DELETEs (R6, and the table's CHECK). That keeps exactly one encoding
 * of the unnamed state, so `getAgentDisplayNames` can go on treating absence
 * from its map as "unnamed" without a second empty-string case.
 */
export async function setAgentDisplayName(o: {
  workspaceId: string;
  ownerId: string;
  /** The submitted name. Anything that normalizes to blank CLEARS the name. */
  name: string | null | undefined;
  /** A coord ownerId when an agent names itself, or 'owner' when a human does. */
  setBy: string;
  sql?: Sql;
}): Promise<SetAgentDisplayNameResult> {
  const workspaceId = o.workspaceId?.trim();
  const ownerId = o.ownerId?.trim();
  // A write with no key would silently name the wrong session (or nothing).
  // The readers return null for the same input because a missing name is a
  // legitimate answer to a READ; there is no legitimate blind WRITE.
  if (!workspaceId || !ownerId) {
    throw new Error('setAgentDisplayName requires both a workspaceId and an ownerId');
  }
  const name = normalizeDisplayNameInput(o.name);
  const db = pg(o.sql);
  if (!name) {
    await db`
      DELETE FROM harness_shared.agent_display_names
       WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}`;
    return { ownerId, displayName: null, cleared: true };
  }
  await db`
    INSERT INTO harness_shared.agent_display_names (workspace_id, owner_id, display_name, set_by, set_at)
    VALUES (${workspaceId}, ${ownerId}, ${name}, ${o.setBy || null}, now())
    ON CONFLICT (workspace_id, owner_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          set_by = EXCLUDED.set_by,
          set_at = EXCLUDED.set_at`;
  return { ownerId, displayName: name, cleared: false };
}

/**
 * The workspace a name for `ownerId` must be written under.
 *
 * NOT `activeWorkspaceId()`, and this is the whole reason the helper exists:
 * the READERS key by the owner's coord_presence workspace_id (adv-roster groups
 * its batch read that way, and coord:glance resolves the caller's own presence
 * row), so a writer that picked the operator's ambient workspace would store a
 * name at a key nothing reads — a rename that silently does nothing, which is
 * indistinguishable from one that failed.
 *
 * Returns null when the owner has no presence row; the caller decides whether
 * to fall back or refuse. Presence is TTL-reaped, but the workspace an owner
 * runs in is stable across its sessions, so a name written under it stays
 * readable when the same owner comes back — which is exactly why the NAME does
 * not live in that reaped table (D-003).
 */
export async function resolveOwnerWorkspaceId(ownerId: string, sql?: Sql): Promise<string | null> {
  const id = ownerId?.trim();
  if (!id) return null;
  const rows = await pg(sql)<Array<{ workspace_id: string | null }>>`
    SELECT workspace_id
      FROM harness_shared.coord_presence
     WHERE owner_id = ${id}
     LIMIT 1`;
  const ws = rows[0]?.workspace_id;
  return typeof ws === 'string' && ws.trim() ? ws.trim() : null;
}
