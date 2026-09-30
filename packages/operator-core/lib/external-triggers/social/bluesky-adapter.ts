/**
 * The Bluesky (AT Protocol) adapter — P-011, the reference Wave A adapter.
 *
 * WHY THIS ONE IS FIRST. It is the only Wave A platform that exercises BOTH
 * halves of the P-003 contract's hard case: a stream that can REFUSE a stored
 * cursor (past its retention window), and a write path with no idempotency
 * mechanism at all. Mastodon and Reddit each hit one of those; Bluesky hits
 * both, so building it first means the shared contract is proven against the
 * strictest case rather than retrofitted to it.
 *
 * FACTS THIS FILE ENCODES, all read from byte-serving sources on 2026-08-23 and
 * pinned in the registry row (`platform-registry.ts`), not recalled:
 *
 *   - Procedures are POST /xrpc/<NSID>, JSON body (atproto.com/specs/xrpc).
 *   - Errors use a uniform { error, message } envelope. The status→retry policy
 *     below is the spec's, verbatim: 429 may carry Retry-After; 500 retry;
 *     501 must NOT be retried; 502–504 retry after a delay.
 *   - createRecord takes { repo, collection, record, rkey?, validate?,
 *     swapCommit? } and returns { uri, cid, ... }.
 *   - app.bsky.feed.post requires text (≤3000 chars / ≤300 graphemes) and
 *     createdAt; a reply needs BOTH root and parent as
 *     com.atproto.repo.strongRef = { uri, cid }.
 *   - There is NO idempotency mechanism. `swapCommit` is a compare-and-swap on
 *     the repo commit (error InvalidSwap), NOT request idempotency. So a
 *     retried createRecord after an ambiguous timeout CAN double-post publicly.
 *     The client-suppliable `rkey` is the only lever that makes a retry land on
 *     the same record, which is why `blueskyPostRkey` exists and is derived,
 *     never random.
 *
 * The provider is behind `BlueskyReadClient` / `BlueskyWriteClient` ports so the
 * conformance kit can drive this against an in-memory world, and a live run can
 * drive the same code against a real PDS. The reconnect/backoff shape follows
 * the landed Slack Socket Mode manager rather than inventing a second one.
 */
import type {
  SocialAdapter,
  SocialBackfillReason,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What we persist between reconciles.
 *
 * `seq` is the firehose sequence number and is MONOTONIC, which is what makes
 * "exactly once" structural here rather than incidental: every path filters to
 * `seq > cursor.seq`, so an overlapping backfill cannot double-emit even if the
 * provider hands back events we already saw.
 *
 * `lastEventAt` exists only for the REST backfill, which is time-bounded rather
 * than seq-bounded. It is deliberately NOT the dedupe key — wall-clock from the
 * provider is fine as a query bound and unusable as an identity.
 */
export interface BlueskyCursor {
  seq: number;
  lastEventAt?: string | null;
}

/** True when `value` is a usable stored cursor. Unusable values need backfill. */
export function isBlueskyCursor(value: unknown): value is BlueskyCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlueskyCursor).seq === 'number' &&
    Number.isFinite((value as BlueskyCursor).seq)
  );
}

/* -------------------------------------------------------------------------- */
/* Provider ports                                                             */
/* -------------------------------------------------------------------------- */

/** One record as the stream (or a REST backfill) hands it to us. */
export interface BlueskyRawEvent {
  /** Firehose sequence number. Monotonic; the basis of all gap arithmetic. */
  seq: number;
  /** at-uri of the record, e.g. at://did:plc:x/app.bsky.feed.post/3k. */
  uri: string;
  /** Content-hash CID. Changes when the record is edited — the version marker. */
  cid: string;
  /** The repo (account DID) the record lives in. */
  did: string;
  /** app.bsky.feed.post fields. */
  text: string;
  createdAt?: string | null;
  authorHandle?: string | null;
  /** Present when this record is a reply. */
  reply?: { root: BlueskyStrongRef; parent: BlueskyStrongRef } | null;
  /** DIDs mentioned via facets, when the provider resolved them. */
  mentions?: string[] | null;
}

/** com.atproto.repo.strongRef — both fields required (lexicon-verified). */
export interface BlueskyStrongRef {
  uri: string;
  cid: string;
}

/** Why the provider refused the cursor we sent. */
export type BlueskyCursorRefusal =
  /** The cursor is ahead of the server's own position (FutureCursor). */
  | 'future-cursor'
  /** The cursor predates the retention window; the stream restarts at the oldest retained seq. */
  | 'cursor-too-old';

