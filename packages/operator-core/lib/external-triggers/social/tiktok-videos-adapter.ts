/**
 * TikTok video read adapter — P-022.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS ADAPTER. TikTok returns a `cursor`,
 * and it is NOT a resumable position. Verbatim from the v2 video-list
 * reference: "the cursor value is a UTC Unix timestamp in milli-seconds. You
 * can pass in a customized timestamp to fetch the user's videos posted BEFORE
 * the provided timestamp", against a list "sorted by create_time in descending
 * order".
 *
 * So the cursor pages BACKWARD IN TIME. The obvious implementation — persist
 * the cursor, send it back next pass — asks TikTok for everything we have
 * ALREADY seen and never for anything new. It does not error. `has_more` stays
 * true as it walks into the creator's history, so the adapter looks busy and
 * healthy while emitting nothing new for as long as it runs. That is the
 * failure this file is arranged to make impossible: TikTok's cursor is used
 * ONLY inside a single pass, and what crosses the pass boundary is a
 * `TikTokWatermarkCursor` that is ours and is never sent to TikTok.
 *
 * WHY EARLY TERMINATION IS ALLOWED HERE AND NOT ON FACEBOOK. D-025 forbids
 * "stop at the first item older than the watermark" for Facebook Pages because
 * its `/feed` is RANKED, so an unseen item can sit behind a seen one. TikTok
 * documents the opposite: the list is sorted by `create_time` descending. That
 * ordering guarantee is precisely what licenses the early exit, so the exit is
 * conditional on a documented vendor fact rather than on convenience. If TikTok
 * ever stops promising descending order, this optimisation becomes the same
 * silent-loss bug D-025 describes — which is why the reason is recorded here
 * next to the code rather than in a commit message.
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
  isTikTokWatermarkCursor,
  tiktokAdvanceWatermark,
  tiktokErrorFor,
  tiktokIsNewAgainstWatermark,
  tiktokRetryDelayMs,
  tiktokWatermarkSeconds,
  TIKTOK_VIDEO_LIST_DEFAULT_COUNT,
  TIKTOK_VIDEO_LIST_MAX_COUNT,
  type TikTokWatermarkCursor,
} from './tiktok-common';

/* -------------------------------------------------------------------------- */
/* The vendor shape                                                           */
/* -------------------------------------------------------------------------- */

/** One entry of `data.videos`, narrowed to the fields this adapter reads. */
export interface TikTokRawVideo {
  id?: unknown;
  /** UTC Unix epoch in SECONDS — not milliseconds. See tiktok-common. */
  create_time?: unknown;
  title?: unknown;
  video_description?: unknown;
  share_url?: unknown;
  embed_link?: unknown;
  cover_image_url?: unknown;
  duration?: unknown;
  comment_count?: unknown;
}

/** The `data` block of a /v2/video/list/ response. */
export interface TikTokVideoListPage {
  videos?: TikTokRawVideo[];
  /** TikTok's BACKWARD pager, in MILLISECONDS. Valid only within one pass. */
  cursor?: unknown;
  has_more?: unknown;
  /** TikTok reports failure in the BODY, so these are checked on every call. */
  errorCode?: unknown;
  errorMessage?: unknown;
  logId?: unknown;
}

export interface TikTokVideoListRequest {
  /** Omitted on the first call of a pass so the newest page comes back. */
  cursor: number | null;
  maxCount: number;
}

