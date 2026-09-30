/**
 * LinkedIn shared facts and helpers (P-021).
 *
 * ⚠ THE ONE THING TO READ BEFORE TOUCHING THIS FILE: **LinkedIn IS WRITE-ONLY
 * FOR US, AND IT CANNOT REPLY.** That is not a gap waiting to be filled in by
 * whoever gets to it next — it is the verified shape of the self-serve grant,
 * and three separate instincts will push you to "fix" it:
 *
 *  1. `w_member_social`'s own DESCRIPTION, in LinkedIn's permissions reference
 *     and again in the Posts API table, reads "Post, **comment** and like posts
 *     on behalf of an authenticated member." Reading that and adding a reply
 *     verb is the single most likely wrong edit to this file. The endpoint that
 *     actually creates a comment — POST /rest/socialActions/{urn}/comments —
 *     declares a DIFFERENT scope in its own permissions table:
 *     `w_member_social_feed`, which does NOT appear among LinkedIn's open
 *     permissions. The scope's prose and the endpoint's table disagree; D-030's
 *     rule (the surface that declares a verb wins for that verb) resolves it
 *     toward the endpoint. Until a live call settles it, reply stays out.
 *  2. Every other adapter in this directory reads. This one has nothing to
 *     read: `r_member_social` is "restricted ... available to approved users
 *     only" and `r_member_social_feed` is "granted to select developers only",
 *     so even the member's OWN posts and the comments on them are unreachable.
 *     There is no cursor here because there is no stream, not because nobody
 *     wrote one.
 *  3. The Posts API error table says, of 409 CONFLICT, "A write conflict
 *     occurred. **Retry the request.**" Do not. See `linkedinCreateRetryable`.
 *
 * VERIFIED 2026-08-23 against the sources listed on the registry row. Facts are
 * cited from the endpoint that governs them rather than read across from a
 * sibling product (D-005): LinkedIn documents the same operation twice, in a
 * consumer self-serve page and a Community Management page, and the two do NOT
 * agree on either the path or the headers.
 */

/**
 * API host. Everything except OAuth lives here: /rest/*, /v2/*, and the
 * /mediaUpload/* URL handed back by assets?action=registerUpload.
 */
export const LINKEDIN_API_HOST = 'api.linkedin.com';

/**
 * OAuth host — DELIBERATELY DIFFERENT from the API host, and the difference is
 * load-bearing rather than cosmetic.
 *
 * Authorization, token exchange, the JWKS and the OIDC discovery document are
 * all served from www.linkedin.com. Most platforms in this registry serve both
 * from one host, so "api.linkedin.com/oauth/..." is the natural guess and it
 * simply does not resolve to the token endpoint. Verified against both the
 * 3-legged OAuth guide and the published discovery document, which names
 * `"token_endpoint": "https://www.linkedin.com/oauth/v2/accessToken"` and
 * `"userinfo_endpoint": "https://api.linkedin.com/v2/userinfo"` — the split
 * stated by the vendor in one object.
 */
export const LINKEDIN_OAUTH_HOST = 'www.linkedin.com';

export const LINKEDIN_AUTHORIZATION_URL = `https://${LINKEDIN_OAUTH_HOST}/oauth/v2/authorization`;
export const LINKEDIN_ACCESS_TOKEN_URL = `https://${LINKEDIN_OAUTH_HOST}/oauth/v2/accessToken`;
export const LINKEDIN_USERINFO_URL = `https://${LINKEDIN_API_HOST}/v2/userinfo`;
export const LINKEDIN_POSTS_URL = `https://${LINKEDIN_API_HOST}/rest/posts`;

/**
 * The three self-serve scopes, and ONLY those.
 *
 * Enumerated from the endpoints this adapter actually calls (D-034):
 * `openid` + `profile` reach /v2/userinfo, whose `sub` is the only way to build
 * the author URN; `w_member_social` reaches /rest/posts. `email` is available
 * self-serve too and is deliberately excluded — nothing here reads an address,
 * and LinkedIn's own guide asks for the least number of scopes. A scope in this
 * list that no call below needs is the phantom-scope defect D-034 named.
 */
export const LINKEDIN_SCOPE_OPENID = 'openid';
export const LINKEDIN_SCOPE_PROFILE = 'profile';
export const LINKEDIN_SCOPE_WRITE_MEMBER = 'w_member_social';

/**
 * The scope the Comments API declares, recorded so the gap is NAMED rather than
 * merely absent. Nothing requests it: it is not self-serve. It exists here so a
 * future reader who wants reply can see exactly which grant would be required
 * instead of re-deriving it from a scope description that misleadingly claims
 * commenting is already covered.
 */
