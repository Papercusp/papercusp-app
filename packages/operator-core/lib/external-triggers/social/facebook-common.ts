/**
 * Concerns shared by Facebook Pages' read and write adapters — P-016.
 *
 * WHY THIS FILE SHARES A CURSOR SHAPE AND `youtube-common.ts` DELIBERATELY DID
 * NOT. That file states plainly that nothing cursor-shaped belongs in it,
 * because YouTube's two streams differ in exactly one place — one has a real
 * server-side time filter and the other has none — so a shared cursor helper
 * would be the seam through which the weaker stream's limits leaked into the
 * stronger one. Facebook is the opposite case and the reasoning has to be
 * re-derived rather than copied: D-025 verified that NEITHER Facebook read
 * stream has a usable cursor and NEITHER has a documented time filter, so both
 * streams sit on the identical watermark-and-rescan model. Here a shared cursor
 * is not a leak — it is the accurate statement that these two streams really do
 * replay the same way. The rule is "share what is genuinely the same", and the
 * two files reach opposite conclusions from it because their platforms differ.
 *
 * FACTS THIS FILE ENCODES, read from live Meta documentation on 2026-08-23 and
 * recorded as plan decisions D-024 through D-028 — from the vendor pages, not
 * from the registry row and not from recall.
 */

import type { SocialQuotaObservation } from './storm-policy';

/* -------------------------------------------------------------------------- */
/* API surface                                                                */
/* -------------------------------------------------------------------------- */

export const FACEBOOK_GRAPH_ORIGIN = 'https://graph.facebook.com';

/**
 * The Graph API version these adapters were WRITTEN AND VERIFIED AGAINST.
 *
 * This is a pin, not a claim about which version is current. The `/comments`
 * edge reference consulted during P-016 verification served v23.0 and carried
 * its own notice that it was outdated and that the current version may differ.
 * Pinning what was actually read is the honest position: every fact in this
 * module is true of v23.0, and a version bump is therefore a deliberate act
 * that re-opens verification rather than a number to freshen in passing.
 *
 * Sending an explicit version also removes a question this module would
 * otherwise have to answer by assumption — what an unversioned Graph call
 * resolves to. That behaviour was not verified during P-016, so no code here
 * depends on it.
 */
export const FACEBOOK_GRAPH_VERSION = 'v23.0';

export function facebookGraphUrl(path: string, origin: string = FACEBOOK_GRAPH_ORIGIN): string {
  const base = origin.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : '/' + path;
  return base + '/' + FACEBOOK_GRAPH_VERSION + suffix;
}

/* -------------------------------------------------------------------------- */
/* Page credential — the D-027 correctness rail                               */
/* -------------------------------------------------------------------------- */

/**
 * Page-level tasks, verbatim from the `/me/accounts` sample response.
 *
 * Two Meta pages disagreed about which are required (D-024); the verified answer
 * is the union, and each capability names the one it actually needs rather than
 * relying on a page-wide list.
 */
export const FACEBOOK_TASK_CREATE_CONTENT = 'CREATE_CONTENT';
export const FACEBOOK_TASK_MODERATE = 'MODERATE';
export const FACEBOOK_TASK_MANAGE = 'MANAGE';
export const FACEBOOK_TASK_ANALYZE = 'ANALYZE';
export const FACEBOOK_TASK_ADVERTISE = 'ADVERTISE';

/**
 * A Page access token together with the provenance needed to trust it.
 *
 * `tasks` is carried because it is the ONLY way to know, before making a call,
 * whether a degraded-but-successful response is possible — see
 * `assertFacebookPageCredential`.
 */
export interface FacebookPageCredential {
  /** The Page this token was minted for, from the `/me/accounts` row. */
  pageId: string;
  /** The Page access token itself. Short-lived, per the vendor page. */
  accessToken: string;
  /** The `tasks` array for this Page, verbatim. */
  tasks: readonly string[];
}