export interface TikTokVideosClient {
  listVideos(request: TikTokVideoListRequest): Promise<TikTokVideoListPage>;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

const TIKTOK_PERMALINK_PREFIX = 'https://www.tiktok.com/';

/**
 * The post text.
 *
 * `video_description` is preferred over `title` because it is the field that
 * carries what a creator actually wrote — the caption. TikTok exposes both and
 * either may be empty; a video with NEITHER is entirely ordinary, because
 * TikTok is media-primary in the same way Instagram is (D-032). The canonical
 * `social-post` schema requires `text`, so an absent caption becomes an empty
 * string plus an explicit `textAbsent` marker, following the precedent the
 * Facebook adapter set rather than inventing a second convention.
 */
export function tiktokVideoText(video: TikTokRawVideo): string {
  const description = typeof video.video_description === 'string' ? video.video_description.trim() : '';
  if (description.length > 0) return description;
  return typeof video.title === 'string' ? video.title.trim() : '';
}

/** The permalink, preferring the vendor-supplied `share_url`. */
export function tiktokVideoUrl(video: TikTokRawVideo, id: string): string {
  const shareUrl = typeof video.share_url === 'string' ? video.share_url.trim() : '';
  if (shareUrl.length > 0) return shareUrl;
  return TIKTOK_PERMALINK_PREFIX + '@_/video/' + id;
}

/**
 * The dedupe key.
 *
 * Derived from id plus `create_time` only. Deliberately NOT from the counters:
 * `like_count`, `comment_count` and `view_count` change constantly on a live
 * video, so folding any of them in would make every poll produce a "new"
 * delivery for content that has not changed — the exact replay storm the key
 * exists to prevent. TikTok exposes no edit marker, so a re-captioned video is
 * knowingly not re-delivered; that is a documented limit, not an oversight.
 */
export function tiktokVideoDedupeKey(id: string, createTimeSeconds: unknown): string {
  const at = typeof createTimeSeconds === 'number' && Number.isFinite(createTimeSeconds)
    ? String(Math.trunc(createTimeSeconds))
    : 'unknown';
  return `tiktok:video:${id}:${at}`;
}

export function normalizeTikTokVideo(video: TikTokRawVideo, id: string): SocialNormalizedEvent {
  const text = tiktokVideoText(video);
  const seconds = typeof video.create_time === 'number' && Number.isFinite(video.create_time)
    ? Math.trunc(video.create_time)
    : null;
  const occurredAt = seconds === null ? null : new Date(seconds * 1000).toISOString();

  const payload: Record<string, unknown> = {
    id,
    text,
    url: tiktokVideoUrl(video, id),
    occurredAt,
  };

  // Every TikTok post is a video, so the media array is never empty in
  // practice. It is built from what the response actually carried rather than
  // asserted, so a field the caller did not request does not appear as null.
  const media: Record<string, unknown> = { type: 'video' };
  if (typeof video.cover_image_url === 'string' && video.cover_image_url.length > 0) {
    // NOTE the 6-hour TTL TikTok documents on this CDN link. It is carried for
    // immediate display only; anything persisting it will find it dead.
    media.coverImageUrl = video.cover_image_url;
    media.coverImageUrlExpires = true;
  }
  if (typeof video.embed_link === 'string' && video.embed_link.length > 0) media.embedLink = video.embed_link;
  if (typeof video.duration === 'number' && Number.isFinite(video.duration)) media.durationSeconds = video.duration;
  payload.media = [media];

  if (text.length === 0) payload.textAbsent = true;
  if (typeof video.comment_count === 'number' && Number.isFinite(video.comment_count)) {
    // The COUNT is readable; the comments themselves are not. TikTok exposes no
    // comment endpoint at this grant tier, so this number is the only visibility
    // we have into a conversation we cannot read or answer.
    payload.commentCount = video.comment_count;
  }

  return {
    externalId: id,
    event: 'post',
    occurredAt,
    payload,
    dedupeKey: tiktokVideoDedupeKey(id, video.create_time),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface TikTokVideosAdapterDeps {
  client: TikTokVideosClient;
  /** Videos per call. Clamped to TikTok's documented maximum of 20. */
  pageSize?: number;
  /** How many pages one pass walks before stopping. THE bound on this stream. */
  maxPages?: number;
  /** Retries for a RATE-LIMITED call only. Nothing else here is retryable. */
  maxRetries?: number;
  /** Injectable so a suite does not spend real seconds proving backoff works. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RETRIES = 3;

export class TikTokVideosAdapter implements SocialAdapter {
  readonly platformId = 'tiktok' as const;

  readonly streamId = 'videos' as const;

  private readonly client: TikTokVideosClient;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: TikTokVideosAdapterDeps) {
    this.client = deps.client;
    const requested = Math.trunc(deps.pageSize ?? TIKTOK_VIDEO_LIST_DEFAULT_COUNT);
    // Clamped to a STATED vendor bound, not a number someone liked: "Default is
    // 10. Maximum is 20."
    this.pageSize = Math.min(Math.max(1, requested), TIKTOK_VIDEO_LIST_MAX_COUNT);
    this.maxPages = Math.max(1, Math.trunc(deps.maxPages ?? DEFAULT_MAX_PAGES));
    this.maxRetries = Math.max(0, Math.trunc(deps.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One page, absorbing a transient rate limit.
   *
   * The retry wraps the page fetch rather than the whole walk on purpose: a
   * rate limit on page 4 must resume at page 4, not restart the pass and
   * re-emit the first three pages' worth of work.
   */
  private async fetchPage(cursor: number | null): Promise<TikTokVideoListPage> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.client.listVideos({ cursor, maxCount: this.pageSize });
        // TikTok reports failure in the BODY with an `error.code`, so a
        // delivered response is not evidence of success. Raising it here — not
        // at the call site — is what puts a body-reported 429 on the same
        // retry path as a thrown one.
        const error = tiktokErrorFor(response.errorCode, response.errorMessage, response.logId);
        if (error) throw error;
        return response;
      } catch (error) {
        const delay = tiktokRetryDelayMs(error, attempt, this.maxRetries);
        if (delay === null) throw error;
        await this.sleep(delay);
      }
    }
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isTikTokWatermarkCursor(ctx.cursor) ? ctx.cursor : null;
    const cursorUnreadable = hadStoredCursor && stored === null;

    const walk = await this.walk(ctx, stored);

    let emitted = 0;
    let cursor: TikTokWatermarkCursor | null = stored;

    for (const { video, id } of walk.videos) {
      if (!tiktokIsNewAgainstWatermark(stored, video.create_time, id)) continue;
      await ctx.emit(normalizeTikTokVideo(video, id));
      emitted += 1;
      cursor = tiktokAdvanceWatermark(cursor, video.create_time, id);
    }

    const result: SocialReconcileResult = {
      cursor,
      emitted,
      ...this.declarePath(hadStoredCursor, cursorUnreadable),
    };

    const lossRisk = this.lossRiskFor(stored, walk.gapClosed);
    if (lossRisk) result.lossRisk = lossRisk;
    return result;
  }

