/**
 * The Facebook Pages WRITE adapter — P-016.
 *
 * TWO VERBS, AND THE REGISTRY IS RIGHT TO DECLARE BOTH. Unlike YouTube — where
 * `comments.insert` REQUIRES a parent and so can only ever produce a reply —
 * Facebook exposes a genuine create (`POST /{page-id}/feed`) and a genuine reply
 * (`POST /{object-id}/comments`). Both are verified (D-028), so both are
 * declared.
 *
 * ⚠ NEITHER VERB HAS ANY IDEMPOTENCY MECHANISM, AND THAT IS A VERIFIED ABSENCE
 * RATHER THAN AN UNKNOWN. The publish reference documents its writable
 * parameters exhaustively — `actions`, `backdated_time`, `child_attachments`,
 * `feed_targeting`, `link`, `message`, `object_attachment`, `place`,
 * `published`, `scheduled_publish_time`, `tags`, `targeting`, `call_to_action` —
 * and there is no idempotency key, client token, request id, or dedup parameter
 * among them. So a retried POST creates a DUPLICATE PUBLIC POST. Per D-016 this
 * is recorded per-verb; here both verbs agree, so the registry scalar `none` is
 * accurate rather than merely conservative.
 *
 * THREE CONSEQUENCES FOLLOW, AND THEY ARE THE DESIGN OF THIS FILE:
 *
 *   1. THIS ADAPTER NEVER RETRIES. Not on a throttle (D-028: retrying extends
 *      the block), and not on anything else — because on a write with no
 *      idempotency, a retry after an ambiguous failure is exactly how one
 *      intended post becomes two public ones. A timeout is the dangerous case:
 *      the write may well have succeeded. Retrying it is a coin flip whose bad
 *      side is visible to the operator's audience.
 *
 *   2. READ-AFTER-WRITE IS USED, AND IT IS THE ONLY DEFENCE THE PLATFORM OFFERS.
 *      Verbatim: "This endpoint supports read-after-write and can immediately
 *      return any fields returned by read operations." So D-008's requirement
 *      that a post ref be MINTED SERVER-SIDE and round-trip-verified costs ONE
 *      call here rather than a create-then-GET pair. This adapter always
 *      requests the id back and refuses to report success on a response it
 *      cannot verify.
 *
 *   3. THE CALLER'S `idempotencyKey` IS HONOURED LOCALLY, since the platform
 *      will not honour it. An injectable seen-store lets a repeat of the SAME
 *      logical write return the FIRST write's result instead of creating a
 *      second post. This is a real guard, not a simulation of one, and its
 *      limits are stated on `FacebookWriteDedupe` rather than implied.
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
  FACEBOOK_TASK_CREATE_CONTENT,
  FACEBOOK_TASK_MODERATE,
  type FacebookPageCredential,
  assertFacebookPageCredential,
} from './facebook-common';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A write that could not be CONFIRMED, which is deliberately distinct from a
 * write that is known to have failed.
 *
 * The distinction is the whole point on a platform with no idempotency: "the
 * post was rejected" invites a corrected retry, while "we do not know whether
 * the post exists" must NOT, because the retry may duplicate a post that already
 * went out. Callers that collapse the two will duplicate exactly in the case
 * where duplication is most visible.
 */
export class FacebookWriteUnconfirmed extends Error {
  constructor(
    readonly verb: 'post' | 'reply',
    detail: string,
  ) {
    super('facebook_write_unconfirmed:' + verb + ':' + detail);
    this.name = 'FacebookWriteUnconfirmed';
  }
}

/* -------------------------------------------------------------------------- */
/* Local dedupe                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The local stand-in for the idempotency the platform does not provide.
 *
 * WHAT IT GENUINELY PREVENTS: a caller retrying the SAME logical write (same
 * derived `idempotencyKey`) against a live adapter that already completed it.
 *
 * WHAT IT CANNOT PREVENT, stated rather than implied — because a dedupe guard
 * that is believed to be stronger than it is, is worse than none:
 *   - A crash between the provider accepting the write and this store recording
 *     it. The post exists; the store does not know. This is why an ambiguous
 *     failure surfaces as FacebookWriteUnconfirmed instead of being retried.
 *   - A second process with its own store, unless the implementation is shared
 *     and durable. An in-memory map is per-process by construction.
 * Both gaps are inherent to compensating for a missing server-side mechanism;
 * neither is closable client-side.
 */
export interface FacebookWriteDedupe {
  get(key: string): Promise<{ externalId: string; url?: string } | null>;
  put(key: string, value: { externalId: string; url?: string }): Promise<void>;
}

