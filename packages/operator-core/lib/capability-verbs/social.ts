/**
 * Provider-neutral SOCIAL capability seam (D-019 Tier 1, plan item P-004).
 *
 * WHY THIS FILE EXISTS RATHER THAN A FOURTH COPY OF mail.ts.
 *
 * `mail.ts` and `chat.ts` each resolve a CONSTANT vault source — they literally
 * hardcode `doc.source !== 'gmail'` and `vaultSource: 'gmail'` — because their
 * canonical datatype has exactly one connected provider today. `social-post`
 * does not: Bluesky, Mastodon and Reddit are simultaneously connected, and D-001
 * bounds the family at ten platforms. So for social the platform is a VARIABLE.
 *
 * Where that variable comes from is the security-relevant part, and there is
 * exactly one admissible answer: it is DERIVED FROM THE POST BEING ACTED ON.
 * It is never a caller argument. Letting a caller name the platform separately
 * from the post would hand an injected payload the choice of which of the
 * owner's identities to speak as — a strictly worse failure than a misdirected
 * reply, because the wrong ACCOUNT is not correctable by a follow-up. The ref is
 * therefore a single opaque token carrying both halves, parsed here, and the
 * platform half is used to look up the credential rather than being trusted.
 *
 * Everything below the seam (lexicon shapes, MIME, fullnames, instance hosts)
 * belongs to the adapter, exactly as threading does for mail.
 */
import type postgres from 'postgres';
import {
  assertSocialPlatformUsable,
  assertSocialWriteAllowed,
  SocialPlatformUnusableError,
  type SocialPlatformId,
  type SocialPlatformRow,
  type SocialWriteVerb,
} from '../external-triggers/social/platform-registry';
import { assertTrustedAddressee, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import {
  resolveCanonicalDocument,
  resolveOutboundContext,
  string,
  type CanonicalDocument,
  type OutboundContext,
} from './resolve';

/* -------------------------------------------------------------------------- */
/* Post references                                                            */
/* -------------------------------------------------------------------------- */

/** A canonical social post: which platform, and the platform's own id for it. */
export interface SocialPostRef {
  platform: SocialPlatformId;
  externalId: string;
}

/**
 * Parse `"<platform>:<externalId>"`.
 *
 * Split on the FIRST colon only. This is load-bearing rather than stylistic:
 * an AT-URI is itself full of colons (`at://did:plc:xyz/app.bsky.feed.post/3k`),
 * so splitting on the last colon, or on every colon, silently truncates real
 * Bluesky ids into something that looks like a valid id and resolves to nothing.
 */
/**
 * The shared first-colon split, factored so the two ref kinds below cannot
 * drift apart.
 *
 * This is the same reasoning as D-006 ruling (d) applied one level down: the
 * AT-URI rule is a single fact, and two hand-maintained copies of it would fail
 * in the worst available way — a post ref that parses correctly beside a
 * destination ref that truncates, or vice versa, with both looking valid.
 */
function splitPlatformToken(
  value: string,
  codes: { required: string; malformed: string; shape: string; tailName: string },
): { platform: string; tail: string } {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(codes.required);
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(
      `${codes.malformed}: expected "${codes.shape}", got ${JSON.stringify(raw.slice(0, 64))}`,
    );
  }
  const platform = raw.slice(0, separator).toLowerCase();
  const tail = raw.slice(separator + 1).trim();
  // DEFENCE IN DEPTH, currently unreachable — deliberately kept, and labelled
  // so nobody mistakes it for a live guard they can test. `raw` is trimmed
  // above, so its last character is non-whitespace; combined with the
  // `separator === raw.length - 1` rejection there is always at least one
  // non-whitespace character after the colon, and `tail` cannot be empty. A
  // trailing-colon token therefore refuses via the SHAPE message above, not
  // here. This branch exists only to keep the invariant local if the trim ever
  // moves. (The same branch was already unreachable in the P-005 original this
  // was factored from.)
  if (!tail) throw new Error(`${codes.malformed}: empty ${codes.tailName}`);
  return { platform, tail };
}

export function parseSocialPostRef(ref: string): SocialPostRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_post_ref_required',
    malformed: 'social_post_ref_malformed',
    shape: '<platform>:<id>',
    tailName: 'id',
  });
  // Validate through the registry so an unknown platform fails here, with the
  // registry's reason, rather than as a confusing vault miss further down.
  assertSocialPlatformUsable(platform);
  return { platform: platform as SocialPlatformId, externalId: tail };
}

export function formatSocialPostRef(ref: SocialPostRef): string {
  return `${ref.platform}:${ref.externalId}`;
}

/* -------------------------------------------------------------------------- */
/* Destination references (create-shaped)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a NEW post goes: which platform, and that platform's own name for the
 * community/page it is addressed to.
 */
export interface SocialDestinationRef {
  platform: SocialPlatformId;
  destination: string;
}

/**
 * Parse `"<platform>:<destination>"` for a create-shaped post.
 *
 * WHY THE PLATFORM RIDES INSIDE THE TOKEN RATHER THAN BESIDE IT. A reply
 * derives its platform from the stored parent (D-006 ruling a), which a create
 * has no equivalent of — so the caller unavoidably names the destination. That
 * does NOT license re-admitting a free-standing `platform` argument: a separate
 * argument could be varied INDEPENDENTLY of the destination, which is exactly
 * the failure D-006 forbids (choosing which of the owner's identities speaks).
 * Carried inside one opaque token, the platform half cannot disagree with the
 * destination half, and rail 2 below judges the token the caller actually named.
 *
 * Splits on the FIRST colon, via the shared splitter above, for the AT-URI
 * reason recorded in D-006.
 */
