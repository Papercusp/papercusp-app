/**
 * The YouTube COMMENTS adapter — P-015 stage 3, the second of YouTube's two
 * read streams (D-022).
 *
 * WHY THIS IS A SEPARATE ADAPTER FROM ACTIVITIES, RESTATED BECAUSE IT IS THE
 * WHOLE POINT. `activities.list` has `publishedAfter`, a real server-side time
 * cursor. `commentThreads.list` has NO timestamp filter of ANY kind. Its
 * complete parameter inventory is `part`; exactly one of
 * `allThreadsRelatedToChannelId` / `id` / `videoId`; and the optional
 * `maxResults`, `moderationStatus`, `order`, `pageToken`, `searchTerms`,
 * `textFormat` (D-021, re-verified against the vendor page 2026-08-23). There is
 * nothing to send a watermark to. So this stream is `watermark-rescan`: the
 * client re-reads from the top and bounds the read itself, and the cost of a
 * pass grows with the gap rather than with what changed.
 *
 * That difference is not cosmetic — it is why the registry carries a per-stream
 * `SocialReadSpec` and why a single adapter spanning both streams would have to
 * report the weaker one's `path` forever.
 *
 * FACTS THIS FILE ENCODES, read from the vendor pages on 2026-08-23 — from the
 * WRITER, not from the registry row and not from recall:
 *
 *   - `maxResults`: "Acceptable values are `1` to `100`, inclusive. The default
 *     value is `20`." (Note this differs from activities.list's `0`–`50`/`5`;
 *     the two endpoints do not share a page-size rule.)
 *   - `order`: "`time` - Comment threads are ordered by time. This is the
 *     default behavior." / "`relevance` - Comment threads are ordered by
 *     relevance."
 *   - `replies.comments[]` is documented as possibly a SUBSET: the list may be
 *     incomplete unless its length equals `snippet.totalReplyCount`, and the
 *     documented remedy is a separate `comments.list` call with `parentId`.
 *     `threadRepliesAreComplete` is the only place that comparison is made.
 *   - The commentThread resource carries NO thread-level timestamp. Its
 *     documented properties are `kind`, `etag`, `id`, six `snippet` fields
 *     (`channelId`, `videoId`, `topLevelComment`, `canReply`,
 *     `totalReplyCount`, `isPublic`) and `replies.comments[]`. Every time value
 *     therefore comes from a nested comment resource.
 *   - `snippet.publishedAt` is "The date and time when the comment was orignally
 *     published" [sic]; `snippet.updatedAt` is "The date and time when the
 *     comment was last updated". The page does NOT state whether `updatedAt` is
 *     present on a never-edited comment — see `youtubeCommentEffectiveAt`.
 *   - `snippet.parentId` is "The unique ID of the parent comment... only set if
 *     the comment was submitted as a reply to another comment". The page does
 *     not say whether a nested reply points at the thread root or at an
 *     intermediate comment, so this adapter carries it verbatim and never
 *     reinterprets it as a thread id.
 *   - There is no `videoId` on the comment resource; it lives on the THREAD's
 *     snippet, which is where the payload takes it from.
 *
 * ⚠ THE ORDERING FACT THE VENDOR PAGE DOES NOT ESTABLISH, AND THE BOUND THAT
 * FOLLOWS. `order=time` is documented only as "ordered by time". Whether that
 * means the top-level comment's publish time or the thread's most recent
 * activity is stated NOWHERE, and the two readings differ in a way that matters:
 * under the first, a brand-new reply on an old thread sits far down the list
 * rather than near the top. This adapter therefore derives NO control flow from
 * the ordering — there is no "stop at the first item older than the watermark"
 * early exit, which under the pessimistic reading would truncate the read before
 * reaching a thread that had just been replied to. The read is bounded by
 * `maxPages`, a fact about this adapter, and the watermark is applied
 * client-side per comment. The residual limit is stated honestly in
 * `YOUTUBE_COMMENTS_RESCAN_BOUND` rather than hidden.
 */