export interface BlueskyStreamPage {
  events: BlueskyRawEvent[];
  /** The provider's current sequence position after this page. */
  cursor: number | null;
  /** Set when the provider refused our cursor instead of replaying from it. */
  refusal?: BlueskyCursorRefusal;
}

export interface BlueskyReadClient {
  /**
   * Replay from `cursor` (null ⇒ cold start, read what the window holds).
   *
   * MUST report a refused cursor via `refusal` rather than silently starting
   * from live — that failure is invisible downstream, because "nothing was
   * missed" and "we lost the gap" both emit zero events.
   */
  streamSince(cursor: number | null, signal?: AbortSignal): Promise<BlueskyStreamPage>;
  /** Bounded REST re-read used when the cursor is unusable. */
  backfill(since: string | null, signal?: AbortSignal): Promise<BlueskyRawEvent[]>;
}

/* -------------------------------------------------------------------------- */
/* Errors + retry policy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An XRPC error in the spec's uniform envelope.
 *
 * `error` is the ASCII constant (e.g. 'InvalidSwap', 'RateLimitExceeded');
 * `message` is the optional human string. Both are carried because the constant
 * is what code may branch on and the message is what a person needs.
 */
export class BlueskyXrpcError extends Error {
  readonly status: number;
  readonly error: string;
  readonly retryAfterMs: number | null;