/** A per-process store. Correct for a single adapter instance, and no more. */
export function inMemoryFacebookWriteDedupe(): FacebookWriteDedupe {
  const seen = new Map<string, { externalId: string; url?: string }>();
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

export interface FacebookCreatePostRequest {
  credential: FacebookPageCredential;
  pageId: string;
  message: string;
  /** Requested back on the SAME call — read-after-write, per the vendor. */
  fields: readonly string[];
}

export interface FacebookCreateCommentRequest {
  credential: FacebookPageCredential;
  /** The post or comment being replied to. */
  objectId: string;
  message: string;
  fields: readonly string[];
}

/** What a create returns. `id` is the vendor's `{"id":"post-id"}`. */
export interface FacebookCreated {
  id?: unknown;
  permalink_url?: unknown;
  created_time?: unknown;
}

export interface FacebookWriteClient {
  createPost(request: FacebookCreatePostRequest): Promise<FacebookCreated>;
  createComment(request: FacebookCreateCommentRequest): Promise<FacebookCreated>;
}

/** Fields requested back on a create, exercising read-after-write. */
export const FACEBOOK_WRITE_READBACK_FIELDS = ['id', 'permalink_url', 'created_time'] as const;

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface FacebookWriteAdapterDeps {
  client: FacebookWriteClient;
  pageId: string;
  credential: FacebookPageCredential;
  dedupe?: FacebookWriteDedupe;
}

export class FacebookWriteAdapter implements SocialWriteAdapter {
  readonly platform = 'facebook-pages' as const;

  private readonly client: FacebookWriteClient;
  private readonly pageId: string;
  private readonly credential: FacebookPageCredential;
  private readonly dedupe: FacebookWriteDedupe;

  constructor(deps: FacebookWriteAdapterDeps) {
    this.client = deps.client;
    this.pageId = deps.pageId;
    this.credential = deps.credential;
    this.dedupe = deps.dedupe ?? inMemoryFacebookWriteDedupe();
  }

  /**
   * Reply to a post or a comment.
   *
   * Requires the MODERATE task and `pages_manage_engagement`. MODERATE is
   * asserted rather than assumed for the same reason the comments READ adapter
   * asserts it (D-027): under-privileged access to this object family degrades
   * silently rather than erroring.
   */
  async reply(request: SocialReplyRequest, _context: OutboundContext): Promise<SocialReplyOutcome> {
    assertFacebookPageCredential(this.credential, this.pageId, FACEBOOK_TASK_MODERATE);

    const objectId = this.targetId(request.target);
    const cached = await this.dedupe.get(request.idempotencyKey);
    if (cached) return this.outcome(cached);

    const created = await this.client.createComment({
      credential: this.credential,
      objectId,
      message: request.text,
      fields: FACEBOOK_WRITE_READBACK_FIELDS,
    });

    return this.confirm('reply', created, request.idempotencyKey);
  }

  /**
   * Create a Page post.
   *
   * Requires the CREATE_CONTENT task and `pages_manage_posts`. The destination
   * is checked against this adapter's Page rather than trusted: D-006 keeps the
   * platform out of caller arguments, and the same reasoning applies to WHICH
   * Page a create lands on — a create is the one operation whose misdirection is
   * publicly visible and not quietly correctable.
   */
  async post(request: SocialPostRequest, _context: OutboundContext): Promise<SocialPostOutcome> {
    assertFacebookPageCredential(this.credential, this.pageId, FACEBOOK_TASK_CREATE_CONTENT);

    if (request.destination !== this.pageId) {
      throw new FacebookWriteUnconfirmed(
        'post',
        'destination-mismatch:' + request.destination + ' is not this adapter page ' + this.pageId,
      );
    }

    // "Either `link` or `message` must be supplied." This adapter sends
    // `message`, so an empty one is refused HERE rather than spending a call to
    // be told, and — since a failed create is indistinguishable from an
    // ambiguous one — avoiding an avoidable failure is avoiding an avoidable
    // duplicate-retry decision.
    if (request.text.trim().length === 0) {
      throw new FacebookWriteUnconfirmed('post', 'empty-message: either link or message must be supplied');
    }

    const cached = await this.dedupe.get(request.idempotencyKey);
    if (cached) return this.outcome(cached);

    const created = await this.client.createPost({
      credential: this.credential,
      pageId: this.pageId,
      message: request.text,
      fields: FACEBOOK_WRITE_READBACK_FIELDS,
    });

    return this.confirm('post', created, request.idempotencyKey);
  }

  /**
   * Turn a create response into a verified outcome, or refuse.
   *
   * D-008: the ref is MINTED from the id the SERVER returned, never assembled
   * from anything the caller supplied. A response without a usable id is not a
   * success with a missing field — it is a write whose result we cannot address,
   * and reporting it as success would hand the caller a ref that resolves to
   * nothing.
   */
  private async confirm(
    verb: 'post' | 'reply',
    created: FacebookCreated,
    idempotencyKey: string,
  ): Promise<SocialReplyOutcome> {
    const externalId = typeof created?.id === 'string' ? created.id.trim() : '';
    if (!externalId) {
      throw new FacebookWriteUnconfirmed(verb, 'no-id-in-response');
    }

    const url =
      typeof created.permalink_url === 'string' && created.permalink_url.trim()
        ? created.permalink_url.trim()
        : 'https://www.facebook.com/' + externalId;

    const value = { externalId, url };
    await this.dedupe.put(idempotencyKey, value);
    return this.outcome(value);
  }

  private outcome(value: { externalId: string; url?: string }): SocialReplyOutcome {
    return {
      externalId: value.externalId,
      ref: 'facebook-pages:' + value.externalId,
      ...(value.url ? { url: value.url } : {}),
    };
  }

  /**
   * The object a reply attaches to.
   *
   * Refuses a target from another platform rather than duck-typing an id out of
   * it: D-006 resolves the platform FROM the stored post, so a mismatch here
   * means the caller reached the wrong adapter, and quietly replying to whatever
   * id happened to be present would post to a Facebook object chosen by a
   * foreign platform's field name.
   */
  private targetId(target: SocialReplyRequest['target']): string {
    if (target.platform !== 'facebook-pages') {
      throw new FacebookWriteUnconfirmed('reply', 'wrong-platform-target:' + target.platform);
    }
    // A DEFINITE false only. An absent can_comment still attempts — see the
    // field's note on SocialReplyTarget.
    if (target.canComment === false) {
      throw new FacebookWriteUnconfirmed('reply', 'can_comment-false:' + target.objectId);
    }
    const objectId = typeof target.objectId === 'string' ? target.objectId.trim() : '';
    if (!objectId) throw new FacebookWriteUnconfirmed('reply', 'target-has-no-object-id');
    return objectId;
  }
}
