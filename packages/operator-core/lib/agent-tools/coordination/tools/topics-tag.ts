/**
 * topics:tag — tag any coordination object (issue/conversation/feature/plan) with
 * a topic, so it joins that topic's cross-object feed and routes to the topic's
 * subscribers (integration-adoption-2026-06-03, Capstone P1). The generic tagger;
 * issues:tag is the issue-specific shortcut.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): tag ONE inline
 * ({ object_kind, object_ref, topic, remove? }) or MANY heterogeneous
 * (items:[{ object_kind, object_ref, topic, remove? }]) →
 * { ok, results:[{ ok, topic, object, topics? | error }], counts }. Each result
 * self-describes its topic + tagged object; one failure never fails the rest;
 * correlate by topic (not array position). The rationale-reproject reaction fires
 * for a single-object call (it reads the top-level object_kind/object_ref).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { tagObject, untagObject, listObjectTags } from '../../../topics-feed';
import { runBulk, bulkContent } from '../../_bulk';

const OBJECT_KIND = z.enum(['issue', 'conversation', 'feature', 'plan']);
const itemSpec = z.object({
  object_kind: OBJECT_KIND,
  object_ref: z.string().min(1).describe('the object id — issue EI-<n>, feature F-<n>, plan slug, conversation id'),
  topic: z.string().min(1),
  remove: z.boolean().optional().describe('untag instead of tag'),
});

export default defineTool({
  name: 'topics:tag',
  description:
    "Tag one OR many coordination objects (issue / conversation / feature / plan) with a topic so each appears in that topic's feed and its changes reach the topic's subscribers. Pass remove:true to untag. Single: { object_kind, object_ref, topic, remove? }. Many heterogeneous: items:[{ object_kind, object_ref, topic, remove? }]. Returns { ok, results:[{ ok, topic, object, topics? | error }], counts } — correlate by topic (not position); one failure never fails the rest.",
  guidance: {
    when: 'You want a feature/plan/issue/conversation to be visible to everyone following a relevance area — tag it with the topic. Tag several at once via items:[…].',
    notWhen: "The topic does not exist yet — topics:create it first (prefer an existing one). For an issue you can also use work_items:tag.",
    chaining: 'topics:list → topics:tag { object_kind, object_ref, topic } → topics:feed { topic }.',
    seeAlso: [
      'topics:feed (see the topic\'s tagged objects)',
      'topics:list (find the right topic to tag with)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      object_kind: OBJECT_KIND.optional().describe('single-tag shorthand: the object kind'),
      object_ref: z.string().min(1).optional().describe('single-tag shorthand: the object id — issue EI-<n>, feature F-<n>, plan slug, conversation id'),
      topic: z.string().min(1).optional().describe('single-tag shorthand: the topic slug'),
      remove: z.boolean().optional().describe('untag instead of tag (single-tag shorthand)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('tag many objects at once — each { object_kind, object_ref, topic, remove? }'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (Boolean(a.object_kind) && Boolean(a.object_ref) && Boolean(a.topic)),
      { message: 'pass { object_kind, object_ref, topic } for one, or items:[{ object_kind, object_ref, topic }] for many' },
    ),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : [{ object_kind: args.object_kind!, object_ref: args.object_ref as string, topic: args.topic as string, remove: args.remove }];
    const env = await runBulk(
      list,
      async (it) => {
        if (it.remove) await untagObject(it.object_kind, it.object_ref, it.topic);
        else await tagObject(it.object_kind, it.object_ref, it.topic, id.ownerId);
        const topics = await listObjectTags(it.object_kind, it.object_ref);
        return { ok: true as const, topic: it.topic, object: { kind: it.object_kind, ref: it.object_ref }, topics };
      },
      { keyOf: (it) => ({ topic: it.topic, object: { kind: it.object_kind, ref: it.object_ref } }) },
    );
    return bulkContent(env);
  },
});