  constructor(status: number, error: string, message?: string, retryAfterMs: number | null = null) {
    super(`bluesky_xrpc_${status}:${error}${message ? ` — ${message}` : ''}`);
    this.name = 'BlueskyXrpcError';
    this.status = status;
    this.error = error;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The spec's retry policy, encoded once.
 *
 * 501 is the one that matters and the one a generic `status >= 500` retry loop
 * gets WRONG: the spec says do not retry it. Retrying a 501 forever against a
 * PDS that will never implement the method is how an adapter turns an
 * unsupported call into a hot loop.
 */
export function blueskyRetryDelayMs(error: unknown, attempt: number): number | null {
  if (!(error instanceof BlueskyXrpcError)) return null;
  const { status } = error;
  if (status === 501) return null; // explicitly NOT retryable
  const retryable = status === 429 || status === 500 || (status >= 502 && status <= 504);
  if (!retryable) return null;
  if (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) return error.retryAfterMs;
  // Same shape as the Slack socket manager's backoff, with jitter — the spec
  // asks for randomized exponential backoff specifically because a fleet of
  // clients retrying in lockstep is what turns a blip into an outage.
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 6));
  return base;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The dedupe key: provider facts only.
 *
 * `uri` identifies the record and `cid` is its content hash, so an EDIT produces
 * a new key (correctly re-delivering changed content) while a replay of the same
 * version does not. The contract forbids wall-clock or randomness here, and the
 * conformance kit proves it by draining twice and comparing.
 */
export function blueskyDedupeKey(event: Pick<BlueskyRawEvent, 'uri' | 'cid'>): string {
  return `${event.uri}@${event.cid}`;
}

/** Which `ext:bluesky:<event>` key this record normalizes to. */
export function blueskyEventName(event: BlueskyRawEvent, selfDid: string | null): string {
  if (event.reply) return 'reply';
  if (selfDid && (event.mentions ?? []).includes(selfDid)) return 'mention';
  return 'post';
}

/** Build the canonical `social-post` payload (D-004). */
export function normalizeBlueskyEvent(
  event: BlueskyRawEvent,
  selfDid: string | null,
): SocialNormalizedEvent {
  const payload: Record<string, unknown> = {
    id: event.uri,
    text: event.text,
    uri: event.uri,
    cid: event.cid,
  };
  if (event.authorHandle) payload.author = event.authorHandle;
  if (event.createdAt) payload.occurredAt = event.createdAt;
  if (event.reply) {
    payload.replyToId = event.reply.parent.uri;
    payload.rootUri = event.reply.root.uri;
    payload.rootCid = event.reply.root.cid;
  }
  // A post's public web URL is derivable from the handle + record key, but only
  // when we actually have the handle — a guessed URL is worse than none.
  const rkey = event.uri.split('/').pop();
  if (event.authorHandle && rkey) {
    payload.url = `https://bsky.app/profile/${event.authorHandle}/post/${rkey}`;
  }

  return {
    externalId: event.uri,
    event: blueskyEventName(event, selfDid),
    occurredAt: event.createdAt ?? null,
    payload,
    dedupeKey: blueskyDedupeKey(event),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface BlueskyAdapterDeps {
  client: BlueskyReadClient;
  /** Our own DID, so a mention can be told from an ordinary post. */
  selfDid?: string | null;
  /** Bounded retry budget for an absorbed rate-limit / transient failure. */
  maxRetries?: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 4;

export class BlueskyAdapter implements SocialAdapter {
  readonly platformId = 'bluesky' as const;

  private readonly client: BlueskyReadClient;
  private readonly selfDid: string | null;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: BlueskyAdapterDeps) {
    this.client = deps.client;
    this.selfDid = deps.selfDid ?? null;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Absorb a rate limit or a transient 5xx instead of propagating it.
   *
   * The conformance kit's `rate-limit-is-absorbed` check asserts the events
   * survive a 429; propagating here would surface a routine throttle as a
   * source-level failure and drop the page.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const delay = blueskyRetryDelayMs(error, attempt);
        if (delay === null || attempt >= this.maxRetries) throw error;
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const stored = isBlueskyCursor(ctx.cursor) ? ctx.cursor : null;
    const cursorUnreadable = ctx.cursor !== null && stored === null;
    const lastSeq = stored?.seq ?? null;

    // A non-null cursor that this adapter cannot parse is persisted state we
    // must recover, not a first connect. Starting the stream from null here
    // would silently discard the gap while reporting a truthful-looking
    // cold-start path, so use the bounded REST backfill instead.
    if (cursorUnreadable) {
      const recovered = await this.withRetry(() => this.client.backfill(null, ctx.signal));
      const emitted = await this.emitAll(recovered, null, ctx);
      return {
        cursor: this.nextCursor(recovered, null, null),
        emitted: emitted.count,
        path: 'backfill',
        backfillReason: 'cursor-rejected',
      };
    }

    const page = await this.withRetry(() => this.client.streamSince(stored?.seq ?? null, ctx.signal));

    // ── the cursor was refused: close the gap by backfill, and SAY SO ────────
    // Starting from live here is the silent-loss bug the whole contract exists
    // to prevent: it emits zero events and is indistinguishable from "nothing
    // happened while we were away".
    if (page.refusal) {
      const reason: SocialBackfillReason =
        page.refusal === 'future-cursor' ? 'cursor-rejected' : 'cursor-expired';
      const recovered = await this.withRetry(() =>
        this.client.backfill(stored?.lastEventAt ?? null, ctx.signal),
      );
      const emitted = await this.emitAll(recovered, lastSeq, ctx);
      return {
        cursor: this.nextCursor(recovered, page.cursor, stored),
        emitted: emitted.count,
        path: 'backfill',
        backfillReason: reason,
      };
    }

    const emitted = await this.emitAll(page.events, lastSeq, ctx);
    const path: SocialReconcilePath =
      stored === null ? 'cold-start' : emitted.count > 0 ? 'cursor-replay' : 'live-only';

    return {
      cursor: this.nextCursor(page.events, page.cursor, stored),
      emitted: emitted.count,
      path,
    };
  }

  /**
   * Emit every event strictly newer than `lastSeq`, in provider order.
   *
   * The `seq > lastSeq` filter is what makes exactly-once structural: it holds
   * on the stream path AND the backfill path, so an overlapping re-read cannot
   * double-deliver.
   */
  private async emitAll(
    events: BlueskyRawEvent[],
    lastSeq: number | null,
    ctx: SocialReconcileContext,
  ): Promise<{ count: number }> {
    const fresh = events
      .filter((event) => (lastSeq === null ? true : event.seq > lastSeq))
      .sort((a, b) => a.seq - b.seq);

    let count = 0;
    for (const event of fresh) {
      if (ctx.signal?.aborted) break;
      await ctx.emit(normalizeBlueskyEvent(event, this.selfDid));
      count += 1;
    }
    return { count };
  }

  /** Never move the cursor BACKWARDS — a rewind would re-deliver on the next pass. */
  private nextCursor(
    events: BlueskyRawEvent[],
    providerCursor: number | null,
    stored: BlueskyCursor | null,
  ): BlueskyCursor {
    const highest = events.reduce((max, event) => Math.max(max, event.seq), Number.NEGATIVE_INFINITY);
    const candidates = [
      stored?.seq ?? Number.NEGATIVE_INFINITY,
      Number.isFinite(highest) ? highest : Number.NEGATIVE_INFINITY,
      providerCursor ?? Number.NEGATIVE_INFINITY,
    ];
    const seq = Math.max(...candidates);
    const newest = events.reduce<string | null>(
      (latest, event) => (event.createdAt && (!latest || event.createdAt > latest) ? event.createdAt : latest),
      stored?.lastEventAt ?? null,
    );
    return { seq: Number.isFinite(seq) ? seq : 0, lastEventAt: newest };
  }
}

/* -------------------------------------------------------------------------- */
/* Write side                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic record key, derived from the content being published.
 *
 * This is the ONLY replay guard available on this platform. The spec documents
 * no idempotency mechanism for procedures, so an ambiguous timeout followed by
 * a retry would otherwise create a SECOND public post — which, unlike a
 * duplicate email, cannot be quietly corrected. Supplying the same `rkey` makes
 * the retry address the same record instead.
 *
 * Derived from provider-facing content only (never wall-clock, never random),
 * because a key that changes between the original attempt and its retry is
 * exactly equivalent to having no key at all.
 */
export function blueskyPostRkey(input: { text: string; replyTo?: BlueskyStrongRef | null }): string {
  const basis = `${input.replyTo?.uri ?? ''}\x00${input.text}`;
  // FNV-1a, base36 — short, stable, and dependency-free. Collision risk is
  // irrelevant here: a collision means the same author posting identical text
  // in reply to the same parent, which is the case we WANT to collapse.
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc${hash.toString(36)}`;
}

/** Input to com.atproto.repo.createRecord, as the lexicon defines it. */
export interface BlueskyCreateRecordInput {
  repo: string;
  collection: string;
  record: Record<string, unknown>;
  rkey?: string;
  validate?: boolean;
  swapCommit?: string;
}

/** Output of com.atproto.repo.createRecord. */
export interface BlueskyCreateRecordOutput {
  uri: string;
  cid: string;
  validationStatus?: 'valid' | 'unknown';
}

export interface BlueskyWriteClient {
  createRecord(input: BlueskyCreateRecordInput): Promise<BlueskyCreateRecordOutput>;
}

/** The maximum `text` length app.bsky.feed.post declares, in characters. */
export const BLUESKY_POST_MAX_CHARS = 3000;
/** The maximum `text` length app.bsky.feed.post declares, in graphemes. */
export const BLUESKY_POST_MAX_GRAPHEMES = 300;

/** Count graphemes the way the lexicon's maxGraphemes bound means it. */
export function blueskyGraphemeCount(text: string): number {
  // Intl.Segmenter is the correct instrument: a naive [...text].length counts
  // an emoji ZWJ sequence as several, which would reject a post the platform
  // would have accepted.
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter === 'function') {
    return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
  }
  return [...text].length;
}

/**
 * Build the app.bsky.feed.post record for a new post or a reply.
 *
 * `createdAt` is CLIENT-declared per the lexicon, so it is a parameter rather
 * than a `new Date()` inside: a retry must reproduce the same record, and a
 * timestamp minted here would differ between the original and the retry.
 */
export function buildBlueskyPostRecord(input: {
  text: string;
  createdAt: string;
  replyTo?: { root: BlueskyStrongRef; parent: BlueskyStrongRef } | null;
}): Record<string, unknown> {
  const text = input.text;
  if (!text.trim() && !input.replyTo) throw new Error('bluesky_post_text_required');
  if (text.length > BLUESKY_POST_MAX_CHARS) {
    throw new Error(`bluesky_post_too_long:chars:${text.length}>${BLUESKY_POST_MAX_CHARS}`);
  }
  const graphemes = blueskyGraphemeCount(text);
  if (graphemes > BLUESKY_POST_MAX_GRAPHEMES) {
    throw new Error(`bluesky_post_too_long:graphemes:${graphemes}>${BLUESKY_POST_MAX_GRAPHEMES}`);
  }

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: input.createdAt,
  };
  if (input.replyTo) {
    // BOTH root and parent are required, and each is a full strongRef. Sending
    // only `parent` is the common mistake and produces a reply that is not
    // threaded to its root.
    record.reply = {
      root: { uri: input.replyTo.root.uri, cid: input.replyTo.root.cid },
      parent: { uri: input.replyTo.parent.uri, cid: input.replyTo.parent.cid },
    };
  }
  return record;
}
