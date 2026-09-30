/**
 * datatypes:get — fetch one OR many datatypes by id from the workspace registry,
 * including the full payload schema + self-improvement surface
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-013). Read-only.
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids` for
 * several → { ok, results:[{ ok, id, datatype? | error }], counts } — each result
 * self-describes its id, so a not-found id never poisons the rest.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getDatatype } from '../../datatype-registry-store';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'datatypes:get',
  description:
    'Fetch one OR many datatypes by id from the workspace registry — including the payload schema, tier, ' +
    'authoritative writer, and self-improvement surface. Pass `id` for one or `ids` for several. Returns ' +
    '{ ok, results:[{ ok, id, datatype? | error }], counts } — correlate by id, not position. Read-only.',
  guidance: {
    when: 'When you have datatype id(s) (from datatypes:list) and want the full definition before referencing or instantiating it.',
    notWhen: 'To browse the registry — datatypes:list. To declare — meta:define-datatype.',
    chaining: 'datatypes:list → datatypes:get { ids:[…] } (inspect) → work_items:create { kind } / blueprint dependencies.datatypes.',
    seeAlso: [
      'datatypes:list (find ids to inspect)',
      'datatypes:install (install one after inspecting)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single datatype id / slug (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('datatype ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId ?? '';
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const datatype = workspaceId ? await getDatatype(sql, workspaceId, id) : null;
        if (!datatype) return { ok: false as const, id, error: 'not_found' };
        return { ok: true as const, id, datatype };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
