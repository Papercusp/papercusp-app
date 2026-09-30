/**
 * operator:dedup_check — fuzzy-similarity check for a candidate title
 * against a recent-cards list. Returns the best match (matchedId,
 * similarity) above the project's similarity threshold, or null when
 * the candidate is sufficiently distinct.
 *
 * Useful for agents about to emit a suggestion / card — call this
 * with the candidate title + currently-visible card titles, skip the
 * emit when a fuzzy duplicate exists.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { findFuzzyDuplicate, FUZZY_THRESHOLD } from '../../operator-fuzzy-dedup';

export default defineTool({
  name: 'operator:dedup_check',
  profile: 'engineer',
  description: 'Check if a candidate title fuzzy-matches any card in `existing` above the threshold. Returns { match, threshold }.',
  capability: 'operator:read',
  guidance: {
    when: `Check whether a suggestion / scan candidate duplicates a recent one before committing it to the panel.`,
    notWhen: `For listing existing scan findings, use \`improvements:digest\`.`,
    seeAlso: [
      'improvements:digest (list existing scan findings)',
      'operator:trigger_state (scan trigger state)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    candidate: z.string().min(1),
    existing: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })),
  }),
  async handler(args) {
    const match = findFuzzyDuplicate(args.candidate, args.existing);
    return { data: { match, threshold: FUZZY_THRESHOLD } };
  },
});
