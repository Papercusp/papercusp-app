/**
 * The YouTube ACTIVITIES adapter — P-015 stage 2, the first of YouTube's two
 * read streams (D-022).
 *
 * WHY YOUTUBE SHIPS TWO READ ADAPTERS RATHER THAN ONE. D-022 settled this: the
 * two streams have genuinely different replay strength — activities.list has a
 * real server-side time cursor, commentThreads.list has no timestamp filter of
 * any kind — and `SocialReconcileResult.path` is a scalar. One adapter spanning
 * both streams would have to report the WEAKER stream's path forever, which
 * defeats the one field the contract exists to make assertable. So this file
 * owns the strong stream and reports honestly about it.
 *
 * FACTS THIS FILE ENCODES, read on 2026-08-23 from the vendor page for
 * activities.list itself — not from the registry row, and not from recall:
 *
 *   - The complete parameter inventory is: `part` (required; accepts
 *     contentDetails, id, snippet), exactly ONE filter of
 *     `channelId` / `home` (deprecated) / `mine`, and the optional
 *     `maxResults`, `pageToken`, `publishedAfter`, `publishedBefore`,
 *     `regionCode`.
 *   - `maxResults`: "Acceptable values are `0` to `50`, inclusive. The default
 *     value is `5`." — mirrored by `clampYouTubeMaxResults`.
 *   - `publishedAfter` "specifies the earliest date and time that an activity
 *     could have occurred for that activity to be included in the API
 *     response", and "If the parameter value specifies a day, but not a time,
 *     then any activities that occurred that day will be included in the result
 *     set."
 *   - `pageToken` "identifies a specific page in the result set that should be
 *     returned" — a page WITHIN one query, which is why it is used only inside a
 *     single reconcile and never persisted (D-021).
 *   - Cost is 1 unit against the GENERAL 10,000-unit bucket (D-020). Cost is
 *     per CALL, not per item, which is why the default page size below is the
 *     maximum the API allows rather than the API's own default of 5: asking for
 *     5 at a time costs ten times the quota for the same data.
 *
 * ⚠ THE FACT THE VENDOR PAGE DOES NOT STATE, WHICH THIS DESIGN TURNS ON.
 * The page never says whether `publishedAfter` is INCLUSIVE at the instant — it
 * describes a lower bound in prose ("the earliest date and time that an activity
 * could have occurred") and states the rule only at DAY granularity. The
 * phrasing reads inclusive, and the day-level rule leans the same way, but that
 * is an inference and this adapter does not get to bet a silent-loss failure on
 * an inference. See `YouTubeActivitiesCursor` for what is done instead.
 */
