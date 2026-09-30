/**
 * Concerns shared by YouTube's two read adapters — P-015.
 *
 * WHY THIS FILE EXISTS. D-022 splits YouTube into an activities adapter and a
 * comments adapter because the two streams have genuinely different replay
 * strength. Rate limiting and timestamp comparison are NOT part of that split:
 * they are properties of the Data API and of ISO 8601, identical on both
 * streams. Leaving them in the activities file would have made the comments
 * adapter import the activities adapter for plumbing it has no relationship to,
 * which is the kind of dependency that later reads as "comments depends on
 * activities" and gets preserved by someone who assumes it meant something.
 *
 * What is deliberately NOT here: anything cursor-shaped. The two streams'
 * cursors are the one thing that genuinely differs (a real server-side time
 * filter versus none at all), so a shared cursor helper would be the seam
 * through which the weaker stream's limitations leak into the stronger one.
 */

/**
 * A `403 rateLimitExceeded` / `429`. `retryAfterSeconds` is a DURATION in
 * seconds, not a timestamp — reading it as an epoch would produce a wait of
 * decades, which presents as a hung adapter rather than an error.
 *
 * Note what this is NOT: `403 quotaExceeded` (the daily unit budget is spent) is
 * not a rate limit and must not be retried — the budget does not refill until
 * the quota day rolls over, so backing off and retrying just burns the retry
 * schedule against a wall. That case belongs to the storm-policy layer
 * (P-015 stage 5) and is deliberately left to propagate.
 */
export class YouTubeRateLimited extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'YouTubeRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const YOUTUBE_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** How long to wait before retrying, or null when the error is not retryable. */
export function youtubeRetryDelayMs(error: unknown, attempt: number, maxAttempts: number): number | null {
  if (!(error instanceof YouTubeRateLimited)) return null;
  if (attempt >= maxAttempts) return null;
  const stated = error.retryAfterSeconds;
  if (stated !== null && Number.isFinite(stated) && stated >= 0) {
    return Math.min(Math.ceil(stated * 1000), YOUTUBE_MAX_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, YOUTUBE_MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * Parse a provider timestamp to epoch ms, or null when it is unusable.
 *
 * Every timestamp comparison in both adapters goes through this rather than
 * comparing ISO strings directly, because two spellings of one instant
 * (`...T00:00:00Z` and `...T00:00:00.000Z`) are not string-equal. A string
 * comparison in a boundary test would let a re-spelled boundary item slip
 * through and be emitted a second time.
 */
export function youtubeInstantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
