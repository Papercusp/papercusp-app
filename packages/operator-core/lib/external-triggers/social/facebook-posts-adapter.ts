/**
 * The Facebook Pages POSTS adapter — P-016, the first of this platform's read
 * streams (D-026).
 *
 * WHY `published_posts` AND NOT `/feed`. The Page node exposes several edges
 * that overlap, and the broadest one is the wrong default. `/feed` is "any
 * interactions with a Facebook Page including: posts and links published by this
 * Page, visitors to this Page, and public posts in which the Page has been
 * tagged" — three different event kinds in one response — and it additionally
 * returns unpublished posts, which must be filtered with `is_published`.
 * `published_posts` is "All published posts by this page": the server applies
 * both filters, so this adapter neither re-implements them client-side nor
 * spends quota on rows it will discard. Visitor-authored posts are a genuinely
 * different event and are a separate declared stream (D-026), not a `from`
 * field for a caller to branch on (D-006).
 *
 * WHY THERE IS NO RETRY LOOP IN THIS FILE, unlike the YouTube adapters. That is
 * not an omission — it is D-028 implemented. YouTube's rate limit is ordinary:
 * back off, retry, succeed. Facebook's is not. The vendor states that
 * "Continuing to make calls will continue to increase your call count, which
 * will increase the time before calls will be successful again" — a retry
 * lengthens the outage it responds to. Since a throttle is the only failure this
 * adapter could sensibly have retried, and retrying it is actively harmful,
 * there is nothing left for a retry loop to do. Throttles propagate as
 * `FacebookGraphThrottled` carrying the vendor-stated hold, for the storm-policy
 * layer to park on.
 *
 * FACTS THIS FILE ENCODES, read from live Meta documentation on 2026-08-23 and
 * recorded as D-024..D-028:
 *
 *   - `published_posts` — "All published posts by this page."
 *   - GET on the feed family requires `pages_read_engagement` +
 *     `pages_read_user_content`, and the requester must hold ONE of the Page
 *     tasks CREATE_CONTENT, MANAGE, or MODERATE.
 *   - "The API will return approximately 600 ranked, published posts per year."
 *     RANKED — see the ordering note below.
 *   - Termination: a page "may be empty but contain a `next` paging link. Stop
 *     paging when the `next` link no longer appears."
 *   - Post URLs are "`https://www.facebook.com/` plus the `page_post_id`".
 *
 * ⚠ THE ORDERING FACT, AND THE CONTROL FLOW IT FORBIDS. The vendor describes the
 * result set as *ranked*, and documents no ordering guarantee for this edge.
 * Under a ranked order an unseen post can sit BEHIND an already-seen one, so the
 * usual "stop at the first item older than the watermark" early exit would drop
 * it and emit nothing — a silent loss indistinguishable from a quiet Page. This
 * adapter therefore derives NO control flow from position: it walks to the
 * declared page bound and filters every item against the watermark individually.
 * That is D-025, and it is the same asymmetry as D-023 one level up — prefer the
 * detectable error (over-fetch, which the watermark filter absorbs) over the
 * silent one.
 */
