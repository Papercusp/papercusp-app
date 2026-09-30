/**
 * LinkedIn writes — post and delete ONLY (P-021).
 *
 * ⚠ THERE IS NO `reply` METHOD ON THIS ADAPTER AND ITS ABSENCE IS THE POINT.
 * Every sibling in this directory implements reply, so the missing method reads
 * as an unfinished file. It is not. LinkedIn's self-serve grant
 * (`w_member_social`) posts but does not comment: the Comments API declares
 * `w_member_social_feed`, which is not among LinkedIn's open permissions. The
 * registry row therefore declares `verbs: ['post', 'delete']`, and
 * `assertSocialWriteAllowed('linkedin', 'reply')` refuses BEFORE any adapter
 * lookup — so a reply attempt is reported as the PLATFORM limitation it is,
 * rather than as an adapter that forgot a method. Adding a throwing `reply`
 * here would destroy exactly that distinction. Full citation chain:
 * linkedin-common.ts.
 *
 * THE OTHER INHERITANCE THAT WOULD BE WRONG. Threads and Instagram publish
 * through a two-step container + publish flow, and Instagram is media-primary.
 * LinkedIn is neither: a post is ONE call to `POST /rest/posts` carrying its
 * commentary inline, and it is text-primary — `commentary` alone is a complete
 * post, so no media assertion belongs here (D-032, reached from LinkedIn's own
 * text-only sample request rather than read across).
 *
 * WHAT MAKES THIS ADAPTER GENUINELY DANGEROUS, AND WHAT IT DOES ABOUT IT.
 * LinkedIn has no idempotency mechanism on create and its own error table
 * advises retrying a 409. A retry that follows that advice publishes a second
 * post to the owner's real profile. So a create here has exactly three
 * outcomes, never two: confirmed, cleanly refused, or UNCONFIRMED — and an
 * unconfirmed create is surfaced as `LinkedInWriteUnconfirmed` rather than
 * being retried or reported as a failure. This mirrors the posture Threads
 * arrived at for the same underlying reason (D-033: a status probe is
 * DETECTION, not idempotency), with LinkedIn's twist that there is no probe to
 * run at all — the read scope needed to look up "did my post land?" is
 * restricted, so the ambiguity genuinely cannot be resolved by this process.
 */
import type { OutboundContext } from '../../capability-verbs/resolve';
import type {
  SocialDeleteOutcome,
  SocialDeleteRequest,
  SocialPostOutcome,
  SocialPostRequest,
  SocialWriteAdapter,
} from '../../capability-verbs/social';
import {
  assertLinkedInCredential,
  linkedinAuthorUrn,
  linkedinCreatedId,
  linkedinCreateRetryable,
  linkedinDeleteRetryable,
  linkedinEncodeUrn,
  linkedinRestHeaders,
  linkedinTokenExpired,
  LINKEDIN_POSTS_URL,
  LINKEDIN_THROTTLE_STATUS,
  type LinkedInCredential,
} from './linkedin-common';

/**
 * A write that could not be confirmed to have happened — and, crucially, could
 * not be confirmed NOT to have happened either.
 *
 * Separate from a plain failure because the two demand opposite responses. A
 * refused write can be retried; an unconfirmed one must NOT be, because
 * LinkedIn has no idempotency key and the retry would publish a second visible
 * post on the owner's real profile.
 *
 * ⚠ WORSE HERE THAN ON THREADS, and worth stating so nobody "improves" this by
 * adding a lookup. Threads can at least probe its container status to find out
 * what happened. LinkedIn cannot: reading a member's own posts requires
 * `r_member_social`, which is restricted to approved developers, so this
 * integration has no way to ask "did it land?" at any tier we hold. The
 * ambiguity is terminal for this process and must reach a human.
 */
export class LinkedInWriteUnconfirmed extends Error {
  readonly verb: 'post' | 'delete';
  readonly reason: string;
  constructor(verb: 'post' | 'delete', reason: string) {
    super(`linkedin_write_unconfirmed:${verb}: ${reason}`);
    this.name = 'LinkedInWriteUnconfirmed';
    this.reason = reason;
    this.verb = verb;
  }
}

/** A refusal decided BEFORE any call — no request was made, nothing was spent. */
export class LinkedInWriteRefused extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`linkedin_write_refused:${reason}: ${detail}`);
    this.name = 'LinkedInWriteRefused';
    this.reason = reason;
  }
}

