/**
 * Threads replies → normalized events (P-018).
 *
 * THE ONE SENTENCE THAT SHAPES THIS FILE: Threads is `watermark-rescan` like
 * Instagram, and unlike Instagram it loses nothing. Both platforms refuse a
 * server-side time filter, so both must re-read from the newest entry and stop
 * client-side at a stored mark. But Instagram's comments edge is capped at 50
 * with no paging documented, which turns that into a permanent loss bound
 * (D-031); both Threads media edges are documented as paginated, return
 * `paging.cursors.before/after`, and state no cap at all. So the rescan here can
 * page backwards until it reaches the watermark.
 *
 * THEREFORE THIS ADAPTER NEVER SETS `lossRisk`, and that is a verified fact
 * rather than an adapter declining to compute the predicate (D-036). The
 * temptation to port `instagramWindowOverflowed` across is exactly the mistake:
 * on a pageable edge the predicate has no meaning, and a "full page" is a page,
 * not evidence of anything.
 *
 * WHICH EDGE, AND WHY IT MATTERS. "GET {media-id}/replies only returns the
 * top-level replies under the Threads ID provided in the request, while GET
 * {media-id}/conversation returns all replies, regardless of the depth."
 * `conversation` is taken because a flattened all-depth read IS the ingestion
 * shape; the alternative is walking `has_replies` down the tree with a call per
 * level, which multiplies cost by depth for the same events. Its documented
 * caveat — "This endpoint is only intended to be used on the root-level threads
 * with replies" — is why the client's watch list is root media ids.
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
  isSocialWatermarkCursor,
  socialAdvanceWatermark,
  socialInstantMs,
  socialIsNewAgainstWatermark,
  type SocialWatermarkCursor,
} from './social-watermark';
import {
  assertThreadsCredential,
  THREADS_REPLY_FIELDS,
  THREADS_SCOPE_READ_REPLIES,
  type ThreadsCredential,
} from './threads-common';

/** One reply as the conversation edge returns it. */
export interface ThreadsRawReply {
  id: string;
  timestamp?: string;
  text?: string;
  username?: string;
  permalink?: string;
  media_type?: string;
  has_replies?: boolean;
  /** "Media ID of the top-level post or original thread in the reply tree". */
  root_post?: string | { id?: string };
  /** "Media ID of the immediate parent of the reply". */
  replied_to?: string | { id?: string };
  is_reply?: boolean;
  is_reply_owned_by_me?: boolean;
  hide_status?: string;
}

export interface ThreadsConversationPage {
  data: ThreadsRawReply[];
  /**
   * `paging.cursors.after`, when the provider returned one.
   *
   * ⚠ USED WITHIN ONE RESCAN AND NEVER PERSISTED. The docs show cursors only in
   * sample responses and never state how to pass one, and an `after` on a
   * reverse-chronological list addresses a position inside THIS result set, not
   * a position in a stream — the same trap the registry records against
   * YouTube's pageToken. Persisting it as a resume point would silently pin the
   * integration to a snapshot of the past.
   */
  nextCursor: string | null;
}

export interface ThreadsConversationRequest {
  credential: ThreadsCredential;
  mediaId: string;
  fields: readonly string[];
  /** Documented on both media edges; true is the provider's own default. */
  reverse: boolean;
  /** The previous page's `after`, or null for the first page of this pass. */
  after: string | null;
}

export interface ThreadsConversationClient {
  /**
   * The ROOT media this pass should read conversations for.
   *
   * Root-level on purpose: the conversation edge states it "is only intended to
   * be used on the root-level threads with replies". Handing it a reply id is
   * outside its documented contract, so the bound is an explicit input rather
   * than something the adapter infers.
   */
  listWatchedRootMediaIds(args: { credential: ThreadsCredential; limit: number }): Promise<string[]>;

  /** GET /{threads-media-id}/conversation, one page. */
  listConversation(request: ThreadsConversationRequest): Promise<ThreadsConversationPage>;
}

/** Unwrap a field the Graph may spell as a bare id or as an expanded node. */
function refId(value: string | { id?: string } | undefined): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

/**
 * Every item on this edge IS a reply — that is what the edge returns — so the
 * event name does not vary the way Instagram's comment/reply split does. It is
 * still derived rather than hardcoded, because `is_reply` is the vendor's own
 * discriminator and a root post appearing here would be a real surprise worth
 * naming rather than silently relabelling.
 */
export function threadsReplyEventName(reply: ThreadsRawReply): string {
  return reply.is_reply === false ? 'post' : 'reply';
}

