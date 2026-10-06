/**
 * capabilities/conformance.ts — the ONE contract suite per pub/sub capability,
 * so every backend (in-memory double + live PG) proves swappability against the
 * SAME assertions, mirroring the sibling seams. Imports vitest, so it is NOT
 * re-exported from the package barrel — test code imports it from
 * `@papercusp/pubsub-substrate/capabilities/conformance`.
 *
 * Consumed by:
 *   - `capabilities.test.ts` (package): the InMemory* doubles.
 *   - the operator's live-PG integration test (via @papercusp/coordination): the
 *     Pg* stores.
 *
 * Cases mint unique ids per run (a `runPrefix`) so the suites are safe against a
 * SHARED live PG table without a cleanup hook — every query filters by an id that
 * no other run uses. Expiry uses far-past/far-future fixed timestamps so the
 * wall-clock `now()` comparison is deterministic without an injectable clock.
 *
 * The LinkableStore conformance suite lives in @papercusp/linkable-edges.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ObjectRef,
  objectToTargetRef,
  resolveObjectSubscribers,
  type SubscribableStore,
  type TaggableStore,
  type ThreadableStore,
  type TopicStore,
} from './types';

const FAR_PAST = '2000-01-01T00:00:00.000Z';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

function prefix(tag: string): { runPrefix: string; uid: () => string } {
  const runPrefix = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let n = 0;
  return { runPrefix, uid: () => `${runPrefix}-${n++}` };
}

// ── Topics ───────────────────────────────────────────────────────────────────

export function describeTopicStoreConformance(
  name: string,
  makeStore: () => TopicStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`TopicStore conformance — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('topconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('create then get returns the topic; create is idempotent on slug', async () => {
      if (skip) return;
      const store = makeStore();
      const slug = uid();
      const a = await store.create({ slug, description: 'first', created_by: 'me', created_ts: '2026-01-01T00:00:00.000Z' });
      expect(a.slug).toBe(slug);
      expect(a.description).toBe('first');
      // Second create with a different description is a no-op (returns existing).
      const b = await store.create({ slug, description: 'second', created_ts: '2026-02-01T00:00:00.000Z' });
      expect(b.description).toBe('first');
      expect((await store.get(slug))?.description).toBe('first');
    });

    it('list excludes merged topics unless includeMerged; merge + resolve follow the chain', async () => {
      if (skip) return;
      const store = makeStore();
      const a = uid();
      const b = uid();
      await store.create({ slug: a, description: 'dup', created_ts: '2026-01-01T00:00:00.000Z' });
      await store.create({ slug: b, description: 'canonical', created_ts: '2026-01-01T00:00:01.000Z' });
      await store.merge(a, b);
      const live = (await store.list()).map((t) => t.slug);
      expect(live).toContain(b);
      expect(live).not.toContain(a);
      expect((await store.list({ includeMerged: true })).map((t) => t.slug)).toEqual(expect.arrayContaining([a, b]));
      expect(await store.resolve(a)).toBe(b);
      expect(await store.resolve(b)).toBe(b);
    });

    // T1(a): a multi-hop chain resolves transitively to the live head, and EVERY
    // merged slug in the chain drops out of list() (only the canonical head is
    // live). merge() is a blind alias write — resolve() is the only thing that
    // follows the chain, so both stores must walk it identically.
    it('resolve walks a 2-hop chain to the canonical head; list excludes every merged slug', async () => {
      if (skip) return;
      const store = makeStore();
      const a = uid();
      const b = uid();
      const c = uid();
      const ts = '2026-01-01T00:00:00.000Z';
      await store.create({ slug: a, description: 'a', created_ts: ts });
      await store.create({ slug: b, description: 'b', created_ts: ts });
      await store.create({ slug: c, description: 'c', created_ts: ts });
      await store.merge(a, b); // a → b
      await store.merge(b, c); // b → c, so a → b → c
      expect(await store.resolve(a)).toBe(c);
      expect(await store.resolve(b)).toBe(c);
      expect(await store.resolve(c)).toBe(c);
      const live = (await store.list()).map((t) => t.slug);
      expect(live).toContain(c);
      expect(live).not.toContain(a);
      expect(live).not.toContain(b);
      // includeMerged surfaces the whole chain.
      expect((await store.list({ includeMerged: true })).map((t) => t.slug)).toEqual(
        expect.arrayContaining([a, b, c]),
      );
    });

    // T1(b): merge() is a blind UPDATE — it does NOT reject a cycle-creating
    // alias (merge(a,b); merge(b,a) leaves a↔b pointing at each other). resolve()
    // must still TERMINATE (its `seen` cycle-guard breaks the walk) and return a
    // DETERMINISTIC value. PINNED: the guard breaks when the walk revisits the
    // START slug, so resolve(x) returns x itself for each member of a 2-cycle.
    it('resolve terminates + is deterministic on a merge-created cycle (pinned: returns the start slug)', async () => {
      if (skip) return;
      const store = makeStore();
      const a = uid();
      const b = uid();
      const ts = '2026-01-01T00:00:00.000Z';
      await store.create({ slug: a, description: 'a', created_ts: ts });
      await store.create({ slug: b, description: 'b', created_ts: ts });
      await store.merge(a, b);
      await store.merge(b, a); // cycle: a → b → a
      // Terminates (no hang/throw) AND is deterministic: the start slug.
      expect(await store.resolve(a)).toBe(a);
      expect(await store.resolve(b)).toBe(b);
    });

    // T1(c): a chain deeper than the 16-iteration cap stops AT the cap without
    // throwing or hanging. PINNED: a 17-merge chain (t0 → … → t17) walked from t0
    // halts after 16 hops at t16 (the cap-truncated head), NOT the true terminal
    // t17. The cap is a safety bound, not a correctness guarantee for pathological
    // depths — pinned so a change to it is a conscious one.
    it('resolve stops at the 16-iteration cap on an over-deep chain without throwing (pinned: t16)', async () => {
      if (skip) return;
      const store = makeStore();
      const ts = '2026-01-01T00:00:00.000Z';
      const slugs = Array.from({ length: 18 }, () => uid()); // s0 … s17
      for (const s of slugs) await store.create({ slug: s, description: 's', created_ts: ts });
      for (let i = 0; i < 17; i++) await store.merge(slugs[i], slugs[i + 1]); // s0 → … → s17
      // 16-iter cap: from s0 we walk s0→s1→…→s16 (16 hops) then stop AT s16.
      expect(await store.resolve(slugs[0])).toBe(slugs[16]);
      // Resolving nearer the head still reaches the true terminal (within the cap).
      expect(await store.resolve(slugs[2])).toBe(slugs[17]);
    });
  });
}

// ── Subscribable ─────────────────────────────────────────────────────────────

export function describeSubscribableStoreConformance(
  name: string,
  makeStore: () => SubscribableStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`SubscribableStore conformance — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('subconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('subscribe then list by subscriber + by target', async () => {
      if (skip) return;
      const store = makeStore();
      const sub = uid();
      const topic = uid();
      await store.subscribe({ subscriber_id: sub, target_kind: 'topic', target_ref: topic, created_ts: '2026-01-01T00:00:00.000Z' });
      const bySub = await store.listSubscriptions(sub);
      expect(bySub.map((s) => s.target_ref)).toEqual([topic]);
      expect(bySub[0].delivery_mode).toBe('full');
      const byTarget = await store.listTargetSubscribers('topic', topic);
      expect(byTarget.map((s) => s.subscriber_id)).toEqual([sub]);
    });

    it('re-subscribe updates delivery_mode without duplicating (keeps the same id)', async () => {
      if (skip) return;
      const store = makeStore();
      const sub = uid();
      const topic = uid();
      const a = await store.subscribe({ subscriber_id: sub, target_kind: 'topic', target_ref: topic, delivery_mode: 'full', created_ts: '2026-01-01T00:00:00.000Z' });
      const b = await store.subscribe({ subscriber_id: sub, target_kind: 'topic', target_ref: topic, delivery_mode: 'digest', created_ts: '2026-02-01T00:00:00.000Z' });
      expect(b.id).toBe(a.id);
      const list = await store.listSubscriptions(sub);
      expect(list).toHaveLength(1);
      expect(list[0].delivery_mode).toBe('digest');
    });

    it('unsubscribe soft-cancels', async () => {
      if (skip) return;
      const store = makeStore();
      const sub = uid();
      const topic = uid();
      await store.subscribe({ subscriber_id: sub, target_kind: 'topic', target_ref: topic, created_ts: '2026-01-01T00:00:00.000Z' });
      await store.unsubscribe(sub, 'topic', topic);
      expect(await store.listSubscriptions(sub)).toEqual([]);
      expect(await store.listTargetSubscribers('topic', topic)).toEqual([]);
    });

    it('expired subscriptions are excluded; future/null expiry included; sorted by (created_ts, id)', async () => {
      if (skip) return;
      const store = makeStore();
      const topic = uid();
      const expiredSub = uid();
      const futureSub = uid();
      const neverSub = uid();
      await store.subscribe({ subscriber_id: expiredSub, target_kind: 'topic', target_ref: topic, created_ts: '2026-01-01T00:00:03.000Z', expires_ts: FAR_PAST });
      await store.subscribe({ subscriber_id: futureSub, target_kind: 'topic', target_ref: topic, created_ts: '2026-01-01T00:00:02.000Z', expires_ts: FAR_FUTURE });
      await store.subscribe({ subscriber_id: neverSub, target_kind: 'topic', target_ref: topic, created_ts: '2026-01-01T00:00:01.000Z', expires_ts: null });
      const subs = await store.listTargetSubscribers('topic', topic);
      // neverSub (00:01) before futureSub (00:02); expiredSub excluded.
      expect(subs.map((s) => s.subscriber_id)).toEqual([neverSub, futureSub]);
    });
  });
}

// ── Threadable ───────────────────────────────────────────────────────────────

export function describeThreadableStoreConformance(
  name: string,
  makeStore: () => ThreadableStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`ThreadableStore conformance — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('threadconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('getOrCreateThread is idempotent on parent; addPost bumps count + last_post; listPosts is ordered with afterId', async () => {
      if (skip) return;
      const store = makeStore();
      const parent: ObjectRef = { kind: 'issue', ref: uid() };
      const tid = uid();
      const t1 = await store.getOrCreateThread(parent, { thread_id: tid, title: 'T', created_ts: '2026-01-01T00:00:00.000Z' });
      // Second call with a different thread_id still returns the original thread.
      const t2 = await store.getOrCreateThread(parent, { thread_id: uid(), created_ts: '2026-02-01T00:00:00.000Z' });
      expect(t2.thread_id).toBe(t1.thread_id);

      const p1 = await store.addPost({ thread_id: t1.thread_id, author_id: 'a', body: 'one', created_ts: '2026-01-01T01:00:00.000Z' });
      const p2 = await store.addPost({ thread_id: t1.thread_id, author_id: 'b', body: 'two', created_ts: '2026-01-01T02:00:00.000Z' });
      expect(p2.id).toBeGreaterThan(p1.id);

      const reloaded = await store.getThreadByParent(parent);
      expect(reloaded?.post_count).toBe(2);
      expect(reloaded?.last_post_ts).toBe('2026-01-01T02:00:00.000Z');

      const all = await store.listPosts(t1.thread_id);
      expect(all.map((p) => p.body)).toEqual(['one', 'two']);
      const afterFirst = await store.listPosts(t1.thread_id, { afterId: p1.id });
      expect(afterFirst.map((p) => p.body)).toEqual(['two']);
    });

    it('reads posts by id for conversation and work-item parent threads', async () => {
      if (skip) return;
      const store = makeStore();
      const posts = await Promise.all([
        { kind: 'conversation' as const, ref: uid() },
        { kind: 'issue' as const, ref: uid() },
      ].map(async (parent) => {
        const thread = await store.getOrCreateThread(parent, {
          thread_id: uid(),
          created_ts: '2026-01-01T00:00:00.000Z',
        });
        return store.addPost({
          thread_id: thread.thread_id,
          author_id: 'reader-test',
          body: `${parent.kind} evidence`,
          created_ts: '2026-01-01T01:00:00.000Z',
        });
      }));

      for (const post of posts) {
        await expect(store.getPostById(post.id)).resolves.toEqual(post);
      }
      await expect(store.getPostById(Math.max(...posts.map((post) => post.id)) + 1)).resolves.toBeNull();
    });
  });
}

// ── resolveObjectSubscribers (the fan-out core) ──────────────────────────────

export function describeResolveObjectSubscribers(
  name: string,
  makeStores: () => { subscriptions: SubscribableStore; tags: TaggableStore; topics: TopicStore },
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`resolveObjectSubscribers — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('resolveconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('unions direct + topic subscribers, dedups keeping the most-verbose mode, resolves merged topics', async () => {
      if (skip) return;
      const { subscriptions, tags, topics } = makeStores();
      const object: ObjectRef = { kind: 'issue', ref: uid() };
      const topicA = uid();
      const topicMerged = uid();
      const directSub = uid();
      const topicSub = uid();
      const bothSub = uid();
      const ts = '2026-01-01T00:00:00.000Z';

      await topics.create({ slug: topicA, description: 'a', created_ts: ts });
      await topics.create({ slug: topicMerged, description: 'm', created_ts: ts });
      await topics.merge(topicMerged, topicA); // topicMerged → topicA

      // Tag the object with the MERGED slug; a sub to the canonical slug must still fire.
      await tags.addTag(object, topicMerged, { created_ts: ts });

      // directSub: object-level, digest.
      await subscriptions.subscribe({ subscriber_id: directSub, target_kind: 'object', target_ref: objectToTargetRef(object), delivery_mode: 'digest', created_ts: ts });
      // topicSub: canonical topic, mention.
      await subscriptions.subscribe({ subscriber_id: topicSub, target_kind: 'topic', target_ref: topicA, delivery_mode: 'mention', created_ts: ts });
      // bothSub: reaches via object (mention) AND topic (full) → keep full.
      await subscriptions.subscribe({ subscriber_id: bothSub, target_kind: 'object', target_ref: objectToTargetRef(object), delivery_mode: 'mention', created_ts: ts });
      await subscriptions.subscribe({ subscriber_id: bothSub, target_kind: 'topic', target_ref: topicA, delivery_mode: 'full', created_ts: ts });

      const resolved = await resolveObjectSubscribers(object, { subscriptions, tags, topics });
      const byId = new Map(resolved.map((r) => [r.subscriber_id, r]));
      expect(new Set(byId.keys())).toEqual(new Set([directSub, topicSub, bothSub]));
      expect(byId.get(directSub)!.delivery_mode).toBe('digest');
      expect(byId.get(topicSub)!.delivery_mode).toBe('mention');
      expect(byId.get(bothSub)!.delivery_mode).toBe('full'); // most-verbose wins
      expect(byId.get(bothSub)!.via).toBe('object'); // direct attribution preferred
    });
  });
}
