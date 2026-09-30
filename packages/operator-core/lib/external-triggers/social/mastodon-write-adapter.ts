/**
 * The Mastodon WRITE adapter — the publishing half of P-012.
 *
 * Bluesky set the shape (P-011); this one shows which parts of that shape were
 * PLATFORM-SPECIFIC rather than general. Three differences are load-bearing, and
 * each comes from a fact read off docs.joinmastodon.org on 2026-08-23:
 *
 * 1. THE DOUBLE-POST GUARD IS THE PLATFORM'S, NOT OURS. POST /api/v1/statuses
 *    documents an `Idempotency-Key` header — "provide this header with any
 *    arbitrary string to prevent duplicate submissions of the same status",
 *    retained "for up to 1 hour". So the derived-rkey machinery Bluesky needed
 *    is not merely unnecessary here, it would be WRONG: `SocialReplyRequest`
 *    already carries a derived `idempotencyKey`, and the adapter's whole job is
 *    to pass it through unmodified. Deriving a second key locally would produce
 *    a key that differs between an attempt and its retry — the exact failure the
 *    header exists to prevent.
 *
 * 2. THE INSTANCE HOST IS A SAFETY RAIL, NOT A PARAMETER. Mastodon is
 *    federated: the credential is scoped to ONE instance, and the reply target
 *    carries its own `instanceHost` derived from the stored status. If those
 *    disagree, the post is about to go to the wrong server — either refused, or
 *    (worse) published to an instance the owner did not mean to post from. This
 *    adapter refuses BEFORE the request. Bluesky needed no equivalent because it
 *    has one host.
 *
 * 3. DELETE CANNOT TELL "ALREADY GONE" FROM "NOT YOURS" — AND HAS NO CAS TO FIX
 *    IT. DELETE /api/v1/statuses/:id returns 404 for BOTH "status is not owned
 *    by you" and "does not exist"; the docs are explicit that the two collapse
 *    into the same response. Bluesky solved its version of this with
 *    `swapRecord` (compare-and-swap); Mastodon offers no such mechanism, so the
 *    disambiguation has to happen BEFORE the delete. See `delete` below.
 */
import type {
  SocialDeleteRequest,
  SocialDeleteOutcome,
  SocialPostRequest,
  SocialPostOutcome,
  SocialReplyRequest,
  SocialReplyOutcome,
  SocialVisibility,
  SocialReplyCapableAdapter,
} from '../../capability-verbs/social';
// Declared in resolve.ts and only IMPORTED by social.ts, so it must be taken
// from its origin rather than re-exported through the verb module (TS2459).
import type { OutboundContext } from '../../capability-verbs/resolve';
import type { MastodonVisibility } from './mastodon-adapter';

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Neutral audience ladder → Mastodon's native `visibility`.
 *
 * THE ONE THAT MATTERS IS `followers` → `private`. Mastodon's label for
 * followers-only is "private", which reads like the neutral ladder's narrowest
 * rung but is its SECOND-narrowest. An adapter that pattern-matched on the word
 * would map `followers` to `direct` (over-narrow, merely broken) or — far worse
 * — fail to find a match and fall through to `public`, which republishes a
 * followers-only thread to the whole network. That is an unretractable
 * disclosure, so this is an exhaustive switch with no default arm: a new rung on
 * the neutral ladder becomes a COMPILE error here rather than a silent
 * widening.
 *
 * Mastodon is the first platform where this mapping is non-trivial — Bluesky and
 * Reddit have no per-post audience at all, which is why the reverse direction
 * (`normalizeSocialVisibility`) could treat an absent value as `public` safely
 * and this direction cannot.
 */
export function mastodonNativeVisibility(visibility: SocialVisibility): MastodonVisibility {
  switch (visibility) {
    case 'public':
      return 'public';
    case 'unlisted':
      return 'unlisted';
    case 'followers':
      return 'private';
    case 'direct':
      return 'direct';
  }
}