export const LINKEDIN_SCOPE_WRITE_MEMBER_FEED_NOT_GRANTED = 'w_member_social_feed';

/**
 * Protocol header required on every call ("All requests require the following
 * header"), stated by both the consumer and the Community Management docs.
 */
export const LINKEDIN_RESTLI_PROTOCOL_HEADER = 'X-Restli-Protocol-Version';
export const LINKEDIN_RESTLI_PROTOCOL_VERSION = '2.0.0';

/**
 * Versioning header required by the /rest/* APIs (NOT by legacy /v2/ugcPosts).
 *
 * PINNED, not computed from the clock. A `YYYYMM` derived from `now` silently
 * rolls onto a version LinkedIn may not serve yet and turns a calendar
 * boundary into an outage; worse, it would change adapter behaviour with no
 * code change and no test able to catch it. Bumping this is a deliberate edit
 * with a re-read of the migration notes — which matters here because LinkedIn
 * sunsets versions on a published schedule.
 */
export const LINKEDIN_VERSION_HEADER = 'LinkedIn-Version';
export const LINKEDIN_VERSION = '202608';

/**
 * Response header carrying the created entity's id.
 *
 * Case differs BETWEEN LinkedIn's own docs for the same operation — the
 * consumer page says `X-RestLi-Id`, the versioned Posts API page says
 * `x-restli-id` — so any lookup must be case-insensitive. HTTP header names are
 * case-insensitive anyway; this constant is lowercase because that is the form
 * `Headers.get` normalizes to, and `linkedinCreatedId` does not assume a
 * particular casing at all.
 */
export const LINKEDIN_CREATED_ID_HEADER = 'x-restli-id';

/** Throttle status. LinkedIn documents no error CODE body for this, only 429. */
export const LINKEDIN_THROTTLE_STATUS = 429;

/**
 * Member daily request budget (Share on LinkedIn), resetting midnight UTC.
 *
 * The binding limit for a single owner and ~667x smaller than the application
 * budget, so it is what a storm policy must ration against. Counts REQUESTS,
 * not posts.
 */
export const LINKEDIN_MEMBER_DAILY_REQUESTS = 150;

/** Application daily request budget, resetting midnight UTC. */
export const LINKEDIN_APPLICATION_DAILY_REQUESTS = 100_000;

/**
 * Access-token lifetime: 60 days (`expires_in: 5184000`).
 *
 * Recorded as a constant because it is an OPERATIONAL fact with teeth, not
 * trivia: programmatic refresh tokens are partner-only, so a self-serve
 * connection cannot renew itself and simply stops working at this boundary
 * until a human completes the browser flow.
 */
export const LINKEDIN_ACCESS_TOKEN_TTL_SECONDS = 5_184_000;

/** A resolved LinkedIn connection. */
export interface LinkedInCredential {
  accessToken: string;
  /**
   * The member id from userinfo's `sub` — NOT a full URN.
   *
   * Stored bare so `linkedinAuthorUrn` is the single place the URN is spelled;
   * storing a pre-built URN invites two spellings of the same identity to drift
   * apart, which is how an author field ends up with a doubled prefix.
   */
  memberId: string;
  /** Scopes the token was actually granted, for pre-flight refusal. */
  scopes: string[];
  /** Epoch ms at which the token expires, when known. */
  expiresAtMs?: number;
}

export class LinkedInCredentialError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`linkedin_credential:${reason}: ${detail}`);
    this.name = 'LinkedInCredentialError';
    this.reason = reason;
  }
}

/** Build the Person URN LinkedIn expects in a post's `author` field. */
export function linkedinAuthorUrn(memberId: string): string {
  const id = memberId.trim();
  if (!id) throw new LinkedInCredentialError('member-id-missing', 'no member id on the credential');
  // Tolerate a value that is ALREADY a URN rather than doubling the prefix.
  // Callers reasonably disagree about whether they hold an id or a URN, and a
  // doubled prefix produces `urn:li:person:urn:li:person:x`, which LinkedIn
  // rejects as INVALID_URN_ID — a confusing error for a trivial cause.
  if (id.startsWith('urn:li:person:')) return id;
  return `urn:li:person:${id}`;
}

/**
 * Refuse a write the credential cannot perform, BEFORE any network call.
 *
 * Pre-flight rather than post-hoc because LinkedIn answers a missing scope with
 * 403 ACCESS_DENIED — indistinguishable at the call site from "this member
 * lacks a company page role" — and because a refused call still spends one of
 * the member's 150 daily requests.
 */
