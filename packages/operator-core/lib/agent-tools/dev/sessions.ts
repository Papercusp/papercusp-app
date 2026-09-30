/**
 * dev:sessions — cross-workspace agent-session list (grouped by spawn_id
 * from harness_shared.tool_invocations).
 *
 * v1: tool-invocation roll-up by spawn. Full transcript drilldown
 * (omp session jsonl + agent_chats transcript merge) is v2.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listSessions } from '../../dev-data';

export default defineTool({
  name: 'dev:sessions',
  profile: 'engineer',
  description: 'Cross-workspace agent sessions, one row per spawn_id with started/ended/tool_count/error_count/duration totals.',
  capability: 'intel:read',
  guidance: {
    when: `List recent /dev panel sessions — used by the dev UI to populate session pickers.`,
    notWhen: `For application AGENT chat sessions, use \`agent_chats:list\`. dev:sessions is the panel's own concept.`,
    seeAlso: [
      'dev:session_detail (drill into one session)',
      'dev:processes (OS-level spawn processes)',
      'agent_chats:list (application chat sessions)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    /** Filter by transport (which adapter drove dispatch). See
     *  dev:telemetry for the same field. */
    transports: z.array(z.enum(['http', 'mcp', 'ipc', 'in_process', 'unknown']))
      .nullable().optional(),
    hours: z.number().int().positive().max(720).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await listSessions({
      workspaceIds: args.workspaceIds ?? null,
      transports: args.transports ?? null,
      hours: args.hours,
      limit: args.limit,
    });
    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: result.entries.length, entries: result.entries }) },
      ],
    };
  },
});
