/**
 * work_items:claim_replica — claim ONE of a high-stakes item's N replica slots
 * (decentralized-dispatch-scaling P-014). The redundancy analogue of work_items:claim_next:
 * instead of an exactly-once grip, this assigns the caller the lowest free replica slot, so up
 * to N distinct Swarms hold distinct slots of the SAME item and run it independently
 * ("claim one item to 2 Swarms"). The slot is heartbeat-leased; a lapsed slot is re-claimable.
 *
 * Returns { ok, replica } with the slot's replica_index + claim_id (needed to heartbeat /
 * record the result), or { ok:false } when the item isn't high-stakes or every slot is held.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimReplicaSlot, resolveReplicaPotSlug } from '../../work-item-redundancy';
import { activeWorkspaceId } from '../../workspace-registry';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'work_items:claim_replica',
  profile: 'engineer',
  description:
    'Claim one replica slot of a HIGH-STAKES (redundancy>1) work-item — the redundancy analogue of claim_next. Up to N distinct Swarms each get a distinct slot of the SAME item and run it independently. Returns the slot (replica_index + claim_id) or null when not high-stakes / all slots held.',
  guidance: {
    when: 'You are a Swarm picking up a high-stakes item that is being run redundantly. Claim a replica slot, run the item independently, then record your result.',
    notWhen:
      'A normal exactly-once item — that is work_items:claim_next. Marking an item high-stakes — that is work_items:set_redundancy.',
    chaining:
      'work_items:claim_replica → (run the item) → work_items:record_replica_result { replicaIndex } → work_items:judge_redundancy resolves the winner.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The high-stakes work-item id.'),
    harness: z.string().min(1).max(80).describe('Harness the work-item lives in.'),
    owner: z.string().max(120).optional().describe('default: you'),
    ttlSec: z.number().int().min(60).max(7200).optional().describe('Lease length (default 1800s = 30m).'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const owner = resolveSelfLiteral(args.owner, ident.ownerId) ?? ident.ownerId;
    const workspaceId = activeWorkspaceId();
    const potSlug = await resolveReplicaPotSlug(workspaceId, args.harness);
    const res = await claimReplicaSlot({
      workspaceId,
      harnessSlug: args.harness,
      potSlug,
      workItemId: args.id,
      owner,
      ownerLabel: ident.ownerLabel ?? null,
      ttlSec: args.ttlSec,
    });
    if (!res.ok) {
      const msg =
        res.reason === 'item-not-found'
          ? `work-item ${args.id} not found in harness ${args.harness}`
          : res.reason === 'not-redundant'
            ? `work-item ${args.id} is not high-stakes (redundancy=${res.redundancy ?? 1}) — use work_items:claim_next`
            : `all ${res.redundancy} replica slots are held by other Swarms`;
      return json({ ok: false, reason: res.reason, error: msg });
    }
    return json({
      ok: true,
      reused: res.reused,
      replica: {
        workItemId: res.replica.workItemId,
        harness: res.replica.harnessSlug,
        replicaIndex: res.replica.replicaIndex,
        redundancy: res.replica.redundancy,
        claimId: res.replica.claimId,
        owner: res.replica.owner,
        expiresTs: res.replica.expiresTs,
      },
    });
  },
});
