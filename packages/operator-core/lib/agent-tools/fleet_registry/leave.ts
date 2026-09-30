/**
 * fleet:leave — drop the caller's fleet membership (named-su-agent-fleets-2026-06-29
 * P-004 / D-002).
 *
 * Clears the caller's coord_presence fleet_slug/fleet_role to NULL. If the caller WAS the
 * fleet's recorded leader, the fleet is left leaderless too (setFleetLeader(null)) while
 * the fleet is active — so a normal leader departure doesn't strand a phantom
 * leader_owner_id pointing at a gone agent. During winding-down, the pointer is retained
 * as a durable final-report recipient; audience-host also has a history fallback for rows
 * cleared by older/runtime-raced leaves. The registry row itself persists (D-003).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet, setFleetLeader } from '../../agent-fleets-store';
import { releaseSeatConsumption } from '../../fleet/seat-accounting';
import { setPresenceFleet } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { json, resetCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { retireFleetLeaderWatches } from './leader-control';

export default defineTool({
  name: 'fleet:leave',
  description:
    'Leave your current fleet — clears your membership label and retires leader watches. An active fleet is left leaderless when its leader leaves; during winding-down, the registry retains that leader only as the durable final-report recipient.',
  guidance: {
    when: 'Stepping out of a fleet you are a member or leader of.',
    notWhen: 'Switching to a different fleet → just fleet:join the other one (it re-labels you).',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:leave',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { ownerId, workspaceId } = resolveFleetCaller(ctx);
    // Which fleet was the caller in? The soft label lives on the presence row.
    const membership = (await fetchPresenceFleet([ownerId])).get(ownerId);
    const currentFleet = membership?.fleetSlug ?? null;

    await setPresenceFleet(workspaceId, ownerId, null, null);
    // WI-5317: a clean leave frees the caller's delegated seat IMMEDIATELY rather
    // than holding it through the boot-grace / presence-stale window — a wound-down
    // member's seat blocked re-spawn (seats_exhausted) on the WI-5211 rig. The
    // seat-accounting liveness floor still frees a crashed member later; this is the
    // instant path for a graceful exit. Best-effort — never fail the leave.
    try {
      await releaseSeatConsumption(ownerId);
    } catch {
      /* seat release is hygiene, never load-bearing */
    }
    // Drop the ex-fleet color from the caller's live window — revert to the
    // terminal's profile default (the inverse of join's recolor). Best-effort:
    // a no-op for non-psu-hosted callers, and never fails the leave.
    await resetCallerTerminal(ownerId);

    let clearedLeadershipOf: string | null = null;
    if (currentFleet) {
      // EI-20971037082099943: leadership watches are durable, while membership is not.
      // A clean leave must sever the old fleet's wake channel or it can resume this
      // session indefinitely after the presence label is gone. Best-effort hygiene:
      // membership remains authoritative even if the event store is unavailable.
      await retireFleetLeaderWatches(ownerId, currentFleet).catch(() => 0);
      const fleet = await getFleet(workspaceId, currentFleet);
      if (fleet && fleet.leaderOwnerId === ownerId && fleet.controlState !== 'winding-down') {
        await setFleetLeader(workspaceId, currentFleet, null);
        clearedLeadershipOf = currentFleet;
      }
    }
    return json({ ok: true, leftFleet: currentFleet, clearedLeadershipOf });
  },
});