export function parseSocialDestinationRef(ref: string): SocialDestinationRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_destination_ref_required',
    malformed: 'social_destination_ref_malformed',
    shape: '<platform>:<destination>',
    tailName: 'destination',
  });
  assertSocialPlatformUsable(platform);
  return { platform: platform as SocialPlatformId, destination: tail };
}

export function formatSocialDestinationRef(ref: SocialDestinationRef): string {
  return `${ref.platform}:${ref.destination}`;
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provider-neutral audience ladder, ordered narrowest to widest.
 *
 * Platforms name these differently (Mastodon says `private` for followers-only;
 * Reddit has no per-post equivalent at all and inherits the subreddit's). The
 * ladder exists so the widening rail below is expressible once instead of per
 * adapter.
 */
export type SocialVisibility = 'direct' | 'followers' | 'unlisted' | 'public';

const VISIBILITY_RANK: Record<SocialVisibility, number> = {
  direct: 0,
  followers: 1,
  unlisted: 2,
  public: 3,
};

const VISIBILITY_ALIASES: Record<string, SocialVisibility> = {
  direct: 'direct',
  dm: 'direct',
  private: 'followers',
  followers: 'followers',
  'followers-only': 'followers',
  unlisted: 'unlisted',
  public: 'public',
};

/**
 * Normalize a platform-native visibility onto the neutral ladder.
 *
 * THREE distinct cases, and collapsing any two of them is a leak:
 *
 *  - ABSENT (null/undefined/blank) → `public`. The platform does not model
 *    per-post audience at all (Reddit, Bluesky today), and those posts really
 *    are public. Narrowing here would make every Reddit reply `direct`, which
 *    is not a safer reading — it is a meaningless one.
 *  - PRESENT BUT UNRECOGNIZED (a future platform's label) → `direct`. An
 *    audience we cannot interpret is not an invitation to guess, and `public`
 *    is the one guess that can leak.
 *  - MALFORMED (present but not a string at all) → `direct`. This is corrupt
 *    stored data, so it gets the narrow floor rather than the absent default.
 *
 * The middle and last cases were originally collapsed into the first by routing
 * through `string()`, which coerces a non-string to `''` and so made malformed
 * data indistinguishable from an absent field — reaching the `public` branch.
 * The control in social.test.ts caught it; that is what the controls are for.
 */
export function normalizeSocialVisibility(value: unknown): SocialVisibility {
  if (value === undefined || value === null) return 'public';
  if (typeof value !== 'string') return 'direct';
  const raw = value.trim().toLowerCase();
  if (!raw) return 'public';
  return VISIBILITY_ALIASES[raw] ?? 'direct';
}

export class SocialVisibilityWidened extends Error {
  readonly parent: SocialVisibility;
  readonly requested: SocialVisibility;
  constructor(parent: SocialVisibility, requested: SocialVisibility) {
    super(
      `social_reply_would_widen_visibility: parent is '${parent}' but the reply asked for '${requested}'. ` +
        `A reply never widens its parent's audience — re-send at '${parent}' or narrower.`,
    );
    this.name = 'SocialVisibilityWidened';
    this.parent = parent;
    this.requested = requested;
  }
}

/**
 * A reply may match its parent's audience or narrow it, never widen it.
 *
 * This rail has no equivalent in mail or chat, which is why it lives here: an
 * email reply reaches the same recipients by construction, and a Slack thread
 * reply inherits the channel. A social reply is different in kind — the parent
 * carries an independent audience setting, and replying `public` to a
 * followers-only post republishes its content, quoted, to everyone. That is a
 * disclosure the owner never authorized and cannot retract, and it is easy to
 * do by accident because `public` is every platform's default.
 */
export function resolveReplyVisibility(
  parent: SocialVisibility,
  requested?: SocialVisibility | null,
): SocialVisibility {
  if (!requested) return parent;
  if (VISIBILITY_RANK[requested] > VISIBILITY_RANK[parent]) {
    throw new SocialVisibilityWidened(parent, requested);
  }
  return requested;
}

/* -------------------------------------------------------------------------- */
/* Rail 1 — reply coordinates derived from the stored document alone          */
/* -------------------------------------------------------------------------- */

/**
 * Platform-native reply target, discriminated so each adapter receives exactly
 * the fields its API needs and cannot silently read a field meant for another.
 */
export type SocialReplyTarget =
  | {
      platform: 'bluesky';
      /** Thread root strong ref — atproto requires BOTH root and parent. */
      rootUri: string;
      rootCid: string;
      parentUri: string;
      parentCid: string;
    }
  | { platform: 'mastodon'; inReplyToId: string; instanceHost: string }
  | { platform: 'reddit'; parentFullname: string; subreddit: string }
  | {
      platform: 'youtube';
      /**
       * `comments.insert`'s REQUIRED `snippet.parentId` — the TOP-LEVEL comment
       * of the thread, never the video and never the commentThread id.
       */
      parentCommentId: string;
      /** Only for the permalink; a document stored without one still replies fine. */
      videoId?: string;
      /**
       * `commentThread.snippet.canReply`. A definite `false` is refused locally,
       * because the vendor page names this flag as the remedy for the
       * `operationNotSupported` 400 the insert would otherwise return.
       */
      canReply?: boolean;
    }
  | {
      platform: 'facebook-pages';
      /**
       * The object the reply attaches to. Facebook's `/comments` edge is
       * "common to multiple Graph API nodes" and a Comment node carries its own
       * `/comments` edge for replies, so this is a POST id when replying to a
       * post and a COMMENT id when replying to a comment. One field rather than
       * two on purpose: the API makes no distinction, and a `postId`/`commentId`
       * pair would invite a caller to supply both and leave the adapter guessing
       * which the reply was meant for.
       */
      objectId: string;
      /** Only for the permalink; a reply works without it. */
      pageId?: string;
      /**
       * `can_comment` — "indicates whether it is possible to reply to that
       * comment". A definite `false` is refused locally. An ABSENT value still
       * attempts, matching the YouTube `canReply` posture: treating a missing
       * optional field as a refusal turns a gap in the response into a dropped
       * reply.
       */
      canComment?: boolean;
    }
  | {
      platform: 'instagram';
      /**
       * The TOP-LEVEL comment the reply attaches to — never a reply's own id.
       *
       * ⚠ THE PLATFORM SILENTLY RE-PARENTS RATHER THAN REFUSING, which is why
       * this is derived here instead of being left to the adapter to pass
       * through. Verbatim from the `/replies` edge reference: "You can only
       * reply to top-level comments; replies to a reply will be added to the
       * top-level comment." So addressing a reply does not fail — it SUCCEEDS,
       * returns a real id, and lands the comment somewhere other than where it
       * was aimed. A silent redirect is worse than an error precisely because
       * nothing in the response says it happened, so the correction has to be
       * made before the call rather than detected after it.
       *
       * This is YouTube's two-level shape reached independently (a reply's
       * stored `replyToId` IS the top-level parent), and the same field name is
       * used by the Instagram comments adapter for the same vendor concept.
       */
      topLevelCommentId: string;
      /** Only for the label; a reply works without it. */
      mediaId?: string;
      /**
       * `hidden`. A definite `true` is refused locally — "You cannot reply to
       * hidden comments." An ABSENT value still attempts, matching the YouTube
       * `canReply` / Pages `canComment` posture: a missing optional field is a
       * gap in the response, not a denial.
       */
      hidden?: boolean;
    }
  | {
      platform: 'threads';
      /**
       * The container's `reply_to_id` — THE EXACT THING BEING REPLIED TO, which
       * on Threads may be a reply as readily as a root post.
       *
       * ⚠ THE OPPOSITE OF THE INSTAGRAM FIELD ABOVE, AND THE CONTRAST IS THE
       * WHOLE REASON BOTH ARE DERIVED HERE RATHER THAN PASSED THROUGH.
       * Instagram silently RE-PARENTS a reply-to-a-reply up to the top-level
       * comment, so its target must be normalised UP or the reply lands
       * somewhere it was not aimed. Threads honours the exact id: "Use the
       * reply_to_id parameter to reply to a specific reply under the root
       * post." So the correct Threads value is the stored document's OWN
       * external id — normalising it up to a parent, by symmetry with
       * Instagram, would post a visible public reply in the wrong place on
       * every nested conversation (D-035).
       */
      replyToId: string;
      /**
       * The root post of the reply tree. Carried for the label, and — more
       * importantly — as the subject of the ownership gate below.
       */
      rootPostId?: string;
      /**
       * The profile that owns the ROOT post.
       *
       * ⚠ NOT DECORATION: Threads gates replying on "You are the owner of the
       * root thread post" OR holding threads_keyword_search /
       * threads_manage_mentions, neither of which this integration requests
       * (D-039). This carries the fact the adapter checks that gate against.
       *
       * OPTIONAL IN THE TYPE AND REFUSED WHEN ABSENT — the opposite posture to
       * the `canReply` / `canComment` / `hidden` flags above, deliberately.
       * Those are permissions the provider affirmatively DENIED, so a missing
       * value means "not reported" and attempting is right. This is a
       * precondition we must affirmatively ESTABLISH, so a missing value means
       * "unknown", and attempting on an unknown would publish a public reply on
       * the strength of a guess.
       */
      rootPostOwnerId?: string;
    }
  | {
      /**
       * ⚠ LINKEDIN CANNOT REPLY, so this variant exists ONLY to address an
       * existing post for DELETE — `SocialDeleteRequest.target` reuses this
       * union, so a delete-capable platform must appear here even when it has
       * no reply path.
       *
       * A future reader adding LinkedIn reply support needs more than this
       * field: LinkedIn's self-serve grant does not include the Comments API's
       * `w_member_social_feed` scope at all. See linkedin-common.ts.
       */
      platform: 'linkedin';
      /**
       * The post's own URN, VERBATIM as LinkedIn issued it in the `x-restli-id`
       * response header — `urn:li:share:{id}` or `urn:li:ugcPost:{id}`.
       *
       * Both spellings are live and the API returns either one for the same
       * create call, so this is stored as issued rather than normalised to a
       * preferred form. Rewriting `ugcPost` to `share` (or the reverse) to make
       * ids look uniform would address a different entity — LinkedIn treats
       * them as distinct URN types and answers INVALID_URN_TYPE.
       */
      postUrn: string;
    };

export interface SocialReplyCoordinates {
  ref: SocialPostRef;
  target: SocialReplyTarget;
  /** The PARENT's audience. The reply may match or narrow it, never widen. */
  parentVisibility: SocialVisibility;
  /** Human-readable destination, echoed back so the caller reports where it went. */
  label: string;
}

/**
 * YouTube's reply target, split out as its own exported function.
 *
 * WHY THIS ONE IS SEPARATE WHEN THE OTHER THREE ARE INLINE. YouTube's registry
 * row carries `blockedOn` (the owner's Google incremental-consent wall), so
 * `assertSocialPlatformUsable` throws `owner-blocked` at the top of
 * `resolveSocialReplyCoordinates` and this branch is UNREACHABLE through the
 * public function today. Leaving the derivation inline would therefore ship it
 * untested until the day the wall lifts — which is the worst possible day to
 * discover it wrong, because it is also the first day anyone tries to reply.
 * Exported, it is directly testable now; the switch calls it, so there is still
 * exactly one implementation.
 *
 * ⚠ THE PARENT IS ALWAYS THE TOP-LEVEL COMMENT. `comments.insert` requires
 * `snippet.parentId`, and YouTube's comment model is two-level: a thread has one
 * top-level comment and a flat list of replies. So replying to a REPLY still
 * addresses that reply's parent, which is why `replyToId` (the stored
 * `snippet.parentId`, carried verbatim by the comments read adapter) is
 * preferred over the document's own id. A document with no `replyToId` IS a
 * top-level comment, so its own external id is the parent.
 */
export function resolveYouTubeReplyTarget(
  payload: Record<string, unknown>,
  externalId: string,
): Extract<SocialReplyTarget, { platform: 'youtube' }> {
  const parentCommentId = string(payload.replyToId) || externalId;
  if (!parentCommentId) {
    throw new Error(
      'social_reply_coordinates_missing:youtube — comments.insert REQUIRES snippet.parentId and the stored document carries neither a replyToId nor an external id',
    );
  }
  const videoId = string(payload.videoId);
  const target: Extract<SocialReplyTarget, { platform: 'youtube' }> = { platform: 'youtube', parentCommentId };
  if (videoId) target.videoId = videoId;
  // Only a definite boolean is carried. An ABSENT flag must stay absent rather
  // than defaulting either way: defaulting to false would disable replies for
  // every document stored before the field existed, and defaulting to true would
  // manufacture a permission the provider never granted.
  if (typeof payload.canReply === 'boolean') target.canReply = payload.canReply;
  return target;
}

/**
 * Instagram's reply target, split out for the same reason YouTube's is: the
 * registry row carries `blockedOn` (Meta app review), so this branch is
 * unreachable through the public function today and would otherwise ship
 * untested until the wall lifts — which is the first day anyone replies, and so
 * the worst day to discover it wrong.
 *
 * ⚠ THE DERIVATION IS LOAD-BEARING, NOT A CONVENIENCE. Instagram does not refuse
 * a reply aimed at a reply; it re-parents it to the top-level comment and
 * returns a normal success. So the choice of id made here is the ONLY point at
 * which the intended target and the actual target can still be made to agree.
 * A stored reply carries `replyToId` (the vendor's `parent_id`), which IS the
 * top-level comment; a document without one already IS top-level, so its own
 * external id is the parent.
 */
export function resolveInstagramReplyTarget(
  payload: Record<string, unknown>,
  externalId: string,
): Extract<SocialReplyTarget, { platform: 'instagram' }> {
  const topLevelCommentId = string(payload.replyToId) || externalId;
  if (!topLevelCommentId) {
    throw new Error(
      'social_reply_coordinates_missing:instagram — POST /{ig-comment-id}/replies needs a comment id and the stored document carries neither a replyToId nor an external id',
    );
  }
  const target: Extract<SocialReplyTarget, { platform: 'instagram' }> = { platform: 'instagram', topLevelCommentId };
  const mediaId = string(payload.subjectId);
  if (mediaId) target.mediaId = mediaId;
  // Only a definite boolean is carried, for the reason given on the field: the
  // comments adapter writes `hidden` ONLY when it is true, so an absent value
  // means "not reported", and defaulting it either way would either drop every
  // reply to a document stored before the field existed or manufacture a
  // permission the provider never gave.
  if (typeof payload.hidden === 'boolean') target.hidden = payload.hidden;
  return target;
}

/**
 * Threads reply coordinates.
 *
 * ⚠ READ THIS BESIDE `resolveInstagramReplyTarget` — THEY LOOK ALIKE AND DO THE
 * OPPOSITE THING, which is exactly the trap two Meta platforms under one app
 * identity set for an author working from the previous adapter. Instagram
 * normalises the target UP to the top-level comment because the platform
 * silently re-parents anything else. Threads addresses the EXACT id, because it
 * honours nested targets: "Use the reply_to_id parameter to reply to a specific
 * reply under the root post." So here the stored document's OWN external id is
 * the answer, and reaching for its `replyToId` — the shape that is correct one
 * file away — would land every nested reply one level too high (D-035).
 *
 * The ownership fields are carried but NOT enforced here: this function is pure
 * and derives coordinates, while the refusal belongs at the call site where the
 * credential is in hand (`assertThreadsMayReply`). Deriving without enforcing is
 * deliberate — a resolver that threw on an unowned root would make the same
 * decision without the credential that actually determines it.
 */
export function resolveThreadsReplyTarget(
  payload: Record<string, unknown>,
  externalId: string,
): Extract<SocialReplyTarget, { platform: 'threads' }> {
  const replyToId = externalId || string(payload.id);
  if (!replyToId) {
    throw new Error(
      'social_reply_coordinates_missing:threads — the container needs a reply_to_id and the stored document carries no external id',
    );
  }
  const target: Extract<SocialReplyTarget, { platform: 'threads' }> = { platform: 'threads', replyToId };
  const rootPostId = string(payload.subjectId);
  if (rootPostId) target.rootPostId = rootPostId;
  // Written by the conversation adapter at ingestion, where root ownership is
  // established by construction. Absent for a document stored by any other
  // path, and absent is refused rather than assumed at the call site.
  const rootPostOwnerId = string(payload.subjectOwnerId);
  if (rootPostOwnerId) target.rootPostOwnerId = rootPostOwnerId;
  return target;
}

/**
 * Derive every reply coordinate from the STORED document.
 *
 * Pure, and exported for the same reason `resolveMailReplyCoordinates` is: the
 * security claim is "these values come from the vault document, never from a
 * caller argument", and a function whose only input is the document makes that
 * claim mechanically checkable instead of merely asserted.
 */
export function resolveSocialReplyCoordinates(doc: CanonicalDocument): SocialReplyCoordinates {
  const platform = doc.source as SocialPlatformId;
  const row = assertSocialPlatformUsable(platform);
  const payload = doc.payload;
  const ref: SocialPostRef = { platform, externalId: doc.externalId };
  const parentVisibility = normalizeSocialVisibility(payload.visibility);

  switch (platform) {
    case 'bluesky': {
      const parentUri = string(payload.uri) || doc.externalId;
      const parentCid = string(payload.cid);
      // A reply to a root post IS the thread root, so root falls back to parent.
      const rootUri = string(payload.rootUri) || parentUri;
      const rootCid = string(payload.rootCid) || parentCid;
      if (!parentUri || !parentCid) {
        throw new Error(
          'social_reply_coordinates_missing:bluesky — atproto needs a strong ref (uri AND cid) for both parent and root',
        );
      }
      return {
        ref,
        target: { platform: 'bluesky', rootUri, rootCid, parentUri, parentCid },
        parentVisibility,
        label: `${row.label} · ${string(payload.authorHandle) || parentUri}`,
      };
    }

    case 'mastodon': {
      const inReplyToId = string(payload.statusId) || doc.externalId;
      const instanceHost = string(payload.instanceHost);
      if (!inReplyToId) throw new Error('social_reply_coordinates_missing:mastodon — no status id');
      if (!instanceHost) {
        // Mastodon has no single API host; the credential is per instance, so
        // an absent host is unrecoverable rather than defaultable.
        throw new Error(
          'social_reply_coordinates_missing:mastodon — no instanceHost on the stored status; Mastodon is federated, so there is no default host to fall back to',
        );
      }
      return {
        ref,
        target: { platform: 'mastodon', inReplyToId, instanceHost },
        parentVisibility,
        label: `${row.label} · ${instanceHost} · ${string(payload.authorHandle) || inReplyToId}`,
      };
    }

    case 'reddit': {
      const parentFullname = string(payload.fullname) || doc.externalId;
      const subreddit = string(payload.subreddit);
      if (!parentFullname || !/^t\d_/.test(parentFullname)) {
        throw new Error(
          `social_reply_coordinates_missing:reddit — expected a fullname like t3_abc123, got ${JSON.stringify(parentFullname.slice(0, 32))}`,
        );
      }
      return {
        ref,
        target: { platform: 'reddit', parentFullname, subreddit },
        parentVisibility,
        label: `${row.label} · ${subreddit ? `r/${subreddit}` : parentFullname}`,
      };
    }

    case 'youtube':
      return {
        ref,
        target: resolveYouTubeReplyTarget(payload, doc.externalId),
        parentVisibility,
        label: `${row.label} · ${string(payload.videoId) || string(payload.threadId) || doc.externalId}`,
      };

    case 'instagram':
      return {
        ref,
        target: resolveInstagramReplyTarget(payload, doc.externalId),
        parentVisibility,
        label: `${row.label} · ${string(payload.subjectId) || doc.externalId}`,
      };

    case 'threads':
      return {
        ref,
        target: resolveThreadsReplyTarget(payload, doc.externalId),
        parentVisibility,
        label: `${row.label} · ${string(payload.subjectId) || doc.externalId}`,
      };

    case 'linkedin':
      // NOT a missing derivation, which is what the default branch below would
      // wrongly imply. LinkedIn is verified and usable — it simply cannot reply
      // at any grant tier we hold, because its self-serve permission covers
      // posting while the Comments API requires `w_member_social_feed`.
      //
      // Cased explicitly because this seam runs BEFORE the write gate, so
      // without it the accurate refusal is masked by a message reading "no
      // coordinate derivation for it YET" — which would send a reader off to
      // implement coordinates that no scope would ever let them use.
      throw new SocialPlatformUnusableError(
        'linkedin',
        'write-verb-unsupported',
        "LinkedIn's self-serve grant (w_member_social) posts but does not comment; the Comments API requires w_member_social_feed, which is not an open permission",
      );

    default:
      // Wave B/C platforms are refused by assertSocialPlatformUsable above
      // (unverified or owner-blocked), so reaching here means a row was
      // verified without its reply coordinates being taught to this seam.
      throw new Error(
        `social_reply_platform_unsupported:${platform} — the registry row is usable but this seam has no coordinate derivation for it yet`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedSocialPost {
  ref: SocialPostRef;
  row: SocialPlatformRow;
  doc: CanonicalDocument;
}

/**
 * Resolve a post ref to the stored document and its platform row.
 *
 * Scoped to (workspace, user) by `resolveCanonicalDocument`, so a caller cannot
 * address another principal's post by guessing an id.
 */
export async function resolveSocialPost(
  sql: postgres.Sql | postgres.TransactionSql,
  params: { workspaceId: string; userId: string; ref: string | SocialPostRef },
): Promise<ResolvedSocialPost> {
  const ref = typeof params.ref === 'string' ? parseSocialPostRef(params.ref) : params.ref;
  const row = assertSocialPlatformUsable(ref.platform);
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: ref.platform,
    externalId: ref.externalId,
  });
  if (doc.source !== ref.platform) {
    // Defence in depth: the query already filters on source.
    throw new Error(`social_post_platform_mismatch:${ref.platform}:${doc.source}`);
  }
  return { ref, row, doc };
}

/**
 * Resolve the outbound credential for a social platform.
 *
 * The platform id doubles as the vault source name and the trigger-source kind
 * — deliberately, so there is no second mapping table to drift out of sync with
 * the registry (see `TRIGGER_KIND_BY_VAULT_SOURCE` in resolve.ts, which derives
 * its social entries from the registry rather than restating them).
 */
export async function resolveSocialOutboundContext(
  sql: postgres.Sql,
  params: { workspaceId: string; userId: string; platform: SocialPlatformId; verb: SocialWriteVerb },
): Promise<{ row: SocialPlatformRow; context: OutboundContext }> {
  const row = assertSocialWriteAllowed(params.platform, params.verb);
  const context = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: params.platform,
  });
  return { row, context };
}

/* -------------------------------------------------------------------------- */
/* Write adapters                                                             */
/* -------------------------------------------------------------------------- */

export interface SocialReplyRequest {
  target: SocialReplyTarget;
  text: string;
  visibility: SocialVisibility;
  /**
   * Stable key for the logical write, so an adapter on a platform with an
   * idempotency mechanism (Mastodon's Idempotency-Key) can pass it through and
   * one without (Reddit) can carry its own dedupe guard. Derived, never caller-
   * supplied — a caller-chosen key would let a retry be forced into a NEW post.
   */
  idempotencyKey: string;
}

export interface SocialReplyOutcome {
  /** Platform id of the created post. */
  externalId: string;
  /** Canonical ref for the created post, so the caller can address it later. */
  ref: string;
  url?: string;
}

/**
 * One piece of media attached to a create-shaped post.
 *
 * `url` is a PUBLICLY FETCHABLE address, not a local path or an upload handle:
 * the platforms that take media this way (Instagram's `image_url`/`video_url`)
 * fetch it themselves, server-side, rather than accepting bytes on the create
 * call.
 */
export interface SocialPostMedia {
  url: string;
  type: 'image' | 'video';
}

/** A create-shaped write: new content, at a destination the caller named. */
export interface SocialPostRequest {
  destination: string;
  text: string;
  visibility: SocialVisibility;
  /** Derived, never caller-supplied — see `socialPostIdempotencyKey`. */
  idempotencyKey: string;
  /**
   * Media to attach. OPTIONAL HERE AND REQUIRED BY SOME PLATFORMS — which is a
   * real asymmetry rather than a loose contract, and worth stating because the
   * shape of `post` quietly assumed otherwise.
   *
   * Every Wave A platform plus Facebook Pages is TEXT-PRIMARY: a post is some
   * text, and media is a decoration you may omit. Instagram is MEDIA-PRIMARY —
   * `POST /{ig-id}/media` takes `image_url` or `video_url`, and the caption is
   * the optional half. There is no text-only Instagram feed post to create, so
   * an Instagram adapter handed a text-only request cannot degrade gracefully;
   * it can only refuse.
   *
   * Optional rather than required for the same reason `lossRisk` is optional on
   * the reconcile result: a required field would strand every existing caller
   * and every text-primary adapter to encode a fact about ONE platform. The
   * asymmetry is therefore carried where it belongs — the platform that needs
   * media asserts it, and says so in its own error rather than in this type.
   */
  media?: readonly SocialPostMedia[];
}

export type SocialPostOutcome = SocialReplyOutcome;

export interface SocialWriteAdapter {
  platform: SocialPlatformId;
  /**
   * Optional for exactly the reason `post` and `delete` are, and it was NOT
   * optional until LinkedIn (P-021) falsified the assumption behind it.
   *
   * Reply is this plan's central verb, so "every social platform can reply" was
   * a natural thing to bake into the contract. LinkedIn is the counterexample:
   * its self-serve grant (`w_member_social`, the only open write permission in
   * LinkedIn's own permissions reference) posts but does not comment — the
   * Comments API declares a DIFFERENT scope, `w_member_social_feed`, which is
   * not self-serve. So LinkedIn's registry row declares `verbs: ['post',
   * 'delete']` and `assertSocialWriteAllowed` refuses 'reply' BEFORE this
   * lookup, exactly as it does for any other undeclared verb.
   *
   * Requiring `reply` here would force such a platform to ship a method that
   * can only throw, and that throw would surface as an ADAPTER defect at the
   * call site rather than as the PLATFORM limitation it actually is — the very
   * confusion the note on `post` below exists to prevent, pointed the other
   * way. The two conditions stay separately reported.
   */
  reply?(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome>;
  /**
   * Optional on purpose. The registry already declares per-platform write verbs
   * (`write.verbs`), and `assertSocialWriteAllowed` refuses a verb a platform
   * does not support BEFORE this lookup — so a missing `post` here means "the
   * adapter has not implemented a verb its platform does declare", which is a
   * distinct and separately-reported condition from "the platform cannot post".
   * Collapsing the two would report an unimplemented adapter as a platform
   * limitation, sending someone to verify a lexicon that was never the problem.
   */
  post?(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome>;
  /**
   * Optional for the same reason `post` is — a missing implementation is an
   * adapter gap, not a platform limitation, and the two are reported
   * separately.
   *
   * `deleted:false` is a FIRST-CLASS outcome, not a failure: it is how an
   * adapter says "the platform reports nothing there to delete". Delete is the
   * one verb whose retry is indistinguishable from its success — a second call
   * on an already-gone post looks exactly like a first call that worked — so an
   * adapter that cannot tell those apart must say so here rather than return a
   * success the caller will read as "I deleted it".
   */
  delete?(request: SocialDeleteRequest, context: OutboundContext): Promise<SocialDeleteOutcome>;
}

/**
 * A write adapter that is statically known to implement `reply`.
 *
 * Exists because `reply` became optional in P-021 for LinkedIn's sake, and a
 * factory returning the plain `SocialWriteAdapter` would then widen every
 * reply-implementing adapter to "might not have it" — pushing `!` assertions
 * into callers that have no doubt at all. Annotating the factory instead keeps
 * the proof where the knowledge is: an adapter that implements reply SAYS so in
 * its return type, and LinkedIn's simply does not make the claim.
 *
 * Prefer this over a non-null assertion at the call site: `!` silences the
 * checker everywhere it is written, whereas this keeps a genuinely reply-less
 * adapter a compile error if someone ever assigns one here.
 */
export type SocialReplyCapableAdapter = SocialWriteAdapter & {
  reply: NonNullable<SocialWriteAdapter['reply']>;
};

export interface SocialDeleteRequest {
  ref: SocialPostRef;
  /** Platform-native handle for the post, derived from the STORED row. */
  target: SocialReplyTarget;
  idempotencyKey: string;
}

export interface SocialDeleteOutcome {
  /** false = the platform reported nothing to delete. Never conflate with success. */
  deleted: boolean;
  detail?: string;
}

const WRITE_ADAPTERS = new Map<SocialPlatformId, SocialWriteAdapter>();

/** Register a platform's write adapter (P-011..P-019 land these). */
export function registerSocialWriteAdapter(adapter: SocialWriteAdapter): void {
  WRITE_ADAPTERS.set(adapter.platform, adapter);
}

/** Test seam: drop a registration so a suite cannot leak into the next. */
export function unregisterSocialWriteAdapter(platform: SocialPlatformId): void {
  WRITE_ADAPTERS.delete(platform);
}

export function getSocialWriteAdapter(platform: SocialPlatformId): SocialWriteAdapter | undefined {
  return WRITE_ADAPTERS.get(platform);
}

/**
 * Derive the idempotency key for a reply.
 *
 * Deliberately a function of (parent, text) and NOT of wall-clock time: the
 * whole point is that a retry of the same logical reply produces the same key.
 * A timestamp would make every retry unique, which is precisely the double-post
 * the key exists to prevent — and Reddit documents no idempotency mechanism at
 * all, so its adapter has nothing else to dedupe on.
 */
export function socialReplyIdempotencyKey(ref: SocialPostRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialPostRef(ref)}\x1f${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Derive the idempotency key for a create-shaped post.
 *
 * Same (target, text) construction and the same deliberate absence of a
 * timestamp as the reply key above — a retry of the same logical write must
 * produce the same key, which a clock would defeat.
 *
 * The `-post-` infix is load-bearing rather than cosmetic. A post ref and a
 * destination ref are BOTH `"<platform>:<tail>"`, so a reply to `reddit:abc`
 * and a post addressed to `reddit:abc` carrying identical text would otherwise
 * be indistinguishable — and an adapter deduping on the key would silently drop
 * the second, genuinely different, write. The two key spaces are therefore
 * disjoint by construction, pinned by test.
 */
export function socialPostIdempotencyKey(ref: SocialDestinationRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialDestinationRef(ref)}\x1f${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-post-${hash.toString(16).padStart(8, '0')}`;
}

export interface SocialReplyResult extends SocialReplyOutcome {
  platform: SocialPlatformId;
  /** Echoed so the caller reports WHERE it went — it never chose. */
  inReplyTo: string;
  label: string;
  visibility: SocialVisibility;
}

/**
 * `social:reply` — D-020 rail 1 for social-post.
 *
 * The caller supplies TEXT ONLY plus an opaque post ref. Destination, account,
 * credential and audience are all resolved server-side from the stored
 * document. Executes rather than drafts, per D-004: the blast radius is the
 * existing thread, it is visible, and a follow-up can correct it.
 *
 * Order of the gates matters and is not arbitrary. The registry write gate runs
 * BEFORE the adapter lookup, so an unverified write path (Bluesky) is refused
 * even once its adapter exists — the gate is about whether we know how to call
 * the API correctly, which having written an adapter does not establish.
 */
export async function replyToCanonicalSocialPost(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    ref: string | SocialPostRef;
    text: string;
    visibility?: SocialVisibility | null;
  },
): Promise<SocialReplyResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_reply_text_required');
  if (text.length > 10_000) throw new Error('social_reply_text_too_long');

  const { ref, doc } = await resolveSocialPost(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    ref: params.ref,
  });
  const coordinates = resolveSocialReplyCoordinates(doc);
  const visibility = resolveReplyVisibility(coordinates.parentVisibility, params.visibility);

  const { context } = await resolveSocialOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    platform: ref.platform,
    verb: 'reply',
  });

  const adapter = getSocialWriteAdapter(ref.platform);
  if (!adapter) {
    throw new Error(
      `social_reply_adapter_missing:${ref.platform} — the platform's write path is verified but no adapter is registered yet`,
    );
  }

  if (typeof adapter.reply !== 'function') {
    throw new Error(
      `social_reply_adapter_verb_missing:${ref.platform} — the registry declares this platform can reply, but its adapter does not implement it`,
    );
  }

  const outcome = await adapter.reply(
    {
      target: coordinates.target,
      text,
      visibility,
      idempotencyKey: socialReplyIdempotencyKey(ref, text),
    },
    context,
  );

  return {
    ...outcome,
    platform: ref.platform,
    inReplyTo: formatSocialPostRef(ref),
    label: coordinates.label,
    visibility,
  };
}

/**
 * Rail 2 for social: a create-shaped destination the CALLER named.
 *
 * `social:post` targets an audience the agent supplies (a subreddit, a page, a
 * community), which is exactly the shape D-020 rail 2 governs. A destination
 * quoted inside an inbound post's body is refused for the same reason an
 * injected email address is: it carries the body-only signature.
 */
export async function assertTrustedSocialDestination(
  sql: postgres.Sql | postgres.TransactionSql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string;
    provenance: AddresseeProvenance;
  },
): Promise<AddresseeDecision> {
  const destination = string(params.destination);
  if (!destination) throw new Error('social_destination_required');
  return assertTrustedAddressee(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: destination,
    provenance: params.provenance,
  });
}

