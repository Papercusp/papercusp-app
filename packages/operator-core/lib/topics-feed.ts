/**
 * topics-feed.ts — cross-object topic tagging + the "everything about topic X"
 * index (integration-adoption-2026-06-03, Capstone P1).
 *
 * A topic tag is a coord_links edge object→topic (rel='tagged', via the substrate
 * PgTaggableStore). Tagging an object routes its changes to the topic's subscribers
 * (the fan-out resolves direct ∪ topic subscribers — su-30a41's substrate). The
 * feed resolves every object tagged a topic — across issues / conversations /
 * features / plans — and enriches each with a title + state from its own table.
 * This is the cross-object work-stream a topic subscriber follows (substrate D-001).
 *
 * features + plans already fan out (su-30a41 seeded registerSubscribableTable for
 * harness_features_consolidated + harness_plans); tagging them here is what makes
 * them reachable BY TOPIC.
 */
import { getOrgPg } from '@papercusp/db-org';
import { PgTaggableStore, type ObjectRef } from '@papercusp/coordination/capabilities';
import { coordScopeWorkspace } from './agent-tools/coordination/log';

export const TAGGABLE_KINDS = ['issue', 'conversation', 'feature', 'plan'] as const;
export type TaggableKind = (typeof TAGGABLE_KINDS)[number];

/**
 * ⚠ THE WORKSPACE SEAM MUST BE DYNAMIC — a static `workspaceId` here reads a
 * different tenant than the one the tag WRITERS use, and fails silently.
 *
 * This module used to pass `workspaceId: DEFAULT_COORD_WORKSPACE` (= the literal
 * `'default'`). Every producer of these edges had already moved to the live coord
 * scope — `work-items.ts` (`getWorkspaceId: () => activeWorkspaceId()`) and
 * `issues-engineer.ts` (`getWorkspaceId: () => coordScopeWorkspace()`, whose own
 * comment records the `'default'` residue as legacy: EI-2760 / WI-4308) — but this
 * READER was left behind by that cutover, so it resolved `'default'` forever.
 *
 * Measured on the live box 2026-09-05 (`coord_links` where rel='tagged',
 * dst_kind='topic'), that split the table almost perfectly in half by correctness:
 *
 *   workspace_id='papercusp-workspace'   159,351 edges   newest: minutes old
 *   workspace_id='default'                 1,487 edges   newest: 2026-08-22
 *
 * So `topicFeed()` — and therefore `topics:feed { topic }`, `topics:feed
 * { coupled: true }` via `coupledTopicSourcesFor().feedForTopic`, and the
 * `topics:tag` read/write helpers below — were addressing 0.92% of the data and
 * nothing written in the last two weeks. The failure mode is an EMPTY FEED, which
 * is indistinguishable from "this topic has nothing tagged", which is why it went
 * unnoticed long enough for the surface to look dead (EI-20212219297008492).
 *
 * `coordScopeWorkspace()` is the same flag-aware seam `issues-engineer.ts` uses,
 * so reader and writer now resolve the same tenant by construction. Note that
 * `coupled-topic-sources.ts` already scoped its OWN query correctly
 * (`fetchItemTopics` fences on `coordWorkspaceId()`) while delegating
 * `feedForTopic` here — the two halves of one read disagreed.
 */
const coordOpts = {
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  getWorkspaceId: () => coordScopeWorkspace(),
};
const tags = new PgTaggableStore(coordOpts);

const nowIso = (): string => new Date().toISOString();

export async function tagObject(kind: TaggableKind, ref: string, topic: string, by?: string): Promise<void> {
  await tags.addTag({ kind, ref }, topic, { created_by: by, created_ts: nowIso() });
}
export async function untagObject(kind: TaggableKind, ref: string, topic: string): Promise<void> {
  await tags.removeTag({ kind, ref }, topic);
}
export async function listObjectTags(kind: TaggableKind, ref: string): Promise<string[]> {
  return tags.listTags({ kind, ref });
}

export interface TopicFeedItem {
  kind: string;
  ref: string;
  title: string | null;
  state: string | null;
}

/** Everything tagged `topic`, across kinds, each enriched with title + state. */
export async function topicFeed(topic: string): Promise<TopicFeedItem[]> {
  const tagged = await tags.listTagged(topic);
  const out: TopicFeedItem[] = [];
  for (const o of tagged) out.push(await enrich(o));
  return out;
}

/** Best-effort title/state lookup per object kind; any read error degrades to nulls. */
async function enrich(o: ObjectRef): Promise<TopicFeedItem> {
  const { sql } = getOrgPg();
  const base: TopicFeedItem = { kind: o.kind, ref: o.ref, title: null, state: null };
  try {
    if (o.kind === 'issue') {
      const r = await sql<{ title: string; state: string }[]>`
        SELECT title, state FROM harness_shared.engineer_issues WHERE issue_id = ${o.ref} LIMIT 1`;
      return r[0] ? { ...base, title: r[0].title, state: r[0].state } : base;
    }
    if (o.kind === 'feature') {
      const r = await sql<{ title: string | null; status: string }[]>`
        SELECT title, status FROM harness_shared.harness_features_consolidated WHERE feature_id = ${o.ref} LIMIT 1`;
      return r[0] ? { ...base, title: r[0].title, state: r[0].status } : base;
    }
    if (o.kind === 'plan') {
      const r = await sql<{ title: string | null; status: string | null }[]>`
        SELECT title, status FROM harness_shared.harness_plans WHERE plan_slug = ${o.ref} LIMIT 1`;
      return r[0] ? { ...base, title: r[0].title, state: r[0].status } : base;
    }
    if (o.kind === 'conversation') {
      const r = await sql<{ title: string | null; state: string }[]>`
        SELECT title, state FROM harness_shared.coord_conversations WHERE id = ${o.ref} LIMIT 1`;
      return r[0] ? { ...base, title: r[0].title, state: r[0].state } : base;
    }
    return base;
  } catch {
    return base;
  }
}
