/**
 * fleet:tree — read the durable spawn subtree + its completion gate (P0, D-003).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Inspect the parent→child spawn
 * lineage rooted at a node (status, owner, role, the work it serves) before cancelling
 * or completing it. Distinct from intel:spawn_tree, which reconstructs lineage from
 * tool_invocations; this reads the durable spawned_agents nursery structure directly.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSubtree } from '../../fleet/spawn-tree';
import { assertCanComplete } from '../../fleet/nursery';
import { isPossiblyWedged } from '../../fleet/spawn-reclaim';

export default defineTool({
  name: 'fleet:tree',
  profile: 'engineer',
  description:
    'Read a spawn subtree (the nursery): every descendant with its status, owner, role, and the work it serves, plus whether the root can complete (no live child). This is spawn-scoped, not fleet-scoped: `fleet` is not an accepted argument; use `fleet:assignments { fleet }` for a named-fleet state view.',
  guidance: {
    when: 'Before fleet:cancel (see what would be torn down) or before completing a nursery (the completion gate refuses while a child lives).',
    notWhen: 'Reading every member of a named fleet — use `fleet:assignments { fleet }` instead; this tool requires a nursery `spawn_id` root.',
    chaining: 'fleet:tree → fleet:cancel { spawn_id }.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    spawn_id: z
      .string()
      .min(1)
      .describe('Nursery root spawn id, not a fleet slug; use fleet:assignments { fleet } for a named-fleet state view.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const nodes = await getSubtree(sql, { workspaceId, rootSpawnId: args.spawn_id });
    const gate = await assertCanComplete(sql, workspaceId, args.spawn_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            root: args.spawn_id,
            can_complete: gate.canComplete,
            open_children: gate.openChildren,
            nodes: nodes.map((n) => ({
              spawn_id: n.spawnId,
              parent: n.parentSpawnId,
              depth: n.depth,
              role: n.childRole,
              status: n.status,
              owner: n.sessionOwner,
              feature: n.featureId,
              plan_item: n.itemId,
              restart_strategy: n.restartStrategy,
              // Per-spawn model escalation observability (what the queen picked
              // vs. how the task went) — omitted when no override applied.
              ...(n.modelSpec ? { model: n.modelSpec } : {}),
              ...(n.modelTier ? { tier: n.modelTier } : {}),
              // The parent-authored brief (mig 230) — the dock brief-pane's source.
              ...(n.brief ? { brief: n.brief } : {}),
              // Liveness annotations (P-008/P-009): stream activity + the
              // wedged-candidate flag (alive + heartbeating, stream silent
              // >10min). Display/triage only — never auto-acted on (P-010).
              ...(n.lastOutputAt ? { last_output_at: n.lastOutputAt } : {}),
              ...(isPossiblyWedged(n) ? { possibly_wedged: true } : {}),
            })),
          }),
        },
      ],
    };
  },
});