/* -------------------------------------------------------------------------- */
/* Provider port                                                              */
/* -------------------------------------------------------------------------- */

/** The status fields the write path reads back after publishing. */
export interface MastodonStatusRef {
  id: string;
  uri: string;
  url?: string | null;
  /** Account.acct of the author — the domain-qualified handle. */
  accountAcct: string;
}

export interface MastodonCreateStatusInput {
  status: string;
  visibility: MastodonVisibility;
  inReplyToId?: string | null;
  /**
   * Sent as the `Idempotency-Key` HEADER, not a form field.
   *
   * Typed as required rather than optional so an adapter cannot forget it: on
   * this platform, omitting it is what turns a network retry into a second
   * public post.
   */
  idempotencyKey: string;
}

export interface MastodonWriteClient {
  /** POST /api/v1/statuses */
  createStatus(input: MastodonCreateStatusInput): Promise<MastodonStatusRef>;
  /** GET /api/v1/statuses/:id — resolves to null on a 404. */
  fetchStatus(id: string): Promise<MastodonStatusRef | null>;
  /** DELETE /api/v1/statuses/:id — resolves false on a 404. */
  deleteStatus(id: string): Promise<boolean>;
}

export interface MastodonWriteAdapterDeps {
  /**
   * Build an authenticated client for this connected source.
   *
   * Takes the instance host explicitly so the caller cannot accidentally build a
   * client for one instance and address a status on another — the rail in
   * `assertSameInstance` runs first, and this signature is what makes that
   * ordering structural rather than conventional.
   */
  createClient(context: OutboundContext, instanceHost: string): Promise<MastodonWriteClient>;
  /** The connected account's `acct` on this instance, for the delete ownership check. */
  resolveSelfAcct(context: OutboundContext, instanceHost: string): Promise<string>;
  /** The instance this connection's credential is scoped to. */
  resolveInstanceHost(context: OutboundContext): Promise<string>;
}

/** Raised when a write would cross instances. Never downgraded to a warning. */
export class MastodonInstanceMismatch extends Error {
  readonly credentialHost: string;
  readonly targetHost: string;
  constructor(credentialHost: string, targetHost: string) {
    super(
      `mastodon_instance_mismatch: this connection is authenticated to '${credentialHost}' but the target status lives on '${targetHost}'. ` +
        `Mastodon credentials are per-instance — connect the '${targetHost}' account to act on it.`,
    );
    this.name = 'MastodonInstanceMismatch';
    this.credentialHost = credentialHost;
    this.targetHost = targetHost;
  }
}

/** Raised when a delete addresses a status the connected account does not own. */
export class MastodonNotOurStatus extends Error {
  readonly statusId: string;
  readonly owner: string;
  readonly self: string;
  constructor(statusId: string, owner: string, self: string) {
    super(
      `mastodon_delete_not_ours: status ${statusId} belongs to '${owner}', not '${self}'. ` +
        `Refusing rather than reporting it as 'nothing to delete' — the platform returns the same 404 for both.`,
    );
    this.name = 'MastodonNotOurStatus';
    this.statusId = statusId;
    this.owner = owner;
    this.self = self;
  }
}

