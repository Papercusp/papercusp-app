/**
 * pot:moderation_queue — the OWNER's moderation queue: list reports filed by members
 * (Brief EN-3 / P-MOD). Read-only; resolve with pot:moderation_resolve, act with
 * pot:takedown / pot:ban_member.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listReports } from '../../hive-reports-store';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:moderation_queue',
  profile: 'engineer',
  description:
    "The owner's moderation queue — list member-filed reports for a Pot (default the open ones). Read-only. Act on a report with pot:moderation_resolve (action/dismiss), pot:takedown (hide content), or pot:ban_member.",
  guidance: {
    when: 'You (the owner) want to review reports members filed via pot:report.',
    notWhen: 'Filing a report (that is pot:report, member-side).',
    chaining: 'pot:moderation_queue → pot:takedown / pot:ban_member / pot:moderation_resolve.',
    seeAlso: [
      'pot:takedown (hide reported content)',
      'pot:ban_member (ban the reported member)',
      'pot:moderation_resolve (mark a report actioned)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z.string().min(1).max(120).describe("The Pot's home harness slug."),
    status: z
      .enum(['open', 'actioned', 'dismissed', 'all'])
      .optional()
      .describe("Filter by status (default 'open' — the live queue). 'all' = full history."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const status = args.status === 'all' ? null : args.status;
    const rows = await listReports(workspaceId, args.pot, { status });
    return text({ ok: true, pot: args.pot, count: rows.length, reports: rows });
  },
});
