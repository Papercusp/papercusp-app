/**
 * The Facebook Pages COMMENTS adapter — P-016, the second read stream (D-026).
 *
 * WHY THIS IS A FAN-OUT AND NOT A POLL. Every other comment stream in this plan
 * is addressable in one request: YouTube has `commentThreads.list` scoped to a
 * channel, Reddit and Mastodon expose account-level notification streams.
 * Facebook does not. The `/comments` edge is documented as "common to multiple
 * Graph API nodes" — Album, Comment, Event, Link, Live Video, Photo, Post,
 * Thread, User, Video — and the PAGE node is not among them. There is no
 * page-wide comments edge, so "what did people say on my Page" is one call PER
 * TRACKED POST (D-026).
 *
 * That shape has a consequence worth stating plainly: the cost of this stream
 * scales with the number of posts under watch, not with the number of comments
 * received. A Page that posts often and is replied to rarely is the expensive
 * case. It compounds with D-028's dynamic budget — "4800 * Number of Engaged
 * Users" per rolling 24 hours — because a Page quiet enough to have a small
 * allowance still has to have each of its recent posts polled. The watch window
 * is therefore an explicit, bounded, declared input rather than "all posts".
 *
 * ⚠ THE RAIL THAT MATTERS MOST IN THIS FILE (D-027). Verbatim from the vendor:
 * `/comments` "returns empty data" on Album, Photo, Post and Video when read
 * with a USER access token — not an error, an empty array. And comment ids "are
 * withheld from apps using Page Public Content Access; to access the comment IDs
 * for a Page post you must be able to perform the MODERATE task". Both degrade
 * the payload while the call still SUCCEEDS. So on this stream an empty result
 * is not evidence of absence, and no downstream check can reconstruct the
 * difference afterwards. The credential is therefore asserted BEFORE the read,
 * and the watermark is never advanced on a read this adapter was not entitled to
 * make — advancing it would turn one wrong-credential poll into permanent loss,
 * since a watermark-and-rescan replay never looks back past the mark.
 *
 * FILTER: the DEFAULT UNDER-FETCHES. `filter` is an "enum { toplevel, stream }".
 * `toplevel` — "This is the default. It returns all top-level comments in
 * chronological order". `stream` — "All-level comments in `chronological` order",
 * described as being for "comment moderation tools". Taking the default would
 * silently drop every reply-to-a-reply, which is precisely the silent-loss
 * failure D-025 rules against, so this adapter sends `stream` explicitly and the
 * value is pinned on the REQUEST in tests rather than left to the client.
 */