/**
 * LinkedIn's `MemberNetworkVisibility`, which has exactly TWO values.
 *
 * Our `SocialVisibility` has four, so two of them have no LinkedIn meaning and
 * are REFUSED rather than approximated. That refusal is deliberate and is the
 * safer half of the mapping: silently widening a 'direct' or 'unlisted' request
 * to PUBLIC would broadcast, to the owner's real professional network,
 * something the caller explicitly asked to keep narrow. Narrowing instead is no
 * better — it would silently drop reach the caller asked for. A visibility we
 * cannot honour exactly is a question for the caller, not a default.
 */
export function linkedinVisibility(visibility: SocialPostRequest['visibility']): 'PUBLIC' | 'CONNECTIONS' {
  switch (visibility) {
    case 'public':
      return 'PUBLIC';
    case 'followers':
      // LinkedIn's CONNECTIONS is "viewable by 1st-degree connections only" —
      // the closest true analogue of a followers-only audience, and narrower
      // than PUBLIC rather than wider, so the mapping cannot over-share.
      return 'CONNECTIONS';
    default:
      throw new LinkedInWriteRefused(
        'visibility-unsupported',
        `LinkedIn posts are either PUBLIC or CONNECTIONS; '${visibility}' has no equivalent, and guessing one would either over-share or silently drop reach`,
      );
  }
}

export interface LinkedInWriteAdapterDeps {
  credential: LinkedInCredential;
  fetch: typeof globalThis.fetch;
  /** Injected so expiry checks are a pure function of inputs. */
  now(): number;
}

/**
 * A LinkedIn write adapter.
 *
 * Returns the plain `SocialWriteAdapter` and NOT `SocialReplyCapableAdapter` —
 * that type is the static claim "this adapter implements reply", and this one
 * truthfully cannot make it.
 */
