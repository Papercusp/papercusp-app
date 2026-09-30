/**
 * The Instagram WRITE adapter — P-017.
 *
 * TWO VERBS WITH GENUINELY DIFFERENT SHAPES, which is the whole reason this is
 * not `facebook-write-adapter.ts` with the host swapped. On Pages both verbs are
 * one POST. Here:
 *
 *   reply → POST /{ig-comment-id}/replies            ONE call
 *   post  → POST /{ig-id}/media        (container)   TWO calls, plus a probe
 *           POST /{ig-id}/media_publish
 *
 * ⚠ NO IDEMPOTENCY ON EITHER VERB, same as Pages and verified the same way: the
 * documented parameter lists carry no key, client token, request id or dedup
 * parameter. A retried publish creates a SECOND public post. So this adapter
 * never retries a write, and the caller's `idempotencyKey` is honoured locally
 * because the platform will not honour it.
 *
 * THE ONE THING INSTAGRAM DOES BETTER THAN PAGES, and the reason the two-step
 * publish is an asset rather than just extra cost: A TIMED-OUT PUBLISH IS
 * DISAMBIGUABLE. Pages' single-call `/feed` leaves a timeout genuinely
 * unknowable — the post may or may not exist and nothing can tell you which.
 * Here the container outlives the call and carries its own `status_code`, so
 * `GET /{ig-container-id}?fields=status_code` answers the question the failed
 * call could not. That is a DETECTION affordance, not idempotency: it does not
 * make a retry safe, it tells you whether one is needed. This adapter uses it to
 * turn "unknown" into one of "already published — do NOT retry" or "not
 * published — a retry would be safe", and reports which.
 *
 * ⚠ AND THE ASYMMETRY THAT DOES NOT APPEAR ANYWHERE IN THE GENERIC CONTRACT:
 * INSTAGRAM HAS NO TEXT-ONLY POST. `POST /{ig-id}/media` requires `image_url` or
 * `video_url`; the caption is the optional half. Every other platform this
 * system speaks to is text-primary, so `SocialPostRequest.text` is the required
 * field and media is the decoration — exactly backwards here. A text-only
 * request cannot be degraded into something valid, so it is refused with a
 * message that names the reason rather than failing at the provider.
 *
 * Vendor facts encoding this file were read from live Meta documentation on
 * 2026-08-23. Where a fact came from an EDGE reference rather than the
 * overview — which is where most of the load-bearing ones live (D-031) — the
 * comment says so.
 */
import type {
  SocialPostOutcome,
  SocialPostRequest,
  SocialReplyOutcome,
  SocialReplyRequest,
  SocialWriteAdapter,
} from '../../capability-verbs/social';
import type { OutboundContext } from '../../capability-verbs/resolve';
import {
  INSTAGRAM_SCOPE_CONTENT_PUBLISH,
  INSTAGRAM_SCOPE_MANAGE_COMMENTS,
  assertInstagramCredential,
  type InstagramCredential,
} from './instagram-common';

/* -------------------------------------------------------------------------- */
/* Container status — the vendor's own enum                                   */
/* -------------------------------------------------------------------------- */

/**
 * The documented values of a container's `status_code`, verbatim from the
 * content-publishing reference:
 *
 *   EXPIRED     "The container was not published within 24 hours and has expired."
 *   ERROR       "The container failed to complete the publishing process."
 *   FINISHED    "The container and its media object are ready to be published."
 *   IN_PROGRESS "The container is still in the publishing process."
 *   PUBLISHED   "The container's media object has been published."
 *
 * Enumerated rather than typed as `string` because the WHOLE recovery argument
 * is a case analysis over these five: three of them are terminal and two of
 * those three mean opposite things about whether a retry is safe. A stringly
 * typed status would let a sixth value fall through whichever branch happened to
 * be last, and the branch that matters most (PUBLISHED) is the one whose
 * misreading duplicates a public post.
 */
export type InstagramContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

const CONTAINER_STATUSES: readonly InstagramContainerStatus[] = [
  'EXPIRED',
  'ERROR',
  'FINISHED',
  'IN_PROGRESS',
  'PUBLISHED',
];

export function isInstagramContainerStatus(value: unknown): value is InstagramContainerStatus {
  return typeof value === 'string' && (CONTAINER_STATUSES as readonly string[]).includes(value);
}

