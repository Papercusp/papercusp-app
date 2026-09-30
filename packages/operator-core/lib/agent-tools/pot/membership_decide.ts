/**
 * pot:membership_decide — OWNER approves or denies a pending-join request
 * (Brief EN-3 / P-MEMBER, the owner approve/deny surface — decide half).
 *
 * Approve → trust-admit the joiner (upsertPotMember with the request's captured
 * devices) + mark 'approved' (federates the decision back). Deny → mark 'denied';
 * the joiner is NEVER trust-admitted.
 *
 * AUTHORITY: the OWNING SWARM — the CANONICAL owner (isCanonicalHiveOwner), not
 * merely "holds ANY pot-identity key" (WI-2000: a divergent/stale local key —
 * the WI-1981 epoch-poison class — must never authorize a membership decision;
 * `loadPotPubkey != null` alone can't tell a canonical owner from a poisoned
 * joiner box). Same canonical-ownership gate revokePotContributor /
 * pot-policy-author use. A claimed viewer on a non-owning Swarm cannot decide.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { isCanonicalHiveOwner } from '../../hive-identity';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { approvePendingJoin, denyPendingJoin } from '../../hive-membership-admission';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const Decision = z.object({
  githubUserId: z.number().int().positive().describe("The pending joiner's numeric GitHub user id (from pot:membership_pending)."),
  decision: z.enum(['approve', 'deny']).describe('approve = trust-admit; deny = reject (never admitted).'),
  reason: softText(LIMITS.ANNOTATION).optional().describe('Optional note (e.g. a deny reason), federated back to the joiner. Auto-truncated to 2000 chars if longer.'),
});

export default defineTool({
  name: 'pot:membership_decide',
  profile: 'engineer',
  description:
    "OWNER decision on one OR many pending-join requests for a Pot: approve (trust-admit the joiner + their captured devices) or deny (never admitted). Pass a single `{ githubUserId, decision, reason? }` for one or `items:[{ githubUserId, decision, reason? }]` for several. Requires this Swarm to hold the Pot key (the owning Swarm). Returns { ok, results:[{ ok, githubUserId, … | error }], counts } — correlate by githubUserId, not position; one failure never fails the rest.",
  guidance: {
    when: 'Joiner(s) are pending under approval-mode membership (see pot:membership_pending) and you (the owner) want to admit or reject them. Clearing a queue? Pass them all via `items:[{ githubUserId, decision }]`.',
    notWhen:
      'Banning an already-admitted member for abuse — use pot:ban_member (revoke + re-key teeth). Setting the membership mode itself — that is pot policy.',
    chaining: 'pot:membership_pending (review the queue) → pot:membership_decide (per joiner, or all at once via items[]). Bulk: correlate by githubUserId, not position; one failure never fails the rest.',
    seeAlso: [
      'pot:membership_pending (review the queue first)',
      'pot:ban_member (remove an already-admitted member)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z
    .object({
      pot: z.string().min(1).max(120).describe("The Pot's home harness slug (batch-level — one Pot per call)."),
      githubUserId: z.number().int().positive().optional().describe('n=1: a single pending joiner id (pair with decision).'),
      decision: z.enum(['approve', 'deny']).optional().describe('n=1: the decision for the single githubUserId.'),
      reason: softText(LIMITS.ANNOTATION).optional().describe('n=1: optional note for the single decision. Auto-truncated to 2000 chars if longer.'),
      items: z.array(Decision).min(1).max(100).optional().describe('decisions to apply (1–100), each { githubUserId, decision, reason? }'),
      workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.githubUserId) && Boolean(a.decision)), {
      message: 'pass `{ githubUserId, decision }` (one) or `items:[{ githubUserId, decision }]` (many)',
    }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );

    // Owner gate (once for the batch): only the CANONICAL owner Swarm may decide
    // (WI-2000: a divergent/stale local key must never pass this gate).
    const isOwner = await isCanonicalHiveOwner(workspaceId, args.pot).catch(() => false);
    if (!isOwner) {
      return text({ ok: false, code: 'not_owner', detail: 'this Swarm does not hold the Pot private key' });
    }
    const identity = await resolveLocalGithubIdentity();
    const decidedBy = identity.kind === 'ok' ? identity.githubUserId : 0;
    if (!decidedBy) {
      return text({ ok: false, code: 'no_owner_identity', detail: 'could not resolve the local GitHub identity' });
    }

    // ⚠ SCOPE (WI-6312): `args.pot` is the LOCAL registry handle; pending-join and member
    // rows are keyed by the FEDERATED scope. Resolved ONCE for the whole batch (like the
    // owner gate above) rather than per decision. The owner gate means this path only runs
    // where canonical == local, so this is a type-safety hardening rather than a behavior
    // change — but it keeps approve/deny reading the same scope the admit path wrote under.
    const potScope = await resolveFederatedPotScope(workspaceId, args.pot);

    const decisions = args.items?.length
      ? args.items
      : [{ githubUserId: args.githubUserId!, decision: args.decision!, reason: args.reason }];
    const env = await runBulk(
      decisions,
      async ({ githubUserId, decision, reason }) => {
        const result =
          decision === 'approve'
            ? await approvePendingJoin({ workspaceId, potHomeSlug: potScope, githubUserId, decidedByGithubUserId: decidedBy })
            : await denyPendingJoin({ workspaceId, potHomeSlug: potScope, githubUserId, decidedByGithubUserId: decidedBy, reason: clampText(reason, LIMITS.ANNOTATION) ?? null });
        // approvePendingJoin/denyPendingJoin return their own { ok, … }; surface it
        // verbatim, keyed by githubUserId.
        return { ...result, ok: (result as { ok?: boolean }).ok !== false, githubUserId };
      },
      { keyOf: ({ githubUserId }) => ({ githubUserId }) },
    );
    return bulkContent(env);
  },
});
