/**
 * network-board/hive-wakes — the hive-scoped staged-wake board
 * (hive-network-surface-2026-06-11 P-014 item 3, closing D-007 GAP 1).
 *
 * The fleet-wide wake board (`pui wake-pane`, EI-312) reads EVERY owner's
 * staged wakes; the per-hive drill-in tab (B-10) only had the hive-pane
 * header's wake summary because no endpoint scoped the queue to one hive.
 * This composes the two existing reads — `listAllPendingWakes` (the queue)
 * and `listFleetAssignments` (owner → harness attribution) — into "the staged
 * wakes of everyone working hive X", served as the `network.hive.wakes` sync
 * query.
 *
 * Split into a PURE filter (`filterWakesToHive` — pre-fetched inputs in, rows
 * out, unit-testable) and a thin IO wrapper (`listHiveWakes`), mirroring the
 * assembleNetworkBoard / buildNetworkBoard convention in build-board.ts.
 */

import type { PendingWake } from '../agent-tools/coordination/pending-wakes';
import { listAllPendingWakes } from '../agent-tools/coordination/pending-wakes';
import type { FleetAssignmentRow } from '../fleet/assignments';
import { listFleetAssignments } from '../fleet/assignments';

/**
 * Pure: the owner IDs attributable to one hive, from fleet rows (presence +
 * claims). Unlike watchOwnersByHarness (live watch panes), this does NOT
 * require `holderAlive`: a manual-mode PAUSED agent is exactly whose staged
 * wakes the owner reviews, and its presence may read stale while paused — a
 * wake staged for it must still surface on the hive's board.
 */
export function hiveOwnerIds(rows: FleetAssignmentRow[], potSlug: string): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.harnessSlug === potSlug && r.agentId) out.add(r.agentId);
  }
  return out;
}

/**
 * Pure: staged wakes whose owner is attributed to `potSlug`. Owners with no
 * fleet row at all (long-gone sessions awaiting the EI-314 sweep) have no hive
 * attribution and are deliberately absent — the fleet-wide board remains the
 * whole truth.
 */
export function filterWakesToHive(
  wakes: PendingWake[],
  fleetRows: FleetAssignmentRow[],
  potSlug: string,
): PendingWake[] {
  const owners = hiveOwnerIds(fleetRows, potSlug);
  return wakes.filter((w) => owners.has(w.ownerId));
}

export interface ListHiveWakesOpts {
  workspaceId?: string;
}

/**
 * Fetch + filter: the staged-wake queue scoped to one hive, owner-grouped
 * order preserved from listAllPendingWakes (owner ASC, oldest-first). Every
 * source is best-effort — a failing read contributes nothing rather than
 * failing the board.
 */
export async function listHiveWakes(
  potSlug: string,
  opts: ListHiveWakesOpts = {},
): Promise<PendingWake[]> {
  const [wakes, fleetRows] = await Promise.all([
    listAllPendingWakes().catch(() => [] as PendingWake[]),
    listFleetAssignments({ workspaceId: opts.workspaceId }).catch(() => [] as FleetAssignmentRow[]),
  ]);
  return filterWakesToHive(wakes, fleetRows, potSlug);
}
