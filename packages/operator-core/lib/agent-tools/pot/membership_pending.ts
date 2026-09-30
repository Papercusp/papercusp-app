/**
 * pot:membership_pending — list a Pot's approval-mode pending-join requests
 * (Brief EN-3 / P-MEMBER, the owner approve/deny surface — read half).
 *
 * Under `membership: 'approval'`, a joiner's request lands in hive_pending_joins and
 * federates to the owner. This is the owner's queue view. Read-only; the decide half
 * is pot:membership_decide.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listPendingJoins } from '../../hive-pending-joins-store';
import { resolveFederatedPotScope } from '../../federated-pot-scope';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:membership_pending',
  profile: 'engineer',
  description:
    "List a Pot's pending-join requests (the approval-mode admission queue). Under membership:'approval' a joiner stays pending until the owner approves; this is the owner's review queue. Read-only — decide with pot:membership_decide.",
  guidance: {
    when: "The Pot's membership policy is 'approval' and you (the owner) want to see who's waiting to join. Pair with pot:membership_decide to approve/deny.",
    notWhen:
      'For the trust roster (already-admitted members) use pot:get / harness:membership. Setting the membership MODE is pot policy (the policy authoring surface), not this.',
    chaining: 'pot:membership_pending (review) → pot:membership_decide (approve/deny each).',
    seeAlso: [
      'pot:membership_decide (approve/deny each pending join)',
      'pot:add-member (add a member directly without a pending request)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: "The Pot's home harness slug." }),
    status: z
      .enum(['pending', 'approved', 'denied', 'all'])
      .optional()
      .describe("Filter by decision status (default 'pending' — the open queue). 'all' = full history."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const status = args.status === 'all' ? null : args.status; // undefined ⇒ store default 'pending'
    // WI-6318: hive_pending_joins is a `hiveScoped` projection, persisted under the
    // OWNER-authored slug. `args.pot` is a tool argument, so on a joiner it is the LOCAL
    // handle and this queue reads EMPTY — indistinguishable from "no one is waiting".
    // A no-op on an owner; fails open to the local handle.
    const rows = await listPendingJoins(workspaceId, await resolveFederatedPotScope(workspaceId, args.pot), {
      status,
    });
    return text({ ok: true, pot: args.pot, count: rows.length, pending: rows });
  },
});