/**
 * The dedupe key.
 *
 * The reply node carries NO edit marker — the documented fields are id, text,
 * username, permalink, timestamp, media_*, children, is_quote_post,
 * quoted_post, has_replies, root_post, replied_to, is_reply,
 * is_reply_owned_by_me, hide_status, reply_audience, gif_url, poll_attachment,
 * topic_tag, is_verified, profile_picture_url — so there is no version to fold
 * in and an edited reply is simply not re-delivered. The id alone is the honest
 * key. `hide_status` is deliberately EXCLUDED despite being mutable: folding it
 * in would re-deliver a reply every time a moderator hid or unhid it.
 */
export function threadsReplyDedupeKey(reply: ThreadsRawReply): string {
  return `threads:reply:${reply.id}`;
}

/**
 * @param rootOwnerId The profile whose root post this reply was ingested from.
 *   Carried into the payload because the WRITE path's ownership gate (D-039) is
 *   evaluated against the ROOT post's owner, and this is the only moment that
 *   fact is known: the adapter reads conversations for root media belonging to
 *   the connected profile, so ownership is established by CONSTRUCTION here and
 *   is unrecoverable from the reply node afterwards (`is_reply_owned_by_me`
 *   describes the REPLY, not the root). Without this a later reply attempt
 *   could only guess, and the gate refuses a guess.
 */
export function normalizeThreadsReply(
  reply: ThreadsRawReply,
  rootMediaId: string,
  rootOwnerId: string,
): SocialNormalizedEvent {
  const parent = refId(reply.replied_to);
  const root = refId(reply.root_post) ?? rootMediaId;
  return {
    externalId: reply.id,
    event: threadsReplyEventName(reply),
    occurredAt: reply.timestamp ?? null,
    dedupeKey: threadsReplyDedupeKey(reply),
    payload: {
      // Canonical `social-post` names (D-004), not Threads'. An OPTIONAL field
      // the vendor did not send is OMITTED rather than nulled — the schema types
      // these as strings, so a null is a schema violation wearing the costume of
      // completeness, and the conformance kit's payload check catches it.
      id: reply.id,
      text: reply.text ?? '',
      occurredAt: reply.timestamp,
      ...(reply.username ? { author: reply.username } : {}),
      // THE IMMEDIATE PARENT, NOT THE ROOT. Threads addresses nested replies
      // exactly (D-035) where Instagram silently re-parents them to top level
      // (D-031), so flattening this to the root here would throw away the one
      // piece of information that makes a correct nested reply possible later.
      ...(parent ? { replyToId: parent } : {}),
      ...(reply.permalink ? { url: reply.permalink } : {}),
      platform: 'threads',
      kind: threadsReplyEventName(reply),
      subjectId: root,
      subjectOwnerId: rootOwnerId,
      ...(reply.has_replies === true ? { hasReplies: true } : {}),
      ...(reply.is_reply_owned_by_me === true ? { ownedByMe: true } : {}),
      // Carried because the write path's ownership gate (D-039) is checked
      // against the ROOT post's owner, and this is where a caller learns it.
      ...(reply.hide_status && reply.hide_status !== 'NOT_HUSHED' ? { hideStatus: reply.hide_status } : {}),
    },
  };
}

export interface ThreadsConversationAdapterDeps {
  client: ThreadsConversationClient;
  userId: string;
  credential: ThreadsCredential;
  /** How many recent ROOT media to poll. THE bound on this stream's cost. */
  watchWindow?: number;
  /**
   * Runaway guard ONLY — not a window, and never a silent truncation.
   *
   * The rescan is bounded by the caller's `AbortSignal`, which the contract
   * provides for exactly this ("cooperative cancellation for a long backfill").
   * This exists solely so a provider that returns an endless cursor chain fails
   * loudly instead of looping forever. Hitting it THROWS rather than returning a
   * short result, because returning would advance the watermark past replies
   * that were never read — inventing the very loss this platform does not have.
   */
  maxPagesPerMedia?: number;
}

const DEFAULT_WATCH_WINDOW = 25;
const DEFAULT_MAX_PAGES_PER_MEDIA = 50;

export class ThreadsConversationAdapter implements SocialAdapter {
  readonly platformId = 'threads' as const;
  readonly streamId = 'replies' as const;

  private readonly client: ThreadsConversationClient;
  private readonly userId: string;
  private readonly credential: ThreadsCredential;
  private readonly watchWindow: number;
  private readonly maxPagesPerMedia: number;

