/**
 * pot:moderation_resolve — OWNER resolves a report (action it / dismiss it)
 * (Brief EN-3 / P-MOD). The resolution federates back to the reporter. This only
 * changes the report's STATUS; the actual content-hide / member-ban are separate
 * owner actions (pot:takedown / pot:ban_member).
 *
 * AUTHORITY: the CANONICAL owning Swarm (isCanonicalHiveOwner — WI-2000: not
 * merely "holds ANY pot-identity key", which a divergent/stale local key
 * (the WI-1981 epoch-poison class) would also satisfy).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { isCanonicalHiveOwner } from '../../hive-identity';
import { setReportStatus } from '../../hive-reports-store';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const Resolution = z.object({
  reportId: z.string().min(1).max(200).describe('The report id (from pot:moderation_queue).'),
  status: z.enum(['actioned', 'dismissed']).describe("'actioned' = you took action; 'dismissed' = no action."),
});

export default defineTool({
  name: 'pot:moderation_resolve',
  profile: 'engineer',
  description:
    "OWNER resolves one OR many moderation reports: 'actioned' (you took action — e.g. a takedown/ban) or 'dismissed' (no action). Pass a single `{ reportId, status }` for one or `items:[{ reportId, status }]` for several. Federates the resolutions back. Requires holding the Pot key. Does NOT itself hide content or ban — use pot:takedown / pot:ban_member for that. Returns { ok, results:[{ ok, reportId, report? | error }], counts } — correlate by reportId, not position; one failure never fails the rest.",
  guidance: {
    when: 'You reviewed report(s) (pot:moderation_queue) and want to mark them resolved. Clearing a queue? Pass them all via `items:[{ reportId, status }]`.',
    notWhen: 'You want to actually hide content (pot:takedown) or ban a member (pot:ban_member) — do that first, then resolve.',
    chaining: 'pot:moderation_queue → (pot:takedown / pot:ban_member) → pot:moderation_resolve. Bulk: correlate by reportId, not position; one failure never fails the rest.',
    seeAlso: [
      'pot:moderation_queue (the reports to resolve)',
      'pot:takedown (hide the content before resolving)',
      'pot:ban_member (ban the member before resolving)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z
    .object({
      pot: z.string().min(1).max(120).describe("The Pot's home harness slug (batch-level — one Pot per call)."),
      reportId: z.string().min(1).max(200).optional().describe('n=1: a single report id (pair with status).'),
      status: z.enum(['actioned', 'dismissed']).optional().describe('n=1: the resolution for the single reportId.'),
      items: z.array(Resolution).min(1).max(100).optional().describe('resolutions to apply (1–100), each { reportId, status }'),
      workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.reportId) && Boolean(a.status)), {
      message: 'pass `{ reportId, status }` (one) or `items:[{ reportId, status }]` (many)',
    }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    // Owner gate (once for the batch): the CANONICAL owner, not merely "holds a key".
    const isOwner = await isCanonicalHiveOwner(workspaceId, args.pot).catch(() => false);
    if (!isOwner) {
      return text({ ok: false, code: 'not_owner', detail: 'this Swarm does not hold the Pot private key' });
    }
    const resolutions = args.items?.length
      ? args.items
      : [{ reportId: args.reportId!, status: args.status! }];
    const env = await runBulk(
      resolutions,
      async ({ reportId, status }) => {
        const report = await setReportStatus(workspaceId, args.pot, reportId, status);
        if (!report) return { ok: false as const, reportId, error: 'no report with that id' };
        return { ok: true as const, reportId, report };
      },
      { keyOf: ({ reportId }) => ({ reportId }) },
    );
    return bulkContent(env);
  },
});
