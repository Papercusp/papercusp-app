/**
 * dev:telemetry — cross-workspace tool-invocation rollup.
 *
 * Returns per-tool call counts, error counts, p50/p95 duration, and the
 * set of workspaces that invoked each tool — over the last N hours.
 * Drives the /dev page Telemetry tab.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { flagPollSuspects, telemetryRollup } from '../../dev-data';

export default defineTool({
  name: 'dev:telemetry',
  profile: 'engineer',
  description: 'Per-tool invocation rollup (count, error rate, p50/p95) across selected workspaces over the last N hours.',
  capability: 'intel:read',
  guidance: {
    when: `Read recent telemetry datapoints (errors, slow requests). For the /dev/telemetry dashboard.`,
    notWhen: `For per-agent audit, use \`audit:list\`. telemetry is observability-shaped, not action-shaped.`,
    seeAlso: [
      'dev:tool_cooccurrence (which tools co-occur in a spawn)',
      'dev:code_run_adoption (code:run adoption metrics)',
      'audit:list (per-agent audit trail)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    /** Filter by which transport drove the dispatch. 'unknown' matches
     *  rows pre-migration 058 (transport=NULL). null/omitted = no filter. */
    transports: z.array(z.enum(['http', 'mcp', 'ipc', 'in_process', 'unknown']))
      .nullable().optional(),
    hours: z.number().int().positive().max(168).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const hours = args.hours ?? 24;
    const result = await telemetryRollup({
      workspaceIds: args.workspaceIds ?? null,
      transports: args.transports ?? null,
      hours,
      limit: args.limit,
    });
    // Poll-detector guard (EI-7029): surface polling-shaped tools UP FRONT so a
    // new storm is flagged on the next telemetry read, not discovered from a
    // bandwidth bill. Empty array = nothing suspect.
    const pollSuspects = flagPollSuspects(result.entries, hours);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.entries.length,
            poll_suspects: pollSuspects,
            entries: result.entries,
          }),
        },
      ],
    };
  },
});
