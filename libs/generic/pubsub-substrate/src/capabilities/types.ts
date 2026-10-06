/**
 * capabilities/types.ts — the pub/sub coordination capabilities (the
 * Subscribable / Threadable / Topics / fan-out slice of the original
 * "Subscribable is a capability, not a table" set, D-001).
 *
 *   Subscribable — follow a topic or an object → injected updates
 *   Threadable   — a comment timeline attachable to any object
 *   Topics       — the subscription/tag vocabulary (slug + merge)
 *   Claimable    — a claim/assignee on an object (INTERFACE — the domain object stores the scalar)
 *   Lifecycle    — open / resolved / closed on an object (INTERFACE — the domain object stores the scalar)
 *   + resolveObjectSubscribers — the fan-out compose (direct ∪ topic subscribers)
 *
 * The typed-entity graph this builds on — `ObjectRef`, Linkable, and Taggable —
 * lives in the lower-level @papercusp/linkable-edges lib; the fan-out reads tags
 * through its `TaggableStore`. The dependency is one-directional
 * (pubsub-substrate → linkable-edges): the codec below maps an `ObjectRef` to a
 * *subscription* target, a subscription concern, so it lives here.
 *
 * Host-agnostic: the host owns identity (passes subscriber_id / author_id /
 * created_by) and the clock (passes ISO `*_ts`). The Postgres backends are the
 * host tie-in adapter and live in @papercusp/coordination/capabilities.
 */

import type { ObjectRef, TaggableStore } from '@papercusp/linkable-edges';
// Re-exported for ergonomics: ObjectRef + TaggableStore appear in this slice's
// public signatures (ThreadRow.parent, resolveObjectSubscribers), so a consumer
// of @papercusp/pubsub-substrate/capabilities gets them without a second import.
export type { ObjectRef, TaggableStore } from '@papercusp/linkable-edges';

/** Delivery tiering for a subscription (D-006 — mandatory noise control).
 *   full    — every change, rendered in full
 *   digest  — coalesced count + one-line summary
 *   mention — only when @-addressed or on resolution
 *   muted   — suppress live delivery entirely (the audience-history is still
 *             retained + pullable, e.g. coord:catch-up). Used by the per-member
 *             fleet delivery override (fleet-delivery-override-mute-digest-2026-06-30
 *             D-001): a 'fleet' subscription row downgrades a derived fleet member. */
export type DeliveryMode = 'full' | 'digest' | 'mention' | 'muted';

export const DELIVERY_MODES: readonly DeliveryMode[] = ['full', 'digest', 'mention', 'muted'];

/** What a subscription follows. `fleet` is the per-member delivery OVERRIDE on a
 *  named fleet (target_ref = fleet slug) — NOT a positive subscription (fleet
 *  membership is derived from coord_presence); the row only ever DOWNGRADES a
 *  member's delivery (digest/muted). No row = the derived default (full).
 *  `event` is a STANDING inject subscription to an arbitrary event key
 *  (target_ref = the event key, e.g. `lock:grant:<ticket>`) — the wake:false
 *  half of watch:create's event-key support (WI-4014 Part 2); the wake:true
 *  half is a standing `events:await`-style row on the separate awaits table,
 *  unrelated to this store. */
export type SubscriptionTargetKind = 'topic' | 'object' | 'fleet' | 'event';

/** Encode an object as a subscription target_ref (`<kind>:<ref>`). Topic targets
 *  use the bare topic slug, so this is only for target_kind='object'. */
export function objectToTargetRef(o: ObjectRef): string {
  return `${o.kind}:${o.ref}`;
}

/** Inverse of {@link objectToTargetRef}. Splits on the FIRST ':' (object ids/
 *  plan slugs never start the string with a kind-colon). */
