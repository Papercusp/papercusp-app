/**
 * The Reddit WRITE adapter — the publishing half of P-013, and the THIRD
 * `SocialWriteAdapter` in the tree.
 *
 * THE REGISTRY ROW WAS WRONG, AND THE CORRECTION IS THIS FILE'S SHAPE. P-001
 * recorded `idempotency: 'none'` with the note "No documented idempotency
 * mechanism, so the adapter must carry its own write-dedupe guard." Read against
 * the writer (reddit-archive/reddit `r2/r2/controllers/api.py`, 2026-08-23) that
 * is false for two of the three verbs, and the differences are load-bearing:
 *
 *   - `reply`  → POST /api/comment. NO duplicate suppression of any kind. The
 *     guard is entirely ours. (Scope: `submit` for a Link or Comment parent —
 *     the docstring makes the required scope depend on the PARENT'S TYPE, with
 *     a Message parent needing `privatemessages` instead. This adapter replies
 *     to content, never to messages, so it asserts a `t1_`/`t3_` parent rather
 *     than silently sending a private message under a content scope.)
 *
 *   - `post`   → POST /api/submit. For a LINK submission reddit has a real,
 *     server-side, DEFAULT-ON duplicate check: "If a link with the same URL has
 *     already been submitted to the specified subreddit an error will be
 *     returned unless `resubmit` is true." That is a genuine idempotency
 *     mechanism the row denied existed. It does NOT cover self-posts, which have
 *     no equivalent — so the guard is ours for `self` and belt-and-braces for
 *     `link`. Critically, the duplicate error is a SUCCESS-EQUIVALENT for a
 *     retry, not a failure to retry harder against.
 *
 *   - `delete` → POST /api/del. IDEMPOTENT BY CONSTRUCTION: the handler reads
 *     `was_deleted = thing._deleted`, sets `_deleted = True`, commits, and
 *     returns early on a thing that does not resolve at all. Re-deleting is a
 *     no-op that still succeeds, so no guard is needed. What it CANNOT do is
 *     tell you whether anything was there — it is `@noresponse`, so the reply
 *     body is empty either way. See `delete` below for why that forces a
 *     pre-check rather than a cheerful `deleted: true`.
 *
 * The platform-scalar `write.idempotency` cannot express any of that, because
 * idempotency here is a PER-VERB property. The row keeps the scalar at its
 * weakest verb's value (`'none'`, which is safe: it over-guards `delete` rather
 * than under-guarding `reply`) and the per-verb truth is recorded in D-016 and
 * enforced here.
 */
import type {
  SocialDeleteOutcome,
  SocialDeleteRequest,
  SocialPostOutcome,
  SocialPostRequest,
  SocialReplyOutcome,
  SocialReplyRequest,
  SocialReplyCapableAdapter,
} from '../../capability-verbs/social';
// `OutboundContext` is declared in resolve.ts and only IMPORTED by social.ts, so
// it must be taken from its origin rather than re-exported through the verb
// module (TS2459 otherwise — a mistake vitest cannot catch, since it does not
// typecheck).
import type { OutboundContext } from '../../capability-verbs/resolve';
import { REDDIT_FULLNAME_PATTERN } from './reddit-adapter';

/* -------------------------------------------------------------------------- */
/* Provider surface                                                           */
/* -------------------------------------------------------------------------- */

/** What POST /api/comment returns, reduced to what the seam needs. */
export interface RedditCommentResult {
  /** Fullname of the created comment, e.g. `t1_abc123`. */
  name: string;
  permalink?: string;
}

export interface RedditSubmitResult {
  /** Fullname of the created link, e.g. `t3_abc123`. */
  name: string;
  url?: string;
}

/** A thing as /api/info reports it — enough to tell present from deleted. */
export interface RedditThingState {
  name: string;
  /** reddit rewrites a removed author to `[deleted]`. */
  author: string;
  /** Some responses expose it directly; absence is not evidence of presence. */
  removed?: boolean;
}

/**
 * The duplicate-submission refusal, raised by the client when reddit rejects a
 * link submission whose URL is already in that subreddit.
 *
 * Modelled as its own error rather than a generic failure because the CORRECT
 * response to it is to stop and report success-equivalence, and the natural
 * response to an unrecognised error is to retry — which here would loop
 * forever against a refusal that will never change.
 */
export class RedditDuplicateSubmission extends Error {
  /** Fullname of the existing submission, when reddit names it. */
  readonly existing: string | null;