import type {
  SocialAdapter,
  SocialBackfillReason,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';
import {
  FACEBOOK_READ_FEED_TASKS,
  type FacebookConnection,
  type FacebookPageCredential,
  type FacebookWatermarkCursor,
  assertFacebookPageCredentialAnyOf,
  facebookAdvanceWatermark,
  facebookIsNewAgainstWatermark,
  facebookNextPageUrl,
  isFacebookWatermarkCursor,
} from './facebook-common';

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                            */
/* -------------------------------------------------------------------------- */

/** One PagePost, flattened to the fields this adapter reads. */
export interface FacebookRawPost {
  id: string;
  /** User-authored text. Absent on posts that carry only media. */
  message?: string | null;
  /**
   * Facebook's OWN generated description of the action ("X added a photo").
   * Distinct from `message`: this is vendor-authored, not user-authored.
   */
  story?: string | null;
  created_time: string;
  /** Presence on a never-edited post is undocumented — see `facebookPostEffectiveAt`. */
  updated_time?: string | null;
  permalink_url?: string | null;
  from?: { id?: string | null; name?: string | null } | null;
  attachments?: { data?: Array<Record<string, unknown>> } | null;
  /** `published_posts` should only ever return true; carried so a lie is visible. */
  is_published?: boolean | null;
}

/** The fields this adapter asks the Graph API for. */
export const FACEBOOK_POST_FIELDS = [
  'id',
  'message',
  'story',
  'created_time',
  'updated_time',
  'permalink_url',
  'from',
  'attachments',
  'is_published',
] as const;

export interface FacebookPostsPageRequest {
  credential: FacebookPageCredential;
  pageSize: number;
  /** The `paging.next` URL to follow, or null for the first page. */
  nextUrl: string | null;
}

export interface FacebookPostsClient {
  listPublishedPosts(request: FacebookPostsPageRequest): Promise<FacebookConnection<FacebookRawPost>>;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The instant this adapter orders and watermarks on: `updated_time` when the
 * provider supplied one, otherwise `created_time`.
 *
 * THE FALLBACK IS LOAD-BEARING, NOT DEFENSIVE — the same reasoning the YouTube
 * comments adapter records for `updatedAt`. The vendor documents what
 * `updated_time` means but never states whether it is present on a post that was
 * never edited. Treating it as always-present would make every un-edited post's
 * instant `undefined`, which sorts and compares as garbage; treating it as never
 * present would file an edit under the ORIGINAL publication instant, which sits
 * below the watermark, so the edit would never be delivered.
 *
 * Keying on the effective instant means an edit re-surfaces the post, and
 * because the dedupe key moves with it, the ingestion seam treats that as a new
 * delivery rather than collapsing it as a duplicate.
 */
export function facebookPostEffectiveAt(post: Pick<FacebookRawPost, 'created_time' | 'updated_time'>): string {
  const updated = post.updated_time;
  if (typeof updated === 'string' && updated.length > 0) return updated;
  return post.created_time;
}

/** `<id>@<effectiveAt>` — both halves provider facts, no wall-clock, no randomness. */
export function facebookPostDedupeKey(post: FacebookRawPost): string {
  return post.id + '@' + facebookPostEffectiveAt(post);
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ THE CANONICAL SCHEMA CANNOT REPRESENT A CAPTION-LESS POST, AND FACEBOOK IS
 * THE FIRST PLATFORM WHERE THAT MATTERS.
 *
 * `social-post` declares `required: ['id', 'text']` with `text` at
 * `minLength: 1`. That held for all of Wave A for a reason that is easy to
 * mistake for a general truth: Bluesky's `app.bsky.feed.post` lexicon REQUIRES
 * text, Mastodon statuses carry HTML content, and Reddit things carry a title.
 * No Wave A platform could produce a text-less post, so the constraint was never
 * tested against one.
 *
 * Facebook can, routinely — a photo posted with no caption. Two mitigations
 * apply before the gap is reached, and they cover nearly everything:
 *   1. `message` is the user's text.
 *   2. `story` is Facebook's OWN generated description of the action. It is
 *      vendor-authored rather than invented here, so using it is reporting, not
 *      fabrication.
 *
 * When BOTH are absent this returns `''`, which the datatype validation will
 * REJECT. That is deliberate and is the least-bad of three options: dropping the
 * post silently loses a real event (the failure this whole plan exists to
 * prevent), and synthesising a placeholder would put words that no one wrote
 * into an operator-facing feed. A rejection is loud, attributable, and arrives
 * with the offending post id attached.
 *
 * This is filed rather than patched here because the right fix is not
 * Facebook-shaped: P-017 (Instagram) will hit it far harder, since a caption-less
 * image is the NORM there rather than an edge case. Widening the canonical
 * datatype is a D-004 decision that should be made once, for every platform,
 * with Instagram's usage in view — not smuggled in as a Facebook special case,
 * which is exactly the kit-patch shape D-017 rejects.
 */
export function facebookPostText(post: FacebookRawPost): string {
  const message = typeof post.message === 'string' ? post.message : '';
  if (message.length > 0) return message;
  const story = typeof post.story === 'string' ? post.story : '';
  return story;
}

/** Post URLs are "`https://www.facebook.com/` plus the `page_post_id`". */
export function facebookPostUrl(post: FacebookRawPost): string {
  const permalink = typeof post.permalink_url === 'string' ? post.permalink_url.trim() : '';
  if (permalink) return permalink;
  return 'https://www.facebook.com/' + post.id;
}

export function normalizeFacebookPost(post: FacebookRawPost): SocialNormalizedEvent {
  const occurredAt = facebookPostEffectiveAt(post);
  const text = facebookPostText(post);

  const payload: Record<string, unknown> = {
    id: post.id,
    text,
    url: facebookPostUrl(post),
    occurredAt,
  };

  const author = post.from?.name ?? post.from?.id ?? null;
  if (typeof author === 'string' && author.length > 0) payload.author = author;

  const media = post.attachments?.data;
  if (Array.isArray(media) && media.length > 0) payload.media = media;

  payload.createdAt = post.created_time;
  if (post.updated_time && post.updated_time !== post.created_time) payload.editedAt = post.updated_time;

  // Stated rather than assumed: `published_posts` is documented to return only
  // published posts, so a `false` here means the edge did not behave as
  // documented. Carrying it makes that visible instead of invisible.
  if (post.is_published === false) payload.isPublished = false;

  // Surfaced per event so a consumer never has to guess why `text` is empty —
  // and so the caption-less population is countable rather than anecdotal when
  // the canonical-schema question above is settled for P-017.
  if (text.length === 0) payload.textAbsent = true;

  return {
    externalId: post.id,
    event: 'post',
    occurredAt,
    payload,
    dedupeKey: facebookPostDedupeKey(post),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface FacebookPostsAdapterDeps {
  client: FacebookPostsClient;
  /** The Page whose posts this adapter reads. */
  pageId: string;
  /** Resolves the Page credential. Its result is asserted before any read. */
  credential: FacebookPageCredential;
  /** Posts per call. */
  pageSize?: number;
  /** How many pages one rescan walks before stopping. THE bound on this stream. */
  maxPages?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

export class FacebookPostsAdapter implements SocialAdapter {
  readonly platformId = 'facebook-pages' as const;

  /** D-026 splits this platform by stream, so several adapters share a platformId. */
  readonly streamId = 'posts' as const;

  private readonly client: FacebookPostsClient;
  private readonly pageId: string;
  private readonly credential: FacebookPageCredential;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(deps: FacebookPostsAdapterDeps) {
    this.client = deps.client;
    this.pageId = deps.pageId;
    this.credential = deps.credential;
    this.pageSize = Math.max(1, Math.trunc(deps.pageSize ?? DEFAULT_PAGE_SIZE));
    this.maxPages = Math.max(1, Math.trunc(deps.maxPages ?? DEFAULT_MAX_PAGES));
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const hadStoredCursor = ctx.cursor !== null && ctx.cursor !== undefined;
    const stored = isFacebookWatermarkCursor(ctx.cursor) ? ctx.cursor : null;

    // D-027: establish the credential BEFORE the read, because an under-privileged
    // read on this platform can succeed and return less than the truth. Nothing
    // downstream can reconstruct that distinction from the response.
    assertFacebookPageCredentialAnyOf(this.credential, this.pageId, FACEBOOK_READ_FEED_TASKS);

    const posts = await this.walk(ctx);

    let emitted = 0;
    let cursor = stored;

    for (const post of posts) {
      const at = facebookPostEffectiveAt(post);
      if (!facebookIsNewAgainstWatermark(stored, at, post.id)) continue;
      await ctx.emit(normalizeFacebookPost(post));
      emitted += 1;
      cursor = facebookAdvanceWatermark(cursor, at, post.id);
    }

    return { cursor, emitted, ...this.declarePath(hadStoredCursor, hadStoredCursor && stored === null) };
  }

  /**
   * Walk pages until the vendor stops offering a `next`, or the declared bound
   * is reached.
   *
   * Note what ends this loop and what does NOT. An empty page does not, and a
   * short page does not — the vendor states a page "may be empty but contain a
   * `next` paging link", so either test would truncate a live read. Only the
   * absence of `next` (via `facebookNextPageUrl`) or `maxPages` ends it.
   */
  private async walk(ctx: SocialReconcileContext): Promise<FacebookRawPost[]> {
    const out: FacebookRawPost[] = [];
    let nextUrl: string | null = null;

    for (let page = 0; page < this.maxPages; page += 1) {
      ctx.signal?.throwIfAborted();

      const connection: FacebookConnection<FacebookRawPost> = await this.client.listPublishedPosts({
        credential: this.credential,
        pageSize: this.pageSize,
        nextUrl,
      });

      for (const post of connection.data ?? []) {
        if (post && typeof post.id === 'string' && typeof post.created_time === 'string') out.push(post);
      }

      nextUrl = facebookNextPageUrl(connection);
      if (nextUrl === null) break;
    }

    return out;
  }

  /**
   * Declare which route closed the gap.
   *
   * ANY stored cursor produces `backfill`, including on a pass that emitted
   * nothing. This follows the doctrine the Wave A adapters established and that
   * EI-21256621031947425 corrected them onto: `cold-start` asserts "first
   * connect for this source", which is a false claim to make about a cursor that
   * existed and was dropped, and `live-only` asserts the provider accepted a
   * cursor and had nothing to replay — a statement about SERVER-side replay that
   * this stream cannot support, since the watermark is never sent anywhere.
   * Reporting either would tell an operator the provider is covering gaps when
   * only our own bounded re-read is.
   *
   * The two backfill REASONS are kept distinct, which is the part that is easy
   * to collapse and costly to get wrong. `no-replay-supported` is this stream's
   * steady state and fires on every tick, so an alert keyed on it is noise.
   * `cursor-rejected` means the persisted cursor could not be READ — rare, and
   * a real loss of state worth waking someone for. Reporting both the same way
   * makes the serious one undetectable behind the routine one. Per the
   * conformance kit, `cursor-rejected` names the LOCAL invalid-cursor condition
   * and does not imply the provider ever saw the cursor.
   */
  private declarePath(
    hadStoredCursor: boolean,
    cursorUnreadable: boolean,
  ): Pick<SocialReconcileResult, 'path' | 'backfillReason'> {
    if (!hadStoredCursor) return { path: 'cold-start' as SocialReconcilePath };
    return {
      path: 'backfill',
      backfillReason: (cursorUnreadable ? 'cursor-rejected' : 'no-replay-supported') as SocialBackfillReason,
    };
  }
}
