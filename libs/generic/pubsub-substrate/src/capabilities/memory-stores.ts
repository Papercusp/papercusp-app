/**
 * capabilities/memory-stores.ts — in-memory doubles for the pub/sub capabilities
 * (Topics, Subscribable, Threadable). Each mirrors the PG store's semantics
 * exactly (idempotency, active/expiry filtering, sort order) so both pass ONE
 * conformance suite (capabilities/conformance.ts) — the swappability proof,
 * matching the sibling seams' InMemory* doubles. The Linkable/Taggable in-memory
 * doubles live in @papercusp/linkable-edges.
 */

import {
  type CreateTopicInput,
  type DeliveryMode,
  type ObjectRef,
  type SubscribableStore,
  type SubscribeInput,
  type SubscriptionRow,
  type SubscriptionTargetKind,
  type ThreadableStore,
  type ThreadPostRow,
  type ThreadRow,
  type TopicRow,
  type TopicStore,
} from './types';

// ── Topics ───────────────────────────────────────────────────────────────────

export class InMemoryTopicStore implements TopicStore {
  private rows = new Map<string, TopicRow>();

  async create(input: CreateTopicInput): Promise<TopicRow> {
    const existing = this.rows.get(input.slug);
    if (existing) return existing;
    const row: TopicRow = {
      slug: input.slug,
      title: input.title ?? null,
      description: input.description,
      created_by: input.created_by ?? null,
      merged_into: null,
      created_ts: input.created_ts,
    };
    this.rows.set(input.slug, row);
    return row;
  }

  async list(opts: { includeMerged?: boolean } = {}): Promise<TopicRow[]> {
    return [...this.rows.values()]
      .filter((r) => opts.includeMerged || r.merged_into == null)
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.slug.localeCompare(b.slug));
  }

  async get(slug: string): Promise<TopicRow | null> {
    return this.rows.get(slug) ?? null;
  }

  async merge(fromSlug: string, intoSlug: string): Promise<void> {
    if (fromSlug === intoSlug) return;
    const row = this.rows.get(fromSlug);
    if (row) row.merged_into = intoSlug;
  }

  async resolve(slug: string): Promise<string> {
    let cur = slug;
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const next = this.rows.get(cur)?.merged_into;
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }
}

// ── Entity subscriptions (Subscribable) ──────────────────────────────────────

interface SubMem extends SubscriptionRow {
  cancelled: boolean;
}

export class InMemoryEntitySubscriptionStore implements SubscribableStore {
  private rows: SubMem[] = [];
  private seq = 0;

  async subscribe(input: SubscribeInput): Promise<SubscriptionRow> {
    const mode: DeliveryMode = input.delivery_mode ?? 'full';
    const active = this.rows.find(
      (r) => !r.cancelled && r.subscriber_id === input.subscriber_id &&
        r.target_kind === input.target_kind && r.target_ref === input.target_ref,
    );
    if (active) {
      active.delivery_mode = mode;
      active.expires_ts = input.expires_ts ?? null;
      if (input.follow_blockers !== undefined) active.follow_blockers = input.follow_blockers;
      return stripCancelled(active);
    }
    const row: SubMem = {
      id: ++this.seq,
      subscriber_id: input.subscriber_id,
      target_kind: input.target_kind,
      target_ref: input.target_ref,
      delivery_mode: mode,
      created_ts: input.created_ts,
      expires_ts: input.expires_ts ?? null,
      follow_blockers: input.follow_blockers ?? false,
      cancelled: false,
    };
    this.rows.push(row);
    return stripCancelled(row);
  }

  async unsubscribe(subscriberId: string, targetKind: SubscriptionTargetKind, targetRef: string): Promise<void> {
    for (const r of this.rows) {
      if (!r.cancelled && r.subscriber_id === subscriberId && r.target_kind === targetKind && r.target_ref === targetRef) {
        r.cancelled = true;
      }
    }
  }

  async listSubscriptions(subscriberId: string): Promise<SubscriptionRow[]> {
    return this.active().filter((r) => r.subscriber_id === subscriberId).map(stripCancelled);
  }

  async listTargetSubscribers(targetKind: SubscriptionTargetKind, targetRef: string): Promise<SubscriptionRow[]> {
    return this.active().filter((r) => r.target_kind === targetKind && r.target_ref === targetRef).map(stripCancelled);
  }

  private active(): SubMem[] {
    const now = Date.now();
    return this.rows
      .filter((r) => !r.cancelled)
      .filter((r) => r.expires_ts == null || new Date(r.expires_ts).getTime() > now)
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.id - b.id);
  }
}

function stripCancelled(r: SubMem): SubscriptionRow {
  const { cancelled: _c, ...rest } = r;
  return { ...rest };
}

// ── Threads (Threadable) ─────────────────────────────────────────────────────

export class InMemoryThreadStore implements ThreadableStore {
  private threads = new Map<string, ThreadRow>(); // thread_id → row
  private byParent = new Map<string, string>(); // `${kind}:${ref}` → thread_id
  private posts: ThreadPostRow[] = [];
  private seq = 0;

  async getOrCreateThread(
    parent: ObjectRef,
    // harness_slug is accepted for interface parity (federation scope); the
    // in-memory store is not federated, so it is not retained.
    opts: { thread_id: string; title?: string; created_by?: string; created_ts: string; harness_slug?: string },
  ): Promise<ThreadRow> {
    const pk = `${parent.kind}:${parent.ref}`;
    const existingId = this.byParent.get(pk);
    if (existingId) return this.threads.get(existingId)!;
    const row: ThreadRow = {
      thread_id: opts.thread_id,
      parent: { ...parent },
      title: opts.title ?? null,
      created_by: opts.created_by ?? null,
      created_ts: opts.created_ts,
      last_post_ts: null,
      post_count: 0,
    };
    this.threads.set(opts.thread_id, row);
    this.byParent.set(pk, opts.thread_id);
    return row;
  }

  async addPost(input: { thread_id: string; author_id?: string; body: string; created_ts: string }): Promise<ThreadPostRow> {
    const post: ThreadPostRow = {
      id: ++this.seq,
      thread_id: input.thread_id,
      author_id: input.author_id ?? null,
      body: input.body,
      created_ts: input.created_ts,
    };
    this.posts.push(post);
    const t = this.threads.get(input.thread_id);
    if (t) {
      t.post_count += 1;
      t.last_post_ts = input.created_ts;
    }
    return { ...post };
  }

  async listPosts(threadId: string, opts: { afterId?: number } = {}): Promise<ThreadPostRow[]> {
    return this.posts
      .filter((p) => p.thread_id === threadId && (opts.afterId == null || p.id > opts.afterId))
      .sort((a, b) => a.id - b.id)
      .map((p) => ({ ...p }));
  }

  async getPostById(postId: number): Promise<ThreadPostRow | null> {
    const post = this.posts.find((candidate) => candidate.id === postId);
    return post ? { ...post } : null;
  }

  async getThreadByParent(parent: ObjectRef): Promise<ThreadRow | null> {
    const id = this.byParent.get(`${parent.kind}:${parent.ref}`);
    return id ? { ...this.threads.get(id)! } : null;
  }
}
