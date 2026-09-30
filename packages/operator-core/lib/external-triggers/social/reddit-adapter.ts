/**
 * The Reddit adapter — P-013, the third and last Wave A adapter.
 *
 * WHY THIS ONE IS THIRD, AND WHAT IT PROVES. Bluesky has a stream with a
 * replayable sequence number; Mastodon has a stream that cannot replay at all.
 * Reddit has NO STREAM. Reading IS the poll, which is the `poll-cursor` replay
 * class D-005 named. If the P-003 contract survives a platform with no stream to
 * reconcile against, the contract is about reconciliation rather than about
 * streams — which is the claim P-003 makes and this file is the third witness
 * to.
 *
 * FACTS THIS FILE ENCODES, read on 2026-08-23 from the reddit-archive source and
 * the official archived API wiki — from the WRITER, not from the registry row
 * and not from recall. The registry row is an artifact; two of its claims did
 * not survive contact with the source (see `reddit-write-adapter.ts`).
 *
 *   - `ListingController.build_listing(self, num, after, reverse, count, ...)`
 *     takes NO `before` parameter. `before` is `after` + `reverse=True`. Both
 *     directions therefore anchor on a fullname; only the walk direction differs.
 *   - `VLimit(param, default=25, max_limit=100)` clamps as
 *     `min(max(i, 1), self.max_limit)`. A gap larger than one page REQUIRES
 *     pagination — the reason the walk below exists.
 *   - `VCount` is `max(int(count), 0)` and is display-only: it does not select
 *     items, so it is deliberately absent from the port.
 *   - A Listing's `after`/`before` are documented as "the fullname of the
 *     listing that follows after/before this page", `null` at the ends.
 *   - `edited` is a THREE-valued field, not a boolean and not a timestamp:
 *     "`false` if not edited, edit date in UTC epoch-seconds otherwise", plus a
 *     documented NOTE that some old edited comments carry `true` instead of a
 *     date. `redditEditedMarker` is the only place that union is interpreted.
 *   - OAuth2 clients may make up to 60 requests/minute; `X-Ratelimit-Reset` is
 *     the "approximate number of seconds to end of period".
 *   - The User-Agent format is MANDATORY and must not be falsified. See
 *     `assertRedditUserAgent`.
 */
import type {
  SocialAdapter,
  SocialNormalizedEvent,
  SocialReconcileContext,
  SocialReconcilePath,
  SocialReconcileResult,
} from './adapter-contract';

/* -------------------------------------------------------------------------- */
/* The paging trap this adapter exists to avoid                               */
/* -------------------------------------------------------------------------- */

/**
 * WHY THE WALK STARTS AT THE TOP AND GOES OLDER, RATHER THAN ANCHORING ON THE
 * STORED MARKER.
 *
 * Both directions are available and both look correct. The rejected design is
 * `before=<stored marker>`, which returns the items immediately NEWER than the
 * marker and walks forward. It fails on the case that actually happens:
 *
 *   A stored marker names a post. Posts get deleted. When the anchor fullname
 *   no longer resolves, `VByName.run` falls through to
 *   `set_error(errors.NO_THING_ID)`, the parameter becomes None, and the
 *   listing quietly returns PAGE 1 — the newest items — as though no anchor had
 *   been supplied. The adapter cannot see that from the response.
 *
 * That is survivable (it re-emits rather than losing, and `dedupeKey` collapses
 * the repeat) but it means the adapter's own report of WHICH PATH it took would
 * be a guess, and `path` is the one field the contract exists to make
 * assertable. An adapter that cannot tell replay from backfill cannot honestly
 * fill it in.
 *
 * Walking from the TOP with `after` never anchors on the marker at all. The
 * marker is used only as a STOP CONDITION — an equality test against fullnames
 * we read — so a deleted marker degrades to "walked the bounded window and
 * never found it", which is precisely `backfill` / `cursor-expired` and is
 * reported as such. The failure mode becomes visible instead of silent, which
 * is the whole point of D-005.
 *
 * It also collapses cold-start and gap-close into ONE walk with one stop
 * condition, and it matches what P-001 recorded in the registry row: "a gap is
 * closed by walking the listing cursor backwards to the stored marker".
 */
export const WALK_FROM_TOP_NOT_BEFORE_ANCHOR =
  'Reddit ingest walks from the top of the listing with `after` and uses the stored marker only as a ' +
  'stop condition. It never passes the marker as a `before` anchor: an unresolvable anchor is silently ' +
  'dropped by VByName and the listing returns page 1, which would make `path` a guess.';