export function createLinkedInWriteAdapter(deps: LinkedInWriteAdapterDeps): SocialWriteAdapter {
  const { credential, fetch, now } = deps;

  function preflight(): void {
    assertLinkedInCredential(credential);
    if (linkedinTokenExpired(credential, now())) {
      // NOT a transient error, and it must not be retried into. Programmatic
      // refresh is partner-only, so a self-serve token that has expired needs a
      // human browser round-trip; retrying only spends the member's daily
      // budget on calls that cannot succeed.
      throw new LinkedInWriteRefused(
        'token-expired',
        'the access token has expired and LinkedIn grants programmatic refresh only to partners — re-authorisation requires a browser round-trip by the member',
      );
    }
  }

  return {
    platform: 'linkedin',

    async post(request: SocialPostRequest, _context: OutboundContext): Promise<SocialPostOutcome> {
      preflight();

      const text = request.text.trim();
      if (!text) {
        throw new LinkedInWriteRefused('text-required', 'a LinkedIn post carries its text in `commentary`, which cannot be blank');
      }

      const author = linkedinAuthorUrn(credential.memberId);
      const visibility = linkedinVisibility(request.visibility);

      let response: Response;
      try {
        response = await fetch(LINKEDIN_POSTS_URL, {
          method: 'POST',
          headers: linkedinRestHeaders(credential),
          body: JSON.stringify({
            author,
            commentary: text,
            visibility,
            distribution: {
              feedDistribution: 'MAIN_FEED',
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: 'PUBLISHED',
            isReshareDisabledByAuthor: false,
          }),
        });
      } catch (cause) {
        // A transport failure says nothing about whether LinkedIn processed the
        // request. With no idempotency key, this is unconfirmed — never a
        // retryable failure.
        throw new LinkedInWriteUnconfirmed(
          'post',
          `the request failed before a response was read (${cause instanceof Error ? cause.message : String(cause)}), so it is unknown whether the post was published`,
        );
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        if (response.status === LINKEDIN_THROTTLE_STATUS) {
          // A 429 means the call was REFUSED, so nothing was published and this
          // is safely a failure rather than an ambiguity. It is still not
          // auto-retried: LinkedIn publishes no quota header, so the adapter
          // cannot know how much budget remains, and retrying into a throttle
          // is what deepens it.
          throw new LinkedInWriteRefused(
            'throttled',
            `LinkedIn returned 429; the member allowance is 150 requests/day resetting midnight UTC and no response header reports remaining quota${detail}`,
          );
        }
        if (!linkedinCreateRetryable(response.status)) {
          // Covers the vendor's own retry advice (409/500/503). A 5xx in
          // particular may well have published the post before failing to say
          // so, which is exactly why it is unconfirmed rather than failed.
          if (response.status >= 500 || response.status === 409) {
            throw new LinkedInWriteUnconfirmed(
              'post',
              `LinkedIn returned ${response.status} and documents retrying it, but post creation has no idempotency key — a retry would risk publishing a second post${detail}`,
            );
          }
        }
        throw new LinkedInWriteRefused('rejected', `LinkedIn returned ${response.status}${detail}`);
      }

      const externalId = linkedinCreatedId(response.headers as unknown as Iterable<[string, string]>);
      if (!externalId) {
        // 2xx with no id header: the post may well exist, and we cannot look it
        // up (the read scope is restricted). Ambiguous by construction.
        throw new LinkedInWriteUnconfirmed(
          'post',
          'LinkedIn accepted the request but returned no x-restli-id header, and the read scope needed to look the post up is restricted to approved developers',
        );
      }

      return {
        externalId,
        ref: `linkedin:${externalId}`,
        // Built from the URN LinkedIn issued. The feed permalink form is the one
        // the docs give for a published UGC post.
        url: `https://www.linkedin.com/feed/update/${externalId}/`,
      };
    },

    async delete(request: SocialDeleteRequest, _context: OutboundContext): Promise<SocialDeleteOutcome> {
      preflight();

      if (request.target.platform !== 'linkedin') {
        throw new LinkedInWriteRefused(
          'target-mismatch',
          `expected a linkedin target, received '${request.target.platform}'`,
        );
      }
      const postUrn = request.target.postUrn?.trim();
      if (!postUrn) {
        throw new LinkedInWriteRefused('target-missing', 'no post URN on the stored row to delete');
      }

      let response: Response;
      try {
        response = await fetch(`${LINKEDIN_POSTS_URL}/${linkedinEncodeUrn(postUrn)}`, {
          method: 'DELETE',
          headers: { ...linkedinRestHeaders(credential), 'X-RestLi-Method': 'DELETE' },
        });
      } catch (cause) {
        // Unlike a create, this one IS safe to retry — deletes are idempotent —
        // but the adapter still does not silently claim success.
        throw new LinkedInWriteUnconfirmed(
          'delete',
          `the request failed before a response was read (${cause instanceof Error ? cause.message : String(cause)}); a delete is idempotent so retrying is safe`,
        );
      }

      // 204 is success AND is also what an already-deleted post returns:
      // "Deletion requests for a previously deleted UGC Post will return a 204."
      // The two are indistinguishable, so this reports `deleted: true` for the
      // ACTION having been carried out, and says plainly in `detail` that it
      // cannot claim the post existed beforehand.
      if (response.status === 204 || response.ok) {
        return {
          deleted: true,
          detail:
            'LinkedIn returned 204. Deletes are idempotent there and an already-deleted post returns 204 as well, so this confirms the post is gone but not that this call is what removed it.',
        };
      }

      if (response.status === 404) {
        // A first-class outcome, never a failure: the platform reports nothing
        // to delete.
        return { deleted: false, detail: 'LinkedIn reported no such post (404)' };
      }

      const detail = await readErrorDetail(response);
      if (response.status === LINKEDIN_THROTTLE_STATUS) {
        throw new LinkedInWriteRefused('throttled', `LinkedIn returned 429 on delete${detail}`);
      }
      if (linkedinDeleteRetryable(response.status)) {
        throw new LinkedInWriteUnconfirmed(
          'delete',
          `LinkedIn returned ${response.status}; a delete is idempotent so this may be retried safely${detail}`,
        );
      }
      throw new LinkedInWriteRefused('rejected', `LinkedIn returned ${response.status}${detail}`);
    },
  };
}

/**
 * Read an error body defensively.
 *
 * Never throws and never rejects: it runs only on a path that is ALREADY
 * reporting a failure, so letting a malformed body raise here would replace a
 * precise diagnosis ("LinkedIn returned 403") with an unrelated parse error and
 * lose the status the caller actually needed.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) return '';
    return ` — ${trimmed.slice(0, 500)}`;
  } catch {
    return '';
  }
}