/* -------------------------------------------------------------------------- */
/* social:post — create-shaped publishing                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the caller is told BEFORE anything goes out.
 *
 * D-004 ruling (b) requires the resolved account and audience to be echoed back
 * before publish REGARDLESS OF THE FLAG, which is why this is a first-class
 * return value rather than a log line: with publishing withheld it is the whole
 * answer, and the owner's ratification decision is made against it.
 */
export interface SocialPostEcho {
  platform: SocialPlatformId;
  destination: string;
  destinationRef: string;
  visibility: SocialVisibility;
  /** WHICH of the owner's connected accounts would speak. */
  account: { sourceId: string; kind: string; credentialRef: string | null };
  /** Rail 2's verdict on the destination the caller named. */
  destinationStanding: AddresseeDecision['standing'];
  destinationProvenance: AddresseeDecision['provenance'];
  destinationVerified: boolean;
  idempotencyKey: string;
  characters: number;
}

export interface SocialPostResult {
  echo: SocialPostEcho;
  /** null iff publishing was withheld. */
  published: (SocialPostOutcome & { platform: SocialPlatformId }) | null;
  withheld: { reason: 'publish-flag-off'; detail: string } | null;
}

/**
 * `social:post` — D-020 rail 2 for social-post, gated by D-004 ruling (b).
 *
 * The ordering below is the security content of this function; every gate can
 * be individually present and the verb still be unsafe if they run out of
 * order.
 *
 *  1. PARSE. An unknown platform fails with the registry's reason before any
 *     vault or credential work happens.
 *  2. RAIL 2, before any credential is resolved. A destination the agent could
 *     only have read out of inbound message content is refused outright — and
 *     it is refused before the owner's credential is even looked up, so an
 *     injected destination never reaches a code path holding an identity.
 *  3. REGISTRY WRITE GATE, before the adapter lookup — same reasoning as
 *     `replyToCanonicalSocialPost`: having written an adapter is not evidence
 *     that we know how to call the API correctly.
 *  4. FLAG, last. It withholds the outbound call ONLY. Everything above it has
 *     already run, so the echo the owner ratifies against is the real
 *     resolution and not a prediction of one.
 *
 * The flag is read HERE rather than at the tool boundary, deliberately. A
 * `publish: boolean` parameter would put the publish authority in the caller's
 * hands, and the next caller to be written is the one that forgets — this way
 * there is exactly one decision point and no argument that can bypass it.
 */