import type {
  SocialAdapter,
  SocialBackfillReason,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';
import {
  FACEBOOK_TASK_MODERATE,
  type FacebookConnection,
  type FacebookPageCredential,
  assertFacebookPageCredential,
  facebookAdvanceWatermark,
  facebookIsNewAgainstWatermark,
  facebookNextPageUrl,
  isFacebookWatermarkCursor,
} from './facebook-common';

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The only `filter` value this adapter will send.
 *
 * Exported so the value is assertable from a test rather than being an
 * implementation detail buried in a client — `toplevel` is the vendor default
 * and drops nested replies, so a silent regression to it must fail loudly.
 */
export const FACEBOOK_COMMENTS_FILTER = 'stream' as const;

export interface FacebookRawComment {
  id: string;
  created_time: string;
  message?: string | null;
  from?: { id?: string | null; name?: string | null } | null;
  /** Set only on a reply. Carried verbatim, never reinterpreted as a thread id. */
  parent?: { id?: string | null } | null;
  /** "indicates whether it is possible to reply to that comment". */
  can_comment?: boolean | null;
  permalink_url?: string | null;
  like_count?: number | null;
}

export const FACEBOOK_COMMENT_FIELDS = [
  'id',
  'created_time',
  'message',
  'from',
  'parent',
  'can_comment',
  'permalink_url',
  'like_count',
] as const;

export interface FacebookCommentsPageRequest {
  credential: FacebookPageCredential;
  /** The post whose comments are being read. There is no page-wide edge. */
  postId: string;
  /** Always `stream`. See FACEBOOK_COMMENTS_FILTER. */
  filter: typeof FACEBOOK_COMMENTS_FILTER;
  pageSize: number;
  nextUrl: string | null;
}

export interface FacebookCommentsClient {
  /**
   * The bounded watch window: the posts whose comments are polled this pass.
   * Returning ALL posts is not an option this interface offers, deliberately.
   */
  listWatchedPostIds(request: { credential: FacebookPageCredential; limit: number }): Promise<string[]>;
  listComments(request: FacebookCommentsPageRequest): Promise<FacebookConnection<FacebookRawComment>>;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** A comment with a parent is a `reply`; anything else is a `comment`. */
export function facebookCommentEventName(comment: FacebookRawComment): string {
  return comment.parent?.id ? 'reply' : 'comment';
}

/**
 * `<id>@<created_time>`.
 *
 * Both halves are provider facts — no wall-clock, no randomness — so the key is
 * stable across identical passes, which the adapter contract requires.
 *
 * NOTE THE ASYMMETRY WITH POSTS, which is a vendor fact rather than an
 * inconsistency: a PagePost carries `updated_time`, so an edited post can be
 * re-surfaced under a moved key. The comment fields documented for this edge
 * carry no edit timestamp, so an edited comment is indistinguishable from its
 * original here and will NOT be re-delivered. That limit is stated in
 * FACEBOOK_COMMENTS_BOUND rather than papered over with a synthetic version.
 */
export function facebookCommentDedupeKey(comment: FacebookRawComment): string {
  return comment.id + '@' + comment.created_time;
}

export const FACEBOOK_COMMENTS_BOUND =
  'Facebook exposes no page-wide comments edge (D-026), so this stream polls one call per WATCHED POST and its cost ' +
  'scales with the size of that window rather than with comment volume. Three limits are structural, not bugs: ' +
  '(1) a comment on a post OUTSIDE the watch window is not seen; (2) the comment fields on this edge carry no edit ' +
  'timestamp, so an EDITED comment is not re-delivered — unlike a post, which carries updated_time; (3) an empty ' +
  'result is only trustworthy because the credential was asserted before the read (D-027) — with a user token, or ' +
  'without the MODERATE task, this edge returns empty data rather than failing.';

export function normalizeFacebookComment(comment: FacebookRawComment, postId: string): SocialNormalizedEvent {
  const payload: Record<string, unknown> = {
    id: comment.id,
    text: typeof comment.message === 'string' ? comment.message : '',
    occurredAt: comment.created_time,
    postId,
  };

  if (typeof comment.permalink_url === 'string' && comment.permalink_url) payload.url = comment.permalink_url;

  const author = comment.from?.name ?? comment.from?.id ?? null;
  if (typeof author === 'string' && author.length > 0) payload.author = author;

  // The canonical field for "what this is a reply to". A top-level comment
  // replies to the POST; a nested one replies to its parent comment.
  payload.replyToId = comment.parent?.id ?? postId;

  // Carried when stated. An ABSENT can_comment is deliberately NOT treated as
  // false: refusing to attempt a reply because an optional field was missing
  // turns a gap in the response into a dropped reply, which is the same
  // asymmetry D-023 settles — prefer the recoverable error over the silent one.
  if (typeof comment.can_comment === 'boolean') payload.canComment = comment.can_comment;

  if (typeof comment.message !== 'string' || comment.message.length === 0) payload.textAbsent = true;

  return {
    externalId: comment.id,
    event: facebookCommentEventName(comment),
    occurredAt: comment.created_time,
    payload,
    dedupeKey: facebookCommentDedupeKey(comment),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface FacebookCommentsAdapterDeps {
  client: FacebookCommentsClient;
  pageId: string;
  credential: FacebookPageCredential;
  /** How many recent posts to poll comments for. THE bound on this stream's cost. */
  watchWindow?: number;
  pageSize?: number;
  /** Pages of comments walked per post before stopping. */
  maxPagesPerPost?: number;
}

const DEFAULT_WATCH_WINDOW = 25;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_POST = 10;

export class FacebookCommentsAdapter implements SocialAdapter {
  readonly platformId = 'facebook-pages' as const;
  readonly streamId = 'comments' as const;

  private readonly client: FacebookCommentsClient;
  private readonly pageId: string;
  private readonly credential: FacebookPageCredential;
  private readonly watchWindow: number;
  private readonly pageSize: number;
  private readonly maxPagesPerPost: number;

  constructor(deps: FacebookCommentsAdapterDeps) {
    this.client = deps.client;
    this.pageId = deps.pageId;
    this.credential = deps.credential;
    this.watchWindow = Math.max(1, Math.trunc(deps.watchWindow ?? DEFAULT_WATCH_WINDOW));
    this.pageSize = Math.max(1, Math.trunc(deps.pageSize ?? DEFAULT_PAGE_SIZE));
    this.maxPagesPerPost = Math.max(1, Math.trunc(deps.maxPagesPerPost ?? DEFAULT_MAX_PAGES_PER_POST));
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isFacebookWatermarkCursor(ctx.cursor) ? ctx.cursor : null;

    // D-027. MODERATE specifically, not any-of: without it this edge succeeds
    // and withholds comment ids, so a weaker credential produces a believable
    // empty answer. This assertion is the only thing standing between that and
    // a permanently silent integration.
    assertFacebookPageCredential(this.credential, this.pageId, FACEBOOK_TASK_MODERATE);

    const postIds = await this.client.listWatchedPostIds({
      credential: this.credential,
      limit: this.watchWindow,
    });

    let emitted = 0;
    let cursor = stored;

    for (const postId of postIds.slice(0, this.watchWindow)) {
      ctx.signal?.throwIfAborted();
      const comments = await this.walkPost(ctx, postId);

      for (const comment of comments) {
        if (!facebookIsNewAgainstWatermark(stored, comment.created_time, comment.id)) continue;
        await ctx.emit(normalizeFacebookComment(comment, postId));
        emitted += 1;
        cursor = facebookAdvanceWatermark(cursor, comment.created_time, comment.id);
      }
    }

    return { cursor, emitted, ...this.declarePath(hadStoredCursor, hadStoredCursor && stored === null) };
  }

  /**
   * Walk one post's comments.
   *
   * As with the posts adapter, only the absence of `paging.next` or the declared
   * page bound ends this — never an empty or short page, which the vendor
   * explicitly warns can still carry a continuation.
   */
  private async walkPost(ctx: SocialReconcileContext, postId: string): Promise<FacebookRawComment[]> {
    const out: FacebookRawComment[] = [];
    let nextUrl: string | null = null;

    for (let page = 0; page < this.maxPagesPerPost; page += 1) {
      ctx.signal?.throwIfAborted();

      const connection: FacebookConnection<FacebookRawComment> = await this.client.listComments({
        credential: this.credential,
        postId,
        filter: FACEBOOK_COMMENTS_FILTER,
        pageSize: this.pageSize,
        nextUrl,
      });

      for (const comment of connection.data ?? []) {
        if (comment && typeof comment.id === 'string' && typeof comment.created_time === 'string') {
          out.push(comment);
        }
      }

      nextUrl = facebookNextPageUrl(connection);
      if (nextUrl === null) break;
    }

    return out;
  }

  /** See the posts adapter — the two backfill reasons must not collapse. */
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
}
