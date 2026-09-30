/**
 * trust:add — trust one OR many GitHub users so their VERIFIED remote work
 * auto-runs (shared-hive-trust-admission-2026-06-14 / P-009, D-001). A SECURITY
 * GRANT: only the owner should call it. Owner-scoped, local-only, never
 * federated. Audited.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `githubUserId` for one
 * or `githubUserIds` for several → { ok, results:[{ ok, githubUserId, trusted? |
 * error }], counts }. The target workspace (the privilege boundary) is resolved
 * ONCE for the batch; each id self-describes its result so one bad grant never
 * poisons the rest. `note` is batch-level.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'trust:add',
  profile: 'engineer',
  // Writes the workspace-scoped trust row + audit row via the admin handle,
  // scoping itself by the resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Add one OR many GitHub user ids to the owner's LOCAL trust list — a SECURITY GRANT: a VERIFIED-author remote work item from a trusted user may then auto-run on the owner's install (across every hive the owner is in), bypassing per-item screening. Pass `githubUserId` for one or `githubUserIds` for several. Owner-scoped, local-only, never federated. Audited. Returns { ok, results:[{ ok, githubUserId, trusted? | error }], counts } — correlate by githubUserId, not position; one failure never fails the rest.",
  capability: 'audit:write',
  guidance: {
    when: "The owner deliberately trusts GitHub user(s) so their verified remote work auto-runs without screening. Pass the numeric github_user_id(s) (match hive_members.github_user_id) — several at once via `githubUserIds`.",
    notWhen:
      'To see who is trusted use trust:list; to revoke use trust:remove. This grants auto-run privilege — only the owner grants trust (an unverified or self-claimed author is never auto-admitted regardless).',
    chaining: 'trust:list (who is trusted) → trust:add { githubUserId, note? } | { githubUserIds:[…] }. Bulk: correlate by githubUserId, not position; one failure never fails the rest.',
    seeAlso: [
      'trust:list (who is trusted)',
      'trust:remove (revoke trust)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      githubUserId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('A single GitHub numeric user id to trust (n=1 shorthand for githubUserIds:[id]; matches hive_members.github_user_id).'),
      githubUserIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .optional()
        .describe('GitHub numeric user ids to trust (1–100).'),
      note: softText(LIMITS.ANNOTATION).optional().describe('Optional human note, e.g. "alice@acme — co-maintainer". Diagnostic only; batch-level. Auto-truncated to 2000 chars if longer.'),
    })
    .refine((a) => Boolean(a.githubUserId) || (a.githubUserIds?.length ?? 0) > 0, {
      message: 'pass `githubUserId` (one) or `githubUserIds` (many)',
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { addTrustedUser } = await import('../../trust/user-trust-list');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    // Merge scalar + array, dedup preserving order (mergeIds is string-keyed; ids are numbers).
    const ids = [...new Set([...toList<number>(args.githubUserId), ...toList<number>(args.githubUserIds)])];
    const env = await runBulk(
      ids,
      async (githubUserId) => {
        const trusted = await addTrustedUser(ws, {
          githubUserId,
          note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
          actor,
          nowMs: Date.now(),
        });
        return { ok: true as const, githubUserId, workspaceId: ws, trusted };
      },
      { keyOf: (githubUserId) => ({ githubUserId }) },
    );
    return bulkContent(env);
  },
});
