/**
 * Threads writes — post and reply (P-018).
 *
 * ⚠ ONE PATH, NOT TWO, AND THIS IS THE FILE MOST LIKELY TO BE WRITTEN WRONG BY
 * COPYING ITS NEIGHBOUR. `instagram-write-adapter.ts` has genuinely asymmetric
 * shapes — a reply is ONE call to `/{ig-comment-id}/replies`, a post is TWO
 * (`/media` then `/media_publish`) — and an author working from it will reach
 * for that split. Threads does not have it: BOTH verbs go through container +
 * `threads_publish`, differing only by the container's `reply_to_id` (D-035).
 * Modelling two paths here would invent a distinction the vendor does not make
 * and double the surface where the retry logic can drift apart.
 *
 * THREE MORE INHERITANCES THAT WOULD BE WRONG:
 *  - MEDIA IS NOT REQUIRED. Threads is TEXT-PRIMARY — `media_type=TEXT` with
 *    `text` alone is a complete post — where Instagram is media-primary and
 *    must refuse a text-only request. An adapter that asserted media here would
 *    reject every ordinary Threads post (D-032).
 *  - THE PRE-PUBLISH WAIT IS THREADS-ONLY. "It is recommended to wait on
 *    average 30 seconds before publishing a Threads media container." Instagram
 *    documents no such wait. The STATUS-poll cadence, by contrast, genuinely
 *    matches — cited from both vendors rather than read across (D-005).
 *  - THERE IS NO THROTTLE CODE TO CATCH (D-037). Threads documents none, so
 *    this adapter cannot classify a throttle from a response and does not
 *    pretend to; the protection is the pre-flight bucket check below.
 *
 * WHAT IS THE SAME, AND VERIFIED SO RATHER THAN ASSUMED: there is no
 * idempotency mechanism of any kind, so a retried publish creates a second
 * public post. The container status endpoint is a DETECTION affordance, not
 * idempotency (D-033) — it tells you what happened, and the retry still has to
 * be gated on the answer.
 */
import type { OutboundContext } from '../../capability-verbs/resolve';
import type {
  SocialPostRequest,
  SocialPostOutcome,
  SocialReplyOutcome,
  SocialReplyRequest,
  SocialReplyTarget,
  SocialWriteAdapter,
} from '../../capability-verbs/social';
import {
  assertThreadsCredential,
  assertThreadsMayReply,
  parseThreadsPublishingLimit,
  threadsHasQuotaFor,
  threadsPublishRetryable,
  THREADS_CONTAINER_SETTLE_MS,
  THREADS_SCOPE_CONTENT_PUBLISH,
  THREADS_SCOPE_MANAGE_REPLIES,
  THREADS_STATUS_POLL_INTERVAL_MS,
  THREADS_STATUS_POLL_MAX_MS,
  THREADS_TEXT_MAX_CHARS,
  type ThreadsContainerStatus,
  type ThreadsCreateMediaType,
  type ThreadsCredential,
} from './threads-common';

/**
 * A write that could not be confirmed to have happened — and, crucially, could
 * not be confirmed NOT to have happened either.
 *
 * Separate from a plain failure because the two demand opposite responses. A
 * refused write can be retried; an unconfirmed one must NOT be, because Threads
 * has no idempotency key and the retry would publish a second visible post.
 */
export class ThreadsWriteUnconfirmed extends Error {
  readonly verb: 'post' | 'reply';
  readonly reason: string;
  constructor(verb: 'post' | 'reply', reason: string) {
    super(`threads_write_unconfirmed:${verb}: ${reason}`);
    this.name = 'ThreadsWriteUnconfirmed';
    this.verb = verb;
    this.reason = reason;
  }
}

/**
 * The publish call did not return a media id and the container could not settle
 * the question either.
 *
 * Carries the last observed status so a human resolving it by hand starts from
 * evidence rather than from scratch. `retryable` is the three-state answer
 * (D-033): `null` means UNDETERMINED and must not be collapsed into `false`.
 */
