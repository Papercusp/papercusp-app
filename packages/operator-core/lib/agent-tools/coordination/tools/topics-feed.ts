/**
 * topics:feed — read everything tagged a topic, across issues / conversations /
 * features / plans: the whole work-stream of an area (integration-adoption-
 * 2026-06-03, Capstone P1; substrate D-001 cross-object index).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): read ONE inline
 * ({ topic }) or MANY (topics:[…] / items:[{ topic }]) →
 * { ok, results:[{ ok, topic, count, items | error }], counts }. Each result
 * self-describes its topic and carries that topic's own feed; one topic that
 * fails to read never fails the rest; correlate by topic, not array position.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { topicFeed } from '../../../topics-feed';
import { readCoupledTopics } from '../coupled-topics-read';
import { censusObserverFor } from '../../../coord/derived-signal-census';
import { mergeIds, runBulk, bulkContent } from '../../_bulk';

export default defineTool({
  name: 'topics:feed',
  description:
    'Read everything tagged with one OR many topics — across issues, conversations, features, and plans — the whole work-stream of an area. Each item carries its title + current state. Single: { topic }. Many: { topics:[…] } or items:[{ topic }]. Or { coupled: true } to DERIVE the topics from your coupling graph — what the peers you are coupled to are working on — when you do not know which topics to name. Returns { ok, results:[{ ok, topic, count, items | error }], counts } — correlate by topic, not position; a topic that fails to read never fails the rest.',
  guidance: {
    when: 'To understand all current work in a relevance area before you start in it, or to see what is happening with e.g. `zero-cache` across every object kind. Read several areas at once via topics:[…]. Use { coupled: true } when you do NOT yet know which topics matter to you: it derives them at read-time from your coupled peers\' held work (each result carries `because`), writes nothing, and narrows by itself as coupling decays.',
    notWhen: 'You want messages waiting for you (coord:inbox) or just the list of topics (topics:list).',
    chaining: 'topics:list → topics:feed { topic } → work_items:get / conversations:get on an item.',
    seeAlso: [
      'topics:list (browse topics first)',
      'work_items:get (drill into an item from the feed)',
      'conversations:get (drill into a conversation from the feed)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      topic: z.string().min(1).optional().describe('single-read shorthand: the topic slug'),
      topics: z.array(z.string().min(1)).min(1).max(100).optional().describe('read MANY topic feeds at once (homogeneous)'),
      items: z
        .array(z.object({ topic: z.string().min(1) }))
        .min(1)
        .max(100)
        .optional()
        .describe('read many topic feeds at once — each { topic }'),
      coupled: z
        .boolean()
        .optional()
        .describe(
          'derive the topics from YOUR coupled peers instead of naming them: what the agents you are coupled to are working on, by topic',
        ),
    })
    .refine(
      (a) =>
        a.coupled === true ||
        (a.items?.length ?? 0) > 0 ||
        (a.topics?.length ?? 0) > 0 ||
        Boolean(a.topic),
      {
        message:
          'pass { topic } for one, { topics:[…] } / items:[{ topic }] for many, or { coupled: true } to derive them from your coupling graph',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    // P-023: the DERIVED mode — no topic slug, because the point is that you do
    // not yet know which topics are live for you. Computed at READ from the
    // coupling union, writing zero subscription rows, so it narrows by itself as
    // coupling decays (D-044 / D-081). A caller may combine it with explicit
    // topics; the derived ones are simply merged in.
    let derivedTopics: string[] = [];
    let derivedBecause: Record<string, string> = {};
    if (args.coupled === true) {
      // P-009: wire the dead-signal census onto a path that ACTUALLY RUNS. The
      // sink lived only on `coord:presence` (11 calls ever), which is why zero
      // rows in `tool_invocations` had ever carried `metadata_json.derivedSignals`
      // — the instrument built to answer "has this relation fired in production?"
      // was attached to the one surface that never runs. `censusObserverFor`
      // returns undefined when the ctx has no metadata channel, so this degrades
      // to today's behaviour rather than throwing.
      const observeCensus = censusObserverFor(ctx);
      const derived = await readCoupledTopics(
        typeof identity?.ownerId === 'string' ? identity.ownerId : '',
        { workspaceId: ctx?.workspaceId ?? null, harnessSlug: ctx?.harnessSlug ?? null },
        { withFeed: false, ...(observeCensus ? { observe: observeCensus } : {}) },
      );
      derivedTopics = derived.map((d) => d.topic);
      derivedBecause = Object.fromEntries(derived.map((d) => [d.topic, d.because]));
    }

    const topics = mergeIds(args.topic, [
      ...derivedTopics,
      ...(args.topics ?? []),
      ...(args.items?.map((it) => it.topic) ?? []),
    ]);
    const env = await runBulk(
      topics,
      async (topic) => {
        const items = await topicFeed(topic);
        const because = derivedBecause[topic];
        // `because` is present only on a DERIVED topic — it is what tells the
        // reader why a topic it never named is in front of it.
        return { ok: true as const, topic, count: items.length, items, ...(because ? { because } : {}) };
      },
      { keyOf: (topic) => ({ topic }) },
    );
    return bulkContent(env);
  },
});
