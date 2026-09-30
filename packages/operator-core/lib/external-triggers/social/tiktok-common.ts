/**
 * Concerns shared by TikTok's read path — P-022.
 *
 * WHY THIS FILE IS SMALL, AND WHY IT EXISTS AT ALL. TikTok ships exactly ONE
 * read adapter, so the usual justification for a `-common` file (two adapters
 * that must agree) does not apply. What lives here instead is the material that
 * would otherwise sit inline in the adapter and be read as incidental: the
 * SECONDS/MILLISECONDS boundary, the watermark type, and the error taxonomy.
 * Each of those is a fact about TIKTOK rather than about reconciliation, and
 * each has a failure mode that is silent. Keeping them addressable — and
 * separately testable — is the point.
 *
 * The thing to carry away from this file is the unit boundary. TikTok mixes two
 * time scales in ONE request/response pair, and neither side announces itself
 * at runtime:
 *
 *   - `cursor` (request body and response) is "a UTC Unix timestamp in
 *     milli-seconds".
 *   - `create_time` on the Video Object is "UTC Unix epoch (in seconds)".
 *
 * A 1000x error between those two does not throw. It produces timestamps in
 * 1970 or in the year 56000, both of which compare cleanly against a watermark
 * and quietly decide that everything is new or that nothing is. Every crossing
 * of that boundary in this codebase goes through `tiktokSecondsToCursorMs` /
 * `tiktokCursorMsToSeconds` so the conversion is named, tested, and impossible
 * to do by accident.
 */

/* -------------------------------------------------------------------------- */
/* The unit boundary                                                          */
/* -------------------------------------------------------------------------- */

/** Milliseconds per second. Named so a bare `1000` never appears in a conversion. */
const MS_PER_SECOND = 1000;

/**
 * A Video Object `create_time` (SECONDS) as a cursor-scale value (MILLISECONDS).
 *
 * Returns null for anything that is not a finite, non-negative integer number
 * of seconds. Null rather than NaN because NaN silently loses every numeric
 * comparison it takes part in — `NaN > mark` and `NaN < mark` are both false —
 * so a NaN would be classified as "not new" and dropped without a trace. A null
 * is forced to be handled.
 */
export function tiktokSecondsToCursorMs(seconds: unknown): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  if (seconds < 0) return null;
  return Math.trunc(seconds) * MS_PER_SECOND;
}

/**
 * A cursor-scale value (MILLISECONDS) as whole seconds.
 *
 * The inverse of the above, and deliberately floor-truncating: a cursor is used
 * as an exclusive upper bound ("videos posted BEFORE this timestamp"), so
 * rounding UP could step past an unseen item at the boundary second and drop
 * it, while rounding down can only re-offer one we have already recorded.
 * Prefer the duplicate the dedupe key absorbs over the silent omission.
 */
export function tiktokCursorMsToSeconds(ms: unknown): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms < 0) return null;
  return Math.floor(ms / MS_PER_SECOND);
}

/* -------------------------------------------------------------------------- */
/* The watermark                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What this adapter persists between passes.
 *
 * NOTE WHAT THIS IS NOT: it is not TikTok's `cursor`. TikTok's cursor is a
 * paging token for one descending scan and means "videos posted BEFORE this
 * instant", so storing it and sending it back next pass asks the vendor for
 * everything we have already seen. This type exists to make that mistake
 * unrepresentable — the stored object is OURS, is named a watermark, and is
 * never sent to TikTok.
 *
 * `boundaryIds` carries the ids already emitted at exactly `watermarkSeconds`.
 * TikTok's `create_time` has one-SECOND resolution, so two videos posted in the
 * same second are not an edge case to wave at — they are ordinary for anyone
 * posting in a burst, and without the boundary set the second one is either
 * emitted forever (if the comparison is `>=`) or dropped forever (if it is `>`).
 */
/**
 * WHY THE MARK IS AN ISO STRING AND NOT THE SECONDS TIKTOK GAVE US. The
 * temptation is to store `create_time` verbatim — it is the native unit and
 * every comparison here is in seconds. But the stored cursor is also read by
 * `cursor-freshness.ts`, which derives the admin pane's "last synced" verdict
 * from a small set of recognized field names, and `watermark` is already one of
 * them. A bespoke numeric field would be unrecognized, and the pane would
 * report this platform as NEVER SYNCED forever while it synced perfectly —
 * a silent, cosmetic-looking failure of exactly the kind this plan keeps
 * finding. Conforming costs one parse per comparison and no shared-code change.
 *
 * The conversion is lossless for integer seconds, which is all TikTok emits.
 */
export interface TikTokWatermarkCursor {
  /** Newest emitted `create_time`, as an ISO instant. Recognized by cursor-freshness. */
  watermark: string;
  /** Ids already emitted whose `create_time` is exactly that second. */
  boundaryIds: string[];
}

export function isTikTokWatermarkCursor(value: unknown): value is TikTokWatermarkCursor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { watermark?: unknown; boundaryIds?: unknown };
  if (typeof candidate.watermark !== 'string') return false;
  if (!Number.isFinite(Date.parse(candidate.watermark))) return false;
  return Array.isArray(candidate.boundaryIds) && candidate.boundaryIds.every((id) => typeof id === 'string');
}

/** The mark as whole seconds, for comparison against a raw `create_time`. */
export function tiktokWatermarkSeconds(cursor: TikTokWatermarkCursor): number | null {
  const ms = Date.parse(cursor.watermark);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / MS_PER_SECOND);
}

/** A `create_time` in seconds as the ISO instant the cursor stores. */
export function tiktokSecondsToInstant(seconds: number): string {
  return new Date(Math.trunc(seconds) * MS_PER_SECOND).toISOString();
}

