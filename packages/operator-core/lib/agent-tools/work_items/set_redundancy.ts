/**
 * work_items:set_redundancy — mark a HIGH-STAKES work-item for BOINC-style redundancy
 * (decentralized-dispatch-scaling P-014). Run the item INDEPENDENTLY on N Swarms, then
 * judge + adopt the best (reuse gym:judge). Opt-in: default is exactly-once (redundancy 1).
 *
 * Inert until the owner sets `PAPERCUSP_WORKITEM_REDUNDANCY=1` — marking an item high-stakes
 * with the flag OFF is recorded but has no dispatch effect (the item still runs exactly-once).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { setItemRedundancy, workItemRedundancyEnabled, MIN_REDUNDANCY } from '../../work-item-redundancy';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'work_items:set_redundancy',
  profile: 'engineer',
  description:
    "Mark a high-stakes work-item for BOINC redundancy: run it independently on N Swarms then judge + adopt the best (reuse gym:judge). Pass { id, redundancy: N≥2 } to opt in, or { redundancy: 1 } to clear (back to exactly-once). Opt-in, off by default — inert until PAPERCUSP_WORKITEM_REDUNDANCY=1.",
  guidance: {
    when: 'A work-item is high-stakes enough to be worth running redundantly (the cost of a wrong result exceeds the cost of a second independent run + a judge). Set redundancy: 2 to fan it out to two Swarms; a judge picks the winner.',
    notWhen:
      'Routine work — redundancy doubles the cost. Issue-family items (bugs/changes) — only feature-family pipeline items carry redundancy. Pinning which Swarm runs it — that is work_items:co_locate.',
    chaining:
      'work_items:set_redundancy { id, redundancy: 2 } → work_items:claim_replica (each Swarm) → work_items:record_replica_result → work_items:judge_redundancy (adopt the winner).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The feature-family work-item id (WI-/F-).'),
    redundancy: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe(`Target independent replicas. 1 = exactly-once (clears). ≥${MIN_REDUNDANCY} = high-stakes.`),
    harness: z.string().max(80).optional().describe('Harness the work-item lives in.'),
  }),
  async handler(args) {
    const res = await setItemRedundancy(args.id, args.redundancy, { harness: args.harness });
    if (!res) {
      return json({ ok: false, error: `work-item ${args.id} not found or not feature-family (no redundancy column)` });
    }
    return json({
      ok: true,
      id: res.id,
      harness: res.harness,
      redundancy: res.redundancy,
      highStakes: res.redundancy >= MIN_REDUNDANCY,
      // Surface that the marker is inert until the master switch is on (so a caller isn't
      // surprised the item still runs exactly-once).
      active: workItemRedundancyEnabled(),
      note: workItemRedundancyEnabled()
        ? undefined
        : 'recorded, but PAPERCUSP_WORKITEM_REDUNDANCY is OFF — the item still runs exactly-once until the owner activates redundancy',
    });
  },
});