  /**
   * Walk pages newest-first, stopping as soon as the gap is provably closed.
   *
   * THE FIRST CALL SENDS NO CURSOR. That is what makes this a forward-progress
   * read at all: a cursor would mean "older than this", so starting from the
   * stored position would walk away from the new items rather than toward them.
   *
   * Termination on `create_time` STRICTLY LESS than the watermark, not `<=`, is
   * deliberate. TikTok's `create_time` has one-second resolution, so several
   * videos can share the watermark second; stopping at the first equal one
   * would drop its same-second siblings, which the boundary-id set exists to
   * disambiguate. Stopping strictly below guarantees every same-second item has
   * been seen.
   */
  private async walk(
    ctx: SocialReconcileContext,
    stored: TikTokWatermarkCursor | null,
  ): Promise<{ videos: Array<{ video: TikTokRawVideo; id: string }>; gapClosed: boolean }> {
    const out: Array<{ video: TikTokRawVideo; id: string }> = [];
    const markSeconds = stored ? tiktokWatermarkSeconds(stored) : null;
    let cursor: number | null = null;
    let gapClosed = false;

    for (let page = 0; page < this.maxPages; page += 1) {
      ctx.signal?.throwIfAborted();

      const response = await this.fetchPage(cursor);

      for (const video of response.videos ?? []) {
        if (!video || typeof video.id !== 'string' || video.id.length === 0) continue;
        const id = video.id;
        if (
          markSeconds !== null &&
          typeof video.create_time === 'number' &&
          Number.isFinite(video.create_time) &&
          Math.trunc(video.create_time) < markSeconds
        ) {
          gapClosed = true;
          break;
        }
        out.push({ video, id });
      }

      if (gapClosed) break;

      // `has_more: false` closes the gap for a different reason than the
      // watermark does: we have reached the end of the creator's history, so
      // there is provably nothing older left to miss.
      if (response.has_more !== true) {
        gapClosed = true;
        break;
      }

      const next = typeof response.cursor === 'number' && Number.isFinite(response.cursor)
        ? response.cursor
        : null;
      // A vendor that says "there is more" but hands back no usable cursor
      // leaves no way to continue. Stopping here is right; claiming the gap
      // closed would not be.
      if (next === null) break;
      cursor = next;
    }

    return { videos: out, gapClosed };
  }

