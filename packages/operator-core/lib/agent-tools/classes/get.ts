/** Full class contract + provider attestations, bulk by class@version ref. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  getCapabilityClass,
  listProviderBindings,
  parseCapabilityClassRef,
} from '../../capability-class-registry-store';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export const getCapabilityClassesTool = defineTool({
  name: 'classes:get',
  description:
    'Fetch one or many exact capability class@version contracts with provider bindings whose conformance ' +
    'status is derived from immutable validation runs.',
  guidance: {
    when: 'After classes:list, before adding a class to an identity or selecting a provider.',
    notWhen: 'To browse/search classes — use classes:list. To validate a provider implementation — use classes:validate.',
    chaining: 'classes:list → classes:get { ref } → classes:validate or the P-017 provider picker.',
    seeAlso: ['classes:list', 'classes:validate'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      ref: z.string().min(3).max(220).optional().describe('Exact class ref, e.g. crm.email@1.0.0.'),
      refs: z.array(z.string().min(3).max(220)).min(1).max(100).optional(),
    })
    .refine((args) => Boolean(args.ref) || Boolean(args.refs?.length), { message: 'pass ref or refs' }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? '';
    const refs = mergeIds(args.ref, args.refs);
    const env = await runBulk(
      refs,
      async (ref) => {
        const parsed = parseCapabilityClassRef(ref);
        if (!parsed) return { ok: false as const, ref, error: 'invalid_ref' };
        const capabilityClass = workspaceId
          ? await getCapabilityClass(getOrgPg().sql, workspaceId, parsed.id, parsed.version)
          : null;
        if (!capabilityClass) return { ok: false as const, ref, error: 'not_found' };
        const providers = await listProviderBindings(
          getOrgPg().sql,
          workspaceId,
          capabilityClass.id,
          capabilityClass.version,
        );
        return { ok: true as const, ref: capabilityClass.ref, capabilityClass, providers };
      },
      { keyOf: (ref) => ({ ref }) },
    );
    return bulkContent(env);
  },
});

export default getCapabilityClassesTool;

