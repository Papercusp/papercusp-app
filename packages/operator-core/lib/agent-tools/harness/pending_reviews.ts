/**
 * harness:pending_reviews — list unresolved pending reviews for a
 * harness + phase.
 *
 * Calls listPendingReviews() in lib/harness-readers.ts directly — same
 * function the GET /api/harness/:slug/reviews route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { phasePhaseLabel } from '../../harness-phases';
import { listPendingReviews } from '../../harness-readers';

export default defineTool({
  name: 'harness:pending_reviews',
  profile: 'engineer',
  description: 'List unresolved pending-review entries for a harness slug (optionally per phase).',
  guidance: {
    when: 'User asks "anything pending review?", "what needs my approval?". The dedicated tool for plan-review state.',
    notWhen: 'For open ISSUES (problems, bugs), use `work_items:list`. For all pending hook events, use `pending_events:list`.',
    seeAlso: [
      'work_items:list (open issues — problems / bugs)',
      'pending_events:list (all pending hook events)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1),
    phase: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const result = await listPendingReviews(args.slug, phasePhaseLabel(args.phase));
    const reviews = result.reviews.slice(0, args.limit ?? 20);
    return { data: { count: reviews.length, reviews } };
  },
});