/**
 * "We recommend querying a container's status once per minute, for no more than
 * 5 minutes." Both halves are the vendor's, quoted rather than tuned — a faster
 * poll spends the call budget the storm policy rations, and a longer one holds a
 * write open past the point the vendor says to stop waiting.
 */
export const INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = 60_000;
export const INSTAGRAM_CONTAINER_POLL_MAX_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A write known NOT to have happened, or one refused before it was attempted.
 *
 * Deliberately distinct from `InstagramPublishAmbiguous` below. This one is safe
 * to act on: nothing was published, so a corrected retry is legitimate.
 */
export class InstagramWriteUnconfirmed extends Error {
  constructor(
    readonly verb: 'post' | 'reply',
    detail: string,
  ) {
    super('instagram_write_unconfirmed:' + verb + ':' + detail);
    this.name = 'InstagramWriteUnconfirmed';
  }
}

/**
 * A publish whose outcome the CALL could not report, resolved as far as the
 * container probe allows.
 *
 * `retrySafe` is the field that matters, and it is a THREE-STATE answer rather
 * than a boolean-with-a-default:
 *   false — the container reports PUBLISHED. The post EXISTS. Retrying creates a
 *           duplicate. This is the case Pages cannot detect at all.
 *   true  — the container reports FINISHED (ready, unpublished). Nothing went
 *           out; publishing again is the correct recovery.
 *   null  — the probe itself failed or returned something unusable, so the
 *           original ambiguity stands. Reported as ambiguity, never collapsed
 *           into either answer: guessing `true` duplicates a post and guessing
 *           `false` silently drops one.
 *
 * The adapter never acts on this itself. It is raised so the CALLER decides,
 * because the choice is about the operator's public timeline and belongs to
 * whoever owns that, not to a retry loop.
 */
export class InstagramPublishAmbiguous extends Error {
  constructor(
    readonly containerId: string,
    readonly observedStatus: InstagramContainerStatus | null,
    readonly retrySafe: boolean | null,
    detail: string,
  ) {
    super('instagram_publish_ambiguous:' + containerId + ':' + (observedStatus ?? 'unknown') + ':' + detail);
    this.name = 'InstagramPublishAmbiguous';
  }
}

/* -------------------------------------------------------------------------- */
/* Local dedupe                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The local stand-in for the idempotency the platform does not provide.
 *
 * Its limits are the same as the Pages equivalent's and are stated rather than
 * implied, because a guard believed to be stronger than it is, is worse than
 * none: it cannot survive a crash between the provider accepting a write and
 * this store recording it, and an in-memory implementation is per-process by
 * construction. Both gaps are inherent to compensating client-side for a missing
 * server-side mechanism. The container probe narrows the FIRST gap for `post`
 * specifically — that is exactly what makes the two-step publish worth its extra
 * call — but it does not close it, and it does not exist for `reply` at all.
 */
export interface InstagramWriteDedupe {
  get(key: string): Promise<{ externalId: string } | null>;
  put(key: string, value: { externalId: string }): Promise<void>;
}

