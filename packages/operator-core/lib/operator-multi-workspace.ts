/**
 * Multi-workspace Operator aggregation.
 *
 * RETIRED CARD SOURCE (unify-agent-launches D-005, 2026-06-05): this module
 * previously aggregated `operator_last_scan` + `operator_dismissed_cards`
 * across workspaces — the foreign-workspace card view. Those tables were
 * dropped with the scanner card stream (migration 167); scan findings now
 * land as work_items in the self-improvement backlog (improvements:digest).
 *
 * The tool/route contract shape survives so existing consumers don't break:
 * the workspace roster is still returned (always with cardCount 0 and no
 * cards). A future cross-workspace view should aggregate the improvements
 * backlog instead.
 */

import { readRegistry } from './workspace-registry';

export interface ForeignCard {
  workspaceId: string;
  workspaceName: string;
  card: Record<string, unknown>;
  /** Set when the card has been dismissed (cooldown filter). */
  dismissed: boolean;
}

export interface MultiWorkspaceSnapshot {
  /** Always empty since D-005 — the card stream is retired. */
  cards: ForeignCard[];
  /** Per-workspace summary (roster only; card fields are zero/null). */
  workspaces: { id: string; name: string; cardCount: number; scanCompletedAt: string | null }[];
}

export async function readMultiWorkspaceSnapshot(currentWorkspaceId: string): Promise<MultiWorkspaceSnapshot> {
  const reg = readRegistry();
  const out: MultiWorkspaceSnapshot = { cards: [], workspaces: [] };
  for (const ws of reg.workspaces) {
    if (ws.id === currentWorkspaceId) continue;
    out.workspaces.push({ id: ws.id, name: ws.name, cardCount: 0, scanCompletedAt: null });
  }
  return out;
}