/**
 * Raised when a call would proceed without a credential strong enough for its
 * result to be believed.
 *
 * THIS IS NOT AN AUTH ERROR IN THE ORDINARY SENSE, WHICH IS WHY IT HAS ITS OWN
 * TYPE. An ordinary auth failure announces itself: the provider returns 401 or
 * 403 and the caller cannot mistake it for data. D-027 verified that Facebook
 * does something materially worse on the comments edge — with a User access
 * token, `/comments` "returns empty data" rather than failing, and comment ids
 * are withheld from apps that cannot perform MODERATE. Both degrade the payload
 * while keeping the call successful, so the wrong credential yields a
 * well-formed, plausible, permanently-empty answer.
 *
 * The rail therefore has to fire BEFORE the request, not in response to it:
 * there is no response feature to key on afterwards.
 */
export class FacebookPageCredentialError extends Error {
  constructor(
    readonly pageId: string,
    readonly requiredTask: string,
    detail: string,
  ) {
    super('facebook_page_credential:' + pageId + ':' + requiredTask + ':' + detail);
    this.name = 'FacebookPageCredentialError';
  }
}

export function isFacebookPageCredential(value: unknown): value is FacebookPageCredential {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { pageId?: unknown; accessToken?: unknown; tasks?: unknown };
  if (typeof candidate.pageId !== 'string' || candidate.pageId.length === 0) return false;
  if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0) return false;
  return Array.isArray(candidate.tasks) && candidate.tasks.every((task) => typeof task === 'string');
}

/**
 * Establish, positively, that this credential can produce a believable result
 * for `pageId` and `requiredTask`. Throws otherwise.
 *
 * Callers must run this before a read whose EMPTY result they intend to trust,
 * and before any watermark advance. Advancing a watermark on an unverified empty
 * read converts one wrong-credential poll into permanent loss: a
 * watermark-and-rescan replay (D-025) never looks back past the mark, so the
 * events in that window become unreachable rather than merely delayed.
 */
export function assertFacebookPageCredential(
  credential: unknown,
  pageId: string,
  requiredTask: string,
): asserts credential is FacebookPageCredential {
  assertFacebookPageCredentialAnyOf(credential, pageId, [requiredTask]);
}

/**
 * The any-of form: the credential must carry AT LEAST ONE of `acceptableTasks`.
 *
 * WHY BOTH FORMS EXIST, RATHER THAN ONE PERMISSIVE ONE. The vendor requirement
 * genuinely differs by capability and the difference is not cosmetic. Reading
 * `/feed` needs the requester to hold "one of the Page tasks CREATE_CONTENT,
 * MANAGE, or MODERATE" — a disjunction. Reading COMMENTS needs MODERATE
 * specifically, because without it comment ids are withheld while the call still
 * succeeds (D-027). Collapsing the two into a single lenient check would let a
 * CREATE_CONTENT-only credential pass the comments rail, which is exactly the
 * silent-empty case the rail exists to stop; collapsing them the other way would
 * refuse a legitimate MANAGE-only reader. So each call site names the set it
 * actually requires.
 */
export function assertFacebookPageCredentialAnyOf(
  credential: unknown,
  pageId: string,
  acceptableTasks: readonly string[],
): asserts credential is FacebookPageCredential {
  const label = acceptableTasks.length ? acceptableTasks.join('|') : 'none-specified';
  if (acceptableTasks.length === 0) {
    throw new FacebookPageCredentialError(pageId, label, 'no-acceptable-tasks-declared');
  }
  if (!isFacebookPageCredential(credential)) {
    throw new FacebookPageCredentialError(pageId, label, 'not-a-page-credential');
  }
  if (credential.pageId !== pageId) {
    throw new FacebookPageCredentialError(pageId, label, 'minted-for:' + credential.pageId);
  }
  if (!acceptableTasks.some((task) => credential.tasks.includes(task))) {
    throw new FacebookPageCredentialError(
      pageId,
      label,
      'tasks:' + (credential.tasks.length ? credential.tasks.join('|') : 'none'),
    );
  }
}

/** Reading a Page's posts: the vendor accepts any ONE of these three tasks. */
export const FACEBOOK_READ_FEED_TASKS = [
  FACEBOOK_TASK_CREATE_CONTENT,
  FACEBOOK_TASK_MANAGE,
  FACEBOOK_TASK_MODERATE,
] as const;

/**
 * One row of the `/me/accounts` response, flattened to what is actually used.
 */
export interface FacebookAccountsRow {
  id?: unknown;
  access_token?: unknown;
  tasks?: unknown;
  name?: unknown;
}