/**
 * Is an item at `seconds` with id `id` new, given the stored mark?
 *
 * An unparseable `create_time` counts as NEW. That is the same directional
 * choice the Facebook adapter makes and for the same reason: an item that
 * cannot be placed against the mark is either emitted (a duplicate the dedupe
 * key absorbs) or dropped (a silent loss nothing can recover). Prefer the
 * detectable error.
 */
export function tiktokIsNewAgainstWatermark(
  stored: TikTokWatermarkCursor | null,
  seconds: unknown,
  id: string,
): boolean {
  if (!stored) return true;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return true;
  const mark = tiktokWatermarkSeconds(stored);
  if (mark === null) return true;
  const at = Math.trunc(seconds);
  if (at < mark) return false;
  if (at === mark) return !stored.boundaryIds.includes(id);
  return true;
}

/**
 * Fold an emitted item into the watermark.
 *
 * At a strictly newer second the mark advances and the boundary set is
 * REPLACED, not appended to — ids at the old second can no longer collide with
 * anything, so carrying them would grow the cursor without bound.
 */
export function tiktokAdvanceWatermark(
  stored: TikTokWatermarkCursor | null,
  seconds: unknown,
  id: string,
): TikTokWatermarkCursor | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return stored;
  const at = Math.trunc(seconds);
  if (!stored) return { watermark: tiktokSecondsToInstant(at), boundaryIds: [id] };
  const mark = tiktokWatermarkSeconds(stored);
  if (mark === null) return { watermark: tiktokSecondsToInstant(at), boundaryIds: [id] };
  if (at > mark) return { watermark: tiktokSecondsToInstant(at), boundaryIds: [id] };
  if (at === mark) {
    return stored.boundaryIds.includes(id)
      ? stored
      : { watermark: stored.watermark, boundaryIds: [...stored.boundaryIds, id] };
  }
  return stored;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A `429 rate_limit_exceeded`.
 *
 * Kept even though TikTok publishes NO rate limit for the Display API, which is
 * exactly why it is worth a note. `rate_limit_exceeded` is in the documented
 * error enum for the Content Posting endpoints, and the Display API's error
 * object shares that enum; the absence of a published NUMBER is not a promise
 * that the limit does not exist. An adapter that treated an undocumented 429 as
 * a generic failure would retry it as hard as it retries a network blip.
 */
export class TikTokRateLimited extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'TikTokRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Never wait longer than this for a rate limit, however long the vendor asks. */
export const TIKTOK_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * How long to wait before retrying, or null when the error is not retryable.
 *
 * ONLY `TikTokRateLimited` is retryable here, and the exclusions are the point.
 * `TikTokAuthRejected` must not be retried — a token that is invalid or missing
 * a scope will be exactly as invalid one second later, so retrying it burns the
 * attempt budget against a wall and delays the operator seeing the real problem.
 * A generic vendor error (`invalid_param`) is a defect in OUR request, and
 * retrying an identical malformed request cannot change its outcome.
 *
 * `retryAfterSeconds` is a DURATION in seconds, not a timestamp: reading it as
 * an epoch would schedule a wait of decades, which presents as a hung adapter
 * rather than as an error anyone can see.
 */
export function tiktokRetryDelayMs(error: unknown, attempt: number, maxAttempts: number): number | null {
  if (!(error instanceof TikTokRateLimited)) return null;
  if (attempt >= maxAttempts) return null;
  const stated = error.retryAfterSeconds;
  if (stated !== null && Number.isFinite(stated) && stated >= 0) {
    return Math.min(Math.ceil(stated * 1000), TIKTOK_MAX_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, TIKTOK_MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * The access token was rejected, or the user never granted the scope.
 *
 * `access_token_invalid` and `scope_not_authorized` are deliberately ONE class
 * here because both are terminal for a pass and neither is retryable — but the
 * `code` is preserved so an operator can tell "reconnect the account" from
 * "the account connected without video.list".
 */
export class TikTokAuthRejected extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TikTokAuthRejected';
    this.code = code;
  }
}

/** TikTok's success sentinel. Anything else in `error.code` is a failure. */
export const TIKTOK_OK = 'ok';

/**
 * Map a TikTok `error.code` to a thrown error, or return null when it is `ok`.
 *
 * Centralised so the adapter never string-matches a code inline. Note that
 * TikTok reports failure IN THE BODY with an `error.code`, so a 200 response is
 * not evidence of success and this must be consulted on every call.
 */
export function tiktokErrorFor(code: unknown, message: unknown, logId?: unknown): Error | null {
  if (typeof code !== 'string' || code === TIKTOK_OK) return null;
  const detail = typeof message === 'string' && message.length > 0 ? message : code;
  const suffix = typeof logId === 'string' && logId.length > 0 ? ` (log_id ${logId})` : '';
  if (code === 'rate_limit_exceeded') return new TikTokRateLimited(`${detail}${suffix}`);
  if (code === 'access_token_invalid' || code === 'scope_not_authorized') {
    return new TikTokAuthRejected(`${detail}${suffix}`, code);
  }
  return new Error(`tiktok: ${detail}${suffix}`);
}

/* -------------------------------------------------------------------------- */
/* Endpoint facts                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The documented MAXIMUM for `max_count` on /v2/video/list/.
 *
 * Verbatim: "The maximum number of videos that will be returned from each page.
 * Default is 10. Maximum is 20." Exported so the adapter clamps to a stated
 * vendor bound rather than a number someone liked.
 */
export const TIKTOK_VIDEO_LIST_MAX_COUNT = 20;

/** The vendor default, for the same reason. */
export const TIKTOK_VIDEO_LIST_DEFAULT_COUNT = 10;
