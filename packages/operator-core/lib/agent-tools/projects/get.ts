/**
 * projects:get — fetch a single project's detail (spec + counts +
 * last spec revision metadata).
 *
 * Mirrors GET /:slug/projects/:id under the Hono harness mount.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getProjectDetail } from '../../projects-data';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'projects:get',
  profile: 'engineer',
  guidance: {
    when: 'User names a specific project and wants its full record (spec, status, metadata).',
    notWhen: 'For SPEC revisions / history, use `projects:spec_revisions`. For the runtime harness state, use `harness:get`.',
    chaining: 'Follow `projects:list` for the slug.',
    seeAlso: [
      'projects:list (find the slug)',
      'projects:spec_revisions (spec change history)',
      'harness:get (the runtime harness state)',
    ],
  },
  description: 'Fetch a single project detail (spec, feature counts, last spec revision summary). Returns null when not found.',
  capability: 'projects:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    id: z.string().min(1),
  }),
  async handler(args, ctx) {
    // Route through the fail-loud resolver so a bare/operator `'*'` ctx (or no
    // slug) is rejected, not read as a bogus `'*'` harness schema (P-004).
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx);
    if (!slug) {
      return harnessRequiredResult('projects:get');
    }
    const project = await getProjectDetail(slug, args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, id: args.id, found: project !== null, project }) }],
    };
  },
});