/**
 * Pick the credential for `pageId` out of a `/me/accounts` response.
 *
 * Returns null rather than throwing when the Page is absent, because "this user
 * does not manage that Page" is a legitimate configuration answer the caller may
 * want to report differently from a malformed credential.
 */
export function selectFacebookPageCredential(
  rows: readonly FacebookAccountsRow[] | null | undefined,
  pageId: string,
): FacebookPageCredential | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (typeof row?.id !== 'string' || row.id !== pageId) continue;
    const token = typeof row.access_token === 'string' ? row.access_token.trim() : '';
    if (!token) return null;
    const tasks = Array.isArray(row.tasks) ? row.tasks.filter((t: unknown): t is string => typeof t === 'string') : [];
    return { pageId, accessToken: token, tasks };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Throttling — D-028                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The two documented throttle codes, and why BOTH are handled here.
 *
 * `80001` is the Business Use Case limit — "Page calls made with a Page or
 * System User access token". `32` is the Platform limit reached by "Page calls
 * made with a User access token". Which one a caller can hit is decided by the
 * token type it happens to be holding, and D-027 established that holding the
 * wrong token type is a real, silent possibility here. Handling only 80001
 * would leave the very failure mode that mis-credentialling produces
 * unclassified — a throttle that reads as an unknown error.
 */
export const FACEBOOK_THROTTLE_CODE_BUC = 80001;
export const FACEBOOK_THROTTLE_CODE_PLATFORM = 32;

/**
 * A throttle response.
 *
 * NOTE WHAT THIS CLASS DOES NOT HAVE: a retry delay. That absence is the point.
 * The vendor states that "Continuing to make calls will continue to increase
 * your call count, which will increase the time before calls will be successful
 * again" — so a retry does not merely fail, it lengthens the outage it is
 * responding to. Naming the field `holdMinutes` rather than `retryAfter` is a
 * deliberate refusal to hand a generic backoff wrapper something it would
 * cheerfully treat as a retry schedule.
 */
export class FacebookGraphThrottled extends Error {
  /**
   * `estimated_time_to_regain_access`: "Time, in minutes, until calls will not
   * longer be throttled" [sic]. Null when the provider did not state one — the
   * vendor documents no fixed fallback duration, so none is invented here.
   */
  readonly holdMinutes: number | null;

  constructor(
    readonly code: number,
    holdMinutes: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'FacebookGraphThrottled';
    this.holdMinutes = holdMinutes;
  }
}

/**
 * One object out of `X-Business-Use-Case-Usage`. Each numeric field is "a whole
 * number expressing the percentage" of the corresponding allowance.
 */
export interface FacebookBucUsage {
  businessId: string;
  type: string | null;
  callCount: number | null;
  totalCputime: number | null;
  totalTime: number | null;
  estimatedTimeToRegainAccess: number | null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Parse the `X-Business-Use-Case-Usage` header.
 *
 * The header is a JSON object keyed by business id, whose values are arrays; the
 * vendor states it "can return up to 32 objects in one call". A malformed or
 * absent header yields an empty array rather than throwing: usage telemetry
 * failing to parse must never be the thing that breaks a call that otherwise
 * succeeded.
 */
export function parseFacebookBucUsage(header: string | null | undefined): FacebookBucUsage[] {
  if (typeof header !== 'string' || header.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out: FacebookBucUsage[] = [];
  for (const [businessId, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      out.push({
        businessId,
        type: typeof row.type === 'string' ? row.type : null,
        callCount: finiteNumber(row.call_count),
        totalCputime: finiteNumber(row.total_cputime),
        totalTime: finiteNumber(row.total_time),
        estimatedTimeToRegainAccess: finiteNumber(row.estimated_time_to_regain_access),
      });
    }
  }
  return out;
}

/**
 * The highest utilisation percentage reported for `type` across the header.
 *
 * WHY A CONSUMER NEEDS THIS RATHER THAN A COMPILED-IN CAP. D-028 verified that
 * the Pages allowance is "4800 * Number of Engaged Users" over a rolling 24
 * hours — a budget that MOVES with engagement, and is therefore smallest exactly
 * when a Page is quiet. Any constant cap is wrong in one direction or the other;
 * the reported percentage is the only figure that tracks the real allowance.
 */
export function facebookPeakUsagePct(usage: readonly FacebookBucUsage[], type = 'pages'): number | null {
  let peak: number | null = null;
  for (const row of usage) {
    if (row.type !== null && row.type !== type) continue;
    for (const value of [row.callCount, row.totalCputime, row.totalTime]) {
      if (value === null) continue;
      if (peak === null || value > peak) peak = value;
    }
  }
  return peak;
}

/** Shape of a Graph error body, flattened to the fields that classify it. */
export interface FacebookGraphErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    error_subcode?: unknown;
    type?: unknown;
  };
}

