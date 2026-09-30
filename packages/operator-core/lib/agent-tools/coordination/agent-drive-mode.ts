/**
 * agent-drive-mode — resolve an owner id's pane-kind + drive mode, the axis that
 * separates the queen-bee LOOP population from OWNER-DIRECTED sessions
 * (queen-fleet-authority-boundary-2026-07-02 P-001 / D-001).
 *
 * `driveMode` (agent-pane-kind.ts) is the discriminator:
 *   - auto        — queen / overwatch / bee: system-driven, the cadence loop wakes
 *                   them; these ARE the maxBees population the Queen reclaims from.
 *   - responsive  — su / sentinel / planner: OWNER-DIRECTED. Not a bee. Holds no
 *                   reclaimable "slot", does not count against maxBees, and must
 *                   never be drained (fleet:drain) or live-terminated
 *                   (idle-session-reaper) as if the Queen could reclaim it.
 *
 * The 2026-07-02 pause-triggered churn was exactly this confusion: a paused-hive
 * zero-claim reclaim sweep enumerated SU fleet LEADERS (su-…) as bee_ids and drained
 * them. This is the code guard so no caller can drain/reap an owner-directed session
 * however it was enumerated.
 *
 * `classifyAgentPane` is the pure taxonomy — it already resolves a roleless `su-…`
 * id to su/responsive with NO IO. This wraps it with the one presence read that
 * supplies the `agentRole` for the ROLE-stamped kinds (sentinel = operator/oracle,
 * planner) and for bees. Best-effort: a presence miss / read error falls back to
 * id-only classification, so an `su-…` id still reads responsive (the guard holds
 * even when presence is unavailable — the very pause-churn condition it protects
 * against), while an unknown non-su owner falls to bee/auto (the drainable default —
 * we never over-PROTECT an unknown owner, only ever protect a provably
 * owner-directed one).
 */
import { classifyAgentPane, type AgentPaneClass } from '@papercusp/agent-mcp';
import { getPresence } from './presence';

/**
 * Resolve an owner's pane kind + drive mode from its live presence role (the same
 * signal adv-roster stamps: `classifyAgentPane({ role: agentRole, ownerId })`).
 */
export async function classifyOwnerDriveMode(ownerId: string): Promise<AgentPaneClass> {
  // Fast path: a psu `su-…` session is owner-directed by its id alone — classify it
  // without a presence read, so the guard holds even if presence is unavailable.
  if (ownerId.startsWith('su-')) return classifyAgentPane({ ownerId });
  let role: string | null = null;
  try {
    role = (await getPresence(ownerId))?.agentRole ?? null;
  } catch {
    role = null; // best-effort: fall back to id-only classification
  }
  return classifyAgentPane({ role, ownerId });
}

/**
 * True iff the owner is an OWNER-DIRECTED (responsive) session — su / sentinel /
 * planner — which the queen-loop must never drain or reap as a bee (P-001 / D-001).
 */
export async function isResponsiveOwner(ownerId: string): Promise<boolean> {
  return (await classifyOwnerDriveMode(ownerId)).driveMode === 'responsive';
}