import type {
  SocialAdapter,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';
import { youtubeInstantMs, youtubeRetryDelayMs } from './youtube-common';

/* -------------------------------------------------------------------------- */
/* Page size                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `maxResults`, mirrored from the vendor page: 0–50 inclusive, default 5.
 *
 * The clamp floor here is 1 rather than the API's 0. Zero is an accepted value
 * that returns no items, so an adapter that passed it through would poll
 * forever, cost a quota unit each time and never emit anything — a hang that
 * presents as "the integration is quiet", which is the most expensive shape of
 * bug in this substrate.
 */
export const YOUTUBE_MAX_RESULTS_CEILING = 50;

/**
 * Deliberately the CEILING, not the API's default of 5.
 *
 * activities.list costs 1 unit per CALL regardless of how many items come back
 * (D-020), so page size is purely a quota multiplier: reading a 50-item gap at
 * the API's default would cost 10 units instead of 1. The only reason to lower
 * it is to force multi-page behaviour in a test.
 */
export const YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT = YOUTUBE_MAX_RESULTS_CEILING;

export function clampYouTubeMaxResults(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.max(Math.trunc(value), 1), YOUTUBE_MAX_RESULTS_CEILING);
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The persisted cursor: a provider timestamp plus the ids sitting exactly on it.
 *
 * WHY TWO FIELDS INSTEAD OF ONE TIMESTAMP. The vendor page does not state
 * whether `publishedAfter` includes an activity occurring at exactly that
 * instant (see the file header). Both readings are defensible, and each admits
 * a different bug:
 *
 *   - If it is INCLUSIVE and we store the newest `publishedAt` verbatim, every
 *     pass re-serves the boundary activity, so a quiet channel re-emits its
 *     newest item forever and every reconnect re-fires the binding. The kit's
 *     `no-op-reconcile-emits-nothing` catches this one.
 *   - If it is EXCLUSIVE and we "fix" the above by storing the newest
 *     `publishedAt` plus a millisecond, we skip anything published inside that
 *     millisecond. Nothing catches this one: it emits zero events and is
 *     indistinguishable from a quiet channel. That is precisely the silent-loss
 *     failure D-005 named and the `path` field exists to expose.
 *
 * So the cursor does not pick a reading. It stores the watermark verbatim and
 * queries a floor ONE MILLISECOND BEFORE it (`youtubeQueryFloor`), carrying the
 * ids already emitted at the watermark instant so the client can drop the
 * overlap the wider query returns.
 *
 * THE ASYMMETRY THAT MAKES THE MARGIN GO BACKWARDS, WHICH IS THE WHOLE TRICK.
 * A margin in either direction removes the ambiguity, but they fail in opposite
 * ways, and only one of the two failures is recoverable:
 *
 *   - FORWARD (`watermark + 1ms`, the obvious fix for the inclusive re-emit):
 *     UNDER-fetches. Anything at the watermark instant is now outside the query
 *     under both readings, so a sibling published in that same instant but
 *     indexed after our poll is never served again. Silent, permanent loss.
 *   - BACKWARD (`watermark - 1ms`, what this adapter does): OVER-fetches. The
 *     boundary instant is inside the query under both readings, and the extra
 *     items it drags in are exactly the ones `boundaryIds` and the client-side
 *     watermark filter already know how to drop.
 *
 * Over-fetching costs a filter pass. Under-fetching costs events, invisibly.
 * That is why the margin points backwards, and `youtube-activities-adapter.test.ts`
 * keeps the forward variant as a permanent control that demonstrably loses a
 * sibling under BOTH readings.
 *
 * The whole conformance kit runs against both an inclusive and an exclusive
 * provider fake, so neither reading is merely assumed.
 *
 * `boundaryIds` is bounded by how many activities share one instant, not by the
 * gap: it is reset every time the watermark advances.
 *
 * WHAT THIS DOES NOT SOLVE, stated so nobody mistakes it for solved: an activity
 * whose `publishedAt` is OLDER than the stored watermark but which appears in
 * the feed later is still dropped by the client-side filter. That is inherent to
 * every time-watermark cursor, not something the margin addresses — the margin
 * exists solely to make the boundary INSTANT reachable, and is deliberately the
 * smallest representable step rather than a lag cushion, which would only move
 * the same cliff a little further out while multiplying the re-read on every
 * pass.
 */
export interface YouTubeActivitiesCursor {
  /**
   * `snippet.publishedAt` of the newest activity read so far, stored exactly as
   * the provider serialized it.
   *
   * Stored verbatim rather than re-serialized because this is the value every
   * boundary comparison is made against, and a round-trip through
   * `Date#toISOString` would rewrite the provider's own precision. It is NOT the
   * value sent to the provider — see `youtubeQueryFloor`.
   */
  publishedAfter: string;
  /** Activity ids already emitted whose `publishedAt` is that same instant. */
  boundaryIds: string[];
}

/** The smallest representable step — see the header's forward/backward asymmetry. */
export const YOUTUBE_QUERY_FLOOR_MARGIN_MS = 1;

/**
 * The value actually sent as `publishedAfter`: one millisecond BEFORE the stored
 * watermark, so the watermark instant itself is inside the query under both the
 * inclusive and the exclusive reading.
 *
 * Returns null for a cold start or an unusable cursor, which is the signal to
 * read the window unfiltered.
 */
export function youtubeQueryFloor(cursor: YouTubeActivitiesCursor | null): string | null {
  if (!cursor) return null;
  const ms = youtubeInstantMs(cursor.publishedAfter);
  if (ms === null) return null;
  return new Date(ms - YOUTUBE_QUERY_FLOOR_MARGIN_MS).toISOString();
}

export function isYouTubeActivitiesCursor(value: unknown): value is YouTubeActivitiesCursor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { publishedAfter?: unknown; boundaryIds?: unknown };
  if (typeof candidate.publishedAfter !== 'string') return false;
  if (!Number.isFinite(Date.parse(candidate.publishedAfter))) return false;
  return Array.isArray(candidate.boundaryIds) && candidate.boundaryIds.every((id) => typeof id === 'string');
}

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One `activity` resource, flattened to the fields this adapter reads.
 *
 * Flattened at the port rather than carried as the raw nested resource so that
 * whoever writes the HTTP client has one obvious mapping to satisfy, and so a
 * missing `contentDetails.upload.videoId` shows up as an absent field here
 * instead of an optional-chain deep inside normalization.
 */
