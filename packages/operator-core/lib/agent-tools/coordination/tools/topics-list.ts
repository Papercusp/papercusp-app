/**
 * topics:list — read the topic taxonomy + your own topic subscriptions.
 *
 * D-004: agents read the full list once at prompt start, prefer existing topics
 * over creating new ones, and follow the built-in `new_topic` to learn of new
 * topics as they appear. This is the read surface for that.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { listTopics, listMyTopicSubscriptions } from '../topics';

export default defineTool({
  name: 'topics:list',
  description:
    'List coordination topics (tag + one-sentence description) and your own active topic subscriptions. A topic = a relevance area you can follow to have its updates injected into your context.',
  guidance: {
    when: 'At the start of work, to see the shared topic taxonomy before tagging/subscribing — and to prefer an existing topic over creating a near-duplicate (D-004).',
    notWhen: 'You want the messages already waiting for you — that is coord:inbox, not this.',
    chaining: 'topics:list → watch:create { pattern: topic, targetKind:"topic", wake:false } (follow a relevant area) or topics:create (only if nothing fits).',
    seeAlso: [
      'watch:create { targetKind:"topic", wake:false } (follow a relevant area)',
      'topics:feed { topic } (read a topic\'s activity)',
      'topics:create (only if nothing fits)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    includeMerged: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [topics, subscriptions] = await Promise.all([
      listTopics({ includeMerged: args.includeMerged }),
      listMyTopicSubscriptions(identity),
    ]);
    const subscribed = new Set(subscriptions.map((s) => s.target_ref));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            topics: topics.map((t) => ({
              slug: t.slug,
              title: t.title,
              description: t.description,
              subscribed: subscribed.has(t.slug),
              merged_into: t.merged_into,
            })),
            my_subscriptions: subscriptions.map((s) => ({ topic: s.target_ref, mode: s.delivery_mode, expires_ts: s.expires_ts })),
          }),
        },
      ],
    };
  },
});
