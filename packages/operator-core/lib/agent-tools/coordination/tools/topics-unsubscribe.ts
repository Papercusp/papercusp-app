/**
 * topics:unsubscribe — stop following a topic (soft-cancel; idempotent).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): unsubscribe from
 * ONE inline ({ topic }) or MANY (topics:[…] / items:[{ topic }]) →
 * { ok, results:[{ ok, topic, error? }], counts }. Each result self-describes its
 * topic; one failure never fails the rest; correlate by topic, not position.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { unsubscribeTopic } from '../topics';
import { mergeIds, runBulk, bulkContent } from '../../_bulk';

export default defineTool({
  name: 'topics:unsubscribe',
  description:
    'Unsubscribe from one OR many topics. Idempotent — unsubscribing from a topic you do not follow is a no-op. Single: { topic }. Many: { topics:[…] } or items:[{ topic }]. Returns { ok, results:[{ ok, topic, error? }], counts } — correlate by topic, not position; one failure never fails the rest.',
  guidance: {
    when: 'A topic you followed is no longer relevant and its updates are noise. Drop several at once via topics:[…].',
    notWhen: 'You want to mute briefly — re-register at mention mode via watch:create { pattern: topic, targetKind:"topic", wake:false, mode:"mention" } instead of dropping it.',
    seeAlso: [
      'watch:create { targetKind:"topic", wake:false } (follow a topic / change its mode)',
      'topics:list (your current subscriptions)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      topic: z.string().min(1).optional().describe('single-unsubscribe shorthand: the topic slug'),
      topics: z.array(z.string().min(1)).min(1).max(200).optional().describe('unsubscribe from MANY topics (homogeneous)'),
      items: z
        .array(z.object({ topic: z.string().min(1) }))
        .min(1)
        .max(200)
        .optional()
        .describe('unsubscribe from many topics at once — each { topic }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.topics?.length ?? 0) > 0 || Boolean(a.topic), {
      message: 'pass { topic } for one, or { topics:[…] } / items:[{ topic }] for many',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const topics = mergeIds(args.topic, [
      ...(args.topics ?? []),
      ...(args.items?.map((it) => it.topic) ?? []),
    ]);
    const env = await runBulk(
      topics,
      async (topic) => {
        await unsubscribeTopic(identity, topic);
        return { ok: true as const, topic };
      },
      { keyOf: (topic) => ({ topic }) },
    );
    return bulkContent(env);
  },
});