  /**
   * Positive evidence of unrecoverable loss (D-031), or null.
   *
   * WHEN THIS FIRES. Only when a watermark EXISTED and the walk hit `maxPages`
   * without reaching back to it. In that state the items beyond the bound are
   * lost permanently, not merely deferred: the watermark advances to the newest
   * item emitted, so the next pass terminates even sooner and never reaches
   * them. Emitting a full page is otherwise indistinguishable from a healthy
   * read, which is exactly the ambiguity `lossRisk` exists to resolve.
   *
   * WHY COLD START IS EXCLUDED. With no watermark there is no gap to fail to
   * close — a bounded first read is the intended behaviour, and reporting loss
   * for it would fire on every new connection and train a reader to ignore the
   * field.
   *
   * HOW REACHABLE THIS IS. The bound is maxPages * pageSize videos — 400 by
   * default — and TikTok documents a per-creator posting cap of roughly 15
   * posts per day. So the default window spans about four weeks of
   * maximum-rate posting, and reaching it means the source was offline for
   * that long rather than that the bound is tight.
   */
  private lossRiskFor(stored: TikTokWatermarkCursor | null, gapClosed: boolean): SocialLossRisk | null {
    if (!stored || gapClosed) return null;
    return {
      kind: 'capped-window-overflow',
      occurrences: 1,
      detail:
        `walked the ${this.maxPages}-page bound (${this.maxPages * this.pageSize} videos at ` +
        `max_count=${this.pageSize}) without reaching the stored watermark at ` +
        `${stored.watermark}, and TikTok offers no forward cursor to resume from. Videos ` +
        `older than the bound but newer than that watermark are not recoverable on a later pass, ` +
        `because the watermark advances past them. Raise maxPages to re-read a longer window.`,
    };
  }

  /**
   * Declare which route closed the gap.
   *
   * ANY stored cursor produces `backfill`, following the doctrine the Wave A
   * adapters were corrected onto by EI-21256621031947425 and that the Facebook
   * adapter records: `cold-start` asserts "first connect for this source",
   * which is false about a cursor that existed, and `live-only` asserts the
   * PROVIDER accepted a cursor and had nothing to replay — a claim about
   * server-side replay this stream cannot make, since the watermark is never
   * sent to TikTok at all.
   *
   * The two backfill reasons stay distinct because collapsing them hides the
   * serious one behind the routine one. `no-replay-supported` is this stream's
   * steady state and fires every tick. `cursor-rejected` means the persisted
   * cursor could not be READ — a real loss of local state worth investigating,
   * and per the conformance kit it names the LOCAL invalid-cursor condition
   * without implying the provider ever saw it.
   */
  private declarePath(
    hadStoredCursor: boolean,
    cursorUnreadable: boolean,
  ): { path: SocialReconcilePath; backfillReason?: SocialBackfillReason } {
    if (!hadStoredCursor) return { path: 'cold-start' };
    return {
      path: 'backfill',
      backfillReason: cursorUnreadable
        ? ('cursor-rejected' as SocialBackfillReason)
        : ('no-replay-supported' as SocialBackfillReason),
    };
  }
}

export function createTikTokVideosAdapter(deps: TikTokVideosAdapterDeps): TikTokVideosAdapter {
  return new TikTokVideosAdapter(deps);
}