  constructor(deps: ThreadsConversationAdapterDeps) {
    this.client = deps.client;
    this.userId = deps.userId;
    this.credential = deps.credential;
    this.watchWindow = Math.max(1, Math.trunc(deps.watchWindow ?? DEFAULT_WATCH_WINDOW));
    this.maxPagesPerMedia = Math.max(1, Math.trunc(deps.maxPagesPerMedia ?? DEFAULT_MAX_PAGES_PER_MEDIA));
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isSocialWatermarkCursor(ctx.cursor) ? ctx.cursor : null;

    // BEFORE the read (D-027, and Threads is the sharpest case of it). An
    // under-privileged read on this family of surfaces returns EMPTY rather than
    // erroring, and Threads documents NO error codes at all — so there is
    // nothing in a response to classify even in principle. A missing
    // threads_read_replies would present as "this profile has no replies",
    // forever, and identically to a healthy quiet account.
    assertThreadsCredential(this.credential, this.userId, THREADS_SCOPE_READ_REPLIES);

    const rootIds = await this.client.listWatchedRootMediaIds({
      credential: this.credential,
      limit: this.watchWindow,
    });

    let emitted = 0;
    let cursor: SocialWatermarkCursor | null = stored;

    for (const mediaId of rootIds.slice(0, this.watchWindow)) {
      ctx.signal?.throwIfAborted();
      cursor = await this.drainMedia(ctx, mediaId, stored, cursor, (n) => {
        emitted += n;
      });
    }

    return {
      cursor,
      emitted,
      ...this.declarePath(hadStoredCursor, hadStoredCursor && stored === null),
      // No `lossRisk`, deliberately and verifiably. See the file header: the
      // edge pages, so there is no capped window to overflow.
    };
  }

  /**
   * Page one root media newest-first, stopping as soon as the window has
   * demonstrably reached back past the watermark.
   *
   * THE STOP RULE IS "STRICTLY OLDER", NOT "AT OR OLDER", AND THE DIFFERENCE IS
   * A REAL BUG. Timestamps here have one-second resolution, so several replies
   * routinely share the watermark's exact instant. Stopping at the first item
   * whose instant EQUALS the mark would skip its unseen siblings at that same
   * instant permanently. Items at the mark are therefore examined — the cursor's
   * `boundaryIds` decides each one individually — and only a strictly older item
   * proves the window has covered the gap.
   *
   * Early exit is legitimate here where it is NOT on Instagram's adapter,
   * because `reverse` is a documented sort over an ALREADY-FLAT list. Instagram
   * must filter every item instead: its replies arrive nested inside their
   * parents, so its flattened sequence is not ordered even though its page is.
   */
  private async drainMedia(
    ctx: SocialReconcileContext,
    mediaId: string,
    stored: SocialWatermarkCursor | null,
    cursorIn: SocialWatermarkCursor | null,
    countEmitted: (n: number) => void,
  ): Promise<SocialWatermarkCursor | null> {
    const mark = stored ? socialInstantMs(stored.watermark) : null;
    let cursor = cursorIn;
    let after: string | null = null;
    let pages = 0;

    for (;;) {
      ctx.signal?.throwIfAborted();

      if (pages >= this.maxPagesPerMedia) {
        // Loud, not silent. Returning here would advance the watermark past
        // replies that were never read.
        throw new Error(
          `threads_conversation_runaway: ${mediaId} returned more than ${this.maxPagesPerMedia} pages without ` +
            'reaching the stored watermark. The rescan was abandoned WITHOUT advancing the cursor, so nothing is ' +
            'lost and the next pass will retry; a provider paging endlessly is a fault, not a backlog.',
        );
      }

      const page = await this.client.listConversation({
        credential: this.credential,
        mediaId,
        fields: THREADS_REPLY_FIELDS,
        // Newest-first: the whole point of a rescan is to reach backwards only
        // as far as the watermark.
        reverse: true,
        after,
      });
      pages += 1;

      let reachedWatermark = false;
      for (const reply of page.data) {
        if (!reply || typeof reply.id !== 'string' || reply.id === '') continue;

        const at = socialInstantMs(reply.timestamp);
        if (mark !== null && at !== null && at < mark) {
          reachedWatermark = true;
          break;
        }

        // Filtered against the ORIGINAL mark, never against the advancing one —
        // otherwise the first emission of this pass would raise the bar for
        // every item behind it.
        if (!socialIsNewAgainstWatermark(stored, reply.timestamp, reply.id)) continue;

        await ctx.emit(normalizeThreadsReply(reply, mediaId, this.userId));
        countEmitted(1);
        cursor = socialAdvanceWatermark(cursor, reply.timestamp, reply.id);
      }

      if (reachedWatermark) break;
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }

    return cursor;
  }

  /**
   * `no-replay-supported` is the honest steady-state answer: Threads has no
   * stream cursor concept at all, so a usable stored WATERMARK does not make a
   * pass a cursor replay. The two backfill reasons must not collapse — a
   * rejected cursor is a fault to investigate, an unsupported one is Tuesday.
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
