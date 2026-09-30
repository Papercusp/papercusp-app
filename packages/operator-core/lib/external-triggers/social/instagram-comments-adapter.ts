/**
 * Instagram comments adapter — P-017.
 *
 * ONE CALL PER WATCHED MEDIA, because comments hang off media and no
 * account-wide comments edge is documented. The cost therefore scales with the
 * watch window, not with comment volume — the same shape the Pages comments
 * stream has (D-026), reached independently from Instagram's own reference
 * rather than assumed from the sibling.
 *
 * WHAT MAKES THIS ADAPTER DIFFERENT FROM ITS PAGES SIBLING, and why the
 * difference is a correctness matter rather than a detail:
 *
 * The Pages feed is RANKED, so that adapter may never early-exit and must filter
 * every item (D-025). This edge documents "results returned in reverse
 * chronological order" for v3.2+ — a real guarantee. But it also documents
 * "Returns a maximum of 50 comments per query" and NO paging cursors at all. So
 * the guarantee does not buy an optimisation; it buys a LOSS BOUND (D-031):
 *
 *     the newest-50 window is complete if and only if fewer than 50 new comments
 *     arrived since the last poll
 *
 * Above that, the older ones are not late — they are unreachable, because the
 * API offers no way to ask for them. This adapter therefore does two things a
 * naive one would not: it still filters every item (the ordering guarantee is
 * used for the loss predicate, not for control flow), and it DECLARES the
 * overflow on the result instead of returning a healthy-looking 50.
 */

