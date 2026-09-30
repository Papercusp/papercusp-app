/**
 * datatypes:list — browse the workspace datatype registry
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-013). Read-only.
 *
 * Surfaces the reusable entity TYPES declared via meta:define-datatype — the names a
 * blueprint references through dependencies.datatypes (P-012) and (generic-kind) the
 * kinds work_items:create accepts. Newest-updated first; defaults to active datatypes.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listDatatypes, countDatatypes, DATATYPE_TIERS } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:list',
  description:
    'List the workspace datatype registry — the reusable entity TYPES (bet, wager, forecast, position, …) ' +
    'declared via meta:define-datatype. Optionally filter by tier. Read-only. Pair the returned `total` with ' +
    'the (capped) `datatypes` array to know if the list was truncated.',
  guidance: {
    when:
      'To discover what datatypes exist before declaring a new one (avoid duplicates), or to find the name to put ' +
      'in a blueprint\'s dependencies.datatypes, or the generic-kind to pass to work_items:create.',
    notWhen: 'To read one datatype\'s full definition — use datatypes:get. To declare one — meta:define-datatype.',
    chaining: 'datatypes:list → datatypes:get { id } (inspect) → work_items:create { kind } / blueprint dependencies.datatypes.',
    seeAlso: [
      'datatypes:get (full detail on one)',
      'datatypes:summary (the overview)',
      "cupboard:search { kind:'datatype' } (installable datatypes)",
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    tier: z
      .enum([...DATATYPE_TIERS] as [string, ...string[]])
      .optional()
      .describe('filter to one tier (generic-kind | first-class | projection)'),
    limit: z.number().int().positive().max(2000).optional().describe('max rows (default 1000, clamped to 2000)'),
    includeInactive: z.boolean().optional().describe('include retired/superseded datatypes (default false)'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ data: obj });
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return reply({ ok: true, datatypes: [], count: 0, total: 0 });
    const datatypes = await listDatatypes(sql, workspaceId, {
      tier: args.tier as (typeof DATATYPE_TIERS)[number] | undefined,
      limit: args.limit,
      activeOnly: !args.includeInactive,
    });
    const total = await countDatatypes(sql, workspaceId);
    return reply({ ok: true, datatypes, count: datatypes.length, total });
  },
});
