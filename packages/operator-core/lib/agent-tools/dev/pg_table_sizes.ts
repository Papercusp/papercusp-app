/**
 * dev:pg_table_sizes — per-table total + index size for a schema.
 * Defaults to harness_shared. Largest first.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pgTableSizes } from '../../dev-data';

export default defineTool({
  name: 'dev:pg_table_sizes',
  profile: 'engineer',
  description: 'List tables in a pg schema with total size, index size, and estimated row count. Defaults to harness_shared.',
  capability: 'intel:read',
  guidance: {
    when: `Diagnostic: per-table sizes + row counts. Use when investigating storage growth.`,
    notWhen: `For application data analysis, query the relevant tools directly. pg_table_sizes is an ops view.`,
    seeAlso: [
      'dev:pg_query (query the tables directly)',
      'dev:pg_health (connection health)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    schema: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await pgTableSizes(args.schema, args.limit);
    return { data: { count: result.tables.length, tables: result.tables } };
  },
});
