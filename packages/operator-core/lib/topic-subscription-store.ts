/**
 * topic-subscription-store.ts — the thin PG binding the P-008 topic matcher's
 * live leg (topic-matcher-io.ts) reads/writes topics + subscriptions through
 * (ambient-semantic-push-2026-07-14). Constructs the SAME coordination capability
 * stores over the SAME org handle + default workspace as the real topics:* tools
 * (agent-tools/coordination/topics.ts) — an auto-subscription written here is
 * indistinguishable from a topics:subscribe row, so the substrate fan-out routes
 * to it identically and topics:list shows it to the agent. Kept identity-free
 * (plain ownerId params) so lib/ code never depends on the agent-tools layer
 * (mirrors topics-feed.ts).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTopicStore,
  type DeliveryMode,
  type SubscriptionRow,
  type TopicRow,
} from '@papercusp/coordination/capabilities';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migration 123; the host seam is a no-op.
  ensureSchema: async () => {},
};
const topicStore = new PgTopicStore(storeOpts);
const subStore = new PgEntitySubscriptionStore(storeOpts);

export type { TopicRow, SubscriptionRow, DeliveryMode };

const nowIso = (): string => new Date().toISOString();

/** Live (unmerged) topics, oldest-first (the store's stable order), capped. */
export async function listLiveTopics(limit: number): Promise<TopicRow[]> {
  const all = await topicStore.list({});
  return all.slice(0, Math.max(0, limit));
}

/** The owner's ACTIVE topic subscriptions (uncancelled, unexpired) — the ground
 *  truth the matcher's carried state reconciles against every tick. */
export async function listTopicSubscriptions(ownerId: string): Promise<SubscriptionRow[]> {
  const all = await subStore.listSubscriptions(ownerId);
  return all.filter((s) => s.target_kind === 'topic');
}

/** Ensure a topic row exists (idempotent — ON CONFLICT DO NOTHING under the
 *  store, so two sides of a P-013 adjacency can race the create and the first
 *  writer wins). Returns the live row. */
export async function ensureTopicFor(input: {
  slug: string;
  title?: string;
  description: string;
  createdBy?: string | null;
}): Promise<TopicRow> {
  return topicStore.create({
    slug: input.slug,
    title: input.title,
    description: input.description,
    created_by: input.createdBy ?? undefined,
    created_ts: nowIso(),
  });
}

/** Write one topic subscription for `ownerId` (idempotent upsert — re-subscribing
 *  updates the mode, same as topics:subscribe). No TTL: the hysteresis machine's
 *  own drift/staleness exits are the lifecycle. */
export async function subscribeTopicFor(ownerId: string, slug: string, mode: DeliveryMode): Promise<void> {
  await subStore.subscribe({
    subscriber_id: ownerId,
    target_kind: 'topic',
    target_ref: slug,
    delivery_mode: mode,
    created_ts: nowIso(),
    expires_ts: null,
  });
}

/** Soft-cancel one topic subscription for `ownerId` (sets cancelled_at — the
 *  same path topics:unsubscribe takes). */
export async function unsubscribeTopicFor(ownerId: string, slug: string): Promise<void> {
  await subStore.unsubscribe(ownerId, 'topic', slug);
}
