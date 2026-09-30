/**
 * trust:remove — revoke trust in one OR many GitHub users
 * (shared-hive-trust-admission-2026-06-14 / P-009). Their verified remote work
 * returns to per-item screening. Owner-scoped, local-only. Audited.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `githubUserId` for one
 * or `githubUserIds` for several → { ok, results:[{ ok, githubUserId, removed |
 * error }], counts }. The workspace (privilege boundary) is resolved ONCE; each
 * id self-describes its result so one failed revoke never poisons the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'trust:remove',
  profile: 'engineer',
  // Deletes the workspace-scoped trust row + writes the audit row via the admin
  // handle, scoping itself by the resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Remove one OR many GitHub user ids from the owner's LOCAL trust list — revokes the auto-run privilege; their verified remote work returns to per-item screening. Pass `githubUserId` for one or `githubUserIds` for several. Owner-scoped, local-only. Audited. Returns { ok, results:[{ ok, githubUserId, removed | error }], counts } — correlate by githubUserId, not position; one failure never fails the rest.",
  capability: 'audit:write',
  guidance: {
    when: 'The owner revokes trust in GitHub user(s) (their remote work should no longer auto-run). Revoking several at once? Pass them all via `githubUserIds`.',
    notWhen: 'To grant trust use trust:add; to view the list use trust:list.',
    chaining: 'trust:list → trust:remove { githubUserId } | { githubUserIds:[…] }. Bulk: correlate by githubUserId, not position; one failure never fails the rest.',
    seeAlso: [
      'trust:add (grant trust)',
      'trust:list (view the trust list)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      githubUserId: z.number().int().positive().optional().describe('A single GitHub numeric user id to un-trust (n=1 shorthand for githubUserIds:[id]).'),
      githubUserIds: z.array(z.number().int().positive()).min(1).max(100).optional().describe('GitHub numeric user ids to un-trust (1–100).'),
    })
    .refine((a) => Boolean(a.githubUserId) || (a.githubUserIds?.length ?? 0) > 0, {
      message: 'pass `githubUserId` (one) or `githubUserIds` (many)',
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { removeTrustedUser } = await import('../../trust/user-trust-list');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    const ids = [...new Set([...toList<number>(args.githubUserId), ...toList<number>(args.githubUserIds)])];
    const env = await runBulk(
      ids,
      async (githubUserId) => {
        const { removed } = await removeTrustedUser(ws, githubUserId, actor);
        return { ok: true as const, githubUserId, workspaceId: ws, removed };
      },
      { keyOf: (githubUserId) => ({ githubUserId }) },
    );
    return bulkContent(env);
  },
});