/**
 * `VLimit`, mirrored exactly: `min(max(i, 1), 100)`, defaulting to 25.
 *
 * Mirrored rather than assumed because the clamp is what makes an
 * over-large page size SILENTLY become 100 rather than an error — an adapter
 * that asked for 500 and reasoned about "did I get a full page?" against 500
 * would conclude the listing was exhausted on every single call.
 */
export const REDDIT_LIMIT_DEFAULT = 25;
export const REDDIT_LIMIT_MAX = 100;

export function clampRedditLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined || !Number.isFinite(limit)) return REDDIT_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), REDDIT_LIMIT_MAX);
}

/* -------------------------------------------------------------------------- */
/* User-Agent — a policy requirement, enforced structurally                   */
/* -------------------------------------------------------------------------- */

/**
 * `<platform>:<app ID>:<version> (by /u/<username>)`.
 *
 * This is enforced here rather than left to the HTTP client because the rule is
 * not a style preference: reddit's API rules state that many default
 * User-Agents "are drastically limited", that the version must be real so old
 * broken clients can be blocked, and — in bold — "NEVER lie about your
 * user-agent... We will ban liars with extreme prejudice."
 *
 * A malformed or generic agent therefore does not degrade gracefully; it earns
 * a throttle that presents as unexplained slowness much later, far from the
 * cause. Validating at construction turns that into an immediate, local error.
 */
export const REDDIT_USER_AGENT_PATTERN = /^[a-z0-9.-]+:[A-Za-z0-9._-]+:v?[A-Za-z0-9._-]+ \(by \/u\/[A-Za-z0-9_-]{3,20}\)$/;

