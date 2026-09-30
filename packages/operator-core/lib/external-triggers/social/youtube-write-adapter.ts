/**
 * The YouTube WRITE adapter — P-015 stage 4.
 *
 * ONE VERB, AND THE REGISTRY IS RIGHT TO DECLARE ONLY ONE. `comments.insert`
 * REQUIRES `snippet.parentId` ("Replies must be linked to a parent comment"),
 * so this endpoint can only ever create a REPLY — it cannot open a new thread.
 * That is why the registry row declares `verbs: ['reply']` and why `post` stays
 * undeclared: not caution, but the shape of the API. Creating a top-level
 * comment is `commentThreads.insert`, a different endpoint that D-005 discipline
 * says stays undeclared until its write shape is verified.
 *
 * FACTS THIS FILE ENCODES, read from the comments.insert vendor page on
 * 2026-08-23 — from the WRITER, not from the registry row and not from recall:
 *
 *   - `POST https://www.googleapis.com/youtube/v3/comments`, `part=snippet`.
 *   - Required body properties: `snippet.textOriginal` AND `snippet.parentId`.
 *   - "A call to this method has a quota cost of 50 units." Against the GENERAL
 *     bucket (D-020) — the same 10,000/day pool the two read streams draw on,
 *     which is why a reply is ~50x a poll and belongs under a per-verb cap
 *     (P-015 stage 5).
 *   - Scope: `https://www.googleapis.com/auth/youtube.force-ssl`, the ONLY scope
 *     listed. Per D-019 it also confers delete rights, which is why it is
 *     requested per-capability rather than in the default Workspace set.
 *   - Documented errors, mapped below: 400 `commentTextRequired`,
 *     `commentTextTooLong`, `invalidCustomEmoji`, `invalidCommentMetadata`,
 *     `operationNotSupported`, `parentCommentIsPrivate`, `parentIdMissing`,
 *     `processingFailure`; 403 `forbidden`, `ineligibleAccount`;
 *     404 `parentCommentNotFound`.
 *   - NO idempotency key, NO client-supplied id, NO server-side duplicate
 *     detection. The page documents none, and the registry records
 *     `idempotency: 'none'` for exactly that reason.
 *
 * ⚠ `operationNotSupported` IS PRE-CHECKABLE, AND THAT IS WHY THE READ ADAPTER
 * CARRIES `canReply`. The vendor page defines that error as the caller not being
 * able to reply to the top-level comment, and names the remedy: check
 * `snippet.canReply` on the commentThread. The comments read adapter already
 * stores that flag on every emitted payload, so this adapter refuses locally
 * rather than spending 50 units to be told no. A 400 that could have been a
 * local assertion is quota burned to learn something we already knew.
 */
import type {
  SocialReplyCapableAdapter,
  SocialReplyOutcome,
  SocialReplyRequest,
} from '../../capability-verbs/social';
import type { OutboundContext } from '../../capability-verbs/resolve';

/* -------------------------------------------------------------------------- */
/* Quota                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "A call to this method has a quota cost of 50 units."
 *
 * Recorded as a constant rather than a comment because P-015 stage 5 derives a
 * per-verb storm cap from it, and a cap derived from `quotaUnitsPerDay` alone
 * would treat a reply as costing the same as a poll — off by a factor of 50,
 * in the direction that spends the whole day's budget in 200 replies.
 *
 * The same page separately notes "The `snippet` part has a quota cost of 2
 * units". The two figures are not summed here: 50 is the page's stated cost for
 * a CALL to this method, and inventing 52 would be arithmetic the vendor did not
 * publish.
 */
export const YOUTUBE_COMMENT_INSERT_UNITS = 50;

/** The only scope comments.insert accepts. D-019 keeps it per-capability. */
export const YOUTUBE_COMMENT_INSERT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A Data API error carrying its documented `reason`.
 *
 * The reason is kept as a distinct field rather than folded into the message
 * because the retry decision depends on it and nothing else: `processingFailure`
 * may be worth another attempt, `parentCommentIsPrivate` never is, and a
 * substring match against a human-readable message is how that distinction gets
 * lost the first time Google rewords one.
 */
