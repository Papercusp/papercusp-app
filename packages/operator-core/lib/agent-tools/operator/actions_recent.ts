/**
 * actions:recent — list recent long-running user-initiated actions for
 * a harness (replan, cleanup, snapshot).
 *
 * Calls listUserActions() in lib/user-actions-data.ts directly — same
 * function the GET /api/user-actions/:slug route projects. Shares the
 * same in-memory cache so MCP and HTTP polls coalesce.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { InvalidSlugError, listUserActions } from '../../user-actions-data';

export default defineTool({
  name: 'actions:recent',
  profile: 'engineer',
  description: 'List recent long-running user-initiated actions for a harness (replan, cleanup, snapshot).',
  capability: 'actions:read',
  guidance: {
    when: `User asks "what have I been doing?", "recent actions". Read-only feed from the actions log.`,
    notWhen: `For workspace-wide audit (cross-harness), use \`cross_harness:recent_activity\` or \`audit:list\`.`,
    seeAlso: [
      'operator:audit (operator-scoped audit feed)',
      'cross_harness:recent_activity (workspace-wide cross-harness audit)',
      'audit:list (full audit trail)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    try {
      const result = await listUserActions({ slug: args.slug, limit: args.limit });
      const actions = result.actions.slice(0, args.limit ?? 20);
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: actions.length, actions }) }],
      };
    } catch (err) {
      if (err instanceof InvalidSlugError) {
        return { content: [{ type: 'text', text: JSON.stringify({ count: 0, actions: [] }) }] };
      }
      throw err;
    }
  },
});
