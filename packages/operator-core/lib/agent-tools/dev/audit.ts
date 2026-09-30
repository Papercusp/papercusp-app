/**
 * dev:audit — cross-workspace audit_log feed.
 *
 * Drives the /dev page Audit tab.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { auditFeed } from '../../dev-data';

export default defineTool({
  name: 'dev:audit',
  profile: 'engineer',
  description: 'Cross-workspace audit_log feed (last N hours).',
  capability: 'audit:read',
  guidance: {
    when: `Dev-panel audit view — filtered + paginated for UI display.`,
    notWhen: `For analysis or LLM consumption, use \`audit:list\` directly. dev:audit is a UI-shaped projection.`,
    seeAlso: [
      'audit:list (analysis / LLM-consumption view)',
      'dev:activity (the lower-detail dev activity feed)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    hours: z.number().int().positive().max(720).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await auditFeed({
      workspaceIds: args.workspaceIds ?? null,
      hours: args.hours,
      limit: args.limit,
    });
    return { data: { count: result.entries.length, entries: result.entries } };
  },
});
