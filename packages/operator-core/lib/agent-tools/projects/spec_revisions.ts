/**
 * projects:spec_revisions — list spec-revision history for a project.
 *
 * Mirrors GET /:slug/projects/:id/spec/revisions. Read-only. Returns
 * up to 100 revision summaries newest-first; pass `revId` to fetch
 * one full revision body via projects:spec_revision instead.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listProjectSpecRevisions } from '../../projects-data';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'projects:spec_revisions',
  profile: 'engineer',
  guidance: {
    when: 'User asks "how has the spec changed?", "when did we update X?", or you need a list of spec revision ids before reading one.',
    notWhen: 'For ONE revision\'s body, use `projects:spec_revision`. For the current spec, use `projects:get`.',
    chaining: 'Pair with `projects:spec_revision` to read a specific revision.',
    seeAlso: [
      'projects:spec_revision (read ONE revision body)',
      'projects:get (the current spec)',
    ],
  },
  description: 'List spec-revision summaries for a project (newest-first; full spec body lives on projects:spec_revision).',
  capability: 'projects:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    projectId: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }),
  // Declarative precondition (adopt-event-rules-engines requires:-half): the
  // former in-handler `if (!slug) throw` guard, lifted.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.harnessSlug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: 'projects:spec_revisions — slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // Precondition guarantees a slug arrived, but the operator `'*'` auto-default
    // is truthy and slips past it — route through the fail-loud resolver so `'*'`
    // is rejected, not read as a bogus `'*'` harness schema (P-004).
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx);
    if (!slug) {
      return harnessRequiredResult('projects:spec_revisions');
    }
    const revisions = await listProjectSpecRevisions(slug, args.projectId, args.limit);
    return {
      content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, projectId: args.projectId, revisions }) }],
    };
  },
});