  constructor(message: string, existing: string | null = null) {
    super(message);
    this.name = 'RedditDuplicateSubmission';
    this.existing = existing;
  }
}

export interface RedditWriteClient {
  /** POST /api/comment — `thingId` is the parent's fullname. */
  comment(params: { thingId: string; text: string }): Promise<RedditCommentResult>;
  /**
   * POST /api/submit.
   *
   * `resubmit` is passed explicitly and is always FALSE for a link, so reddit's
   * own default-on duplicate check stays armed. A client that hardcodes
   * `resubmit: true` disables the one native mechanism this platform has.
   */
  submit(params: {
    sr: string;
    kind: 'link' | 'self';
    title: string;
    text?: string;
    url?: string;
    resubmit: boolean;
  }): Promise<RedditSubmitResult>;
  /** POST /api/del — returns nothing on success, by design. */
  del(params: { id: string }): Promise<void>;
  /**
   * GET /api/info — optional, and the reason `delete` can answer honestly.
   *
   * Optional because a client may not have been granted `read`. When it is
   * absent the adapter says so rather than guessing; see `delete`.
   */
  info?(fullnames: string[]): Promise<RedditThingState[]>;
}

export interface RedditWriteAdapterDeps {
  /**
   * Build an authenticated client for this connected source. Called per write
   * so a short-lived bearer is refreshed by the client rather than cached
   * across calls — reddit's access tokens expire after one hour.
   */
  createClient(context: OutboundContext): Promise<RedditWriteClient>;
}

/* -------------------------------------------------------------------------- */
/* Destination parsing                                                        */
/* -------------------------------------------------------------------------- */

export interface RedditDestination {
  subreddit: string;
  title: string;
}

/**
 * Split a `reddit:` destination into a subreddit and a title.
 *
 * Reddit is the first Wave A platform where a post REQUIRES a title — bluesky
 * and mastodon have no such field — so the destination has to carry one. The
 * form is `r/<subreddit>#<title>`; a missing title is refused rather than
 * defaulted, because a submission's title is the part a human reads and an
 * adapter-invented one would be published under the owner's real name.
 */
