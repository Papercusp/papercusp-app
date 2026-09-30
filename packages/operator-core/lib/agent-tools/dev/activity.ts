/**
 * dev:activity — most-recent tool invocations across selected workspaces.
 * Drives the right-rail activity feed on /dev.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activityFeed } from '../../dev-data';

export default defineTool({
  name: 'dev:activity',
  profile: 'engineer',
  description: 'Most-recent tool invocations across selected workspaces (live activity feed).',
  capability: 'intel:read',
  guidance: {
    when: `Diagnostic feed of recent workspace activity — for dashboards and debugging. Lower-detail than \`audit:list\`.`,
    notWhen: `For agent action audit, use \`audit:list\`. dev:activity is for the /dev panel, not for analysis.`,
    seeAlso: [
      'audit:list (per-agent action audit)',
      'dev:audit (the dev-panel audit view)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await activityFeed({
      workspaceIds: args.workspaceIds ?? null,
      limit: args.limit,
    });
    return { data: { count: result.entries.length, entries: result.entries } };
  },
});
