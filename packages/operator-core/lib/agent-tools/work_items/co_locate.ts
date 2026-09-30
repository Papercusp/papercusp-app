/**
 * work_items:co_locate — the Queen's co-location lever (hive-coordination-model P-002).
 *
 * Stamp a work-item's Swarm AFFINITY so the flag-gated claim path routes its tightly-
 * coupled work to the right Swarm (instant within-Swarm coordination) and lets loosely-
 * coupled work spread across Swarms. Three shapes:
 *   - explicit  { workItem, swarm }            — pin to a Swarm (or `swarm: null` to clear).
 *   - decided   { workItem, coLocateWith, tight? } — co-locate with (tight, default) or
 *                                                spread from (tight:false) another item's
 *                                                Swarm, via the decideCoLocation policy.
 *   - read      { workItem }                    — report the current affinity, no write.
 *
 * The affinity is INERT until the per-Hive claim lease is active
 * (the `WORKITEM_CLAIM_LEASE` flag); on a single Swarm everything is co-located
 * locally, so the lever reports `local` and changes nothing.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { localSwarmId } from '../../fleet/swarm-identity';
import { decideCoLocation, type SwarmSlot } from '../../fleet/co-location';
import { setWorkItemSwarmAffinity, getWorkItemSwarmAffinity } from '../../work-items';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'work_items:co_locate',
  profile: 'engineer',
  description:
    "The Mug's co-location lever: stamp a work-item's Swarm affinity so tightly-coupled work runs on the SAME Swarm (instant coordination) and loosely-coupled work spreads. Pin with { swarm }, decide with { coLocateWith, tight? }, or read the current affinity with just { workItem }.",
  guidance: {
    when: 'You are the Mug placing work: co-locate a work-item with its tight collaborators on one Swarm (coLocateWith), pin it to a specific Swarm (swarm), or check where it is affined. The affinity is honored by claim_next once the per-Pot claim lease is active.',
    notWhen:
      "Ranking a bee's queue (work_items:reorder) or sending a specific item to a specific agent (work_items:claim). Co-location is about WHICH SWARM, not which bee.",
    chaining:
      'fleet:assignments (see where collaborators run) → work_items:co_locate { workItem, coLocateWith } → the affined Swarm claims it under the lease.',
    seeAlso: [
      'work_items:reorder (rank a single bee\'s claimed queue — not swarm placement)',
      'work_items:set_priority (GLOBAL backlog order)',
      'work_items:claim (send a specific item to a specific agent instead)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workItem: z.string().min(1).max(120).describe('The work-item id to place (WI-/F-/EI-).'),
    harness: z.string().max(80).optional().describe('Harness the work-item lives in.'),
    swarm: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('Explicit Swarm id to affine to; null clears the affinity. Overrides coLocateWith.'),
    coLocateWith: z
      .string()
      .max(120)
      .optional()
      .describe("Another work-item id whose Swarm to co-locate with (tight) or spread from (tight:false)."),
    tight: z
      .boolean()
      .optional()
      .describe('true (default) = co-locate with coLocateWith; false = spread to a different Swarm.'),
  }),
  async handler(args) {
    const opt = { harness: args.harness };

    // Read mode — no placement directive → report the current affinity.
    if (args.swarm === undefined && !args.coLocateWith) {
      const cur = await getWorkItemSwarmAffinity(args.workItem, opt);
      if (!cur) return json({ ok: false, error: `work-item ${args.workItem} not found` });
      return json({ ok: true, mode: 'read', workItem: cur.id, swarmAffinity: cur.swarmAffinity });
    }

    // Explicit mode — caller named the Swarm (or null to clear); overrides coLocateWith.
    if (args.swarm !== undefined) {
      const set = await setWorkItemSwarmAffinity(args.workItem, args.swarm, opt);
      if (!set) return json({ ok: false, error: `work-item ${args.workItem} not found` });
      return json({
        ok: true,
        mode: 'explicit',
        workItem: set.id,
        swarmAffinity: set.swarmAffinity,
        action: args.swarm === null ? 'clear' : 'pin',
      });
    }

    // Decided mode — co-locate (or spread) relative to coLocateWith via the policy.
    // localSwarmId treats an unbooted/empty harness as the safe 'local' single-Swarm
    // answer (it never throws), so an omitted harness => the local Swarm is INTENDED here,
    // not a silent scope leak: this handler has no ctx to resolve a harness from, and a
    // single-box deploy has exactly one Swarm. allow-scope-default(P-003): co-location
    // local-Swarm fallback. (Follow-up: resolve from the placed work-item's harness for a
    // federated multi-Swarm setup.)
    const local = localSwarmId(activeWorkspaceId(), args.harness ?? '');
    const peer = await getWorkItemSwarmAffinity(args.coLocateWith!, opt);
    if (!peer) return json({ ok: false, error: `coLocateWith item ${args.coLocateWith} not found` });
    const peerSwarm = peer.swarmAffinity ?? local; // an unaffined collaborator runs on the local Swarm
    const roster: SwarmSlot[] = [...new Set([local, peerSwarm])].map((s) => ({ swarm: s, load: 0 }));
    const decision = decideCoLocation({
      collaboratorSwarms: [peerSwarm],
      roster,
      localSwarm: local,
      tight: args.tight,
    });
    const set = await setWorkItemSwarmAffinity(args.workItem, decision.swarm, opt);
    if (!set) return json({ ok: false, error: `work-item ${args.workItem} not found` });
    return json({
      ok: true,
      mode: 'decided',
      workItem: set.id,
      swarmAffinity: set.swarmAffinity,
      action: decision.action,
      reason: decision.reason,
    });
  },
});
