/**
 * Concerns shared by the Instagram adapters — P-017.
 *
 * WHY THIS IS NOT `facebook-common.ts` WITH A DIFFERENT HOST. Instagram runs on
 * the same Graph host, under the same Meta app identity, behind the same app
 * review — so the reflex is to reuse the Pages helpers wholesale. Three verified
 * facts make that wrong, and each of them would have produced an adapter that
 * passes every test and is incorrect against the live API:
 *
 *  - The timestamp field is `timestamp`, not `created_time`, and its documented
 *    format carries a `+0000` offset with no colon (`2017-05-19T23:27:28+0000`).
 *  - Ordering is the OPPOSITE story. The Pages feed is RANKED, which is why that
 *    adapter may never early-exit (D-025). This edge documents
 *    "results returned in reverse chronological order" for v3.2+ — a real
 *    guarantee, and the thing that makes a newest-first window meaningful.
 *  - The edge is CAPPED at "a maximum of 50 comments per query" with NO paging
 *    documented, where the Pages edge pages freely. That converts a throughput
 *    question into a correctness one (D-031).
 *
 * FACTS THIS FILE ENCODES were read from live Meta documentation on 2026-08-23 —
 * from the EDGE reference pages, not the parent node's, which is where the three
 * above actually live. The IG Media reference describes the comments edge in one
 * line and states none of them.
 */

import type { SocialQuotaObservation } from './storm-policy';

/* -------------------------------------------------------------------------- */
/* API surface                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The Facebook Login flavor, which is the one this integration uses (D-030
 * records why): "Instagram API with Facebook Login for Business" runs against
 * `graph.facebook.com` with a Facebook User or Page token and REQUIRES a linked
 * Page. The other flavor (`graph.instagram.com`, an Instagram User token, no
 * Page) is a separate app identity and a separate review, which is exactly what
 * we are not taking on.
 */
export const INSTAGRAM_GRAPH_ORIGIN = 'https://graph.facebook.com';

/**
 * Pinned deliberately. The comments edge's ordering guarantee is stated PER API
 * VERSION — "Requests made using API version 3.1 or older will have results
 * returned in chronological order" versus "version 3.2+ ... reverse
 * chronological order" — so the version is not cosmetic here: it selects which
 * end of the result set the cap keeps. An unpinned version could silently
 * reverse the window this adapter's correctness argument depends on.
 */
export const INSTAGRAM_GRAPH_VERSION = 'v23.0';

/** The version at and above which results are documented newest-first. */
export const INSTAGRAM_REVERSE_CHRONO_SINCE = 3.2;

/**
 * True when a version string carries the reverse-chronological guarantee.
 *
 * Exported and tested rather than assumed, because the whole newest-50 argument
 * rests on it: on an older version the same call returns the OLDEST comments,
 * and an adapter that kept the newest-first reasoning would then be reading the
 * wrong end of every busy thread while looking perfectly healthy.
 */
export function instagramIsReverseChronological(version: string): boolean {
  const numeric = Number.parseFloat(version.replace(/^v/i, ''));
  if (!Number.isFinite(numeric)) return false;
  return numeric >= INSTAGRAM_REVERSE_CHRONO_SINCE;
}

