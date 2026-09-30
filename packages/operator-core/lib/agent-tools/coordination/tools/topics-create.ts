/**
 * topics:create — add a topic to the shared taxonomy (tag + one sentence).
 *
 * D-004: prefer-existing, no creation-time gate — Opus-4.8 agents reading the
 * list first suffices. Creating a genuinely-new topic injects a notice to every
 * `new_topic` subscriber, so the taxonomy stays a live shared artifact. Re-create
 * of an existing slug is a no-op (returns the existing topic).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { createTopic } from '../topics';
import { hardText, LIMITS } from '../../limits';

export default defineTool({
  name: 'topics:create',
  description:
    'Create a coordination topic: a short slug + one-sentence description. Prefer an existing topic (topics:list) over a near-duplicate. Notifies new_topic subscribers; re-creating an existing slug is a no-op.',
  guidance: {
    when: 'No existing topic fits a relevance area you (and likely others) will want to follow. Keep the slug to a word or two; the description to one sentence.',
    notWhen: 'A close-enough topic already exists in topics:list — subscribe/tag to that instead. Near-duplicates get merged with topics:merge.',
    seeAlso: [
      'topics:list (a close-enough topic may already exist)',
      'watch:create { targetKind:"topic", wake:false } (follow the new topic)',
      'topics:merge (fold a near-duplicate into an existing topic)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, 'slug: lowercase letters/digits/_/- , ≤41 chars, e.g. "federation"'),
    title: hardText(LIMITS.SHORT_TITLE).optional(),
    description: hardText(LIMITS.ANNOTATION),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const res = await createTopic(identity, { slug: args.slug, title: args.title, description: args.description });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            topic: { slug: res.topic.slug, title: res.topic.title, description: res.topic.description },
            created: res.created,
            new_topic_subscribers_notified: res.notified,
          }),
        },
      ],
    };
  },
});
