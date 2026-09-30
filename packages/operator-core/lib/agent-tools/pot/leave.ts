/**
 * pot:leave — a JOINER cleanly leaves a shared pot
 * (shared-hive-hardening-2026-06-13 P-012). The durable inverse of joining a
 * pot (joinPotAsView): the thin tool wrapper over `leaveHive` (leave-pot.ts).
 *
 * Distinct from pot:dissolve — that is the OWNER tearing down a LOCAL pot
 * (stops the Mug, cancels cups, deregisters the home harness). pot:leave is a
 * JOINER walking away from a remote pot they joined: stop federating (leave the
 * swarm topic), delete the member git-sync routines, drop local presence, and
 * deregister the `remote_hive` view + its member clones.
 *
 * ROOT-ONLY (not callable from a cup) + confirm-gated (it tears down what the
 * join built). Idempotent + best-effort — every leg folds its outcome into the
 * result; a partial leave is fully re-runnable. Clone dirs on disk are KEPT by
 * default (re-joinable); `deleteClones:true` also removes them.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { leaveHive } from '../../harness/leave-hive';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:leave',
  profile: 'engineer',
  description:
    "Leave a shared pot you JOINED (root-only, pass confirm:true): stop federating (leave the swarm topic), delete the member git-sync routines, drop local presence rows, and deregister the remote_hive view + its member clones. Idempotent + best-effort. Clone dirs are kept by default — deleteClones:true also removes them. NOT for a local pot you own — that is pot:dissolve.",
  guidance: {
    when: 'A joiner cleanly leaving a shared pot they joined — stop federating, deregister the joined view + members, kill their git-sync routines. Operator/user only.',
    notWhen:
      'Tearing down a LOCAL pot you OWN (stop its operator, cancel its members) — pot:dissolve. Pausing federation without leaving — there is no pause; leave + re-join. From a cup — not allowed.',
    chaining: 'pot:list / pot:get to find the joined pot (remote_hive) view slug before; re-join via the pot directory join flow if you change your mind.',
    seeAlso: [
      'pot:list (find the joined pot slug first)',
      'pot:add-member (the inverse — add a member to a pot)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .describe("The joined pot's remote_hive VIEW slug (or a joined member slug — leaving the whole pot)."),
    confirm: z
      .boolean()
      .optional()
      .describe('Required true — pot:leave tears down federation, routines, presence, and the joined registry entries.'),
    deleteClones: z
      .boolean()
      .optional()
      .describe('Also rm -rf the member clone dirs from disk. Default false — keep the clones (re-joinable).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only (mirrors pot:dissolve) — a cup never leaves a pot.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_leave_root_only',
        message:
          'pot:leave cannot be called from a cup (a spawned/parented agent). Only the operator/user leaves a pot.',
      });
    }
    if (!args.confirm) {
      return text({
        ok: false,
        error: 'confirm_required',
        message:
          'pot:leave tears down federation, git-sync routines, presence, and the joined registry entries — pass confirm:true to proceed. Clone dirs are kept unless deleteClones:true.',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );

    const result = await leaveHive({
      workspaceId,
      slug: args.slug,
      deleteClones: args.deleteClones,
    });

    return text({ ...result });
  },
});