export function assertRedditUserAgent(userAgent: string): string {
  if (!REDDIT_USER_AGENT_PATTERN.test(userAgent)) {
    throw new Error(
      `reddit_user_agent_invalid: expected "<platform>:<app ID>:<version> (by /u/<username>)", got ` +
        `${JSON.stringify(userAgent.slice(0, 80))}. Reddit's API rules make this format mandatory and forbid ` +
        `falsifying it; a generic agent is heavily throttled rather than rejected, so the failure would ` +
        `otherwise surface as unexplained slowness far from its cause.`,
    );
  }
  return userAgent;
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The persisted cursor.
 *
 * ONE FIELD, ONE MEANING. `newestFullname` is the marker to stop at on the next
 * pass. It is deliberately NOT also the walk-continuation signal — that is
 * "the page came back full", a separate local fact. P-012 shipped an interface
 * where one field carried both meanings; they agree on every page except the
 * last, which is exactly the page where being wrong re-emits forever.
 */
export interface RedditCursor {
  /** Fullname (t3_… / t1_…) of the newest thing this connection has emitted. */
  newestFullname: string;
}

export function isRedditCursor(value: unknown): value is RedditCursor {
  if (!value || typeof value !== 'object') return false;
  const fullname = (value as { newestFullname?: unknown }).newestFullname;
  return typeof fullname === 'string' && REDDIT_FULLNAME_PATTERN.test(fullname);
}

/** `t1_` comment, `t3_` link — the two kinds this adapter ingests. */
export const REDDIT_FULLNAME_PATTERN = /^t\d_[a-z0-9]+$/i;

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                            */
/* -------------------------------------------------------------------------- */

export type RedditThingKind = 't1' | 't3';

/**
 * `edited` as reddit actually serves it. Modelled as the real union rather than
 * normalized at the port, so the legacy `true` case cannot be quietly coerced
 * to a timestamp by whoever writes the HTTP client.
 */
export type RedditEdited = false | true | number;

export interface RedditRawThing {
  kind: RedditThingKind;
  /** Fullname, e.g. `t3_8xwlg`. The stable provider-side id. */
  name: string;
  /** Base-36 id without the type prefix. */
  id: string;
  author: string;
  subreddit: string;
  /** UTC epoch seconds. Documented as never carrying a fractional part. */
  createdUtc: number;
  edited: RedditEdited;
  /** Links only. */
  title?: string;
  /** Links: `selftext`. Comments: `body`. Already unescaped by the client. */
  text?: string;
  permalink?: string;
  url?: string;
  over18?: boolean;
  /** Comments only — the link this comment belongs to. */
  linkFullname?: string;
}

export interface RedditListingPage {
  /** Newest-first, as reddit serves a listing. */
  children: RedditRawThing[];
  /**
   * The listing's own `after` cursor. Recorded for completeness and for a live
   * attestation run to compare against, but the walk deliberately does not
   * depend on it: the next anchor is derived from the last child, which is
   * observable in the page we already hold.
   */
  after?: string | null;
}

export interface RedditReadClient {
  /**
   * One listing page, newest-first.
   *
   * `after` is the fullname to continue OLDER from, or null for the top of the
   * listing. `limit` is already clamped by `clampRedditLimit`.
   */
  fetchPage(params: { after: string | null; limit: number; signal?: AbortSignal }): Promise<RedditListingPage>;
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

export class RedditRateLimited extends Error {
  /** `X-Ratelimit-Reset`: approximate SECONDS to the end of the current period. */
  readonly resetSeconds: number | null;

  constructor(message: string, resetSeconds: number | null) {
    super(message);
    this.name = 'RedditRateLimited';
    this.resetSeconds = resetSeconds;
  }
}

export const REDDIT_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * How long to wait before retrying, or null when the error is not a rate limit
 * or the budget is exhausted.
 *
 * `X-Ratelimit-Reset` is seconds-to-end-of-period, NOT a timestamp — reading it
 * as an epoch would produce a wait of ~57 years, which presents as a hung
 * adapter rather than an error.
 */
export function redditRetryDelayMs(error: unknown, attempt: number, maxAttempts: number): number | null {
  if (!(error instanceof RedditRateLimited)) return null;
  if (attempt >= maxAttempts) return null;
  const stated = error.resetSeconds;
  if (stated !== null && Number.isFinite(stated) && stated >= 0) {
    return Math.min(Math.ceil(stated * 1000), REDDIT_MAX_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, REDDIT_MAX_RATE_LIMIT_WAIT_MS);
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The version half of the dedupe key.
 *
 * Reddit's `edited` is `false`, an epoch-second number, or — for some old
 * comments only — the boolean `true`. The three cases are NOT interchangeable:
 *
 *   - `false`   → never edited; the creation time is the version.
 *   - number    → the edit time is the version, so an edit yields a new key and
 *                 the changed content is correctly re-delivered.
 *   - `true`    → reddit has lost the edit date. The key stays stable (which the
 *                 contract requires) but is COARSE: a further edit to such a
 *                 legacy comment cannot change it, so that edit will not be
 *                 re-delivered. That is a property of reddit's stored data, not
 *                 something the adapter can recover, and it is recorded here
 *                 rather than papered over with a wall-clock value — which would
 *                 break replay dedupe outright.
 */
export function redditEditedMarker(edited: RedditEdited, createdUtc: number): string {
  if (edited === false) return `c${createdUtc}`;
  if (edited === true) return 'e-legacy';
  return `e${edited}`;
}

export function redditDedupeKey(thing: Pick<RedditRawThing, 'name' | 'edited' | 'createdUtc'>): string {
  return `${thing.name}@${redditEditedMarker(thing.edited, thing.createdUtc)}`;
}

/** Which `ext:reddit:<event>` key this thing normalizes to. */
export function redditEventName(thing: Pick<RedditRawThing, 'kind'>): string {
  return thing.kind === 't1' ? 'comment' : 'post';
}

/**
 * Build the canonical `social-post` payload (D-004).
 *
 * `fullname` and `subreddit` are NOT decoration. `resolveSocialReplyCoordinates`
 * reads exactly those two off the stored document to build a Reddit reply
 * target, and throws when the fullname is missing or malformed — so omitting
 * them would not fail during ingestion, it would fail later at every attempt to
 * reply, against a document that looked perfectly well-formed. The round-trip
 * test in this adapter's suite drives the real derivation over this payload for
 * that reason.
 */
export function normalizeRedditThing(thing: RedditRawThing): SocialNormalizedEvent {
  const occurredAt = new Date(thing.createdUtc * 1000).toISOString();
  const payload: Record<string, unknown> = {
    id: thing.name,
    text: thing.text ?? thing.title ?? '',
    // The two fields the reply seam requires.
    fullname: thing.name,
    subreddit: thing.subreddit,
    author: thing.author,
    occurredAt,
    kind: thing.kind,
  };
  if (thing.title) payload.title = thing.title;
  if (thing.permalink) payload.url = `https://www.reddit.com${thing.permalink}`;
  if (thing.url) payload.linkUrl = thing.url;
  if (thing.over18 !== undefined) payload.over18 = thing.over18;
  if (thing.linkFullname) payload.replyToId = thing.linkFullname;
  if (typeof thing.edited === 'number') payload.editedAt = new Date(thing.edited * 1000).toISOString();

  return {
    externalId: thing.name,
    event: redditEventName(thing),
    occurredAt,
    payload,
    dedupeKey: redditDedupeKey(thing),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface RedditAdapterDeps {
  client: RedditReadClient;
  /**
   * Validated at construction — see `assertRedditUserAgent`. Held so a live
   * client cannot be built without one, even though the adapter never sends it
   * itself.
   */
  userAgent: string;
  /** Items per listing page. Clamped by `clampRedditLimit`. */
  pageSize?: number;
  /** How many pages one reconcile will walk before stopping. */
  maxPages?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RETRIES = 4;

export class RedditAdapter implements SocialAdapter {
  readonly platformId = 'reddit' as const;

  private readonly client: RedditReadClient;
  private readonly userAgent: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: RedditAdapterDeps) {
    this.client = deps.client;
    this.userAgent = assertRedditUserAgent(deps.userAgent);
    this.pageSize = clampRedditLimit(deps.pageSize);
    this.maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Exposed so a live client build can assert it carries the same agent. */
  get requiredUserAgent(): string {
    return this.userAgent;
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const delay = redditRetryDelayMs(error, attempt, this.maxRetries);
        if (delay === null) throw error;
        await this.sleep(delay);
      }
    }
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const stored = isRedditCursor(ctx.cursor) ? ctx.cursor : null;
    const cursorUnreadable = ctx.cursor !== null && stored === null;
    const marker = stored?.newestFullname ?? null;

    const collected: RedditRawThing[] = [];
    let anchor: string | null = null;
    let markerFound = false;
    let pages = 0;

    // ONE walk, from the top, going older. The marker is a stop condition, never
    // an anchor — see WALK_FROM_TOP_NOT_BEFORE_ANCHOR.
    while (pages < this.maxPages) {
      const at = anchor;
      const page: RedditListingPage = await this.withRetry(() =>
        this.client.fetchPage({ after: at, limit: this.pageSize, signal: ctx.signal }),
      );
      pages += 1;

      for (const thing of page.children) {
        if (marker !== null && thing.name === marker) {
          markerFound = true;
          break;
        }
        collected.push(thing);
      }
      if (markerFound) break;

      // "The page came back full" is the walk-continuation signal, and it is a
      // LOCAL fact about this page — deliberately not folded into the cursor.
      if (page.children.length < this.pageSize) break;
      const last = page.children[page.children.length - 1];
      if (!last) break;
      anchor = last.name;
    }

    const emitted = await this.emitAll(collected, ctx);
    const cursor = this.nextCursor(collected, stored);

    const path: SocialReconcilePath =
      marker === null
        ? cursorUnreadable
          ? 'backfill'
          : 'cold-start'
        : markerFound
          ? emitted === 0
            ? 'live-only'
            : 'cursor-replay'
          : 'backfill';

    if (path !== 'backfill') return { cursor, emitted, path };

    // We walked the whole bounded window and never saw the marker — either it
    // was deleted (its fullname no longer appears in the listing at all) or the
    // gap is larger than the window we are willing to walk. Saying so is the
    // difference between a reported backfill and a silent restart-from-live.
    //
    // Both cases are 'cursor-expired', NOT 'cursor-rejected', and the
    // distinction is not pedantic: this walk never sends the marker to reddit,
    // so reddit cannot have rejected it. 'cursor-rejected' would send whoever
    // reads the field looking for a provider error that was never emitted.
    return {
      cursor,
      emitted,
      path,
      backfillReason: cursorUnreadable ? 'cursor-rejected' : 'cursor-expired',
    };
  }

  /**
   * Emit oldest-first, deduped within the pass.
   *
   * The listing is newest-first; bindings want chronological order. The
   * within-pass dedupe matters because a listing can shift under a multi-page
   * walk (a new post arriving mid-walk shifts every page boundary down by one,
   * which re-serves an item already read on the previous page).
   */
  private async emitAll(things: RedditRawThing[], ctx: SocialReconcileContext): Promise<number> {
    const seen = new Set<string>();
    let emitted = 0;
    for (let i = things.length - 1; i >= 0; i -= 1) {
      const thing = things[i]!;
      const key = redditDedupeKey(thing);
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.emit(normalizeRedditThing(thing));
      emitted += 1;
    }
    return emitted;
  }

  /**
   * The newest thing we actually read this pass, or the stored marker when the
   * pass read nothing.
   *
   * Derived from `collected[0]` (the listing is newest-first) rather than from
   * the page's own `after`/`before` fields: `before` is documented as null on
   * the newest page, which is the page every poll fetches — so it is null
   * exactly when it would be needed as a forward marker.
   */
  private nextCursor(collected: RedditRawThing[], stored: RedditCursor | null): RedditCursor | null {
    const newest = collected[0];
    if (newest) return { newestFullname: newest.name };
    return stored;
  }
}
