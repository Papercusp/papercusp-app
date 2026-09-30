/**
 * work_items:redundancy_status — read a high-stakes item's redundancy config + replica ledger
 * (decentralized-dispatch-scaling P-014): the target replica count, each slot's status
 * (claimed/complete/winner/loser), owner, and judge verdict (composite + rationale). The
 * read surface for "where is this redundant item — who's running it, who won?".
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): pass `id` for one or
 * `ids` for several (all in the shared `harness`) → { ok, results:[{ ok, id, … | error }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getItemRedundancy, listReplicas, resolveReplicaPotSlug, workItemRedundancyEnabled } from '../../work-item-redundancy';
import { activeWorkspaceId } from '../../workspace-registry';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'work_items:redundancy_status',
  profile: 'engineer',
  description:
    "Read one OR many work-items' redundancy config + replica ledger (pass `id` for one or `ids` for several, all in the shared `harness`): target N, each slot's status (claimed/complete/winner/loser), owner, lease expiry, and judge verdict. Returns { ok, results:[{ ok, id, redundancy, completeCount, judgeable, replicas, … | error }], counts }.",
  guidance: {
    when: 'Checking how one or more high-stakes items are progressing across their Swarms — how many replicas completed, whether judged, which replica won.',
    notWhen: 'A normal item (it has no replicas). The plain item state — that is work_items:get.',
    chaining: 'work_items:redundancy_status → (if ≥2 complete) work_items:judge_redundancy.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).max(120).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1).max(120)).max(100).optional().describe('work-item ids to read (1–100)'),
      harness: z.string().min(1).max(80).describe('Harness the work-item(s) live in (shared by all ids).'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    // Shared harness ⇒ resolve the workspace + replica hive ONCE, not per item.
    const workspaceId = activeWorkspaceId();
    const potSlug = await resolveReplicaPotSlug(workspaceId, args.harness);
    const env = await runBulk(
      ids,
      async (id) => {
        const redundancy = await getItemRedundancy(id, { harness: args.harness });
        if (redundancy == null) {
          return { ok: false as const, id, error: `work-item ${id} not found in harness ${args.harness}` };
        }
        const replicas = await listReplicas(id, { harness: args.harness, workspaceId, potSlug });
        const completeCount = replicas.filter((r) => r.status === 'complete').length;
        return {
          ok: true as const,
          id,
          harness: args.harness,
          redundancy,
          highStakes: redundancy > 1,
          active: workItemRedundancyEnabled(),
          completeCount,
          judgeable: completeCount >= 2,
          replicas: replicas.map((r) => ({
            replicaIndex: r.replicaIndex,
            owner: r.owner,
            status: r.status,
            expired: r.expired,
            expiresTs: r.expiresTs,
            judgeComposite: r.judgeComposite,
            judgeRationale: r.judgeRationale,
          })),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
