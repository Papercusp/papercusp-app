/**
 * dev:pg_active_queries — list active/idle pg connections + their queries.
 *
 * Mirrors Restart's `/active-queries` endpoint; oldest first so long-
 * running queries surface at the top.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pgActiveQueries } from '../../dev-data';

export default defineTool({
  name: 'dev:pg_active_queries',
  profile: 'engineer',
  description: 'List current pg_stat_activity rows (pid, state, query, duration) for the operator database.',
  capability: 'intel:read',
  guidance: {
    when: `Diagnostic: list currently-running PG queries (pg_stat_activity). Use when investigating slow / hung queries.`,
    notWhen: `For routine diagnostics, the /dev/pg panel is enough. Use this tool when scripting an investigation.`,
    seeAlso: [
      'dev:pg_health (connection / pool health)',
      'dev:pg_query (run a read-only diagnostic query)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const result = await pgActiveQueries(args.limit);
    return { data: { count: result.queries.length, queries: result.queries } };
  },
});