import type {
  SocialAdapter,
  SocialBackfillReason,
  SocialLossRisk,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';
import {
  INSTAGRAM_COMMENTS_MAX_PER_QUERY,
  INSTAGRAM_COMMENT_FIELDS,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SCOPE_MANAGE_COMMENTS,
  type InstagramCredential,
  type InstagramWatermark,
  assertInstagramCredential,
  instagramAdvanceWatermark,
  instagramIsNewAgainstWatermark,
  instagramIsReverseChronological,
  instagramWindowOverflowed,
  isInstagramWatermark,
} from './instagram-common';

/** One comment as the edge returns it. Field names are the vendor's. */
export interface InstagramRawComment {
  id: string;
  timestamp: string;
  text?: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
  parent_id?: string;
  replies?: { data?: InstagramRawComment[] };
}

export interface InstagramCommentsPageRequest {
  credential: InstagramCredential;
  mediaId: string;
  fields: readonly string[];
  limit: number;
}

export interface InstagramCommentsClient {
  /**
   * The media this pass should read comments for.
   *
   * Deliberately NOT "all media": the cost of this stream is exactly this list's
   * length, so the bound has to be an explicit input rather than something the
   * adapter discovers.
   */
  listWatchedMediaIds(args: { credential: InstagramCredential; limit: number }): Promise<string[]>;

  /**
   * GET /{ig-media-id}/comments.
   *
   * Returns the raw array. There is no paging parameter because the edge
   * documents none — that absence is load-bearing, not an omission here.
   */
  listComments(request: InstagramCommentsPageRequest): Promise<InstagramRawComment[]>;
}

/**
 * A reply is a genuinely different event from a top-level comment: it is
 * addressed at a conversation rather than at the media, and a triage plan will
 * usually want to treat the two differently. `parent_id` is the vendor's own
 * discriminator — "ID of the parent IG Comment if this comment was created on
 * another IG Comment".
 */
export function instagramCommentEventName(comment: InstagramRawComment): string {
  return typeof comment.parent_id === 'string' && comment.parent_id !== '' ? 'reply' : 'comment';
}

/**
 * The dedupe key.
 *
 * The IG Comment node carries NO edit timestamp — the fields are id, timestamp,
 * text, username, like_count, hidden, parent_id, replies, from, media, user —
 * so there is no version marker to fold in and an edited comment is simply not
 * re-delivered. The id alone is therefore the honest key: adding anything
 * mutable (like_count moves constantly) would re-deliver the same comment every
 * time somebody liked it.
 */
export function instagramCommentDedupeKey(comment: InstagramRawComment): string {
  return `instagram:comment:${comment.id}`;
}

export function normalizeInstagramComment(
  comment: InstagramRawComment,
  mediaId: string,
): SocialNormalizedEvent {
  return {
    externalId: comment.id,
    event: instagramCommentEventName(comment),
    occurredAt: comment.timestamp ?? null,
    dedupeKey: instagramCommentDedupeKey(comment),
    payload: {
      // The canonical `social-post` field names (D-004), not Instagram's. An
      // OPTIONAL field the vendor did not give us is OMITTED rather than set to
      // null: the schema types `url` as a string, so a null would be a schema
      // violation dressed up as completeness — and the conformance kit's payload
      // check catches exactly that.
      id: comment.id,
      text: comment.text ?? '',
      occurredAt: comment.timestamp,
      ...(comment.username ? { author: comment.username } : {}),
      ...(comment.parent_id ? { replyToId: comment.parent_id } : {}),
      // Platform-specific extras ride alongside (the datatype allows them) so a
      // plan can act on them without a second fetch.
      platform: 'instagram',
      kind: instagramCommentEventName(comment),
      subjectId: mediaId,
      ...(typeof comment.like_count === 'number' ? { likeCount: comment.like_count } : {}),
      ...(comment.hidden === true ? { hidden: true } : {}),
    },
  };
}

/**
 * Flatten a comment and its expanded replies into one list.
 *
 * `replies` is requested through field expansion because the edge "Returns only
 * top-level comments" by default — so without this every nested reply would be
 * silently absent, and the integration would look like it worked.
 */
export function flattenInstagramComments(page: readonly InstagramRawComment[]): InstagramRawComment[] {
  const out: InstagramRawComment[] = [];
  for (const comment of page) {
    if (!comment || typeof comment.id !== 'string' || typeof comment.timestamp !== 'string') continue;
    out.push(comment);
    for (const reply of comment.replies?.data ?? []) {
      if (reply && typeof reply.id === 'string' && typeof reply.timestamp === 'string') {
        out.push({ ...reply, parent_id: reply.parent_id ?? comment.id });
      }
    }
  }
  return out;
}

export interface InstagramCommentsAdapterDeps {
  client: InstagramCommentsClient;
  igUserId: string;
  credential: InstagramCredential;
  /** How many recent media to poll. THE bound on this stream's cost. */
  watchWindow?: number;
  /** Overridable only for tests; the real value is the vendor's documented cap. */
  maxPerQuery?: number;
}

const DEFAULT_WATCH_WINDOW = 25;

export class InstagramCommentsAdapter implements SocialAdapter {
  readonly platformId = 'instagram' as const;
  readonly streamId = 'comments' as const;

  private readonly client: InstagramCommentsClient;
  private readonly igUserId: string;
  private readonly credential: InstagramCredential;
  private readonly watchWindow: number;
  private readonly maxPerQuery: number;

  constructor(deps: InstagramCommentsAdapterDeps) {
    this.client = deps.client;
    this.igUserId = deps.igUserId;
    this.credential = deps.credential;
    this.watchWindow = Math.max(1, Math.trunc(deps.watchWindow ?? DEFAULT_WATCH_WINDOW));
    this.maxPerQuery = Math.max(1, Math.trunc(deps.maxPerQuery ?? INSTAGRAM_COMMENTS_MAX_PER_QUERY));
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isInstagramWatermark(ctx.cursor) ? ctx.cursor : null;

    // BEFORE the read, not after (D-027 re-derived for Instagram). Under-privilege
    // on this surface omits rather than refuses — restricted users' comments are
    // "withheld", age-gated media comments "aren't returned", and `username`
    // needs this very scope since 2024-08-27. An incomplete answer that arrives
    // as a 200 cannot be detected downstream, so it has to be prevented here.
    assertInstagramCredential(this.credential, this.igUserId, INSTAGRAM_SCOPE_MANAGE_COMMENTS);

    const mediaIds = await this.client.listWatchedMediaIds({
      credential: this.credential,
      limit: this.watchWindow,
    });

    let emitted = 0;
    let cursor: InstagramWatermark | null = stored;
    let overflows = 0;
    const overflowed: string[] = [];

    for (const mediaId of mediaIds.slice(0, this.watchWindow)) {
      ctx.signal?.throwIfAborted();

      const page = await this.client.listComments({
        credential: this.credential,
        mediaId,
        fields: INSTAGRAM_COMMENT_FIELDS,
        limit: this.maxPerQuery,
      });

      // The predicate runs on the TOP-LEVEL page, which is what the cap counts.
      // Running it on the flattened list would let expanded replies inflate the
      // count past the cap and mask a real overflow.
      if (instagramWindowOverflowed(page, stored, this.maxPerQuery)) {
        overflows += 1;
        overflowed.push(mediaId);
      }

      for (const comment of flattenInstagramComments(page)) {
        // Every item is filtered. The ordering guarantee is used for the loss
        // predicate above, NEVER as a licence to stop early: expanded replies
        // arrive nested inside their parent and carry their own timestamps, so
        // the flattened sequence is not ordered even though the page is.
        if (!instagramIsNewAgainstWatermark(stored, comment.timestamp, comment.id)) continue;
        await ctx.emit(normalizeInstagramComment(comment, mediaId));
        emitted += 1;
        cursor = instagramAdvanceWatermark(cursor, comment.timestamp, comment.id);
      }
    }

    return {
      cursor,
      emitted,
      ...this.declarePath(hadStoredCursor, hadStoredCursor && stored === null),
      ...(overflows > 0 ? { lossRisk: this.declareLoss(overflows, overflowed, stored === null) } : {}),
    };
  }

  private declareLoss(
    occurrences: number,
    mediaIds: readonly string[],
    coldStart: boolean,
  ): SocialLossRisk {
    const shown = mediaIds.slice(0, 5).join(', ');
    const more = mediaIds.length > 5 ? ` (+${mediaIds.length - 5} more)` : '';
    // The condition is the same in both cases and the remedy is not, so the
    // caller is told which one it is rather than left to infer it from `path`.
    const because = coldStart
      ? `history was truncated at the cap on first read: everything older than the newest ${this.maxPerQuery} was never reachable`
      : `the oldest comment on the page is still newer than the stored watermark, so comments between the two fell off the end`;
    const remedy = coldStart
      ? 'This is a bounded start, not a regression — but it is a real gap, so treat the account as watched-from-now rather than fully read.'
      : 'Poll more often, or narrow the watch window.';
    return {
      kind: 'capped-window-overflow',
      occurrences,
      detail:
        `${occurrences} media returned a full ${this.maxPerQuery}-comment page and ${because}. The edge documents no ` +
        `paging and states "Comments cannot be filtered by timestamp", so the gap is permanent. ${remedy} ` +
        `Media: ${shown}${more}. (Graph ${INSTAGRAM_GRAPH_VERSION}, reverse-chronological: ` +
        `${instagramIsReverseChronological(INSTAGRAM_GRAPH_VERSION)})`,
    };
  }

  /**
   * The two backfill reasons must not collapse — see the Pages adapters.
   * `no-replay-supported` is the honest steady-state answer here: the platform
   * has no cursor concept at all, so a stored watermark being usable does not
   * make this a cursor replay.
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
}