import type {
  SocialAdapter,
  SocialBackfillReason,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';
import { youtubeInstantMs, youtubeRetryDelayMs } from './youtube-common';

/* -------------------------------------------------------------------------- */
/* Page size                                                                  */
/* -------------------------------------------------------------------------- */

/** `maxResults` for commentThreads.list: 1–100 inclusive, vendor default 20. */
export const YOUTUBE_COMMENT_THREADS_MAX_RESULTS = 100;

/**
 * Deliberately the CEILING, not the vendor's default of 20.
 *
 * commentThreads.list costs 1 unit per CALL against the general bucket (D-020),
 * so page size is a pure quota multiplier — and this stream re-reads the window
 * on EVERY pass, which multiplies the difference by the poll frequency rather
 * than paying it once.
 */
export const YOUTUBE_COMMENTS_PAGE_SIZE_DEFAULT = YOUTUBE_COMMENT_THREADS_MAX_RESULTS;

export function clampYouTubeCommentThreadsMaxResults(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return YOUTUBE_COMMENTS_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.max(Math.trunc(value), 1), YOUTUBE_COMMENT_THREADS_MAX_RESULTS);
}

/**
 * The honest statement of what a bounded rescan cannot see, kept as an exported
 * string so it can be quoted into an operator-facing surface instead of being
 * rediscovered.
 */
export const YOUTUBE_COMMENTS_RESCAN_BOUND =
  'commentThreads.list has no time filter, so this stream is re-read from the top and bounded by maxPages. ' +
  'Two consequences are structural, not bugs: (1) activity on a thread that sits beyond the bounded window is ' +
  'not seen — and because `order=time` is undocumented as to whether it tracks the top-level comment or the ' +
  'latest reply, a new reply on an OLD thread may be one of those; (2) replies.comments[] can be a subset of ' +
  'snippet.totalReplyCount, so a heavily-replied thread reports fewer replies than it has. Neither is silent: ' +
  'the first is bounded by a stated maxPages, and the second is detectable per thread via threadRepliesAreComplete.';

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                            */
/* -------------------------------------------------------------------------- */

/** One `comment` resource, flattened to the fields this adapter reads. */
export interface YouTubeRawComment {
  id: string;
  /** `snippet.publishedAt`, verbatim. */
  publishedAt: string;
  /** `snippet.updatedAt`. Presence on a never-edited comment is undocumented. */
  updatedAt?: string | null;
  authorDisplayName?: string | null;
  /** `snippet.authorChannelId.value`. */
  authorChannelId?: string | null;
  /** `snippet.textDisplay` — may differ from the original (links become titles). */
  textDisplay?: string | null;
  /** `snippet.textOriginal` — only returned to the comment's own author. */
  textOriginal?: string | null;
  /** `snippet.parentId`, set only on a reply. Carried verbatim, never reinterpreted. */
  parentId?: string | null;
  likeCount?: number | null;
  /** `snippet.channelId` — the channel the comment is associated with. */
  channelId?: string | null;
}

/** One `commentThread` resource, flattened. */
export interface YouTubeRawCommentThread {
  id: string;
  /** `snippet.videoId` — the comment resource does NOT carry this. */
  videoId?: string | null;
  /** `snippet.channelId`. */
  channelId?: string | null;
  /** `snippet.totalReplyCount`. */
  totalReplyCount: number;
  /** `snippet.isPublic`. */
  isPublic?: boolean | null;
  /** `snippet.canReply`. */
  canReply?: boolean | null;
  /** `snippet.topLevelComment`. */
  topLevelComment: YouTubeRawComment;
  /** `replies.comments[]` — MAY BE A SUBSET. See `threadRepliesAreComplete`. */
  replies?: YouTubeRawComment[] | null;
}

export interface YouTubeCommentThreadsPage {
  items: YouTubeRawCommentThread[];
  nextPageToken?: string | null;
}

