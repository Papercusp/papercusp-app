/**
 * cross_harness:recent_activity — workspace-wide recent audit_log feed.
 *
 * Mirrors GET /api/harness/all/recent-activity.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readRecentActivity } from '../../cross-harness-data';

export default defineTool({
  name: 'cross_harness:recent_activity',
  profile: 'engineer',
  description: 'Workspace-wide recent activity feed (ts, harness_slug, action, subject, actor) from harness_shared.audit_log.',
  guidance: {
    when: 'User asks "what\'s been happening across all my harnesses?", "any cross-harness activity?". The workspace-level activity feed.',
    notWhen: 'For ONE harness\'s activity, use `harness:status`. For your own audit trail, use `audit:list`.',
    seeAlso: [
      'harness:status (ONE harness\'s live activity)',
      'cross_harness:supervisor_notes (supervisor annotations across harnesses)',
    ],
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const events = await readRecentActivity(args.limit);
    return { data: { events } };
  },
});