export function instagramGraphUrl(path: string, origin: string = INSTAGRAM_GRAPH_ORIGIN): string {
  const base = origin.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/${INSTAGRAM_GRAPH_VERSION}${suffix}`;
}

/**
 * The documented hard ceiling on one comments query: "Returns a maximum of 50
 * comments per query."
 *
 * This is NOT a page size we chose and NOT a tunable — asking for more does not
 * get more, and there is no documented cursor to ask again with. It is the width
 * of the only window the API offers.
 */
export const INSTAGRAM_COMMENTS_MAX_PER_QUERY = 50;

/**
 * Requested EXPLICITLY because the default is lossy: the edge "Returns only
 * top-level comments", so every nested reply is silently absent unless `replies`
 * is expanded. Same class of trap as the Pages edge's `toplevel` default, by an
 * entirely different mechanism — which is why it had to be re-verified here
 * rather than carried across.
 */
export const INSTAGRAM_COMMENT_FIELDS = [
  'id',
  'timestamp',
  'text',
  'username',
  'like_count',
  'hidden',
  'parent_id',
  'replies{id,timestamp,text,username,parent_id}',
] as const;

/* -------------------------------------------------------------------------- */
/* Credentials — the D-027 rail, re-derived for Instagram                     */
/* -------------------------------------------------------------------------- */

/**
 * What an Instagram call needs to be entitled to its answer.
 *
 * `igUserId` is the Instagram professional account id; `pageId` is the Facebook
 * Page it is linked to, which the Facebook Login flavor documents as REQUIRED.
 * Both are carried because they are not interchangeable and mixing them up
 * produces a call that succeeds against the wrong object.
 */
export interface InstagramCredential {
  igUserId: string;
  pageId: string;
  accessToken: string;
  /** Scopes actually granted, as returned by the OAuth exchange. */
  scopes: string[];
}

/**
 * Reading a commenter's `username` requires `instagram_manage_comments` "as of
 * August 27, 2024" — the vendor's own dated warning. It is also the permission
 * the whole comment-moderation surface is gated on.
 */
export const INSTAGRAM_SCOPE_MANAGE_COMMENTS = 'instagram_manage_comments';
export const INSTAGRAM_SCOPE_BASIC = 'instagram_basic';
export const INSTAGRAM_SCOPE_CONTENT_PUBLISH = 'instagram_content_publish';

export class InstagramCredentialError extends Error {
  readonly missingScope: string;
  constructor(message: string, missingScope: string) {
    super(message);
    this.name = 'InstagramCredentialError';
    this.missingScope = missingScope;
  }
}

export function isInstagramCredential(value: unknown): value is InstagramCredential {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.igUserId === 'string' &&
    c.igUserId !== '' &&
    typeof c.pageId === 'string' &&
    c.pageId !== '' &&
    typeof c.accessToken === 'string' &&
    c.accessToken !== '' &&
    Array.isArray(c.scopes) &&
    c.scopes.every((s) => typeof s === 'string')
  );
}

/**
 * Assert a credential is entitled to `requiredScope` BEFORE the call goes out.
 *
 * WHY BEFORE, RATHER THAN CHECKING THE RESPONSE. The Pages investigation (D-027)
 * found that an under-privileged comments read returns EMPTY DATA rather than an
 * error, which no amount of response inspection can distinguish from "there are
 * no comments". Instagram's own docs describe the same shape from a different
 * direction — comments from restricted users are "withheld", age-gated media
 * comments "aren't returned" — i.e. the API's habit under this family of
 * conditions is to omit rather than to refuse. A pre-call assertion is the only
 * point at which the difference is still visible.
 */
export function assertInstagramCredential(
  credential: unknown,
  igUserId: string,
  requiredScope: string,
): asserts credential is InstagramCredential {
  if (!isInstagramCredential(credential)) {
    throw new InstagramCredentialError(
      'instagram_credential_malformed: expected { igUserId, pageId, accessToken, scopes }',
      requiredScope,
    );
  }
  if (credential.igUserId !== igUserId) {
    throw new InstagramCredentialError(
      `instagram_credential_wrong_account: credential is for ${credential.igUserId}, call is for ${igUserId}`,
      requiredScope,
    );
  }
  if (!credential.scopes.includes(requiredScope)) {
    throw new InstagramCredentialError(
      `instagram_credential_missing_scope: ${requiredScope} is not granted, and this call would return an incomplete answer rather than an error`,
      requiredScope,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Throttling — Instagram's OWN codes, not Facebook's                         */
/* -------------------------------------------------------------------------- */

/**
 * Instagram's Business Use Case throttle code. The rate-limiting reference lists
 * `error code 80002` against Instagram, while `80001` and `32` are documented as
 * Page calls with a Page/System-User token and a User token respectively. Those
 * are a different product's codes; carrying them here would be the
 * inherited-not-verified mistake this item exists to avoid.
 */
export const INSTAGRAM_THROTTLE_CODE_BUC = 80002;

/** The `type` value identifying Instagram's rows inside the usage header. */
export const INSTAGRAM_USAGE_TYPE = 'instagram';

export class InstagramGraphThrottled extends Error {
  readonly code: number;
  /** Minutes until access returns, or null when the provider stated none. */
  readonly holdMinutes: number | null;
  constructor(code: number, holdMinutes: number | null, message: string) {
    super(message);
    this.name = 'InstagramGraphThrottled';
    this.code = code;
    this.holdMinutes = holdMinutes;
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export interface InstagramUsageRow {
  businessId: string;
  type: string | null;
  callCount: number | null;
  totalCputime: number | null;
  totalTime: number | null;
  estimatedTimeToRegainAccess: number | null;
}

/**
 * Parse `X-Business-Use-Case-Usage`, keeping ONLY Instagram's rows.
 *
 * The header is shared across products and can carry up to 32 objects with types
 * "ads_insights, ads_management, custom_audience, instagram, leadgen, messenger,
 * or pages". Filtering by type is not tidiness: an account that also drives
 * Pages will have `pages` rows in the same header, and a peak taken across all
 * of them measures a budget this adapter does not spend from.
 */
export function parseInstagramUsage(header: string | null | undefined): InstagramUsageRow[] {
  if (typeof header !== 'string' || header.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const out: InstagramUsageRow[] = [];
  for (const [businessId, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const type = typeof row.type === 'string' ? row.type : null;
      if (type !== INSTAGRAM_USAGE_TYPE) continue;
      out.push({
        businessId,
        type,
        callCount: finiteNumber(row.call_count),
        totalCputime: finiteNumber(row.total_cputime),
        totalTime: finiteNumber(row.total_time),
        estimatedTimeToRegainAccess: finiteNumber(row.estimated_time_to_regain_access),
      });
    }
  }
  return out;
}

/** The highest utilisation percentage Instagram reported, or null if it said nothing. */
export function instagramPeakUsagePct(usage: readonly InstagramUsageRow[]): number | null {
  let peak: number | null = null;
  for (const row of usage) {
    for (const value of [row.callCount, row.totalCputime, row.totalTime]) {
      if (value === null) continue;
      if (peak === null || value > peak) peak = value;
    }
  }
  return peak;
}

/** Classify a Graph error body as an Instagram throttle, or null when it is not one. */
export function instagramThrottleFrom(
  body: { error?: { code?: unknown; message?: unknown } } | null | undefined,
  usageHeader: string | null | undefined,
): InstagramGraphThrottled | null {
  const code = finiteNumber(body?.error?.code);
  if (code !== INSTAGRAM_THROTTLE_CODE_BUC) return null;

  let hold: number | null = null;
  for (const row of parseInstagramUsage(usageHeader)) {
    const stated = row.estimatedTimeToRegainAccess;
    if (stated === null) continue;
    if (hold === null || stated > hold) hold = stated;
  }

  const message =
    typeof body?.error?.message === 'string' && body.error.message.trim() !== ''
      ? body.error.message.trim()
      : `instagram_graph_throttled_${code}`;
  return new InstagramGraphThrottled(code, hold, message);
}

/**
 * Translate a response into the platform-neutral shape the storm-policy layer
 * consumes. Everything vendor-shaped stops here (the same seam as
 * `facebookQuotaObservation`).
 *
 * A throttle with no stated duration crosses as `null`, never as a default:
 * Meta states "Continuing to make calls will continue to increase your call
 * count, which will increase the time before calls will be successful again",
 * and documents no fallback duration to invent.
 */
export function instagramQuotaObservation(
  usageHeader: string | null | undefined,
  error?: unknown,
): SocialQuotaObservation {
  const throttled = error instanceof InstagramGraphThrottled;
  return {
    peakUsagePct: instagramPeakUsagePct(parseInstagramUsage(usageHeader)),
    throttled,
    throttleHoldMs:
      throttled && error.holdMinutes !== null && Number.isFinite(error.holdMinutes) && error.holdMinutes >= 0
        ? Math.ceil(error.holdMinutes * 60_000)
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Watermark — no timestamp filter exists, so replay is client-side           */
/* -------------------------------------------------------------------------- */

/**
 * "Comments cannot be filtered by timestamp" — stated verbatim on the edge
 * reference. So there is no server-side replay to ask for and the cursor is
 * ours: the newest instant already seen, plus the ids seen AT that instant.
 *
 * The id set exists because two comments can share a timestamp (the format's
 * resolution is one second), and a bare `>` comparison would drop the second of
 * them forever while a `>=` would re-emit the first on every pass.
 */
export interface InstagramWatermark {
  watermark: string;
  seenAtWatermark: string[];
}

export function isInstagramWatermark(value: unknown): value is InstagramWatermark {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.watermark === 'string' &&
    c.watermark !== '' &&
    Array.isArray(c.seenAtWatermark) &&
    c.seenAtWatermark.every((s) => typeof s === 'string')
  );
}

/**
 * Parse an Instagram timestamp to epoch ms.
 *
 * The documented shape is `2017-05-19T23:27:28+0000` — an ISO 8601 basic-format
 * offset with NO colon. `Date.parse` accepts it, but the format is worth naming:
 * a helper written for RFC 3339 (`+00:00`) with a hand-rolled regex would reject
 * every real Instagram timestamp, and the failure would look like "no new
 * comments" rather than a parse error.
 */
export function instagramInstantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

export function instagramIsNewAgainstWatermark(
  stored: InstagramWatermark | null,
  timestamp: string | null | undefined,
  id: string,
): boolean {
  if (stored === null) return true;
  const at = instagramInstantMs(timestamp);
  const mark = instagramInstantMs(stored.watermark);
  if (at === null || mark === null) return true;
  if (at > mark) return true;
  if (at < mark) return false;
  return !stored.seenAtWatermark.includes(id);
}

export function instagramAdvanceWatermark(
  stored: InstagramWatermark | null,
  timestamp: string | null | undefined,
  id: string,
): InstagramWatermark {
  const at = instagramInstantMs(timestamp);
  const mark = stored ? instagramInstantMs(stored.watermark) : null;

  if (at === null) return stored ?? { watermark: '', seenAtWatermark: [] };
  if (stored === null || mark === null || at > mark) {
    return { watermark: timestamp as string, seenAtWatermark: [id] };
  }
  if (at < mark) return stored;
  return stored.seenAtWatermark.includes(id)
    ? stored
    : { watermark: stored.watermark, seenAtWatermark: [...stored.seenAtWatermark, id] };
}

/* -------------------------------------------------------------------------- */
/* D-031 — the loss bound, made computable                                    */
/* -------------------------------------------------------------------------- */

/**
 * Did this pass's window fail to reach back to what we last saw?
 *
 * THE PREDICATE IS THE WHOLE POINT. A capped, unpageable, newest-first edge
 * gives back 50 comments whether or not there were 51, and the two cases are
 * indistinguishable from the result alone. But they ARE distinguishable from the
 * result plus the watermark: if a FULL page's OLDEST item is still newer than
 * the watermark, the window did not reach the last thing we saw, so at least one
 * comment fell off the end and is now unreachable — the API offers no way to
 * address it.
 *
 * Returns false when the page is short (the window covered everything available)
 * or when its oldest item is at or older than the watermark (the window bridged
 * the gap). Both are the safe answers, and both are common.
 *
 * ⚠ A COLD START IS NOT EXEMPT, and an earlier version of this function said it
 * was. The reasoning was that with no watermark there is no gap to bridge, so a
 * full first page is "simply the newest 50 — the accepted starting position".
 * That confuses INTENT with DATA. If the account already has 200 comments, a
 * capped first read reaches 50 of them and the other 150 are as unreachable as
 * any mid-stream overflow: same cap, same absent paging, same permanence. The
 * conformance kit caught it — under a small cap it observed the adapter
 * under-delivering on cold start, which is precisely the case the exemption
 * would have declared healthy.
 *
 * So a FULL page reports the condition either way. What differs is only the
 * explanation a caller gets, which is why the caller is told which case it is.
 */
export function instagramWindowOverflowed(
  page: readonly { id: string; timestamp: string }[],
  stored: InstagramWatermark | null,
  maxPerQuery: number = INSTAGRAM_COMMENTS_MAX_PER_QUERY,
): boolean {
  if (page.length < maxPerQuery) return false;
  // Cold start: a full page means history was truncated at the cap. There is no
  // watermark to compare against, and none is needed — the page being full IS
  // the evidence.
  if (stored === null) return true;

  const mark = instagramInstantMs(stored.watermark);
  if (mark === null) return false;

  let oldest: number | null = null;
  for (const item of page) {
    const at = instagramInstantMs(item.timestamp);
    if (at === null) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  if (oldest === null) return false;

  return oldest > mark;
}
