/**
 * Concerns shared by the Threads adapters — P-018.
 *
 * WHY THIS IS NOT `instagram-common.ts` WITH A DIFFERENT HOST, even though both
 * sit under one Meta app identity and one review. Every structural similarity
 * here is superficial, and each of the four facts below would produce an
 * adapter that passes every test and is wrong against the live API:
 *
 *  - THE HOST IS A THIRD ONE. `graph.threads.net` at `v1.0` — not
 *    `graph.facebook.com` (Pages, and Instagram's Facebook-Login flavor) and
 *    not `graph.instagram.com`. No URL helper or version pin transfers.
 *  - THREADS IS TEXT-PRIMARY; INSTAGRAM IS MEDIA-PRIMARY. `media_type=TEXT`
 *    with `text` alone is a complete post here, where Instagram requires media
 *    on every publish. An adapter copied across would refuse every valid post.
 *  - POST AND REPLY ARE ONE PATH, not two. Instagram's reply is a single call
 *    and its post is two; Threads publishes both through container +
 *    threads_publish, differing only by `reply_to_id` (D-035).
 *  - THERE IS NO USAGE HEADER AND NO THROTTLE CODE (D-037). Instagram's 80002
 *    and `X-Business-Use-Case-Usage` do not exist on this host. Watching for
 *    them would mean watching for something never sent, which reads as healthy.
 *
 * FACTS THIS FILE ENCODES were read from live Meta documentation on 2026-08-23,
 * from the ENDPOINT pages as well as the overview — the reply permission gate,
 * the container expiry and the paging behaviour are each stated on exactly one
 * endpoint page and on no overview.
 */

/* -------------------------------------------------------------------------- */
/* API surface                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The Threads API host. The overview documents `graph.threads.net` and
 * `graph.threads.com` as equivalent; one is pinned rather than alternated so a
 * failure is never ambiguous between "the host is down" and "the other host
 * behaves differently".
 */
export const THREADS_GRAPH_ORIGIN = 'https://graph.threads.net';

/**
 * Pinned. Unlike Instagram — where the version SELECTS the ordering guarantee
 * and is therefore load-bearing — Threads documents ordering through an
 * explicit `reverse` parameter instead, so the version is a stability pin here
 * rather than a correctness one. It is still pinned: an unannounced major would
 * otherwise change field availability under a running integration.
 */
export const THREADS_GRAPH_VERSION = 'v1.0';