export function assertLinkedInCredential(credential: LinkedInCredential): void {
  if (!credential.accessToken?.trim()) {
    throw new LinkedInCredentialError('token-missing', 'no access token on the connection');
  }
  if (!credential.memberId?.trim()) {
    throw new LinkedInCredentialError(
      'member-id-missing',
      `no member id — obtain it from ${LINKEDIN_USERINFO_URL} (\`sub\`), which needs the '${LINKEDIN_SCOPE_OPENID}' and '${LINKEDIN_SCOPE_PROFILE}' scopes`,
    );
  }
  if (!credential.scopes.includes(LINKEDIN_SCOPE_WRITE_MEMBER)) {
    throw new LinkedInCredentialError(
      'scope-missing',
      `writing requires '${LINKEDIN_SCOPE_WRITE_MEMBER}' (granted by the self-serve Share on LinkedIn product); this token holds [${credential.scopes.join(', ')}]`,
    );
  }
}

/**
 * Whether the token is expired at `nowMs`.
 *
 * Its own function because the answer is ACTIONABLE and platform-specific: an
 * expired LinkedIn token cannot be refreshed programmatically on a self-serve
 * app, so this is not a transient error to retry through — it is a request for
 * human re-authorisation, and the two must not be conflated.
 */
export function linkedinTokenExpired(credential: LinkedInCredential, nowMs: number): boolean {
  return typeof credential.expiresAtMs === 'number' && credential.expiresAtMs <= nowMs;
}

/**
 * Extract the created entity id from response headers, case-insensitively.
 *
 * Returns null rather than throwing: a create that returned 201 with no id
 * header is precisely the AMBIGUOUS case the write adapter must not retry, and
 * that decision belongs to the caller rather than to a parser.
 */
export function linkedinCreatedId(headers: Iterable<[string, string]>): string | null {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === LINKEDIN_CREATED_ID_HEADER) {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/**
 * Whether a failed CREATE may be retried automatically. It may not — ever.
 *
 * ⚠ THIS FUNCTION DELIBERATELY CONTRADICTS THE VENDOR'S OWN DOCUMENTATION, and
 * that is the whole reason it exists as a named function instead of an inline
 * `if`. The Posts API error table lists 409 CONFLICT as "A write conflict
 * occurred. **Retry the request.**" LinkedIn offers NO idempotency key, header
 * or dedupe of any kind on post creation, so following that advice on a request
 * that may well have succeeded publishes a SECOND post to the owner's real
 * profile. A duplicate public post is not correctable the way a duplicate
 * request to an idempotent endpoint is.
 *
 * The same reasoning covers 500 and 503 ("Retry the request", "Retry ... after
 * a brief delay") and any network-level failure: none of them tell you whether
 * the write landed.
 *
 * Always false, by construction. It takes a status so call sites read as a
 * decision rather than a constant, and so the test suite can pin the whole
 * documented retry-advice set — 409/500/503 — as refused rather than pinning
 * one example and hoping.
 */
export function linkedinCreateRetryable(_status: number): boolean {
  return false;
}

/**
 * Whether a failed DELETE may be retried. It may.
 *
 * The asymmetry with create is the vendor's, not ours, and it is stated
 * explicitly: "Post deletions are idempotent. Deletion requests for a
 * previously deleted UGC Post will return a 204 code - No Content." A retried
 * delete cannot produce a second visible artefact, so the usual transient
 * classes are safe here.
 *
 * 429 is excluded on purpose: retrying INTO a throttle is what deepens it, and
 * a delete is never urgent enough to justify that.
 */
export function linkedinDeleteRetryable(status: number): boolean {
  return status === 500 || status === 503 || status === 504;
}

/** Headers every /rest/* call carries. */
export function linkedinRestHeaders(credential: LinkedInCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    [LINKEDIN_RESTLI_PROTOCOL_HEADER]: LINKEDIN_RESTLI_PROTOCOL_VERSION,
    [LINKEDIN_VERSION_HEADER]: LINKEDIN_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Percent-encode a URN for use as a PATH SEGMENT.
 *
 * `encodeURIComponent` alone is not enough for LinkedIn's rest.li routing: it
 * leaves `(`, `)`, `'`, `!` and `*` unescaped, and composite URNs — the shape
 * every comment id takes, `urn:li:comment:(urn:li:activity:123,456)` — contain
 * parentheses and commas that rest.li parses as structure. The docs' own note
 * ("URNs included in the URL params must be URL encoded") understates this by
 * showing only the simple colon case.
 */
export function linkedinEncodeUrn(urn: string): string {
  return encodeURIComponent(urn).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
