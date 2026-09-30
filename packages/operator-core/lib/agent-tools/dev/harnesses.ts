/**
 * dev:harnesses — cross-workspace harness list with health.
 *
 * Drives the /dev page Harnesses tab. workspaceIds=null = all workspaces.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listAllHarnessesWithHealth } from '../../dev-data';

export default defineTool({
  name: 'dev:harnesses',
  profile: 'engineer',
  description: 'List harnesses across selected workspaces with health verdict for each.',
  capability: 'harness:read',
  guidance: {
    when: `Dev-panel harness enumeration with diagnostic columns (active connections, recent errors).`,
    notWhen: `For ordinary list, use \`harness:list\`. dev:harnesses is the diagnostic projection.`,
    seeAlso: [
      'harness:list (the ordinary harness list)',
      'dev:build_status (per-harness build / smoke status)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
  }),
  async handler(args) {
    const result = await listAllHarnessesWithHealth(args.workspaceIds ?? null);
    return { data: { count: result.harnesses.length, harnesses: result.harnesses } };
  },
});