export async function postToCanonicalSocialDestination(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string | SocialDestinationRef;
    text: string;
    visibility?: SocialVisibility | null;
    provenance: AddresseeProvenance;
  },
): Promise<SocialPostResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_post_text_required');
  if (text.length > 10_000) throw new Error('social_post_text_too_long');

  const ref =
    typeof params.destination === 'string'
      ? parseSocialDestinationRef(params.destination)
      : params.destination;

  // A create has no parent to inherit from, so the widening rail (D-006 ruling
  // c) has nothing to compare against and does not apply. An absent value
  // therefore lands on `public` for the reason recorded in
  // `normalizeSocialVisibility`: these posts genuinely are public, and
  // narrowing a create to `direct` would produce a DM, which is not a safer
  // reading of "post" but a different verb. A MALFORMED value still fails
  // closed to `direct` through the same normalizer.
  const visibility =
    params.visibility === undefined || params.visibility === null
      ? 'public'
      : normalizeSocialVisibility(params.visibility);

  const decision = await assertTrustedSocialDestination(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    destination: ref.destination,
    provenance: params.provenance,
  });

  const { context } = await resolveSocialOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    platform: ref.platform,
    verb: 'post',
  });

  const adapter = getSocialWriteAdapter(ref.platform);
  if (!adapter) {
    throw new Error(
      `social_post_adapter_missing:${ref.platform} — the platform's write path is verified but no adapter is registered yet`,
    );
  }
  if (typeof adapter.post !== 'function') {
    throw new Error(
      `social_post_adapter_verb_missing:${ref.platform} — the registry declares this platform can post, but its adapter implements only reply`,
    );
  }

  const echo: SocialPostEcho = {
    platform: ref.platform,
    destination: ref.destination,
    destinationRef: formatSocialDestinationRef(ref),
    visibility,
    account: {
      sourceId: context.source.id,
      kind: context.source.kind,
      credentialRef: context.source.credentialRef,
    },
    destinationStanding: decision.standing,
    destinationProvenance: decision.provenance,
    destinationVerified: decision.verified,
    idempotencyKey: socialPostIdempotencyKey(ref, text),
    characters: text.length,
  };

  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.SOCIAL_AUTO_PUBLISH, `social-post:${params.workspaceId}`);
  if (!enabled) {
    return {
      echo,
      published: null,
      withheld: {
        reason: 'publish-flag-off',
        detail:
          "publishing to the owner's public identity is withheld until the owner ratifies it (flag papercusp-social-auto-publish, default OFF per D-004(b)) — everything above the outbound call ran, so this echo is the real resolution. Flip it via /admin/features.",
      },
    };
  }

  const outcome = await adapter.post(
    {
      destination: ref.destination,
      text,
      visibility,
      idempotencyKey: echo.idempotencyKey,
    },
    context,
  );

  return { echo, published: { ...outcome, platform: ref.platform }, withheld: null };
}