/** Normalize a host for comparison: case-insensitive, no scheme, no trailing slash. */
export function normalizeInstanceHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function assertSameInstance(credentialHost: string, targetHost: string): void {
  if (normalizeInstanceHost(credentialHost) !== normalizeInstanceHost(targetHost)) {
    throw new MastodonInstanceMismatch(credentialHost, targetHost);
  }
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the Mastodon write adapter.
 *
 * A factory for the same reason Bluesky's is: the credential lives on the
 * connected SOURCE, and here that is doubly true — the same operator may hold
 * accounts on several instances, and a module-level singleton would publish to
 * whichever was registered last.
 */
export function createMastodonWriteAdapter(deps: MastodonWriteAdapterDeps): SocialReplyCapableAdapter {
  async function bind(context: OutboundContext, targetHost: string): Promise<MastodonWriteClient> {
    const credentialHost = await deps.resolveInstanceHost(context);
    // Rail 2 — runs before any client is built, so a cross-instance write
    // cannot be issued even by a client that was constructed carelessly.
    assertSameInstance(credentialHost, targetHost);
    return deps.createClient(context, credentialHost);
  }

  return {
    platform: 'mastodon',

    async reply(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome> {
      if (request.target.platform !== 'mastodon') {
        throw new Error(`mastodon_adapter_wrong_target:${request.target.platform}`);
      }
      const { inReplyToId, instanceHost } = request.target;
      const client = await bind(context, instanceHost);
      const created = await client.createStatus({
        status: request.text,
        visibility: mastodonNativeVisibility(request.visibility),
        inReplyToId,
        // Passed through, never re-derived — see note 1 in the header.
        idempotencyKey: request.idempotencyKey,
      });
      return {
        externalId: created.uri,
        ref: `mastodon:${created.uri}`,
        ...(created.url ? { url: created.url } : {}),
      };
    },

    async post(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome> {
      // For a create, `destination` names the instance to publish from — there
      // is no platform-wide default, so it is required rather than optional.
      const client = await bind(context, request.destination);
      const created = await client.createStatus({
        status: request.text,
        visibility: mastodonNativeVisibility(request.visibility),
        inReplyToId: null,
        idempotencyKey: request.idempotencyKey,
      });
      return {
        externalId: created.uri,
        ref: `mastodon:${created.uri}`,
        ...(created.url ? { url: created.url } : {}),
      };
    },

    /**
     * Delete a status, having first established WHOSE it is.
     *
     * THE PROBLEM. `DELETE /api/v1/statuses/:id` answers 404 for both "status is
     * not owned by you" and "does not exist" — the docs state plainly that the
     * two conditions collapse and cannot be told apart from the response. The
     * naive adapter maps that 404 to `deleted: false` and is WRONG in a way that
     * matters: `deleted:false` is defined as "the platform reported nothing to
     * delete", so an attempt to delete SOMEONE ELSE'S post gets reported to the
     * caller as a benign no-op. The caller then believes the post is gone. It is
     * not; it was never ours to remove.
     *
     * THE FIX. Read the status first. That converts the ambiguity into two
     * decidable cases before the destructive call is made:
     *   - absent           → genuinely nothing there    → deleted:false
     *   - present, not ours → an authorization failure   → THROW, never false
     *   - present, ours     → delete it
     *
     * The read-then-delete window is not atomic and does not need to be: the
     * only thing that can happen inside it is the status disappearing, which
     * lands in the 404 branch below and is reported as `deleted:false` — the
     * honest answer for that case anyway. The race is benign in exactly one
     * direction, which is what makes a non-atomic check sufficient here.
     */
    async delete(request: SocialDeleteRequest, context: OutboundContext): Promise<SocialDeleteOutcome> {
      if (request.target.platform !== 'mastodon') {
        throw new Error(`mastodon_adapter_wrong_target:${request.target.platform}`);
      }
      const { inReplyToId: statusId, instanceHost } = request.target;
      const client = await bind(context, instanceHost);
      const self = await deps.resolveSelfAcct(context, instanceHost);

      const existing = await client.fetchStatus(statusId);
      if (!existing) {
        return {
          deleted: false,
          detail: 'the status was not found on this instance — it was already removed, or never existed',
        };
      }
      if (normalizeInstanceHost(existing.accountAcct) !== normalizeInstanceHost(self)) {
        // Deliberately NOT `deleted:false`. See the method note.
        throw new MastodonNotOurStatus(statusId, existing.accountAcct, self);
      }

      const removed = await client.deleteStatus(statusId);
      if (!removed) {
        return {
          deleted: false,
          detail: 'the status disappeared between the ownership check and the delete — it is gone either way',
        };
      }
      return { deleted: true };
    },
  };
}