/**
 * Classify a Graph response as a throttle, or null when it is not one.
 *
 * The hold duration is taken from the usage header when the body does not carry
 * one, because `estimated_time_to_regain_access` is documented as a header field
 * rather than an error field.
 */
export function facebookThrottleFrom(
  body: FacebookGraphErrorBody | null | undefined,
  usageHeader: string | null | undefined,
): FacebookGraphThrottled | null {
  const code = finiteNumber(body?.error?.code);
  if (code !== FACEBOOK_THROTTLE_CODE_BUC && code !== FACEBOOK_THROTTLE_CODE_PLATFORM) return null;
  const usage = parseFacebookBucUsage(usageHeader);
  let hold: number | null = null;
  for (const row of usage) {
    const stated = row.estimatedTimeToRegainAccess;
    if (stated === null) continue;
    if (hold === null || stated > hold) hold = stated;
  }
  const message =
    typeof body?.error?.message === 'string' && body.error.message.trim() !== ''
      ? body.error.message.trim()
      : 'facebook_graph_throttled_' + code;
  return new FacebookGraphThrottled(code, hold, message);
}

/**
 * How long to hold off entirely, in milliseconds — NOT a retry delay.
 *
 * Returns null when the provider stated no duration, which callers must treat as
 * "stop and surface", never as "guess a number and try again". Inventing a
 * fallback here would reintroduce precisely the retry that extends the block.
 */
export function facebookThrottleHoldMs(error: unknown): number | null {
  if (!(error instanceof FacebookGraphThrottled)) return null;
  const minutes = error.holdMinutes;
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null;
  return Math.ceil(minutes * 60_000);
}

/**
 * Translate what a Graph response revealed into the platform-neutral shape the
 * storm-policy layer consumes.
 *
 * WHY THE BRIDGE LIVES HERE AND NOT THERE. The storm-policy layer must not learn
 * Graph header names or error codes — it already derives caps for four other
 * platforms, and a vendor conditional inside it is how a generic layer becomes
 * four special cases. Everything vendor-shaped stops at this function; what
 * crosses is two facts any platform with a scaling allowance can state.
 *
 * NOTE WHAT IS DELIBERATELY NOT DONE: a throttle with no stated duration crosses
 * as `throttleHoldMs: null`, not as a default. The vendor documents that
 * continuing to call extends the block and states no fallback duration, so
 * inventing one here would put a retry loop underneath a policy whose entire
 * purpose is to prevent one.
 */