/**
 * One `commentThreads.list` call.
 *
 * NOTE WHAT THIS SIGNATURE CANNOT EXPRESS: there is no time parameter, because
 * the endpoint has none. Keeping the port honest is deliberate — a client
 * interface that accepted a `publishedAfter` here would invite someone to
 * "wire it up" against an endpoint that silently ignores it, which would look
 * exactly like a working incremental read while quietly re-reading everything.
 */
export interface YouTubeCommentThreadsClient {
  listCommentThreads(params: {
    pageToken: string | null;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<YouTubeCommentThreadsPage>;
}

/**
 * Whether `replies.comments[]` holds every reply the thread claims to have.
 *
 * The vendor page states the list may be a subset and that the remedy is a
 * separate `comments.list` call with `parentId`. That call is deliberately NOT
 * made here: it is a per-thread request, so folding it in would make one pass
 * cost O(threads) calls against the same general bucket the rest of the
 * integration draws on — an unbounded quota amplification triggered by whichever
 * video happens to go viral. Detecting the shortfall and reporting it beats
 * silently paying for it.
 */
export function threadRepliesAreComplete(thread: YouTubeRawCommentThread): boolean {
  return (thread.replies?.length ?? 0) >= thread.totalReplyCount;
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The persisted watermark.
 *
 * D-023 APPLIES HERE, BUT ONLY HALF OF IT. That decision has two parts: query a
 * floor one millisecond before the watermark, and carry the ids sitting exactly
 * on it. The FLOOR half is meaningless on this stream — there is no query
 * parameter to put it in — so only `boundaryIds` carries over. It is still
 * required for exactly the same reason: a comment landing in the same instant as
 * the watermark but arriving later must be emitted, while the one already
 * emitted at that instant must not be, and a bare `>` or `>=` comparison cannot
 * do both.
 */
export interface YouTubeCommentsCursor {
  /**
   * The newest effective timestamp emitted so far, stored verbatim as the
   * provider serialized it — see `youtubeCommentEffectiveAt` for why "effective".
   */
  watermark: string;
  /** Comment ids already emitted whose effective timestamp is that same instant. */
  boundaryIds: string[];
}

export function isYouTubeCommentsCursor(value: unknown): value is YouTubeCommentsCursor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { watermark?: unknown; boundaryIds?: unknown };
  if (typeof candidate.watermark !== 'string') return false;
  if (!Number.isFinite(Date.parse(candidate.watermark))) return false;
  return Array.isArray(candidate.boundaryIds) && candidate.boundaryIds.every((id) => typeof id === 'string');
}

/**
 * The timestamp this adapter orders and watermarks on: `updatedAt` when the
 * provider supplied one, otherwise `publishedAt`.
 *
 * THE FALLBACK IS LOAD-BEARING, NOT DEFENSIVE. The vendor page documents what
 * `updatedAt` means but says nothing about whether it is present on a comment
 * that was never edited — unlike `parentId` and `moderationStatus`, whose
 * conditionality it does spell out. Treating it as always-present would make
 * every never-edited comment's timestamp `undefined`, which sorts and compares
 * as garbage; treating it as never-present would drop edits.
 *
 * WHY `updatedAt` WINS WHEN IT IS THERE: an edited comment is content the
 * operator has not seen. Watermarking on `publishedAt` would file the edit under
 * the original publication instant, which is below the watermark, so the edit
 * would never be delivered. Keying on the effective timestamp means an edit
 * re-surfaces the comment — and the dedupe key changes with it, so the
 * ingestion seam treats it as a new delivery rather than a duplicate.
 */
export function youtubeCommentEffectiveAt(comment: Pick<YouTubeRawComment, 'publishedAt' | 'updatedAt'>): string {
  const updated = comment.updatedAt;
  if (typeof updated === 'string' && updated.length > 0) return updated;
  return comment.publishedAt;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** A top-level comment is `comment`; anything with a parent is `reply`. */
export function youtubeCommentEventName(comment: Pick<YouTubeRawComment, 'parentId'>): string {
  return comment.parentId ? 'reply' : 'comment';
}

/**
 * `<id>@<effectiveAt>`.
 *
 * Both halves are provider facts — no wall-clock, no randomness — so the key is
 * stable across identical passes, which the contract requires. Because the
 * effective timestamp moves when a comment is edited, an edit produces a new key
 * and is correctly re-delivered rather than being collapsed as a duplicate of
 * the original.
 */
export function youtubeCommentDedupeKey(comment: Pick<YouTubeRawComment, 'id' | 'publishedAt' | 'updatedAt'>): string {
  return `${comment.id}@${youtubeCommentEffectiveAt(comment)}`;
}

/**
 * Build the canonical `social-post` payload (D-004).
 *
 * `threadId` and `parentId` are NOT decoration — they are what a reply has to
 * be addressed to. `comments.insert` replies to a comment, so P-015 stage 4's
 * reply seam reads them off the stored document; omitting them would not fail
 * during ingestion, it would fail later at every attempt to reply, against a
 * document that looked perfectly well-formed. That is the failure mode the
 * Reddit adapter already hit once, recorded in its `normalizeRedditThing` note.
 */
export function normalizeYouTubeComment(
  comment: YouTubeRawComment,
  thread: YouTubeRawCommentThread,
): SocialNormalizedEvent {
  const occurredAt = youtubeCommentEffectiveAt(comment);
  const payload: Record<string, unknown> = {
    id: comment.id,
    // textOriginal is only served to the comment's own author, so textDisplay is
    // the field that is reliably present.
    text: comment.textDisplay ?? comment.textOriginal ?? '',
    author: comment.authorDisplayName ?? comment.authorChannelId ?? '',
    occurredAt,
    // The two fields the reply seam requires.
    threadId: thread.id,
    channelId: comment.channelId ?? thread.channelId ?? '',
  };
  if (comment.parentId) payload.replyToId = comment.parentId;
  if (comment.authorChannelId) payload.authorChannelId = comment.authorChannelId;
  if (typeof comment.likeCount === 'number') payload.likeCount = comment.likeCount;
  if (comment.updatedAt && comment.updatedAt !== comment.publishedAt) payload.editedAt = comment.updatedAt;
  payload.publishedAt = comment.publishedAt;
  if (thread.videoId) {
    payload.videoId = thread.videoId;
    payload.url = `https://www.youtube.com/watch?v=${thread.videoId}&lc=${comment.id}`;
  }
  if (typeof thread.canReply === 'boolean') payload.canReply = thread.canReply;
  // Stated per event rather than inferred later: a consumer counting replies off
  // this stream needs to know when the count it can see is short of the truth.
  if (!threadRepliesAreComplete(thread)) {
    payload.repliesTruncated = true;
    payload.totalReplyCount = thread.totalReplyCount;
  }

  return {
    externalId: comment.id,
    event: youtubeCommentEventName(comment),
    occurredAt,
    payload,
    dedupeKey: youtubeCommentDedupeKey(comment),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface YouTubeCommentsAdapterDeps {
  client: YouTubeCommentThreadsClient;
  /** Threads per call. Clamped by `clampYouTubeCommentThreadsMaxResults`. */
  pageSize?: number;
  /** How many pages one rescan will walk before stopping. THE bound on this stream. */
  maxPages?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RETRIES = 4;

/** One comment paired with the thread it was read from. */
interface CommentInThread {
  comment: YouTubeRawComment;
  thread: YouTubeRawCommentThread;
}

export class YouTubeCommentsAdapter implements SocialAdapter {
  readonly platformId = 'youtube' as const;

  /** See the activities adapter: D-022 means two adapters answer `platformId === 'youtube'`. */
  readonly streamId = 'comments' as const;

  private readonly client: YouTubeCommentThreadsClient;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: YouTubeCommentsAdapterDeps) {
    this.client = deps.client;
    this.pageSize = clampYouTubeCommentThreadsMaxResults(deps.pageSize);
    this.maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const delay = youtubeRetryDelayMs(error, attempt, this.maxRetries);
        if (delay === null) throw error;
        await this.sleep(delay);
      }
    }
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isYouTubeCommentsCursor(ctx.cursor) ? ctx.cursor : null;

    const threads = await this.walk(ctx);
    const comments = this.flatten(threads);

    const emitted = await this.emitAll(comments, stored, ctx);
    const cursor = this.nextCursor(comments, stored);

    return { cursor, emitted, ...this.declarePath(hadStoredCursor, hadStoredCursor && stored === null) };
  }

  /**
   * Declare which route closed the gap.
   *
   * ANY stored cursor produces `backfill`, INCLUDING on a pass that emitted
   * nothing. This follows the doctrine the Mastodon adapter established:
   * `live-only` asserts "the cursor was accepted and the provider had nothing to
   * replay", which is a claim about server-side replay that this stream cannot
   * support. Reporting it would tell an operator the provider is covering gaps
   * when only our own bounded re-read is — the false comfort D-005 exists to
   * prevent.
   *
   * ⚠ CORRECTED 2026-08-23 (P-016). This method previously returned
   * `no-replay-supported` for an UNREADABLE stored cursor too, and the comment
   * here argued for that: the watermark is never sent anywhere, so no provider
   * ever rejected it, and naming it `cursor-rejected` would send a reader
   * hunting for an API error that was never produced.
   *
   * That argument was wrong about what the field MEANS, and the conformance kit
   * settled it in the other direction while P-015 was closing. `cursor-rejected`
   * denotes the LOCAL invalid-cursor condition — the kit's own words are that an
   * adapter must "identify the local invalid-cursor condition as rejected state,
   * EVEN WHEN THE PROVIDER ITSELF NEVER SAW THE CURSOR" — and the Reddit adapter
   * already read it that way. Collapsing the two cases cost the one distinction
   * that matters operationally: `no-replay-supported` is the steady state and
   * fires on every single tick, so an alert keyed on it is noise, whereas losing
   * persisted state is rare and worth waking someone for. Reporting both
   * identically made the rarer, more serious event undetectable.
   */
  private declarePath(
    hadStoredCursor: boolean,
    cursorUnreadable: boolean,
  ): Pick<SocialReconcileResult, 'path' | 'backfillReason'> {
    if (!hadStoredCursor) return { path: 'cold-start' as SocialReconcilePath };
    return {
      path: 'backfill',
      backfillReason: (cursorUnreadable ? 'cursor-rejected' : 'no-replay-supported') as SocialBackfillReason,
    };
  }

  /**
   * Re-read the window from the top.
   *
   * `pageToken` lives entirely inside this walk and is never persisted: it
   * identifies a page within THIS query's result set, so carrying it across an
   * offline gap would resume into a page of a result set that no longer exists.
   * On a stream with no time filter that mistake is especially inviting, because
   * a stored pageToken LOOKS like the incremental cursor this endpoint does not
   * have (D-021).
   */
  private async walk(ctx: SocialReconcileContext): Promise<YouTubeRawCommentThread[]> {
    const collected: YouTubeRawCommentThread[] = [];
    let pageToken: string | null = null;
    let pages = 0;

    while (pages < this.maxPages) {
      if (ctx.signal?.aborted) break;
      const token: string | null = pageToken;
      const page: YouTubeCommentThreadsPage = await this.withRetry(() =>
        this.client.listCommentThreads({ pageToken: token, maxResults: this.pageSize, signal: ctx.signal }),
      );
      pages += 1;
      collected.push(...page.items);

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    return collected;
  }

  /**
   * Every comment the pass read, top-level and replies alike, each paired with
   * its thread.
   *
   * Replies are ingested rather than ignored because the write verb this
   * platform declares is `reply` — an integration that can reply but cannot see
   * that someone replied back is half a conversation. They cost nothing extra:
   * `replies.comments[]` arrives inside the same 1-unit call.
   */
  private flatten(threads: YouTubeRawCommentThread[]): CommentInThread[] {
    const out: CommentInThread[] = [];
    for (const thread of threads) {
      out.push({ comment: thread.topLevelComment, thread });
      for (const reply of thread.replies ?? []) out.push({ comment: reply, thread });
    }
    return out;
  }

  /**
   * Filter to what is genuinely new, order it, and emit oldest-first.
   *
   * The provider's ordering is never trusted — `order=time` is undocumented as
   * to what it tracks (see the file header), so this sorts client-side and takes
   * no early exit.
   */
  private async emitAll(
    comments: CommentInThread[],
    stored: YouTubeCommentsCursor | null,
    ctx: SocialReconcileContext,
  ): Promise<number> {
    const watermarkMs = stored ? youtubeInstantMs(stored.watermark) : null;
    const boundary = new Set(stored?.boundaryIds ?? []);

    const fresh: CommentInThread[] = [];
    const seen = new Set<string>();
    for (const entry of comments) {
      const at = youtubeInstantMs(youtubeCommentEffectiveAt(entry.comment));
      // An unparseable provider timestamp is emitted rather than dropped: it
      // cannot be placed against the watermark, and losing a real comment over a
      // formatting problem is the worse failure. It sorts last and cannot move
      // the cursor.
      if (at !== null && watermarkMs !== null) {
        if (at < watermarkMs) continue;
        if (at === watermarkMs && boundary.has(entry.comment.id)) continue;
      }
      // A thread can legitimately appear twice across a multi-page walk when the
      // list shifts under it, which would otherwise emit its comments twice.
      const key = youtubeCommentDedupeKey(entry.comment);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(entry);
    }

    fresh.sort((a, b) => {
      const left = youtubeInstantMs(youtubeCommentEffectiveAt(a.comment));
      const right = youtubeInstantMs(youtubeCommentEffectiveAt(b.comment));
      if (left === null || right === null) {
        if (left === right) return a.comment.id.localeCompare(b.comment.id);
        return left === null ? 1 : -1;
      }
      if (left !== right) return left - right;
      return a.comment.id.localeCompare(b.comment.id);
    });

    for (const entry of fresh) {
      await ctx.emit(normalizeYouTubeComment(entry.comment, entry.thread));
    }
    return fresh.length;
  }

  /**
   * Advance the watermark to the newest effective instant READ this pass —
   * including comments filtered out as already-emitted boundary duplicates,
   * since they are still evidence of how far the read got.
   *
   * When the watermark does not move, the stored `boundaryIds` are CARRIED
   * FORWARD rather than recomputed: dropping them on a pass that read nothing
   * new would re-admit exactly the comments they exist to suppress, and this
   * stream re-reads the whole window every pass, so that mistake would re-emit
   * the boundary on every single tick rather than occasionally.
   */
  private nextCursor(
    comments: CommentInThread[],
    stored: YouTubeCommentsCursor | null,
  ): YouTubeCommentsCursor | null {
    let newest = stored?.watermark ?? null;
    let newestMs = youtubeInstantMs(newest);

    for (const { comment } of comments) {
      const value = youtubeCommentEffectiveAt(comment);
      const at = youtubeInstantMs(value);
      if (at === null) continue;
      if (newestMs === null || at > newestMs) {
        newestMs = at;
        newest = value;
      }
    }

    if (newest === null || newestMs === null) return stored;

    const atBoundary = comments
      .filter(({ comment }) => youtubeInstantMs(youtubeCommentEffectiveAt(comment)) === newestMs)
      .map(({ comment }) => comment.id);
    const carried = stored && youtubeInstantMs(stored.watermark) === newestMs ? stored.boundaryIds : [];

    return {
      watermark: newest,
      boundaryIds: [...new Set([...carried, ...atBoundary])].sort(),
    };
  }
}
