/**
 * The Bluesky WRITE adapter — the publishing half of P-011.
 *
 * This is the FIRST `SocialWriteAdapter` in the tree, so it sets the shape the
 * Mastodon and Reddit adapters will follow. Three decisions are load-bearing and
 * each comes from a fact read off the lexicons, not from habit:
 *
 * 1. THE DOUBLE-POST GUARD IS OURS. atproto documents no idempotency mechanism
 *    for procedures — no key header, no replay-safe retry. So an ambiguous
 *    timeout followed by a retry would publish a SECOND post to the owner's real
 *    public identity, which (unlike a duplicate email) cannot be quietly
 *    withdrawn. The only lever is the client-suppliable `rkey`: the same rkey
 *    addresses the same record, so a retry collapses onto the original instead
 *    of creating a sibling. `blueskyPostRkey` derives it from content alone.
 *
 * 2. DELETE USES `swapRecord`, AND THAT IS WHAT MAKES ITS ANSWER HONEST.
 *    deleteRecord is documented as "Delete a repository record, OR ENSURE IT
 *    DOESN'T EXIST" — it succeeds whether or not anything was there. A plain
 *    call therefore cannot distinguish "I deleted your post" from "it was
 *    already gone", and `SocialDeleteOutcome` explicitly forbids returning a
 *    success the caller will read as the former. Passing `swapRecord: <cid>`
 *    (compare-and-swap on the record's CID) restores the distinction: it
 *    succeeds only if that exact version was present, and fails `InvalidSwap`
 *    otherwise — which we report as `deleted: false` rather than as an error.
 *
 * 3. `createdAt` IS INJECTED, NOT MINTED HERE. The lexicon has the client
 *    declare it, so a `new Date()` inside would make a retry differ from the
 *    original record — defeating guard 1 at the moment it matters most.
 */
import type {
  SocialDeleteRequest,
  SocialDeleteOutcome,
  SocialPostRequest,
  SocialPostOutcome,
  SocialReplyRequest,
  SocialReplyOutcome,
  SocialReplyCapableAdapter,
} from '../../capability-verbs/social';
// `OutboundContext` is declared in resolve.ts and only IMPORTED by social.ts, so
// it must be taken from its origin rather than re-exported through the verb
// module (TS2459 otherwise — a mistake vitest cannot catch, since it does not
// typecheck).
import type { OutboundContext } from '../../capability-verbs/resolve';
import {
  BlueskyXrpcError,
  blueskyPostRkey,
  buildBlueskyPostRecord,
  type BlueskyCreateRecordOutput,
  type BlueskyStrongRef,
} from './bluesky-adapter';

/** The collection every app.bsky.feed.post record lives in. */
export const BLUESKY_POST_COLLECTION = 'app.bsky.feed.post';

/** Parsed at-uri: at://<repo>/<collection>/<rkey>. */
export interface BlueskyRecordRef {
  repo: string;
  collection: string;
  rkey: string;
}

/**
 * Split an at-uri into the three fields the repo procedures address records by.
 *
 * Strict on purpose: `deleteRecord` addresses a record by (repo, collection,
 * rkey), so a silently-wrong parse here deletes the WRONG record rather than
 * failing. There is no safe partial answer.
 */
export function parseBlueskyRecordUri(uri: string): BlueskyRecordRef {
  const withoutScheme = uri.startsWith('at://') ? uri.slice('at://'.length) : null;
  if (!withoutScheme) throw new Error(`bluesky_uri_not_at_uri:${uri}`);
  const parts = withoutScheme.split('/');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error(`bluesky_uri_malformed:${uri} — expected at://<repo>/<collection>/<rkey>`);
  }
  const [repo, collection, rkey] = parts;
  return { repo, collection, rkey };
}

/** Everything the write adapter needs from the outside world. */
export interface BlueskyWriteAdapterDeps {
  /**
   * Build an authenticated XRPC client for this connected source. Called per
   * write so a short-lived access token is refreshed by the client rather than
   * cached across calls (the spec says access tokens live ~minutes).
   */
  createClient(context: OutboundContext): Promise<BlueskyRepoClient>;
  /**
   * The repo (DID) to publish into, resolved from the connected source.
   * Separate from the client so a test can drive one without the other.
   */
  resolveRepo(context: OutboundContext): Promise<string>;
  /** Injected so a retry reproduces the record byte-for-byte. */
  now?(): Date;
}

