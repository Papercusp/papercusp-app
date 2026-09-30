/**
 * In-memory "selected bee" relay (pui-bee-dossier-pane-2026-06-06).
 *
 * The desktop chat dock runs the swarm pane and the bee-dossier pane as TWO
 * SEPARATE pui processes. When the owner moves the cursor in the swarm (Fleet)
 * pane, that pane PUBLISHES the selected bee's ownerId here; the bee pane READS
 * it (polling, ~1.5s) and renders that bee's dossier.
 *
 * WHY in-memory and NOT Postgres: the selection is EPHEMERAL ipc (one short
 * string, per workspace, no durability requirement, no cross-machine sync) — it
 * is a transport between two co-located processes, and "the DB is not a
 * transport" (owner principle). A module-scoped Map in the operator process is
 * the right store: it lives exactly as long as the operator/dock session, costs
 * nothing, and never touches PG. (An SSE/NOTIFY push rail would be nicer than
 * polling, but the two pui processes don't share a selection channel today and
 * the poll is a single tiny GET — the documented v1 tradeoff.)
 *
 * Keyed by workspaceId (null → a single shared "default" slot) so multiple
 * workspaces in one operator never cross-talk.
 */

interface SelectionEntry {
  ownerId: string | null;
  /** Adopted agent-name, when the publisher knew it (display only). */
  name: string | null;
  /** epoch ms of the last publish — lets a reader show staleness if it wants. */
  ts: number;
}

const DEFAULT_KEY = '__default__';
const selections = new Map<string, SelectionEntry>();

function keyOf(workspaceId: string | null | undefined): string {
  return workspaceId && workspaceId.length > 0 ? workspaceId : DEFAULT_KEY;
}

/** Publish the selected bee for a workspace (swarm pane → here). */
export function setSelectedBee(
  workspaceId: string | null | undefined,
  ownerId: string | null,
  name: string | null = null,
): SelectionEntry {
  const entry: SelectionEntry = {
    ownerId: ownerId && ownerId.length > 0 ? ownerId : null,
    name: name && name.length > 0 ? name : null,
    ts: Date.now(),
  };
  selections.set(keyOf(workspaceId), entry);
  return entry;
}

/** Read the selected bee for a workspace (bee pane ← here). Null when unset. */
export function getSelectedBee(
  workspaceId: string | null | undefined,
): SelectionEntry | null {
  return selections.get(keyOf(workspaceId)) ?? null;
}

/** Clear a workspace's selection (test hygiene + explicit deselect). */
export function clearSelectedBee(workspaceId: string | null | undefined): void {
  selections.delete(keyOf(workspaceId));
}
