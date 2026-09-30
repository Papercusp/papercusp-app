/**
 * work_items:record_replica_result — record THIS Swarm's independent result for a replica slot
 * it holds (decentralized-dispatch-scaling P-014), marking the slot `complete` (ready to judge).
 *
 * `text` is the distilled output the judge will score (a summary / diff / answer of the run) and
 * the winner's becomes the item's adopted result. Owner-checked: only a still-running slot you
 * hold can record (no double-record; a stolen slot rejects).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { recordReplicaResult, resolveReplicaPotSlug } from '../../work-item-redundancy';
import { activeWorkspaceId } from '../../workspace-registry';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'work_items:record_replica_result',
  profile: 'engineer',
  description:
    "Record your replica's result for a high-stakes item slot you hold + mark it complete (ready to judge). `text` is the distilled output the judge scores (and the winner's is adopted). Owner-checked — no double-record.",
  guidance: {
    when: 'You finished running your replica of a high-stakes item — record the distilled result so the judge can compare it against the other Swarms.',
    notWhen:
      'A normal item — that is work_items:complete / work_items:set_state. You do not hold the slot (you must claim_replica first).',
    chaining: 'work_items:claim_replica → (run) → work_items:record_replica_result → work_items:judge_redundancy.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The high-stakes work-item id.'),
    harness: z.string().min(1).max(80).describe('Harness the work-item lives in.'),
    replicaIndex: z.number().int().min(0).describe('Your replica slot (from claim_replica).'),
    text: z.string().min(1).describe('The distilled output the judge scores (summary/diff/answer of your run).'),
    owner: z.string().max(120).optional().describe('default: you'),
    meta: z.unknown().optional().describe('Optional structured metadata to keep alongside the result.'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const owner = resolveSelfLiteral(args.owner, ident.ownerId) ?? ident.ownerId;
    const workspaceId = activeWorkspaceId();
    const potSlug = await resolveReplicaPotSlug(workspaceId, args.harness);
    const replica = await recordReplicaResult({
      workspaceId,
      harnessSlug: args.harness,
      potSlug,
      workItemId: args.id,
      replicaIndex: args.replicaIndex,
      owner,
      result: { text: args.text, meta: args.meta },
    });
    if (!replica) {
      return json({
        ok: false,
        error: `no claimed replica slot ${args.replicaIndex} held by ${owner} for ${args.id} (already recorded, stolen, or never claimed)`,
      });
    }
    return json({
      ok: true,
      replica: {
        workItemId: replica.workItemId,
        replicaIndex: replica.replicaIndex,
        status: replica.status,
        redundancy: replica.redundancy,
      },
    });
  },
});
