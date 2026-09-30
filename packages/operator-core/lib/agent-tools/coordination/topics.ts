/**
 * topics.ts — the PG-wired topics surface the topics:* tools call. Constructs
 * the capability stores over the org embedded-pg handle (mirroring
 * subscriptions.ts), and binds the pure topics-core workflow to coordLog +
 * getOrgPg. Topics are workspace-local in v1 (not federated — D-009).
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTopicStore,
  type DeliveryMode,
  type SubscriptionRow,
  type TopicRow,
} from '@papercusp/coordination/capabilities';
import { coordLog, coordScopeReady, coordScopeWorkspace } from './log';
import type { AgentIdentity } from './identity';
import {
  type CreateTopicResult,
  type MergeTopicsResult,
  type TopicsStores,
  createTopicCore,
  ensureBuiltinTopics,
  mergeTopicsCore,
  NEW_TOPIC,
} from './topics-core';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migration 123; the host seam is a no-op.
  ensureSchema: async () => {},
  // Keep the registry on the same active coordination workspace as tagged
  // edges. A construction-time `workspaceId` would strand topics in `default`
  // after the per-workspace cutover.
  getWorkspaceId: () => coordScopeWorkspace(),
};
const topicStore = new PgTopicStore(storeOpts);
const subStore = new PgEntitySubscriptionStore(storeOpts);
const stores: TopicsStores = { topics: topicStore, subscriptions: subStore };

export { NEW_TOPIC };

function nowIso(): string {
  return new Date().toISOString();
}

const DERIVED_TOPIC_TITLE = 'Live tagged topic';
const DERIVED_TOPIC_DESCRIPTION =
  'Auto-discovered from live tagged coordination content; use topics:create to curate its title and description.';

interface TaggedTopicRow {
  slug: string;
  created_at: unknown;
}

function taggedTopicCreatedTs(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  // `created_at` is NOT NULL in coord_links. Keep the projection total if a
  // test double or a future backend violates that contract.
  return nowIso();
}

/**
 * Topic tags are written as coord_links edges by work-item/issue creation,
 * while coord_topics is a curated registry written only by topics:create.
 * Include the live edge vocabulary so topics:list can actually discover feeds
 * whose tags have never received a registry row.
 */
async function listLiveTaggedTopics(includeMerged = false): Promise<TopicRow[]> {
  const sql = getOrgPg().sql;
  const rows = await sql<TaggedTopicRow[]>`
    SELECT cl.dst_ref AS slug, MIN(cl.created_at) AS created_at
      FROM harness_shared.coord_links cl
      LEFT JOIN harness_shared.coord_topics t
        ON t.workspace_id = cl.workspace_id AND t.slug = cl.dst_ref
     WHERE cl.workspace_id = ${coordScopeWorkspace()}
       AND cl.dst_kind = 'topic'
       AND cl.rel = 'tagged'
       AND ${includeMerged ? sql`TRUE` : sql`t.merged_into IS NULL`}
     GROUP BY cl.dst_ref
     ORDER BY MIN(cl.created_at) ASC, cl.dst_ref ASC`;

  return rows.map((row) => ({
    slug: row.slug,
    title: DERIVED_TOPIC_TITLE,
    description: DERIVED_TOPIC_DESCRIPTION,
    created_by: null,
    merged_into: null,
    created_ts: taggedTopicCreatedTs(row.created_at),
  }));
}

export async function listTopics(opts: { includeMerged?: boolean } = {}): Promise<TopicRow[]> {
  // coordScopeWorkspace() is synchronous by contract, but this targeted query
  // must wait for the flag-backed scope to resolve before reading either table.
  await coordScopeReady();
  await ensureBuiltinTopics(stores, nowIso());
  const [registered, tagged] = await Promise.all([topicStore.list(opts), listLiveTaggedTopics(opts.includeMerged)]);
  const bySlug = new Map(registered.map((topic) => [topic.slug, topic]));
  for (const topic of tagged) {
    // Registered metadata wins over the derived fallback, including for
    // includeMerged=true rows.
    if (!bySlug.has(topic.slug)) bySlug.set(topic.slug, topic);
  }
  return [...bySlug.values()].sort(
    (a, b) => a.created_ts.localeCompare(b.created_ts) || a.slug.localeCompare(b.slug),
  );
}

export async function createTopic(
  identity: AgentIdentity,
  input: { slug: string; title?: string; description: string },
): Promise<CreateTopicResult> {
  return createTopicCore(stores, coordLog, {
    slug: input.slug,
    title: input.title,
    description: input.description,
    created_by: identity.ownerId,
    nowIso: nowIso(),
  });
}

export async function subscribeTopic(
  identity: AgentIdentity,
  slug: string,
  opts: { mode?: DeliveryMode; ttl_sec?: number } = {},
): Promise<SubscriptionRow> {
  await ensureBuiltinTopics(stores, nowIso());
  const expires_ts = opts.ttl_sec != null ? new Date(Date.now() + opts.ttl_sec * 1000).toISOString() : null;
  return subStore.subscribe({
    subscriber_id: identity.ownerId,
    target_kind: 'topic',
    target_ref: slug,
    delivery_mode: opts.mode ?? 'full',
    created_ts: nowIso(),
    expires_ts,
  });
}

export async function unsubscribeTopic(identity: AgentIdentity, slug: string): Promise<void> {
  await subStore.unsubscribe(identity.ownerId, 'topic', slug);
}

export async function mergeTopics(
  _identity: AgentIdentity,
  from: string,
  into: string,
): Promise<MergeTopicsResult> {
  return mergeTopicsCore(stores, { from, into, nowIso: nowIso() });
}

/** A subscriber's own active topic subscriptions (for topics:list rendering). */
export async function listMyTopicSubscriptions(identity: AgentIdentity): Promise<SubscriptionRow[]> {
  const all = await subStore.listSubscriptions(identity.ownerId);
  return all.filter((s) => s.target_kind === 'topic');
}
