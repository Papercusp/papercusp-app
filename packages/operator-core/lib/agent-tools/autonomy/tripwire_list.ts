/**
 * autonomy:tripwire_list — the recent auto-decision / tripwire feed
 * (queen-autonomy-policy-2026-06-13 B-16 / P-080; backs the settings
 * "recent-auto-decisions feed with one-click undo", P-031).
 *
 * Each row is one Queen AUTO-decision of a reversible action: its category /
 * class / action, the watch status (armed → cleared | tripped → reverted), and
 * the revert handle the owner's one-click undo (autonomy:tripwire_revert) uses.
 * Read-only. Empty until the owner arms autonomy + lowers a ceiling (nothing
 * auto-decides before then).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'autonomy:tripwire_list',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    'List recent auto-decisions and their auto-revert tripwires (category, class, action, watch status armed/cleared/tripped/reverted, revert handle). Backs the settings recent-auto-decisions feed. Read-only.',
  capability: 'intel:read',
  guidance: {
    when: 'Rendering the owner recent-auto-decisions feed, or inspecting which auto-decisions are under watch / tripped. Filter by status (armed|cleared|tripped|reverted) or category.',
    notWhen:
      'To UNDO one use autonomy:tripwire_revert. To see graduation standings use autonomy:graduation_status. To read ceilings use autonomy:policy_get.',
    seeAlso: [
      'autonomy:tripwire_revert (undo an auto-decision)',
      'autonomy:graduation_status (graduation standings)',
      'autonomy:policy_get (read the ceilings)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    status: z
      .enum(['armed', 'cleared', 'tripped', 'reverted'])
      .optional()
      .describe('Filter by watch status; omit for all.'),
    category: z.string().optional().describe('Filter by autonomy category id; omit for all.'),
    limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50, newest first).'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { listRecentTripwires } = await import('../../autonomy/tripwire/store');
    const { isAutonomyCategory } = await import('../../autonomy/categories');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const { sql } = getOrgPg();

    const category =
      args.category && isAutonomyCategory(args.category) ? args.category : undefined;
    const rows = await listRecentTripwires(sql, ws, {
      ...(args.status ? { status: args.status } : {}),
      ...(category ? { category } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, count: rows.length, tripwires: rows }, null, 2) },
      ],
    };
  },
});
