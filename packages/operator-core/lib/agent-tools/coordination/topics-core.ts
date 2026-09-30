/**
 * topics-core.ts — the topic workflow logic, pure over injected capability
 * stores + an inject sink, so it is unit-testable with in-memory doubles. The
 * PG-wired surface (topics.ts) binds these to getOrgPg + coordLog for the tools.
 *
 * The one non-trivial piece is the built-in `new_topic` (D-004): the topic
 * taxonomy is a live shared artifact, so creating a NEW topic injects a notice
 * to everyone subscribed to `new_topic`. Reuses the shared subscribe→inject
 * delivery primitive (fanout-delivery.ts).
 */

import type {
  SubscribableStore,
  TopicRow,
  TopicStore,
} from '@papercusp/coordination/capabilities';
import { deliverInjectMany, type InjectEvent, type InjectSink } from './fanout-delivery';

/** The built-in topic every agent may follow to learn of new topics as created. */
export const NEW_TOPIC = 'new_topic';
const NEW_TOPIC_DESC =
  'Built-in topic — subscribe to be notified each time a new topic is created. The taxonomy is a live shared artifact.';

/** The self-improvement loop's capture/triage lens (papercusp-self-improvement-loop-2026-06-04, D-003). */
export const IMPROVEMENT_TOPIC = 'papercusp-improvement';

/**
 * Code-seeded built-in topics. They exist on a fresh migrate (no manual create),
 * are idempotent (prefer-existing create), and never broadcast new_topic (the
 * seed calls topics.create directly, not createTopicCore).
 */
const BUILTIN_TOPICS: ReadonlyArray<{ slug: string; title: string; description: string }> = [
  { slug: NEW_TOPIC, title: 'New topics', description: NEW_TOPIC_DESC },
  {
    slug: IMPROVEMENT_TOPIC,
    title: 'Papercusp improvement',
    description:
      'Captured papercusp DX / tooling / code improvements an agent discovered — the capture + triage lens for the self-improvement loop. File a work_item (issue today) here when you hit a papercusp friction.',
  },
  {
    slug: 'coord-dx',
    title: 'Coordination DX',
    description: 'Sub-area of papercusp-improvement: friction in the coordination surfaces (coord:*, locks:*, topics, presence, inbox, handoffs).',
  },
  {
    slug: 'db-tooling',
    title: 'DB / migration tooling',
    description: 'Sub-area of papercusp-improvement: friction in DB + migration tooling (migration allocation, boot-apply, drift, jsonb footguns, schema ops).',
  },
];

export interface TopicsStores {
  topics: TopicStore;
  subscriptions: SubscribableStore;
}

/** Ensure the built-in topic rows exist (idempotent; safe to call per op). */
export async function ensureBuiltinTopics(stores: TopicsStores, nowIso: string): Promise<void> {
  for (const t of BUILTIN_TOPICS) {
    await stores.topics.create({
      slug: t.slug,
      title: t.title,
      description: t.description,
      created_by: 'system',
      created_ts: nowIso,
    });
  }
}

export interface CreateTopicArgs {
  slug: string;
  title?: string;
  description: string;
  created_by: string;
  nowIso: string;
}

export interface CreateTopicResult {
  topic: TopicRow;
  /** True if this call created the topic (vs it already existing). */
  created: boolean;
  /** new_topic subscribers notified. */
  notified: number;
}

/**
 * Create a topic (prefer-existing — re-create is a no-op, D-004) and, when it is
 * genuinely new, inject a notice to new_topic subscribers. The creator is not
 * self-notified.
 */
export async function createTopicCore(
  stores: TopicsStores,
  sink: InjectSink,
  args: CreateTopicArgs,
): Promise<CreateTopicResult> {
  await ensureBuiltinTopics(stores, args.nowIso);
  const existing = await stores.topics.get(args.slug);
  const topic = await stores.topics.create({
    slug: args.slug,
    title: args.title,
    description: args.description,
    created_by: args.created_by,
    created_ts: args.nowIso,
  });
  // No new_topic broadcast for a re-create or for the built-in itself.
  if (existing || args.slug === NEW_TOPIC) return { topic, created: false, notified: 0 };

  const subs = await stores.subscriptions.listTargetSubscribers('topic', NEW_TOPIC);
  const resolved = subs
    .filter((s) => s.subscriber_id !== args.created_by)
    .map((s) => ({ subscriber_id: s.subscriber_id, delivery_mode: s.delivery_mode, via: NEW_TOPIC }));
  const ev: InjectEvent = {
    from: args.created_by,
    subject: `topic:${args.slug}`,
    summary: `new topic “${args.slug}” — ${args.description}`,
    notify_kind: 'topic_created',
    extra: { topic: args.slug },
  };
  const notified = await deliverInjectMany(resolved, ev, sink);
  return { topic, created: true, notified };
}

export interface MergeTopicsResult {
  /** Subscribers re-pointed from the merged slug to its target. */
  moved: number;
}

/**
 * Merge `from` → `into` (topics:merge, D-004's cheap dedup). Aliases the topic
 * (so a tag with the old slug resolves to the new one) AND re-points the merged
 * slug's subscribers onto the target so they keep receiving its updates.
 */
export async function mergeTopicsCore(
  stores: TopicsStores,
  args: { from: string; into: string; nowIso: string },
): Promise<MergeTopicsResult> {
  if (args.from === args.into) return { moved: 0 };
  await stores.topics.merge(args.from, args.into);
  // Re-point onto the CANONICAL head, not `into` verbatim: if `into` was itself
  // already merged (into c), parking subscribers on the dead middle slug would
  // strand them — list() excludes it and the fan-out keys delivery on the
  // resolved tag slug (resolveObjectSubscribers), never on a raw target_ref, so
  // they'd silently lose the feed. resolve() follows the chain to the live slug.
  // (A self-pointing chain — e.g. into===from after a cycle — resolves back to
  // `from`; the from===canonical guard then skips the no-op re-subscribe so we
  // don't unsubscribe-then-orphan the very subscribers we just moved.)
  const canonical = await stores.topics.resolve(args.into);
  if (canonical === args.from) return { moved: 0 };
  const subs = await stores.subscriptions.listTargetSubscribers('topic', args.from);
  let moved = 0;
  for (const s of subs) {
    await stores.subscriptions.subscribe({
      subscriber_id: s.subscriber_id,
      target_kind: 'topic',
      target_ref: canonical,
      delivery_mode: s.delivery_mode,
      created_ts: args.nowIso,
    });
    await stores.subscriptions.unsubscribe(s.subscriber_id, 'topic', args.from);
    moved += 1;
  }
  return { moved };
}