/** A per-process store. Correct for a single adapter instance, and no more. */
export function inMemoryInstagramWriteDedupe(): InstagramWriteDedupe {
  const seen = new Map<string, { externalId: string }>();
  return {
    async get(key) {
      return seen.get(key) ?? null;
    },
    async put(key, value) {
      seen.set(key, value);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface InstagramCreateReplyRequest {
  credential: InstagramCredential;
  /** The TOP-LEVEL comment. See the note on the reply target. */
  commentId: string;
  message: string;
}

export interface InstagramCreateContainerRequest {
  credential: InstagramCredential;
  igUserId: string;
  /** Exactly one of these is set; the adapter refuses a request that sets neither. */
  imageUrl?: string;
  videoUrl?: string;
  /** `VIDEO` for video; absent for a single image, per the vendor's own examples. */
  mediaType?: 'VIDEO';
  /** The post text. Optional at the provider — Instagram posts may be caption-less. */
  caption?: string;
}

export interface InstagramPublishContainerRequest {
  credential: InstagramCredential;
  igUserId: string;
  /** The vendor's parameter name for the container id is `creation_id`. */
  creationId: string;
}

export interface InstagramContainerStatusRequest {
  credential: InstagramCredential;
  containerId: string;
}

/** Every create on this surface answers `{"id": "..."}` and nothing else. */
export interface InstagramCreated {
  id?: unknown;
}

export interface InstagramWriteClient {
  createReply(request: InstagramCreateReplyRequest): Promise<InstagramCreated>;
  createContainer(request: InstagramCreateContainerRequest): Promise<InstagramCreated>;
  publishContainer(request: InstagramPublishContainerRequest): Promise<InstagramCreated>;
  /** `GET /{ig-container-id}?fields=status_code`. */
  containerStatus(request: InstagramContainerStatusRequest): Promise<{ status_code?: unknown }>;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface InstagramWriteAdapterDeps {
  client: InstagramWriteClient;
  igUserId: string;
  credential: InstagramCredential;
  dedupe?: InstagramWriteDedupe;
  /**
   * Injected so the five-minute vendor cadence is a real constant in production
   * and instant in tests. A test that genuinely waited would either take five
   * minutes or force the timeout down to a value that no longer models the
   * documented behaviour.
   */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class InstagramWriteAdapter implements SocialWriteAdapter {
  readonly platform = 'instagram' as const;

  private readonly client: InstagramWriteClient;
  private readonly igUserId: string;
  private readonly credential: InstagramCredential;
  private readonly dedupe: InstagramWriteDedupe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: InstagramWriteAdapterDeps) {
    this.client = deps.client;
    this.igUserId = deps.igUserId;
    this.credential = deps.credential;
    this.dedupe = deps.dedupe ?? inMemoryInstagramWriteDedupe();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Reply to a comment.
   *
   * ONE call, and no read-after-write is available: the edge's documented
   * response is `{"id": "..."}` and nothing more. That is a verified ABSENCE
   * rather than an omission here — Pages documents read-after-write explicitly
   * and this edge documents a single-key response — which is why the outcome
   * carries no `url`. Synthesising one would be inventing an address the vendor
   * never published.
   */
  async reply(request: SocialReplyRequest, _context: OutboundContext): Promise<SocialReplyOutcome> {
    assertInstagramCredential(this.credential, this.igUserId, INSTAGRAM_SCOPE_MANAGE_COMMENTS);

    const commentId = this.targetCommentId(request.target);

    if (request.text.trim().length === 0) {
      // `message` is the edge's ONE required parameter. Refused here rather than
      // at the provider because a failed write and an ambiguous one are not
      // distinguishable from the caller's side, so an avoidable failure is an
      // avoidable retry decision.
      throw new InstagramWriteUnconfirmed('reply', 'empty-message: message is the required parameter on /replies');
    }

    const cached = await this.dedupe.get(request.idempotencyKey);
    if (cached) return this.outcome(cached.externalId);

    const created = await this.client.createReply({
      credential: this.credential,
      commentId,
      message: request.text,
    });

    return this.confirm('reply', created, request.idempotencyKey);
  }

  /**
   * Create a feed post: container, then publish, with the status probe between
   * them and again on an ambiguous publish.
   *
   * THE PRE-PUBLISH PROBE IS NOT DEFENSIVE PADDING — it is bought cheaply and it
   * removes the expensive case. Publishing a container that is still
   * IN_PROGRESS fails, and a failed publish is exactly the ambiguous state this
   * whole design exists to avoid; waiting for FINISHED first turns a likely
   * ambiguity into a certainty. It is affordable because the registry records a
   * verified fact about WHICH budget each call spends: the publishing cap "is
   * enforced on the POST /{ig-id}/media_publish endpoint", so container creation
   * and status polling do not draw on it. The probe costs call budget, never
   * publishing quota.
   */
  async post(request: SocialPostRequest, _context: OutboundContext): Promise<SocialPostOutcome> {
    assertInstagramCredential(this.credential, this.igUserId, INSTAGRAM_SCOPE_CONTENT_PUBLISH);

    if (request.destination !== this.igUserId) {
      throw new InstagramWriteUnconfirmed(
        'post',
        'destination-mismatch:' + request.destination + ' is not this adapter account ' + this.igUserId,
      );
    }

    const media = this.singleMedia(request);

    const cached = await this.dedupe.get(request.idempotencyKey);
    if (cached) return this.outcome(cached.externalId);

    const container = await this.client.createContainer({
      credential: this.credential,
      igUserId: this.igUserId,
      ...(media.type === 'video' ? { videoUrl: media.url, mediaType: 'VIDEO' as const } : { imageUrl: media.url }),
      ...(request.text.trim() ? { caption: request.text } : {}),
    });

    const containerId = typeof container?.id === 'string' ? container.id.trim() : '';
    if (!containerId) {
      // Nothing was published: a container that was never addressable cannot
      // have been publish()ed. Safe to report as a definite failure.
      throw new InstagramWriteUnconfirmed('post', 'no-container-id-in-response');
    }

    await this.awaitContainerReady(containerId);

    let published: InstagramCreated;
    try {
      published = await this.client.publishContainer({
        credential: this.credential,
        igUserId: this.igUserId,
        creationId: containerId,
      });
    } catch (error) {
      // The call failed to REPORT. Whether it failed to ACT is a different
      // question, and the container is the only thing that can answer it.
      throw await this.disambiguatePublish(containerId, error);
    }

    const mediaId = typeof published?.id === 'string' ? published.id.trim() : '';
    if (!mediaId) {
      // A response that arrived but carries no id is the same epistemic state as
      // a timeout: the publish may well have happened. It must NOT be reported
      // as a definite failure, which would invite the duplicate-creating retry.
      throw await this.disambiguatePublish(containerId, new Error('no-media-id-in-response'));
    }

    await this.dedupe.put(request.idempotencyKey, { externalId: mediaId });
    return this.outcome(mediaId);
  }

  /* ------------------------------------------------------------------------ */
  /* Container lifecycle                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Poll until the container is publishable, at the vendor's stated cadence.
   *
   * The first check is immediate — an image container is typically FINISHED at
   * once, and sleeping a minute before the first look would add the vendor's
   * worst case to every ordinary post.
   */
  private async awaitContainerReady(containerId: string): Promise<void> {
    const startedAt = this.now();

    for (;;) {
      const status = await this.readStatus(containerId);

      if (status === 'FINISHED') return;
      if (status === 'PUBLISHED') {
        // Not reachable through this adapter's own flow, and deliberately not
        // treated as success: we hold no media id, so returning would mint a ref
        // to nothing. It is reported as the ambiguity it is, with retry marked
        // UNSAFE — the post exists.
        throw new InstagramPublishAmbiguous(
          containerId,
          'PUBLISHED',
          false,
          'container was already published before this adapter published it',
        );
      }
      if (status === 'ERROR' || status === 'EXPIRED') {
        // Both are terminal and both mean nothing went out. A definite failure.
        throw new InstagramWriteUnconfirmed('post', 'container-' + status.toLowerCase() + ':' + containerId);
      }

      const elapsed = this.now() - startedAt;
      if (elapsed + INSTAGRAM_CONTAINER_POLL_INTERVAL_MS > INSTAGRAM_CONTAINER_POLL_MAX_MS) {
        // The vendor says stop at five minutes; it does not say the container is
        // dead. It may still finish and remains publishable for 24 hours, so the
        // id is carried out rather than dropped — but nothing was published, so
        // this is an unconfirmed write and not an ambiguous one.
        throw new InstagramWriteUnconfirmed(
          'post',
          'container-not-ready-within-' + INSTAGRAM_CONTAINER_POLL_MAX_MS + 'ms:' + containerId,
        );
      }
      await this.sleep(INSTAGRAM_CONTAINER_POLL_INTERVAL_MS);
    }
  }

  /**
   * Resolve an ambiguous publish as far as the container allows.
   *
   * Never throws on the probe's own failure: a probe that fails leaves the
   * original ambiguity exactly as it was, and turning a failed diagnostic into a
   * different error would lose the fact that a post may exist.
   */
  private async disambiguatePublish(containerId: string, cause: unknown): Promise<InstagramPublishAmbiguous> {
    const detail = cause instanceof Error ? cause.message : String(cause);

    let status: InstagramContainerStatus | null = null;
    try {
      status = await this.readStatus(containerId);
    } catch {
      status = null;
    }

    if (status === 'PUBLISHED') {
      return new InstagramPublishAmbiguous(containerId, status, false, 'already-published:' + detail);
    }
    if (status === 'FINISHED') {
      // Ready and unpublished: the publish did not take effect.
      return new InstagramPublishAmbiguous(containerId, status, true, 'not-published:' + detail);
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      // Terminal and unpublished — a retry of THIS container cannot succeed, so
      // it is not "safe to retry" in any useful sense.
      return new InstagramPublishAmbiguous(containerId, status, false, 'container-terminal:' + detail);
    }
    // IN_PROGRESS or an unreadable probe: genuinely unresolved.
    return new InstagramPublishAmbiguous(containerId, status, null, 'unresolved:' + detail);
  }

  private async readStatus(containerId: string): Promise<InstagramContainerStatus> {
    const response = await this.client.containerStatus({ credential: this.credential, containerId });
    const raw = response?.status_code;
    if (!isInstagramContainerStatus(raw)) {
      throw new InstagramWriteUnconfirmed('post', 'unrecognised-status_code:' + JSON.stringify(raw ?? null));
    }
    return raw;
  }

  /* ------------------------------------------------------------------------ */
  /* Request shaping                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * The single media item a feed post is built from.
   *
   * Refuses a text-only request. This is the adapter's most opinionated
   * refusal and the one most likely to be mistaken for a gap, so the reason is
   * in the message: Instagram's create takes `image_url` or `video_url` and
   * there is no text-only feed post to fall back to. Refusing costs the caller
   * an error; the alternative — inventing a placeholder image — would publish
   * something to the operator's audience that nobody asked for.
   *
   * Carousels are declined SEPARATELY and explicitly rather than by silently
   * taking the first item. The vendor supports them ("`children` — a comma
   * separated list of up to 10 container IDs", each child its own container),
   * so posting only the first item of a two-image request would drop content the
   * caller supplied while reporting success.
   */
  private singleMedia(request: SocialPostRequest): { url: string; type: 'image' | 'video' } {
    const media = request.media ?? [];
    if (media.length === 0) {
      throw new InstagramWriteUnconfirmed(
        'post',
        'media-required: POST /{ig-id}/media takes image_url or video_url — Instagram has no text-only feed post',
      );
    }
    if (media.length > 1) {
      throw new InstagramWriteUnconfirmed(
        'post',
        'carousel-unsupported: ' +
          media.length +
          ' media supplied; a carousel needs one container per child plus a CAROUSEL parent, which this adapter does not build',
      );
    }
    const only = media[0]!;
    const url = typeof only.url === 'string' ? only.url.trim() : '';
    if (!url) throw new InstagramWriteUnconfirmed('post', 'media-url-empty');
    return { url, type: only.type };
  }

  /**
   * The comment a reply attaches to.
   *
   * The top-level resolution itself happens in `resolveInstagramReplyTarget`,
   * where it can be tested without a client; what is enforced here is that the
   * target belongs to THIS platform and is not one the vendor documents as
   * un-replyable.
   */
  private targetCommentId(target: SocialReplyRequest['target']): string {
    if (target.platform !== 'instagram') {
      throw new InstagramWriteUnconfirmed('reply', 'wrong-platform-target:' + target.platform);
    }
    // "You cannot reply to hidden comments." A DEFINITE true only — an absent
    // flag still attempts, per the field's note.
    if (target.hidden === true) {
      throw new InstagramWriteUnconfirmed('reply', 'hidden-comment:' + target.topLevelCommentId);
    }
    const commentId = typeof target.topLevelCommentId === 'string' ? target.topLevelCommentId.trim() : '';
    if (!commentId) throw new InstagramWriteUnconfirmed('reply', 'target-has-no-comment-id');
    return commentId;
  }

  private async confirm(
    verb: 'post' | 'reply',
    created: InstagramCreated,
    idempotencyKey: string,
  ): Promise<SocialReplyOutcome> {
    const externalId = typeof created?.id === 'string' ? created.id.trim() : '';
    if (!externalId) {
      throw new InstagramWriteUnconfirmed(verb, 'no-id-in-response');
    }
    await this.dedupe.put(idempotencyKey, { externalId });
    return this.outcome(externalId);
  }

  /**
   * D-008: the ref is minted from the id the SERVER returned.
   *
   * No `url`. Neither `/replies` nor `/media_publish` documents anything but an
   * id in its response, and this surface has no documented permalink form to
   * assemble one from — unlike Pages, whose adapter can fall back to
   * `facebook.com/{id}`. An invented URL that resolved to nothing would be worse
   * than an absent one, because the caller would show it to someone.
   */
  private outcome(externalId: string): SocialReplyOutcome {
    return { externalId, ref: 'instagram:' + externalId };
  }
}