export interface YouTubeRawActivity {
  /** `id` — the activity resource's own stable id. */
  id: string;
  /** `snippet.publishedAt`, ISO 8601, verbatim from the provider. */
  publishedAt: string;
  /** `snippet.channelId` — the channel the activity belongs to. */
  channelId: string;
  /** `snippet.channelTitle`. */
  channelTitle?: string | null;
  /** `snippet.title`. */
  title?: string | null;
  /** `snippet.description`. */
  description?: string | null;
  /**
   * `snippet.type` — `upload`, `like`, `subscription`, `playlistItem`, … The
   * event name is derived from it, so an `ext:youtube:upload` binding fires only
   * for uploads rather than for every kind of channel activity.
   */
  type?: string | null;
  /** `contentDetails.upload.videoId`, present for upload activities. */
  videoId?: string | null;
}

export interface YouTubeActivitiesPage {
  items: YouTubeRawActivity[];
  /** `nextPageToken`, absent/null on the last page. */
  nextPageToken?: string | null;
}

export interface YouTubeActivitiesClient {
  /**
   * One `activities.list` call.
   *
   * `publishedAfter` is the stored watermark verbatim, or null to read without
   * the filter. `pageToken` continues WITHIN this query only.
   */
  listActivities(params: {
    publishedAfter: string | null;
    pageToken: string | null;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<YouTubeActivitiesPage>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The provider refused the stored `publishedAfter` value itself — the Data API
 * `400 invalidValue` shape.
 *
 * Modelled as a distinct error rather than a generic failure because it is the
 * ONLY signal that separates "the cursor is unusable, close the gap another
 * way" from "the call failed, retry it". Collapsing the two would either retry
 * forever against a value that can never be accepted, or discard a transient
 * failure as a cursor problem and re-read the whole window for nothing.
 */
export class YouTubeCursorRejected extends Error {
  /** The value the provider refused, for the log line. Never a credential. */
  readonly rejectedValue: string | null;

  constructor(message: string, rejectedValue: string | null) {
    super(message);
    this.name = 'YouTubeCursorRejected';
    this.rejectedValue = rejectedValue;
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** Which `ext:youtube:<event>` key an activity normalizes to. */
export function youtubeActivityEventName(activity: Pick<YouTubeRawActivity, 'type'>): string {
  const type = (activity.type ?? '').trim().toLowerCase();
  return type.length > 0 ? type : 'activity';
}

/**
 * `<id>@<publishedAt>`.
 *
 * An activity resource carries no edit marker — there is no YouTube equivalent
 * of reddit's three-valued `edited` field — so `publishedAt` serves as the
 * version half. Both halves are provider facts, which is what the contract
 * requires: no wall-clock time, no randomness, stable across identical passes.
 */
export function youtubeActivityDedupeKey(activity: Pick<YouTubeRawActivity, 'id' | 'publishedAt'>): string {
  return `${activity.id}@${activity.publishedAt}`;
}

/**
 * Build the canonical `social-post` payload (D-004).
 *
 * `text` falls back through title then description then empty string because the
 * canonical schema requires `text` and a non-upload activity (a `like`, a
 * `subscription`) can legitimately carry neither — and failing datatype
 * validation for a well-formed provider response would drop the event entirely
 * rather than deliver a thin one.
 */
export function normalizeYouTubeActivity(activity: YouTubeRawActivity): SocialNormalizedEvent {
  const payload: Record<string, unknown> = {
    id: activity.id,
    text: activity.title ?? activity.description ?? '',
    author: activity.channelTitle ?? activity.channelId,
    channelId: activity.channelId,
    activityType: youtubeActivityEventName(activity),
    occurredAt: activity.publishedAt,
  };
  if (activity.title) payload.title = activity.title;
  if (activity.description) payload.description = activity.description;
  if (activity.channelTitle) payload.channelTitle = activity.channelTitle;
  if (activity.videoId) {
    payload.videoId = activity.videoId;
    payload.url = `https://www.youtube.com/watch?v=${activity.videoId}`;
  }

  return {
    externalId: activity.id,
    event: youtubeActivityEventName(activity),
    occurredAt: activity.publishedAt,
    payload,
    dedupeKey: youtubeActivityDedupeKey(activity),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface YouTubeActivitiesAdapterDeps {
  client: YouTubeActivitiesClient;
  /** Items per call. Clamped by `clampYouTubeMaxResults`. */
  pageSize?: number;
  /** How many pages one reconcile will walk before stopping. */
  maxPages?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RETRIES = 4;

export class YouTubeActivitiesAdapter implements SocialAdapter {
  readonly platformId = 'youtube' as const;

  /**
   * Which of YouTube's two read streams this instance is.
   *
   * Not part of the `SocialAdapter` contract — the contract is per-platform and
   * stays that way. It exists so a conformance report or a log line can say
   * WHICH youtube adapter it is talking about, since D-022 means two of them
   * legitimately answer `platformId === 'youtube'`.
   */
  readonly streamId = 'activities' as const;

  private readonly client: YouTubeActivitiesClient;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: YouTubeActivitiesAdapterDeps) {
    this.client = deps.client;
    this.pageSize = clampYouTubeMaxResults(deps.pageSize);
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
    const stored = isYouTubeActivitiesCursor(ctx.cursor) ? ctx.cursor : null;

    // A stored cursor we cannot READ is not a cold start. Reporting 'cold-start'
    // here would claim "first connect ever" for what is really a cursor this
    // adapter version can no longer parse — and would hide the fact that a gap
    // of unknown size was closed by a bounded window rather than by the
    // provider. It is a backfill, and it says so.
    const unreadableCursor = hadStoredCursor && stored === null;

    let read: YouTubeRawActivity[];
    let rejected = false;

    if (unreadableCursor) {
      read = await this.walk(null, ctx);
    } else {
      try {
        // The FLOOR, not the watermark — one millisecond earlier, so the
        // watermark instant is reachable under either reading of publishedAfter.
        read = await this.walk(youtubeQueryFloor(stored), ctx);
      } catch (error) {
        if (!(error instanceof YouTubeCursorRejected)) throw error;
        // The provider refused the watermark itself. Re-read the bounded window
        // WITHOUT the filter and close the gap client-side. Shrugging and
        // starting from live here is the silent loss D-005 named.
        rejected = true;
        read = await this.walk(null, ctx);
      }
    }

    const emitted = await this.emitAll(read, stored, ctx);
    const cursor = this.nextCursor(read, stored);

    if (unreadableCursor || rejected) {
      // 'cursor-rejected', not 'cursor-expired'. The distinction is not
      // pedantic: activities.list has no documented retention window that ages
      // a `publishedAfter` value out, so nothing here ever EXPIRES. What
      // happens is that a value is refused — by the provider as invalid, or by
      // this adapter as unparseable. Reporting 'cursor-expired' would send
      // whoever reads the field hunting for a retention boundary that does not
      // exist.
      return { cursor, emitted, path: 'backfill', backfillReason: 'cursor-rejected' };
    }

    const path: SocialReconcilePath = stored === null ? 'cold-start' : emitted === 0 ? 'live-only' : 'cursor-replay';
    return { cursor, emitted, path };
  }

  /**
   * Read every page of one query.
   *
   * `pageToken` lives entirely inside this walk and is never persisted: it
   * identifies a page within THIS query's result set, so carrying it across an
   * offline gap would resume into a page of a result set that no longer exists
   * (D-021).
   */
  private async walk(publishedAfter: string | null, ctx: SocialReconcileContext): Promise<YouTubeRawActivity[]> {
    const collected: YouTubeRawActivity[] = [];
    let pageToken: string | null = null;
    let pages = 0;

    while (pages < this.maxPages) {
      if (ctx.signal?.aborted) break;
      const token: string | null = pageToken;
      const page: YouTubeActivitiesPage = await this.withRetry(() =>
        this.client.listActivities({
          publishedAfter,
          pageToken: token,
          maxResults: this.pageSize,
          signal: ctx.signal,
        }),
      );
      pages += 1;
      collected.push(...page.items);

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    return collected;
  }

  /**
   * Filter to what is genuinely new, order it, and emit oldest-first.
   *
   * THE ORDER OF THE PROVIDER'S RESPONSE IS NEVER TRUSTED. The vendor page does
   * not specify the ordering of `activities.list` items, so this adapter derives
   * no control flow from it — no "stop at the first item older than the
   * watermark" early exit, which would silently truncate the gap to nothing if
   * the feed ever came back oldest-first. The bound on a backfill is
   * `maxPages`, a fact about this adapter, not a guess about the provider.
   * Ordering for EMISSION is then done client-side, because bindings want
   * chronological order regardless of how the page arrived.
   */
  private async emitAll(
    read: YouTubeRawActivity[],
    stored: YouTubeActivitiesCursor | null,
    ctx: SocialReconcileContext,
  ): Promise<number> {
    const watermarkMs = stored ? youtubeInstantMs(stored.publishedAfter) : null;
    const boundary = new Set(stored?.boundaryIds ?? []);

    const fresh: YouTubeRawActivity[] = [];
    const seen = new Set<string>();
    for (const activity of read) {
      const at = youtubeInstantMs(activity.publishedAt);
      // An unparseable provider timestamp is emitted rather than dropped: it
      // cannot be placed against the watermark, and dropping it would lose a
      // real event over a formatting problem. It sorts last and does not move
      // the cursor (see nextCursor).
      if (at !== null && watermarkMs !== null) {
        if (at < watermarkMs) continue;
        if (at === watermarkMs && boundary.has(activity.id)) continue;
      }
      // Within-pass dedupe: a multi-page walk can re-serve an item when the feed
      // shifts under it, exactly as a listing walk can.
      const key = youtubeActivityDedupeKey(activity);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(activity);
    }

    fresh.sort((a, b) => {
      const left = youtubeInstantMs(a.publishedAt);
      const right = youtubeInstantMs(b.publishedAt);
      if (left === null || right === null) {
        if (left === right) return a.id.localeCompare(b.id);
        return left === null ? 1 : -1;
      }
      if (left !== right) return left - right;
      // Ties broken by id so two activities sharing an instant emit in a stable
      // order across passes — the dedupe-stability check compares the sequence.
      return a.id.localeCompare(b.id);
    });

    for (const activity of fresh) {
      await ctx.emit(normalizeYouTubeActivity(activity));
    }
    return fresh.length;
  }

  /**
   * Advance the watermark to the newest instant READ this pass — including
   * items that were filtered out as already-emitted boundary duplicates, since
   * they are still evidence of where the feed has been read up to.
   *
   * When the watermark does not move, the stored `boundaryIds` are CARRIED
   * FORWARD rather than recomputed. Dropping them on a pass that read nothing
   * new would re-admit exactly the items they exist to suppress, so the next
   * pass would re-emit the boundary — the inclusive-reading bug, reintroduced
   * one level down.
   */
  private nextCursor(
    read: YouTubeRawActivity[],
    stored: YouTubeActivitiesCursor | null,
  ): YouTubeActivitiesCursor | null {
    let newest = stored?.publishedAfter ?? null;
    let newestMs = youtubeInstantMs(newest);

    for (const activity of read) {
      const at = youtubeInstantMs(activity.publishedAt);
      if (at === null) continue;
      if (newestMs === null || at > newestMs) {
        newestMs = at;
        newest = activity.publishedAt;
      }
    }

    if (newest === null || newestMs === null) return stored;

    const atBoundary = read
      .filter((activity) => youtubeInstantMs(activity.publishedAt) === newestMs)
      .map((activity) => activity.id);
    const carried = stored && youtubeInstantMs(stored.publishedAfter) === newestMs ? stored.boundaryIds : [];

    return {
      publishedAfter: newest,
      boundaryIds: [...new Set([...carried, ...atBoundary])].sort(),
    };
  }
}