export function parseRedditDestination(destination: string): RedditDestination {
  const withoutPlatform = destination.startsWith('reddit:') ? destination.slice('reddit:'.length) : destination;
  const hash = withoutPlatform.indexOf('#');
  if (hash <= 0) {
    throw new Error(
      `reddit_destination_malformed:${JSON.stringify(destination.slice(0, 64))} — expected "r/<subreddit>#<title>". ` +
        `A reddit submission requires a title and this adapter will not invent one.`,
    );
  }
  const raw = withoutPlatform.slice(0, hash);
  const title = withoutPlatform.slice(hash + 1).trim();
  const subreddit = raw.replace(/^\/?r\//, '').trim();
  if (!subreddit || !title) {
    throw new Error(
      `reddit_destination_malformed:${JSON.stringify(destination.slice(0, 64))} — expected "r/<subreddit>#<title>".`,
    );
  }
  return { subreddit, title };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

function redditPermalinkUrl(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  return permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
}

/**
 * Build the Reddit write adapter.
 *
 * A FACTORY over a client port, not a module-load registration, for the same
 * reason Bluesky's is: the credential lives on the connected SOURCE, so there is
 * nothing to register until an owner has connected an account.
 */
export function createRedditWriteAdapter(deps: RedditWriteAdapterDeps): SocialReplyCapableAdapter {
  /**
   * THE DOUBLE-POST GUARD.
   *
   * Reddit gives `reply` nothing at all — no key header, no client-chosen id,
   * no server-side duplicate check — so a retry after an ambiguous timeout
   * publishes a SECOND comment under the owner's real identity. Unlike a
   * duplicate email that cannot be quietly withdrawn.
   *
   * Two levels, because a retry arrives in two shapes:
   *   - CONCURRENT (the caller fired again before the first settled) → the
   *     in-flight promise is returned, so only one request is ever sent.
   *   - SEQUENTIAL (the first settled, the caller retried anyway) → the
   *     recorded outcome is replayed without a second write.
   *
   * Scope is honestly bounded: this is per-adapter-instance, so it collapses
   * the retry window that actually exists (seconds, same process) and NOT a
   * duplicate across a restart. Reddit exposes no mechanism that could; saying
   * so here is better than implying a durability this cannot have.
   */
  const settled = new Map<string, SocialReplyOutcome>();
  const inflight = new Map<string, Promise<SocialReplyOutcome>>();

  function once(key: string, work: () => Promise<SocialReplyOutcome>): Promise<SocialReplyOutcome> {
    const done = settled.get(key);
    if (done) return Promise.resolve(done);
    const running = inflight.get(key);
    if (running) return running;
    const started = work()
      .then((outcome) => {
        settled.set(key, outcome);
        return outcome;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, started);
    return started;
  }

  return {
    platform: 'reddit',

    async reply(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome> {
      if (request.target.platform !== 'reddit') {
        throw new Error(`reddit_write_target_mismatch:${request.target.platform}`);
      }
      const parent = request.target.parentFullname;
      if (!REDDIT_FULLNAME_PATTERN.test(parent)) {
        throw new Error(`reddit_reply_parent_malformed:${JSON.stringify(parent.slice(0, 32))}`);
      }
      // POST /api/comment routes on the PARENT'S TYPE: a `t4_` message parent
      // creates a private message and needs `privatemessages` scope. Replying to
      // content must never silently become sending a DM, so the kinds this
      // adapter accepts are named rather than assumed.
      const kind = parent.slice(0, parent.indexOf('_'));
      if (kind !== 't1' && kind !== 't3') {
        throw new Error(
          `reddit_reply_parent_kind_unsupported:${kind} — /api/comment creates a PRIVATE MESSAGE for a t4_ parent, ` +
            `under a different scope. This adapter replies to content (t1_/t3_) only.`,
        );
      }

      return once(request.idempotencyKey, async () => {
        const client = await deps.createClient(context);
        const created = await client.comment({ thingId: parent, text: request.text });
        return {
          externalId: created.name,
          ref: `reddit:${created.name}`,
          url: redditPermalinkUrl(created.permalink),
        };
      });
    },

    async post(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome> {
      const { subreddit, title } = parseRedditDestination(request.destination);

      return once(request.idempotencyKey, async () => {
        const client = await deps.createClient(context);
        try {
          // `kind: 'self'` — this seam publishes text. `resubmit: false` keeps
          // reddit's native duplicate check armed for the link path a future
          // caller may take; it is inert for a self-post, which is exactly the
          // asymmetry D-016 records.
          const created = await client.submit({
            sr: subreddit,
            kind: 'self',
            title,
            text: request.text,
            resubmit: false,
          });
          return {
            externalId: created.name,
            ref: `reddit:${created.name}`,
            url: created.url,
          };
        } catch (error) {
          if (error instanceof RedditDuplicateSubmission && error.existing) {
            // The native mechanism firing is a SUCCESS-EQUIVALENT for a retry:
            // the content is already published, and the existing submission is
            // the right thing to hand back. Retrying here would loop against a
            // refusal that can never change.
            return {
              externalId: error.existing,
              ref: `reddit:${error.existing}`,
            };
          }
          throw error;
        }
      });
    },

    async delete(request: SocialDeleteRequest, context: OutboundContext): Promise<SocialDeleteOutcome> {
      if (request.target.platform !== 'reddit') {
        throw new Error(`reddit_write_target_mismatch:${request.target.platform}`);
      }
      const fullname = request.target.parentFullname;
      const client = await deps.createClient(context);

      // WHY THIS PRE-CHECKS RATHER THAN REPORTING SUCCESS.
      //
      // POST /api/del is `@noresponse`: an empty body whether it deleted
      // something, deleted something already deleted, or resolved nothing at
      // all (`if not thing: return`). So the call itself can never distinguish
      // "I deleted your post" from "it was already gone" — and
      // `SocialDeleteOutcome` explicitly forbids returning a success the caller
      // will read as the former.
      //
      // /api/info restores the distinction, and reddit's own API rules prefer a
      // batch lookup to single-resource calls, so this is the endpoint they
      // point at. Without it the honest answer is `deleted: false` WITH a
      // reason — under-claiming, which is the safe direction: the contract's
      // consumer carries the flag through untouched rather than raising it.
      if (!client.info) {
        await client.del({ id: fullname });
        return {
          deleted: false,
          detail:
            'reddit /api/del returns an empty body whether or not anything was removed, and this client has no ' +
            '/api/info lookup to confirm with — so the delete was issued but cannot be attested.',
        };
      }

      const [before] = await client.info([fullname]);
      if (!before || before.author === '[deleted]' || before.removed === true) {
        return { deleted: false, detail: 'nothing was there to delete' };
      }

      await client.del({ id: fullname });
      return { deleted: true };
    },
  };
}
