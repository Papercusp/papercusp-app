/**
 * fleet:supersede — the explicit "successor retires its predecessor" fleet
 * lifecycle step (WI-2034601 fix 2). A fleet superseded by a successor on the
 * SAME mission has no durable way to stand its controller down: fleet:wind-down
 * exists, but it is gated to the owner / that fleet's own live leader / the
 * queen (fleet-auth.ts), and an abandoned predecessor almost always has no live
 * leader — so an agent would have to know to chain fleet:take-leadership before
 * fleet:wind-down by hand. Nobody did, and a superseded fleet has been observed
 * sitting controlState='active' (burning governor ticks, confusing
 * fleet:status/assignments readers) for days (WI-2034601).
 *
 * This composes the two existing primitives atomically instead of adding new
 * registry state: recover leadership over the predecessor when its registered
 * leader is not live (take-leadership-core), then apply a TERMINAL wind-down
 * (control-core, noResumePath:true — nobody is coming back). Reuses the typed
 * control-state machinery (mig 575) end-to-end; no schema change.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { fleetSlugFromName, getFleet } from '../../agent-fleets-store';
import { getPresence } from '../coordination/presence';
import { applyFleetControl } from './control-core';
import { takeFleetLeadership } from './take-leadership-core';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:supersede',
  // P-011 prompt-weight: refusal + post-state prose moved to the free `returns`. NOTE the
  // `chaining` below is the SHARED ROUTING_LADDER constant — trimming it would silently
  // reword every other fleet tool, so the budget is recovered here instead
  // (EI-22083648545226771).
  description:
    "Retire a PREDECESSOR fleet in favor of a SUCCESSOR carrying its mission forward: recovers leadership over the predecessor if its registered leader is not live (fleet:take-leadership), then applies a TERMINAL fleet:wind-down (noResumePath:true) so its controlState stops reading 'active' and it stops burning governor ticks / confusing fleet:status readers.",
  guidance: {
    returns:
      "Refuses when the named successor does not exist or has no live leader, so you can never strand a predecessor's remaining capacity in favor of a fleet that cannot itself continue the mission. On success the predecessor keeps its registry row (fleets are never deleted, D-003) — only its control state changes.",
    when:
      "A new fleet has taken over an old fleet's mission (same plan/goal, a fresh launch or take-leadership elsewhere) and the old fleet is still controlState='active' with no live members driving it.",
    notWhen:
      "The predecessor still has live members doing real work — wind it down yourself (fleet:wind-down) once it is actually done, or fold it via fleet:take-leadership + keep working it, not supersede. To just pause/resume your OWN fleet, use fleet:wind-down / fleet:pause / fleet:resume directly.",
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:wind-down (the terminal flip this composes)',
      'fleet:take-leadership (the authority recovery this composes)',
      'fleet:status (verify controlState after)',
    ],
  },
  capability: 'fleet:supersede',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).max(120).describe('The PREDECESSOR fleet slug (or name) to retire.'),
    supersededBy: z
      .string()
      .min(1)
      .max(120)
      .describe('The SUCCESSOR fleet slug (or name) carrying the mission forward — must exist and have a live leader.'),
    reason: z
      .string()
      .max(400)
      .optional()
      .describe("Why — travels on the predecessor's registry row. Omit for an auto-composed reason naming the successor."),
  }),
  async handler(args, ctx) {
    const { ownerId, workspaceId, identity } = resolveFleetCaller(ctx);
    const predecessorSlug = fleetSlugFromName(args.fleet);
    const successorSlug = fleetSlugFromName(args.supersededBy);
    if (predecessorSlug === successorSlug) {
      return json(
        { ok: false, error: 'self_supersede', message: 'A fleet cannot supersede itself.' },
        true,
      );
    }

    const successor = await getFleet(workspaceId, successorSlug);
    if (!successor) {
      return json(
        {
          ok: false,
          error: 'successor_not_found',
          message: `Successor fleet '${successorSlug}' does not exist — refusing to retire '${predecessorSlug}' with no live continuation. See fleet:list.`,
        },
        true,
      );
    }
    let successorLeaderLive = false;
    if (successor.leaderOwnerId) {
      try {
        successorLeaderLive = (await getPresence(successor.leaderOwnerId)) !== null;
      } catch {
        successorLeaderLive = false;
      }
    }
    if (!successorLeaderLive) {
      return json(
        {
          ok: false,
          error: 'successor_leader_not_live',
          message: `Successor fleet '${successorSlug}' has no live leader (${successor.leaderOwnerId ?? 'none'}) — refusing to retire '${predecessorSlug}' in favor of a fleet that cannot itself continue the mission. Have the successor's leader call this once they are live, or take its leadership first.`,
        },
        true,
      );
    }

    const predecessor = await getFleet(workspaceId, predecessorSlug);
    if (!predecessor) {
      return json(
        {
          ok: false,
          error: 'fleet_not_found',
          message: `No fleet '${predecessorSlug}' in this workspace — see fleet:list.`,
        },
        true,
      );
    }

    // Recover authority over a leaderless predecessor BEFORE winding it down —
    // applyFleetControl refuses to emit a leader-shaped cue against a dead
    // registry leader (EI-21094636043854606; control-core.ts fleet_leader_mismatch).
    let tookLeadership = false;
    let predecessorLeaderLive = false;
    if (predecessor.leaderOwnerId) {
      try {
        predecessorLeaderLive = (await getPresence(predecessor.leaderOwnerId)) !== null;
      } catch {
        predecessorLeaderLive = false;
      }
    }
    if (predecessor.leaderOwnerId !== ownerId && !predecessorLeaderLive) {
      await takeFleetLeadership(workspaceId, predecessor, identity, ownerId, {});
      tookLeadership = true;
    }

    const reason =
      args.reason?.trim() ||
      `superseded by fleet '${successorSlug}' (same mission, live leader) — standing down permanently.`;
    const result = await applyFleetControl(ctx, predecessorSlug, 'wind-down', reason, {
      noResumePath: true,
    });
    return json(
      { ...result, predecessor: predecessorSlug, supersededBy: successorSlug, tookLeadership },
      !result.ok,
    );
  },
});