/** The two repo procedures this adapter calls, both lexicon-verified. */
export interface BlueskyRepoClient {
  createRecord(input: {
    repo: string;
    collection: string;
    record: Record<string, unknown>;
    rkey?: string;
    validate?: boolean;
    swapCommit?: string;
  }): Promise<BlueskyCreateRecordOutput>;
  deleteRecord(input: {
    repo: string;
    collection: string;
    rkey: string;
    swapRecord?: string;
    swapCommit?: string;
  }): Promise<void>;
}

function publicUrl(repo: string, rkey: string): string {
  return `https://bsky.app/profile/${repo}/post/${rkey}`;
}

/**
 * Build the Bluesky write adapter.
 *
 * A factory rather than a module-level singleton because the credential lives on
 * the connected SOURCE, not on the process — the same running operator can hold
 * two Bluesky accounts, and a singleton would quietly publish to whichever was
 * registered last.
 */
export function createBlueskyWriteAdapter(deps: BlueskyWriteAdapterDeps): SocialReplyCapableAdapter {
  const now = deps.now ?? (() => new Date());

  async function publish(
    context: OutboundContext,
    text: string,
    replyTo: { root: BlueskyStrongRef; parent: BlueskyStrongRef } | null,
  ): Promise<SocialReplyOutcome> {
    const [client, repo] = await Promise.all([deps.createClient(context), deps.resolveRepo(context)]);
    const record = buildBlueskyPostRecord({
      text,
      createdAt: now().toISOString(),
      replyTo,
    });
    // The double-post guard. Derived from content, so the retry of a timed-out
    // call lands on this same record instead of creating a second public post.
    const rkey = blueskyPostRkey({ text, replyTo: replyTo?.parent ?? null });
    const created: BlueskyCreateRecordOutput = await client.createRecord({
      repo,
      collection: BLUESKY_POST_COLLECTION,
      record,
      rkey,
      // Ask the PDS to validate against the lexicon. Cheaper to be refused here
      // than to publish a malformed record that renders wrong in every client.
      validate: true,
    });
    return {
      externalId: created.uri,
      ref: `bluesky:${created.uri}`,
      url: publicUrl(repo, rkey),
    };
  }

  return {
    platform: 'bluesky',

    async reply(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome> {
      if (request.target.platform !== 'bluesky') {
        throw new Error(`bluesky_adapter_wrong_target:${request.target.platform}`);
      }
      const { rootUri, rootCid, parentUri, parentCid } = request.target;
      return publish(context, request.text, {
        // BOTH refs are required by the lexicon; sending parent alone produces a
        // reply that is not threaded to its root.
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      });
    },

    async post(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome> {
      return publish(context, request.text, null);
    },

    async delete(request: SocialDeleteRequest, context: OutboundContext): Promise<SocialDeleteOutcome> {
      if (request.target.platform !== 'bluesky') {
        throw new Error(`bluesky_adapter_wrong_target:${request.target.platform}`);
      }
      const client = await deps.createClient(context);
      // `parent*` on the resolved coordinates IS the post being addressed.
      const { parentUri, parentCid } = request.target;
      const ref = parseBlueskyRecordUri(parentUri);

      try {
        await client.deleteRecord({
          repo: ref.repo,
          collection: ref.collection,
          rkey: ref.rkey,
          // Without this, deleteRecord's "or ensure it doesn't exist" semantics
          // make success meaningless — see the header note.
          swapRecord: parentCid,
        });
        return { deleted: true };
      } catch (error) {
        if (error instanceof BlueskyXrpcError && error.error === 'InvalidSwap') {
          // NOT a failure: the CAS says the record is not there in the version we
          // were asked to remove. Reporting `deleted:false` is how the contract
          // says "nothing there to delete" without claiming a deletion.
          return {
            deleted: false,
            detail:
              'the record was not present at the CID we were asked to delete — it was already removed, or edited since it was read',
          };
        }
        throw error;
      }
    },
  };
}
