/**
 * datatypes:summary — workspace observability over the datatype registry
 * (reflexive-platform-extensibility-datatypes-2026-06-24 P-011).
 *
 * The at-a-glance view: how many datatypes this workspace has, broken down by TIER
 * (generic-kind / first-class / projection) and by global REVIEW-STATUS
 * (none / pending / approved / rejected), plus how many are published. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { datatypesSummary } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:summary',
  description:
    'Workspace observability over the datatype registry (P-011): active datatypes counted by TIER ' +
    '(generic-kind / first-class / projection) and by global REVIEW-STATUS (none / pending / approved / rejected), ' +
    'plus how many are published. Read-only — the at-a-glance "what datatypes does this workspace have".',
  guidance: {
    when: 'For a dashboard / status read of a workspace\'s datatype surface and its local→shared graduation.',
    notWhen: 'To list the datatypes themselves (datatypes:list) or fetch one (datatypes:get).',
    chaining: 'datatypes:summary (overview) → datatypes:list (the rows) → datatypes:get (one definition).',
    seeAlso: [
      'datatypes:list (the rows behind the summary)',
      'datatypes:get (one datatype in detail)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const reply = (obj: unknown) => ({ data: obj });
    const sql = getOrgPg().sql;
    const summary = await datatypesSummary(sql, ctx.workspaceId ?? '');
    return reply({ ok: true, ...summary });
  },
});