export function threadsGraphUrl(path: string, origin: string = THREADS_GRAPH_ORIGIN): string {
  const base = origin.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/${THREADS_GRAPH_VERSION}${suffix}`;
}

/**
 * Requested on the conversation edge.
 *
 * `root_post` and `replied_to` are the two that matter and neither is a
 * default: "Media ID of the top-level post or original thread in the reply
 * tree" and "Media ID of the immediate parent of the reply" respectively. They
 * are what makes a FLAT response reconstructable into a tree, and — more
 * importantly here — what lets the write path address a specific nested parent
 * (D-035) and what the ownership gate is checked against (D-039).
 */
export const THREADS_REPLY_FIELDS = [
  'id',
  'text',
  'username',
  'permalink',
  'timestamp',
  'media_type',
  'has_replies',
  'root_post',
  'replied_to',
  'is_reply',
  'is_reply_owned_by_me',
  'hide_status',
] as const;

/** Documented `media_type` values for CREATING a container. */
export type ThreadsCreateMediaType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';

/** "text: Optional. Required for media_type=TEXT" — capped at 500 characters. */
export const THREADS_TEXT_MAX_CHARS = 500;

/* -------------------------------------------------------------------------- */
/* Publishing timing — TWO constants, and only ONE matches Instagram          */
/* -------------------------------------------------------------------------- */

/**
 * "It is recommended to wait on average 30 seconds before publishing a Threads
 * media container."
 *
 * THREADS-ONLY. Instagram documents no equivalent pre-publish wait, so this is
 * not a constant that was read across — it is the reason the write adapter's
 * cadence differs from P-017's despite the two flows looking identical.
 */
export const THREADS_CONTAINER_SETTLE_MS = 30_000;

/**
 * "We recommend querying a container's status once per minute, for no more than
 * 5 minutes."
 *
 * This one GENUINELY MATCHES Instagram's guidance. Per D-005 a match between
 * two platforms is cited from both vendors rather than inferred from one, which
 * is why it is stated here with its own source rather than imported.
 */
export const THREADS_STATUS_POLL_INTERVAL_MS = 60_000;
export const THREADS_STATUS_POLL_MAX_MS = 5 * 60_000;

/**
 * Container lifetime, VERIFIED ON THREADS' OWN TROUBLESHOOTING PAGE rather than
 * assumed from Instagram's identical figure: the `EXPIRED` status reads "The
 * container was not published within 24 hours and has expired."
 */
export const THREADS_CONTAINER_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * The documented statuses of `GET /{threads-container-id}`.
 *
 * This endpoint is a DETECTION affordance, not idempotency (D-033): when a
 * publish call times out without returning a media id, asking the container
 * what happened distinguishes an already-published call from a lost one. The
 * retry still has to be gated on the answer — Threads documents no idempotency
 * key of any kind, so an ungated retry publishes twice.
 */
export type ThreadsContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

/**
 * Can a publish be retried, given what the container says?
 *
 * Returns the three-state answer D-033 requires. `null` means UNDETERMINED —
 * the probe did not settle it — and is deliberately distinct from `false`: a
 * caller must park an undetermined publish for a human rather than either
 * retrying it (double-post) or discarding it (silent loss).
 */
export function threadsPublishRetryable(status: ThreadsContainerStatus | null): boolean | null {
  switch (status) {
    // The media object exists. Retrying would publish a second copy.
    case 'PUBLISHED':
      return false;
    // Terminal without a media object: nothing was published, so a fresh
    // container is the correct recovery. EXPIRED needs a NEW container, not a
    // re-publish of this one — the caller is told so by name.
    case 'EXPIRED':
    case 'ERROR':
      return true;
    // Still moving, or ready but unpublished. Neither is a retry decision yet.
    case 'IN_PROGRESS':
    case 'FINISHED':
      return null;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials — the D-027 rail, re-derived for Threads                       */
/* -------------------------------------------------------------------------- */

/**
 * Every scope string below was resolved against the PERMISSIONS REFERENCE, not
 * the Threads overview. That is not pedantry: the overview's scope list omits
 * `threads_read_replies` entirely, and building the read path from it yields an
 * adapter missing the one permission its reads require.
 */
export const THREADS_SCOPE_BASIC = 'threads_basic';
export const THREADS_SCOPE_CONTENT_PUBLISH = 'threads_content_publish';
export const THREADS_SCOPE_MANAGE_REPLIES = 'threads_manage_replies';
export const THREADS_SCOPE_READ_REPLIES = 'threads_read_replies';

/**
 * The two scopes that would entitle replying to a root post we do NOT own.
 * Named so the ownership gate can explain precisely what would lift it, and
 * deliberately NOT requested (D-039).
 */
export const THREADS_SCOPES_REPLY_TO_UNOWNED = [
  'threads_keyword_search',
  'threads_manage_mentions',
] as const;

export interface ThreadsCredential {
  /** The Threads user id every write endpoint is addressed to. */
  userId: string;
  accessToken: string;
  /** Scopes actually granted, as returned by the OAuth exchange. */
  scopes: string[];
}

export class ThreadsCredentialError extends Error {
  readonly missingScope: string;
  constructor(message: string, missingScope: string) {
    super(message);
    this.name = 'ThreadsCredentialError';
    this.missingScope = missingScope;
  }
}

export function isThreadsCredential(value: unknown): value is ThreadsCredential {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.userId === 'string' &&
    c.userId !== '' &&
    typeof c.accessToken === 'string' &&
    c.accessToken !== '' &&
    Array.isArray(c.scopes) &&
    c.scopes.every((s) => typeof s === 'string')
  );
}

/**
 * Assert a credential is entitled to `requiredScope` BEFORE the call goes out.
 *
 * WHY BEFORE, RATHER THAN INSPECTING THE RESPONSE. D-027 measured that an
 * under-privileged read on this family of Meta surfaces returns EMPTY DATA
 * rather than an error, and Threads is the sharpest case in the registry: it
 * documents no error codes at all, so there is nothing in a response to
 * classify even in principle. A missing `threads_read_replies` would therefore
 * present as "this profile has no replies" — indefinitely, and identically to
 * the healthy quiet case. The pre-call assertion is the only point at which the
 * difference is still observable.
 */
export function assertThreadsCredential(
  credential: unknown,
  userId: string,
  requiredScope: string,
): asserts credential is ThreadsCredential {
  if (!isThreadsCredential(credential)) {
    throw new ThreadsCredentialError(
      'threads_credential_malformed: expected { userId, accessToken, scopes }',
      requiredScope,
    );
  }
  if (credential.userId !== userId) {
    throw new ThreadsCredentialError(
      `threads_credential_wrong_account: credential is for ${credential.userId}, call is for ${userId}`,
      requiredScope,
    );
  }
  if (!credential.scopes.includes(requiredScope)) {
    throw new ThreadsCredentialError(
      `threads_credential_missing_scope: ${requiredScope} is not granted, and Threads documents no error code, so this call would return an incomplete answer rather than fail`,
      requiredScope,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* D-039 — the reply ownership gate, made enforceable                         */
/* -------------------------------------------------------------------------- */

export class ThreadsReplyNotPermitted extends Error {
  readonly rootPostOwnerId: string | null;
  constructor(message: string, rootPostOwnerId: string | null) {
    super(message);
    this.name = 'ThreadsReplyNotPermitted';
    this.rootPostOwnerId = rootPostOwnerId;
  }
}

/**
 * May this profile reply under this root post?
 *
 * THE VENDOR STATES A GATE THAT NO SCOPE SATISFIES. Verbatim: "To reply to a
 * thread, you must meet one of the following permission requirements" — "You
 * are the owner of the root thread post" OR "You have either the
 * threads_keyword_search or the threads_manage_mentions permission." Holding
 * `threads_manage_replies` — the capability scope, which is separately required
 * — does not entitle you to reply under someone else's root post.
 *
 * v1 takes the ownership branch and requests neither review-heavy scope
 * (D-039), so this is where that decision becomes enforceable rather than
 * aspirational. Checked BEFORE the call for the same reason as the credential
 * assertion above: Threads publishes no error codes, so a refusal arriving from
 * the provider could not be told apart from any other failure.
 *
 * `rootPostOwnerId` is nullable because the conversation edge does not always
 * carry it. An UNKNOWN owner is refused rather than assumed — an adapter that
 * defaulted to "probably ours" would post publicly on the strength of a guess,
 * which is the one class of error here that cannot be taken back.
 */
export function assertThreadsMayReply(
  credential: ThreadsCredential,
  rootPostOwnerId: string | null | undefined,
): void {
  const owner = typeof rootPostOwnerId === 'string' && rootPostOwnerId !== '' ? rootPostOwnerId : null;

  const entitledByScope = THREADS_SCOPES_REPLY_TO_UNOWNED.some((s) => credential.scopes.includes(s));
  if (entitledByScope) return;

  if (owner === null) {
    throw new ThreadsReplyNotPermitted(
      'threads_reply_root_owner_unknown: the root post owner could not be determined, and replying is gated on owning it. ' +
        `Refusing rather than assuming ownership. Granting one of ${THREADS_SCOPES_REPLY_TO_UNOWNED.join(' or ')} would lift this gate.`,
      null,
    );
  }
  if (owner !== credential.userId) {
    throw new ThreadsReplyNotPermitted(
      `threads_reply_root_not_owned: the root post belongs to ${owner}, not ${credential.userId}. ` +
        `Replying under another profile's root post requires ${THREADS_SCOPES_REPLY_TO_UNOWNED.join(' or ')}, ` +
        'neither of which this integration requests (D-039).',
      owner,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Publishing limits — the ONE thing Threads lets you observe                 */
/* -------------------------------------------------------------------------- */

/**
 * The four per-profile buckets, as reported by
 * `GET /{threads-user-id}/threads_publishing_limit`.
 *
 * THIS IS STRICTLY BETTER THAN INSTAGRAM'S AFFORDANCE and it is worth being
 * precise about why, because the registry's `limits.notes` calls Threads the
 * weakest observability position in the registry and both statements are true.
 * These BUCKETS are absolute and queryable, where Instagram's header reports
 * only percentages. The general 4800-per-impression CALL budget, by contrast,
 * has neither an endpoint nor a header on Threads — it is unobservable, and
 * that is the half that makes the overall position weak.
 */
export interface ThreadsPublishingLimit {
  /** Posts published in the current rolling window, or null when unreported. */
  postsUsed: number | null;
  postsQuota: number | null;
  repliesUsed: number | null;
  repliesQuota: number | null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstRow(body: Record<string, unknown>): Record<string, unknown> {
  // The endpoint answers in the Graph `{ data: [ { ... } ] }` envelope. A bare
  // object is accepted too rather than refused: the shape is documented by
  // example only, and rejecting the un-enveloped form would turn a cosmetic
  // difference into a total loss of the only budget signal this platform has.
  const data = body.data;
  if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') {
    return data[0] as Record<string, unknown>;
  }
  return body;
}

/**
 * Parse the publishing-limit response.
 *
 * Every field is INDEPENDENTLY nullable. A partial answer is common and is not
 * an error, but a missing field must never read as zero-used: that would look
 * like a full allowance and authorise exactly the burst the check exists to
 * prevent. Absent stays null all the way to the consumer, which treats it as
 * "unknown" rather than "fine".
 */
export function parseThreadsPublishingLimit(body: unknown): ThreadsPublishingLimit {
  const empty: ThreadsPublishingLimit = {
    postsUsed: null,
    postsQuota: null,
    repliesUsed: null,
    repliesQuota: null,
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return empty;
  const row = firstRow(body as Record<string, unknown>);

  const config = row.config && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {};
  const replyConfig =
    row.reply_config && typeof row.reply_config === 'object' ? (row.reply_config as Record<string, unknown>) : {};

  return {
    postsUsed: finiteNumber(row.quota_usage),
    postsQuota: finiteNumber(config.quota_total),
    repliesUsed: finiteNumber(row.reply_quota_usage),
    repliesQuota: finiteNumber(replyConfig.quota_total),
  };
}

/**
 * Is there room to publish one more of `verb`?
 *
 * Returns `null` when the answer is UNKNOWN — the figure was not reported —
 * rather than collapsing unknown into permitted. The caller decides what to do
 * with an unknown; this function refuses to invent one, because the whole point
 * of consulting a bucket is that Threads gives no error code to recognise the
 * refusal after the fact.
 */
export function threadsHasQuotaFor(
  limit: ThreadsPublishingLimit,
  verb: 'post' | 'reply',
): boolean | null {
  const used = verb === 'post' ? limit.postsUsed : limit.repliesUsed;
  const quota = verb === 'post' ? limit.postsQuota : limit.repliesQuota;
  if (used === null || quota === null) return null;
  return used < quota;
}