export function facebookQuotaObservation(
  usageHeader: string | null | undefined,
  error?: unknown,
): SocialQuotaObservation {
  const throttled = error instanceof FacebookGraphThrottled;
  const usage = parseFacebookBucUsage(usageHeader);
  return {
    peakUsagePct: facebookPeakUsagePct(usage),
    throttled,
    throttleHoldMs: throttled ? facebookThrottleHoldMs(error) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Paging — D-025                                                             */
/* -------------------------------------------------------------------------- */

export interface FacebookPaging {
  cursors?: { before?: unknown; after?: unknown };
  next?: unknown;
  previous?: unknown;
}

export interface FacebookConnection<T> {
  data?: T[];
  paging?: FacebookPaging;
}

/**
 * The next page URL, or null when iteration is genuinely finished.
 *
 * THE ONLY LEGAL TERMINATION TEST. Verbatim from the vendor: a page "may be
 * empty but contain a `next` paging link. Stop paging when the `next` link no
 * longer appears." So neither an empty `data` array nor a short page ends the
 * stream, and code that stops on either will silently truncate a read that had
 * more to give. Routing every termination decision through this one function is
 * what keeps that mistake from being made independently in each adapter.
 */
export function facebookNextPageUrl(connection: FacebookConnection<unknown> | null | undefined): string | null {
  const next = connection?.paging?.next;
  return typeof next === 'string' && next.trim() !== '' ? next.trim() : null;
}

/**
 * The honest statement of what a bounded rescan cannot see, exported as a string
 * so an operator-facing surface can quote it rather than rediscover it.
 */
export const FACEBOOK_RESCAN_BOUND =
  'Facebook Pages exposes no storable cursor and no documented since/until filter on either read stream (D-025), ' +
  'so each pass re-reads from the top and is bounded by maxPages. Two consequences are structural, not bugs: ' +
  '(1) the /feed family is documented as returning "approximately 600 ranked, published posts per year" — RANKED, ' +
  'not chronological — so this adapter derives no control flow from position and filters every item against the ' +
  'watermark instead of stopping at the first old one; (2) activity older than the bounded window is not seen. ' +
  'Neither is silent: the bound is a stated maxPages, and hitting it is reported rather than presented as completion.';

/* -------------------------------------------------------------------------- */
/* Time + cursor                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse a provider timestamp to epoch ms, or null when unusable.
 *
 * Every comparison goes through this rather than comparing ISO strings, because
 * two spellings of one instant are not string-equal and a re-spelled boundary
 * item would be emitted twice.
 */
export function facebookInstantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The persisted watermark, shared by both read streams.
 *
 * D-023 APPLIES, AND — AS WITH YOUTUBE'S COMMENTS STREAM — ONLY HALF OF IT. The
 * FLOOR half of that decision (query one millisecond behind the mark) needs a
 * query parameter to put the floor in, and D-025 verified there is none on
 * either Facebook stream. So `boundaryIds` carries the whole burden: an item
 * landing in the same instant as the watermark but arriving later must be
 * emitted, while one already emitted at that instant must not be, and no bare
 * `>` or `>=` comparison can do both.
 */
export interface FacebookWatermarkCursor {
  /** The newest instant emitted so far, stored verbatim as the provider spelled it. */
  watermark: string;
  /** Ids already emitted whose instant is exactly that mark. */
  boundaryIds: string[];
}

export function isFacebookWatermarkCursor(value: unknown): value is FacebookWatermarkCursor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { watermark?: unknown; boundaryIds?: unknown };
  if (typeof candidate.watermark !== 'string') return false;
  if (!Number.isFinite(Date.parse(candidate.watermark))) return false;
  return Array.isArray(candidate.boundaryIds) && candidate.boundaryIds.every((id) => typeof id === 'string');
}

/**
 * Decide whether an item at `instant` with id `id` is new, given the stored mark.
 *
 * Kept as one function rather than inlined per adapter because the
 * equal-instant case is the part that is easy to get subtly wrong in each place
 * independently, and both streams need identical behaviour.
 */
export function facebookIsNewAgainstWatermark(
  stored: FacebookWatermarkCursor | null,
  instant: string | null | undefined,
  id: string,
): boolean {
  if (!stored) return true;
  const at = facebookInstantMs(instant);
  // An unparseable instant cannot be placed against the mark. Emitting it is the
  // recoverable error (a duplicate the dedupe key absorbs); dropping it is not.
  if (at === null) return true;
  const mark = facebookInstantMs(stored.watermark);
  if (mark === null) return true;
  if (at < mark) return false;
  if (at === mark) return !stored.boundaryIds.includes(id);
  return true;
}

/**
 * Fold an emitted item into the cursor.
 *
 * When the instant EQUALS the current mark the id is added to `boundaryIds`;
 * when it exceeds it the mark advances and the boundary set is replaced rather
 * than appended to, since ids at the old instant can no longer collide.
 */
export function facebookAdvanceWatermark(
  stored: FacebookWatermarkCursor | null,
  instant: string | null | undefined,
  id: string,
): FacebookWatermarkCursor | null {
  const at = facebookInstantMs(instant);
  if (at === null) return stored;
  if (!stored) return { watermark: instant as string, boundaryIds: [id] };
  const mark = facebookInstantMs(stored.watermark);
  if (mark === null) return { watermark: instant as string, boundaryIds: [id] };
  if (at > mark) return { watermark: instant as string, boundaryIds: [id] };
  if (at === mark) {
    return stored.boundaryIds.includes(id)
      ? stored
      : { watermark: stored.watermark, boundaryIds: [...stored.boundaryIds, id] };
  }
  return stored;
}