export function targetRefToObject(targetRef: string): ObjectRef {
  const i = targetRef.indexOf(':');
  if (i < 0) return { kind: '', ref: targetRef };
  return { kind: targetRef.slice(0, i), ref: targetRef.slice(i + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscribable
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: number;
  subscriber_id: string;
  target_kind: SubscriptionTargetKind;
  target_ref: string;
  delivery_mode: DeliveryMode;
  /** ISO-8601 create time. */
  created_ts: string;
  /** ISO-8601 expiry, or null for a standing subscription. */
  expires_ts: string | null;
  /** WI-4119: direct work-item subscriptions may follow one blocker hop. */
  follow_blockers?: boolean;
  /** WI-4119: non-null only for a generated blocker subscription. */
  derived_from?: ObjectRef | null;
}

export interface SubscribeInput {
  subscriber_id: string;
  target_kind: SubscriptionTargetKind;
  target_ref: string;
  /** Defaults to 'full'. */
  delivery_mode?: DeliveryMode;
  /** ISO-8601 create time (host clock). */
  created_ts: string;
  expires_ts?: string | null;
  /** WI-4119: opt a direct work-item subscription into one-hop blocker follows. */
  follow_blockers?: boolean;
}

export interface SubscribableStore {
  /** Register (or update the mode/TTL of) a subscription. Idempotent on
   *  (subscriber, target): a re-subscribe updates delivery_mode + expires_ts. */
  subscribe(input: SubscribeInput): Promise<SubscriptionRow>;
  /** Soft-cancel one subscription (idempotent). */
  unsubscribe(subscriberId: string, targetKind: SubscriptionTargetKind, targetRef: string): Promise<void>;
  /** Every active subscription of one subscriber. */
  listSubscriptions(subscriberId: string): Promise<SubscriptionRow[]>;
  /** Every active subscriber of one target (the fan-out's hot path). */
  listTargetSubscribers(targetKind: SubscriptionTargetKind, targetRef: string): Promise<SubscriptionRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Threadable
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreadRow {
  thread_id: string;
  parent: ObjectRef;
  title: string | null;
  created_by: string | null;
  created_ts: string;
  last_post_ts: string | null;
  post_count: number;
}

export interface ThreadPostRow {
  id: number;
  thread_id: string;
  author_id: string | null;
  body: string;
  created_ts: string;
}

export interface ThreadableStore {
  /** Return the thread for `parent`, creating it if absent. `thread_id` is the
   *  host-supplied id used when creating. */
  getOrCreateThread(
    parent: ObjectRef,
    opts: {
      thread_id: string;
      title?: string;
      created_by?: string;
      created_ts: string;
      /** Harness scope (federation): set from the parent's harness when the
       *  caller is harness-scoped; the thread + its posts then federate over that
       *  harness's peer-log. Omit = local. */
      harness_slug?: string;
    },
  ): Promise<ThreadRow>;
  /** Append a post; bumps the thread's post_count + last_post_ts. */
  addPost(input: { thread_id: string; author_id?: string; body: string; created_ts: string }): Promise<ThreadPostRow>;
  /** Posts in a thread, oldest-first; `afterId` for incremental reads. */
  listPosts(threadId: string, opts?: { afterId?: number }): Promise<ThreadPostRow[]>;
  /** Read one post by its workspace-local numeric id, or null when absent. */
  getPostById(postId: number): Promise<ThreadPostRow | null>;
  /** The thread attached to `parent`, or null. */
  getThreadByParent(parent: ObjectRef): Promise<ThreadRow | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Topics — the Subscribable/Taggable vocabulary (slug + merge)
// ─────────────────────────────────────────────────────────────────────────────

export interface TopicRow {
  slug: string;
  title: string | null;
  description: string;
  created_by: string | null;
  /** Alias target slug if this topic was merged (topics:merge), else null. */
  merged_into: string | null;
  created_ts: string;
}

export interface CreateTopicInput {
  slug: string;
  title?: string;
  description: string;
  created_by?: string;
  created_ts: string;
}

export interface TopicStore {
  /** Create a topic (idempotent on slug — re-create is a no-op returning the row). */
  create(input: CreateTopicInput): Promise<TopicRow>;
  /** All topics; live-only unless `includeMerged`. */
  list(opts?: { includeMerged?: boolean }): Promise<TopicRow[]>;
  get(slug: string): Promise<TopicRow | null>;
  /** Alias `fromSlug` → `intoSlug` (topics:merge). Sets merged_into and is a
   *  cheap dedup, not a creation-time gate (D-004). */
  merge(fromSlug: string, intoSlug: string): Promise<void>;
  /** Follow the merged_into chain to the live canonical slug. */
  resolve(slug: string): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claimable + Lifecycle — INTERFACE-ONLY. The domain object stores the scalar
// (assignee / state) on its own table; the substrate names the contract so
// tools + UI can treat any claimable/lifecycle object uniformly. No generic
// table backs these by design (D-007: content, scoped to the object).
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimableStore {
  claim(object: ObjectRef, assignee: string): Promise<void>;
  release(object: ObjectRef): Promise<void>;
  getAssignee(object: ObjectRef): Promise<string | null>;
}

export type LifecycleState = 'open' | 'resolved' | 'closed';

export const LIFECYCLE_STATES: readonly LifecycleState[] = ['open', 'resolved', 'closed'];

export interface LifecycleStore {
  setState(object: ObjectRef, state: LifecycleState): Promise<void>;
  getState(object: ObjectRef): Promise<LifecycleState | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan-out resolution — the core compose used by the local fan-out: every
// subscriber that should receive an object's change = direct object-subscribers
// ∪ subscribers of every topic the object is tagged with (merged topics
// resolved to their canonical slug). De-duplicated by subscriber, keeping the
// most-verbose delivery_mode (full > digest > mention) when an agent reaches the
// object via more than one path.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedSubscriber {
  subscriber_id: string;
  delivery_mode: DeliveryMode;
  /** How this subscriber matched: 'object' (direct) or the topic slug. */
  via: string;
}

// muted = least verbose (0): when a subscriber reaches a target via more than one
// path, any live mode outranks a muted one (mute never wins a merge).
const MODE_RANK: Record<DeliveryMode, number> = { full: 3, digest: 2, mention: 1, muted: 0 };

/** Merge a candidate subscriber into the resolved map, keeping the most-verbose
 *  mode and preferring a direct ('object') match for the `via` attribution. */
export function mergeResolved(
  map: Map<string, ResolvedSubscriber>,
  cand: ResolvedSubscriber,
): void {
  const prev = map.get(cand.subscriber_id);
  if (!prev) {
    map.set(cand.subscriber_id, cand);
    return;
  }
  const mode = MODE_RANK[cand.delivery_mode] >= MODE_RANK[prev.delivery_mode] ? cand.delivery_mode : prev.delivery_mode;
  const via = prev.via === 'object' || cand.via === 'object' ? 'object' : prev.via;
  map.set(cand.subscriber_id, { subscriber_id: cand.subscriber_id, delivery_mode: mode, via });
}

/**
 * Resolve every subscriber that should be notified of a change to `object`.
 * Pure composition over the two stores + the topic store (for merge resolution),
 * so it has one implementation that works against PG or in-memory doubles alike.
 */
export async function resolveObjectSubscribers(
  object: ObjectRef,
  stores: { subscriptions: SubscribableStore; tags: TaggableStore; topics: TopicStore },
): Promise<ResolvedSubscriber[]> {
  const out = new Map<string, ResolvedSubscriber>();

  // 1. Direct object subscribers.
  for (const s of await stores.subscriptions.listTargetSubscribers('object', objectToTargetRef(object))) {
    mergeResolved(out, { subscriber_id: s.subscriber_id, delivery_mode: s.delivery_mode, via: 'object' });
  }

  // 2. Topic subscribers, for every topic the object is tagged with (resolving
  //    merged topics to their canonical slug — a sub to the canonical slug must
  //    still fire when the object carries the merged alias, and vice-versa).
  const tags = await stores.tags.listTags(object);
  const canonical = new Set<string>();
  for (const slug of tags) canonical.add(await stores.topics.resolve(slug));
  for (const slug of canonical) {
    for (const s of await stores.subscriptions.listTargetSubscribers('topic', slug)) {
      mergeResolved(out, { subscriber_id: s.subscriber_id, delivery_mode: s.delivery_mode, via: slug });
    }
  }

  return [...out.values()];
}