export class ThreadsPublishAmbiguous extends Error {
  readonly containerId: string;
  readonly lastStatus: ThreadsContainerStatus | null;
  readonly retryable: boolean | null;
  constructor(containerId: string, lastStatus: ThreadsContainerStatus | null) {
    const retryable = threadsPublishRetryable(lastStatus);
    super(
      `threads_publish_ambiguous: container ${containerId} last reported ${lastStatus ?? 'no status'}; ` +
        (retryable === true
          ? 'nothing was published, so a NEW container may be created'
          : retryable === false
            ? 'the post EXISTS — do not retry, or it will be published twice'
            : 'the outcome is undetermined — park this for a human rather than guessing'),
    );
    this.name = 'ThreadsPublishAmbiguous';
    this.containerId = containerId;
    this.lastStatus = lastStatus;
    this.retryable = retryable;
  }
}

/**
 * Local dedupe, because the vendor offers none.
 *
 * Keyed on the DERIVED idempotency key, so a retry of the same logical write is
 * absorbed here rather than becoming a second public post. This is a guard, not
 * a guarantee: it cannot survive a process restart, which is precisely why the
 * container-status probe below exists as the second line.
 */
export interface ThreadsWriteDedupe {
  get(key: string): Promise<{ externalId: string } | null>;
  set(key: string, value: { externalId: string }): Promise<void>;
}

export function inMemoryThreadsWriteDedupe(): ThreadsWriteDedupe {
  const seen = new Map<string, { externalId: string }>();
  return {
    async get(key) {
      return seen.get(key) ?? null;
    },
    async set(key, value) {
      seen.set(key, value);
    },
  };
}

export interface ThreadsCreateContainerRequest {
  credential: ThreadsCredential;
  userId: string;
  mediaType: ThreadsCreateMediaType;
  text: string;
  imageUrl?: string;
  videoUrl?: string;
  /** Present ONLY for a reply. Its absence is what makes this a root post. */
  replyToId?: string;
}

export interface ThreadsPublishRequest {
  credential: ThreadsCredential;
  userId: string;
  creationId: string;
}

export interface ThreadsCreated {
  id: string;
}

export interface ThreadsWriteClient {
  /** POST /{threads-user-id}/threads — returns the container id. */
  createContainer(request: ThreadsCreateContainerRequest): Promise<ThreadsCreated>;
  /** POST /{threads-user-id}/threads_publish — returns the media id. */
  publishContainer(request: ThreadsPublishRequest): Promise<ThreadsCreated>;
  /** GET /{threads-container-id} — the detection affordance, never idempotency. */
  getContainerStatus(args: {
    credential: ThreadsCredential;
    containerId: string;
  }): Promise<ThreadsContainerStatus | null>;
  /**
   * GET /{threads-user-id}/threads_publishing_limit.
   *
   * OPTIONAL because it is a pre-flight, not a dependency. When absent the
   * adapter publishes without checking — which is the Instagram posture — and
   * when present it can refuse BEFORE spending a call, which matters more here
   * than anywhere else in the registry: Threads publishes no throttle code, so
   * a bucket refusal arriving from the provider could not be recognised as one.
   */
  getPublishingLimit?(args: { credential: ThreadsCredential; userId: string }): Promise<unknown>;
}

