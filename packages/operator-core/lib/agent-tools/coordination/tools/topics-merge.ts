/**
 * topics:merge — alias a near-duplicate topic into the canonical one.
 *
 * D-004's cheap dedup in place of a creation-time gate: when two agents create
 * near-duplicate topics, merge `from` → `into`. Tags on the old slug resolve to
 * the new one, and the old slug's subscribers are re-pointed onto the target so
 * they keep receiving its updates.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { mergeTopics } from '../topics';

export default defineTool({
  name: 'topics:merge',
  description:
    'Merge topic `from` into `into`: aliases the slug (tags resolve to the target) and re-points the merged topic’s subscribers onto the target. The dedup for accidental near-duplicate topics.',
  guidance: {
    when: 'topics:list shows two topics that mean the same thing — fold the lesser-used into the better one.',
    notWhen: 'The two topics are genuinely distinct areas — keep both.',
    seeAlso: [
      'topics:list (review both topics before merging)',
      'topics:tag (retag objects instead of merging topics)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    from: z.string().min(1),
    into: z.string().min(1),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const res = await mergeTopics(identity, args.from, args.into);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, from: args.from, into: args.into, subscribers_moved: res.moved }),
        },
      ],
    };
  },
});