export class YouTubeWriteError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message?: string) {
    super(message ?? `${status} ${reason}`);
    this.name = 'YouTubeWriteError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Reasons that can NEVER succeed on a retry, so a caller must not schedule one.
 *
 * Deliberately an allow-list of the terminal cases rather than a deny-list of
 * the retryable ones: an unrecognised future reason then defaults to
 * "not known to be terminal", which costs one wasted retry, instead of
 * defaulting to terminal and silently dropping a reply that would have gone
 * through.
 */
export const YOUTUBE_TERMINAL_WRITE_REASONS: ReadonlySet<string> = new Set([
  'commentTextRequired',
  'commentTextTooLong',
  'invalidCustomEmoji',
  'invalidCommentMetadata',
  'operationNotSupported',
  'parentCommentIsPrivate',
  'parentIdMissing',
  'parentCommentNotFound',
  'ineligibleAccount',
  'forbidden',
]);

export function isTerminalYouTubeWriteError(error: unknown): boolean {
  return error instanceof YouTubeWriteError && YOUTUBE_TERMINAL_WRITE_REASONS.has(error.reason);
}

/* -------------------------------------------------------------------------- */
/* Client port                                                                */
/* -------------------------------------------------------------------------- */

export interface YouTubeInsertedComment {
  /** The server-assigned comment id. There is no client-supplied id. */
  id: string;
  /** `snippet.parentId`, echoed back. */
  parentId?: string | null;
}

export interface YouTubeWriteClient {
  /**
   * `POST /youtube/v3/comments?part=snippet`.
   *
   * NOTE WHAT THIS SIGNATURE CANNOT EXPRESS: there is no idempotency key and no
   * client-supplied id, because the endpoint has neither. A port that accepted
   * one would imply a safety this API does not provide.
   */
  insertComment(params: {
    parentId: string;
    textOriginal: string;
    signal?: AbortSignal;
  }): Promise<YouTubeInsertedComment>;
}

export interface YouTubeWriteAdapterDeps {
  createClient(context: OutboundContext): Promise<YouTubeWriteClient>;
}

/**
 * The public watch URL for a comment, which is how a human finds what we wrote.
 *
 * Returns undefined without a videoId rather than guessing a URL: a reply's
 * permalink needs the video it lives under, and a fabricated link that 404s is
 * worse than no link, because it looks like a delivery receipt.
 */
export function youtubeCommentUrl(videoId: string | null | undefined, commentId: string): string | undefined {
  if (!videoId) return undefined;
  return `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export function createYouTubeWriteAdapter(deps: YouTubeWriteAdapterDeps): SocialReplyCapableAdapter {
  /**
   * THE DOUBLE-POST GUARD.
   *
   * YouTube gives `comments.insert` nothing at all — no key header, no
   * client-chosen id, no server-side duplicate check (the vendor page documents
   * none of the three). So a retry after an ambiguous timeout publishes a SECOND
   * reply under the owner's real identity, on a public video, where it is
   * visible to everyone who reads the thread.
   *
   * Two levels, because a retry arrives in two shapes:
   *   - CONCURRENT (the caller fired again before the first settled) → the
   *     in-flight promise is returned, so only one request is ever sent.
   *   - SEQUENTIAL (the first settled, the caller retried anyway) → the recorded
   *     outcome is replayed without a second write.
   *
   * Scope is honestly bounded: per-adapter-instance, so it collapses the retry
   * window that actually exists (seconds, same process) and NOT a duplicate
   * across a restart. YouTube exposes no mechanism that could; saying so beats
   * implying a durability this cannot have. This is the same guard, and the same
   * stated bound, as the Reddit write adapter — the two platforms have the
   * identical gap.
   *
   * A FAILED attempt is deliberately NOT recorded as settled: it is dropped from
   * `inflight` and never enters `settled`, so a retry after a transient failure
   * is allowed to actually retry. Caching failures here would turn one blip into
   * a permanently unsendable reply.
   */
  const settled = new Map<string, SocialReplyOutcome>();
  const inflight = new Map<string, Promise<SocialReplyOutcome>>();

  function once(key: string, work: () => Promise<SocialReplyOutcome>): Promise<SocialReplyOutcome> {
    const done = settled.get(key);
    if (done) return Promise.resolve(done);
    const running = inflight.get(key);
    if (running) return running;
    const started = work()
      .then((outcome) => {
        settled.set(key, outcome);
        return outcome;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, started);
    return started;
  }

  return {
    platform: 'youtube',

    async reply(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome> {
      if (request.target.platform !== 'youtube') {
        throw new Error(`youtube_write_target_mismatch:${request.target.platform}`);
      }
      const target = request.target;

      // `parentIdMissing` is a documented 400. Asserting locally turns a
      // 50-unit round trip into an immediate, specific error.
      if (!target.parentCommentId) {
        throw new Error(
          'youtube_reply_parent_missing — comments.insert REQUIRES snippet.parentId; replies must be linked to a parent comment',
        );
      }

      // `commentTextRequired`: "Comments cannot be empty." Same reasoning.
      if (request.text.trim().length === 0) {
        throw new Error('youtube_reply_text_empty — comments.insert rejects an empty snippet.textOriginal');
      }

      // `operationNotSupported`, pre-checked against the flag the vendor page
      // itself names as the remedy. Only a definite `false` refuses: an absent
      // flag means the stored document predates the field, and refusing on
      // ABSENCE would silently disable replies for every document already in the
      // vault.
      if (target.canReply === false) {
        throw new Error(
          `youtube_reply_not_permitted:${target.parentCommentId} — the commentThread reports canReply:false, which comments.insert ` +
            `refuses as operationNotSupported. Refused locally rather than spending ${YOUTUBE_COMMENT_INSERT_UNITS} units to be told no.`,
        );
      }

      return once(request.idempotencyKey, async () => {
        const client = await deps.createClient(context);
        const created = await client.insertComment({
          parentId: target.parentCommentId,
          // `textOriginal` is the documented write field. `textDisplay` is a
          // READ projection the server builds (it rewrites links into titles),
          // so writing to it would be writing to a rendered view.
          textOriginal: request.text,
        });
        return {
          externalId: created.id,
          ref: `youtube:${created.id}`,
          url: youtubeCommentUrl(target.videoId, created.id),
        };
      });
    },

    // `post` and `delete` are deliberately absent. The registry declares only
    // `reply`, so assertSocialWriteAllowed refuses the other verbs BEFORE this
    // lookup — and per the SocialWriteAdapter contract note, a missing method
    // here means "the adapter has not implemented a verb its platform declares",
    // which is a different and separately-reported condition. Adding an empty
    // `post` that threw would collapse the two.
  };
}