export interface ThreadsWriteAdapterDeps {
  client: ThreadsWriteClient;
  userId: string;
  credential: ThreadsCredential;
  dedupe?: ThreadsWriteDedupe;
  /**
   * Injected so the vendor's real cadence is a real constant in production and
   * instant under test. A test that genuinely waited would either take five and
   * a half minutes or force the constants down to values that no longer model
   * the documented behaviour — and the second is worse, because it passes.
   */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ThreadsWriteAdapter implements SocialWriteAdapter {
  readonly platform = 'threads' as const;

  private readonly client: ThreadsWriteClient;
  private readonly userId: string;
  private readonly credential: ThreadsCredential;
  private readonly dedupe: ThreadsWriteDedupe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: ThreadsWriteAdapterDeps) {
    this.client = deps.client;
    this.userId = deps.userId;
    this.credential = deps.credential;
    this.dedupe = deps.dedupe ?? inMemoryThreadsWriteDedupe();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  async reply(request: SocialReplyRequest, _context: OutboundContext): Promise<SocialReplyOutcome> {
    assertThreadsCredential(this.credential, this.userId, THREADS_SCOPE_MANAGE_REPLIES);
    const target = this.threadsTarget(request.target);

    // THE D-039 GATE, BEFORE THE CALL. Threads gates replying on owning the root
    // post unless a review-heavy scope is held, and publishes no error code to
    // recognise a refusal by. An unknown owner is refused rather than assumed —
    // guessing would publish a visible reply that cannot be taken back.
    assertThreadsMayReply(this.credential, target.rootPostOwnerId);

    return this.publish('reply', request.text, request.idempotencyKey, { replyToId: target.replyToId });
  }

  async post(request: SocialPostRequest, _context: OutboundContext): Promise<SocialPostOutcome> {
    assertThreadsCredential(this.credential, this.userId, THREADS_SCOPE_CONTENT_PUBLISH);

    // NO MEDIA ASSERTION, DELIBERATELY (D-032). Instagram's adapter refuses a
    // text-only request because there is no text-only Instagram feed post to
    // create. Threads' own worked example is "Create a media container with
    // text only", so the same assertion here would reject the ordinary case.
    const media = request.media?.[0];
    return this.publish('post', request.text, request.idempotencyKey, {
      ...(media?.type === 'image' ? { mediaType: 'IMAGE' as const, imageUrl: media.url } : {}),
      ...(media?.type === 'video' ? { mediaType: 'VIDEO' as const, videoUrl: media.url } : {}),
    });
  }

  /**
   * The single write path both verbs take.
   *
   * ORDER MATTERS AND IS NOT ARBITRARY: validate → dedupe → quota pre-flight →
   * create → settle → publish. Everything that can refuse cheaply refuses
   * before a container exists, because an abandoned container is not free — it
   * occupies the profile's 24-hour publishing state until it expires, and a
   * caller cannot see it.
   */
  private async publish(
    verb: 'post' | 'reply',
    text: string,
    idempotencyKey: string,
    extra: {
      replyToId?: string;
      mediaType?: ThreadsCreateMediaType;
      imageUrl?: string;
      videoUrl?: string;
    },
  ): Promise<SocialReplyOutcome> {
    const mediaType: ThreadsCreateMediaType = extra.mediaType ?? 'TEXT';

    if (mediaType === 'TEXT' && text.trim().length === 0) {
      // `text` is documented "Required for media_type=TEXT". Refused locally
      // because a failed write and an ambiguous one are indistinguishable from
      // the caller's side, so an avoidable failure is an avoidable retry
      // decision — on a platform where the wrong retry double-posts.
      throw new ThreadsWriteUnconfirmed(verb, 'empty-text: text is required for media_type=TEXT');
    }
    if (text.length > THREADS_TEXT_MAX_CHARS) {
      throw new ThreadsWriteUnconfirmed(
        verb,
        `text-too-long: ${text.length} characters exceeds the documented ${THREADS_TEXT_MAX_CHARS}-character limit`,
      );
    }

    const cached = await this.dedupe.get(idempotencyKey);
    if (cached) return this.outcome(cached.externalId);

    await this.assertQuota(verb);

    const container = await this.client.createContainer({
      credential: this.credential,
      userId: this.userId,
      mediaType,
      text,
      ...(extra.imageUrl ? { imageUrl: extra.imageUrl } : {}),
      ...(extra.videoUrl ? { videoUrl: extra.videoUrl } : {}),
      ...(extra.replyToId ? { replyToId: extra.replyToId } : {}),
    });

    // "It is recommended to wait on average 30 seconds before publishing a
    // Threads media container" — so the server has "enough time to fully
    // process the upload". Threads-only; do not carry to or from Instagram.
    await this.sleep(THREADS_CONTAINER_SETTLE_MS);

    let published: ThreadsCreated;
    try {
      published = await this.client.publishContainer({
        credential: this.credential,
        userId: this.userId,
        creationId: container.id,
      });
    } catch (error) {
      // THE ONE PLACE A RETRY WOULD DOUBLE-POST. The publish may have succeeded
      // and the response been lost, so the container — not the exception — is
      // the authority on what happened.
      throw await this.disambiguate(container.id, error);
    }

    if (!published?.id) {
      throw await this.disambiguate(container.id, null);
    }

    await this.dedupe.set(idempotencyKey, { externalId: published.id });
    return this.outcome(published.id);
  }

  /**
   * Ask the container what actually happened.
   *
   * "We recommend querying a container's status once per minute, for no more
   * than 5 minutes." The loop STOPS as soon as the answer is decisive; it does
   * not run the full five minutes to be thorough, because every extra call
   * spends from a budget this platform will not report on.
   *
   * A probe that itself throws is swallowed on purpose: the caller's problem is
   * the ORIGINAL ambiguous write, and replacing it with "the status probe
   * failed" would discard the containerId a human needs to resolve it.
   */
  private async disambiguate(containerId: string, cause: unknown): Promise<Error> {
    const deadline = this.now() + THREADS_STATUS_POLL_MAX_MS;
    let last: ThreadsContainerStatus | null = null;

    for (;;) {
      try {
        last = await this.client.getContainerStatus({ credential: this.credential, containerId });
      } catch {
        last = null;
      }
      if (threadsPublishRetryable(last) !== null) break;
      if (this.now() >= deadline) break;
      await this.sleep(THREADS_STATUS_POLL_INTERVAL_MS);
    }

    const ambiguous = new ThreadsPublishAmbiguous(containerId, last);
    if (cause instanceof Error) ambiguous.cause = cause;
    return ambiguous;
  }

  /**
   * Pre-flight the per-verb bucket.
   *
   * WHY THIS EXISTS HERE AND NOT ON INSTAGRAM. Threads declares SEPARATE
   * rolling buckets for posts (250) and replies (1,000), so a reply may not be
   * rationed against the publishing bucket or vice versa (D-030). More
   * importantly it publishes no throttle error code, so exhausting a bucket
   * produces a failure this adapter could not classify after the fact — the
   * check has to happen before.
   *
   * AN UNKNOWN ANSWER PROCEEDS. `threadsHasQuotaFor` returns null when the
   * figure was not reported, and treating unknown as exhausted would let one
   * missing field silently halt all writing.
   */
  private async assertQuota(verb: 'post' | 'reply'): Promise<void> {
    if (!this.client.getPublishingLimit) return;
    let limit;
    try {
      limit = parseThreadsPublishingLimit(
        await this.client.getPublishingLimit({ credential: this.credential, userId: this.userId }),
      );
    } catch {
      // The pre-flight is an optimisation over an unreportable failure, not a
      // gate on writing. A broken probe must not become an outage.
      return;
    }
    if (threadsHasQuotaFor(limit, verb) === false) {
      throw new ThreadsWriteUnconfirmed(
        verb,
        `quota-exhausted: the ${verb} bucket reports no remaining allowance in the rolling 24-hour window. ` +
          'Nothing was sent, so this is safe to retry once the window moves.',
      );
    }
  }

  /**
   * No `url`. The documented response to both calls is `{"id": "..."}` and
   * nothing more — a verified ABSENCE rather than an omission here. `permalink`
   * exists as a READ field on the reply node, so an address can be fetched
   * later; synthesising one from the id would be inventing a URL format the
   * vendor never published.
   */
  private outcome(externalId: string): SocialReplyOutcome {
    return { externalId, ref: `threads:${externalId}` };
  }

  private threadsTarget(target: SocialReplyTarget): Extract<SocialReplyTarget, { platform: 'threads' }> {
    if (target.platform !== 'threads') {
      throw new ThreadsWriteUnconfirmed(
        'reply',
        `wrong-target-platform: received a ${target.platform} target on the Threads adapter`,
      );
    }
    return target;
  }
}
