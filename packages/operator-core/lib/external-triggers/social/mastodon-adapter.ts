/**
 * The Mastodon adapter — P-012, the second Wave A adapter.
 *
 * WHY THIS ONE IS SECOND, AND WHAT IT PROVES. Bluesky (P-011) is a single host
 * with a monotonic integer sequence number. Mastodon is the opposite on every
 * axis that matters, which is what makes it the right adapter to prove the P-003
 * contract generalizes rather than merely fits its first author:
 *
 *   - It is MULTI-INSTANCE. There is no platform-wide host and no platform-wide
 *     client id; the host is per-connection configuration, and the credential is
 *     scoped to one instance. `instanceHost` is therefore threaded through
 *     everything and is never defaultable.
 *   - Its stream CANNOT REPLAY. Reconciliation is mandatory on every connect
 *     rather than an optimization, which means overlap between live stream
 *     delivery and the REST re-read is GUARANTEED, not exceptional.
 *   - Its ids are NOT ORDERABLE by us (see below).
 *   - It HAS a real idempotency mechanism, so unlike Bluesky the write path
 *     needs no derived-key guard of its own.
 *
 * FACTS THIS FILE ENCODES, read from docs.joinmastodon.org on 2026-08-23 and
 * pinned in the registry row, not recalled:
 *
 *   - Status.id is "String (cast from an integer but not guaranteed to be a
 *     number)". THE ADAPTER THEREFORE NEVER COMPARES IDS — not numerically
 *     (an 18-digit snowflake exceeds Number.MAX_SAFE_INTEGER, so ids one apart
 *     collapse to the same double) and not lexicographically ("9" > "10").
 *     Ordering comes from `created_at`, which is documented as a Datetime, and
 *     gap arithmetic is delegated to the server.
 *   - Status.edited_at is a nullable Datetime added in 3.5.0. `id + edited_at`
 *     is the version identity, which is what makes the dedupe key stable across
 *     a replay and different after an edit.
 *   - Status.visibility is exactly one of public | unlisted | private | direct.
 *   - Status.content is "String (HTML)" — hence the htmlToText reduction.
 *   - Timeline paging: `since_id` "sets a lower bound on results";
 *     `min_id` "returns results immediately newer than this ID... sets a cursor
 *     at this ID and paginates forward". Those are NOT interchangeable, and
 *     picking the wrong one is a silent-loss bug — see MIN_ID_NOT_SINCE_ID.
 *   - limit defaults to 20 and caps at 40 statuses, so any gap larger than a
 *     page REQUIRES pagination. This is not a tuning detail; it is the reason
 *     the walk below exists.
 */
import { htmlToText } from '../../html-to-text';
import { assertSocialEgressAllowed } from './social-egress';
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
 * WHY `min_id` AND NEVER `since_id`. Both are documented as ID bounds, and they
 * read as synonyms. They are not, and the difference is a silent-loss bug of
 * exactly the class D-005 named:
 *
 *   `since_id` "sets a lower bound on results" — and says nothing about WHICH
 *   end of the matching range you get back. In practice you get the NEWEST
 *   page. So if 100 statuses arrived while the desktop was asleep and the page
 *   limit is 40, a `since_id` read returns the newest 40, the adapter advances
 *   its marker past all 100, and the middle 60 ARE GONE PERMANENTLY.
 *
 *   `min_id` "returns results immediately newer than this ID... paginates
 *   forward" — the oldest unseen page first. Walking it forward covers the
 *   whole gap.
 *
 * What makes this dangerous rather than merely wrong is that the broken version
 * has NO detectable symptom. It emits a full page of real events, reports a
 * healthy `emitted` count, and advances its cursor — it looks exactly like a
 * successful catch-up. The zero-events tell that catches Bluesky's cursor bug
 * does not exist here.
 *
 * The conformance kit's `offline-gap-closed-exactly-once` check DOES catch it,
 * but only when the test gap spans more than one page — which is why the
 * harness in the test file deliberately uses a page size smaller than the gap.
 * A harness whose page size exceeds the gap makes that check decorative.
 */
export const MIN_ID_NOT_SINCE_ID =
  'Mastodon gap recovery pages forward with min_id; since_id returns the NEWEST page and silently drops the middle of any gap larger than one page.';

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What we persist between reconciles.
 *
 * `minId` is an OPAQUE server token, not a value we interpret. It is handed
 * back to the provider verbatim and never compared, incremented, or parsed —
 * see the id note in the file header.
 */
export interface MastodonCursor {
  /** The last status id we have fully processed; the `min_id` for the next walk. */
  minId: string;
  /** Newest `created_at` seen, carried for diagnostics only — never for ordering decisions. */
  lastEventAt?: string | null;
}

/** True when `value` is a usable stored cursor. Unusable values need backfill. */
export function isMastodonCursor(value: unknown): value is MastodonCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MastodonCursor).minId === 'string' &&
    (value as MastodonCursor).minId.length > 0
  );
}

/* -------------------------------------------------------------------------- */
/* Provider port                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where a raw item came from.
 *
 * This is a discriminator rather than an inferred property on purpose. "Is this
 * a mention of me?" is answered by the notifications endpoint, whose `mention`
 * type is documented as "Someone mentioned you in their status" and whose scope
 * (`read:notifications`) the registry row already declares. Re-deriving it by
 * scanning a status's mention list would be a second, weaker answer to a
 * question the provider already answered.
 */
export type MastodonItemSource = 'timeline' | 'notification-mention';

/** One status as the timeline, the notification list, or the stream hands it to us. */
export interface MastodonRawStatus {
  /** Status.id — opaque. Never parsed, never compared. */
  id: string;
  /** Federation URI (Status.uri) — stable across instances. */
  uri: string;
  /** Status.url — the HTML permalink. Nullable per the entity docs. */
  url?: string | null;
  /** Status.content — HTML, reduced to text on normalization. */
  content: string;
  /** Status.created_at — a Datetime, and the ONLY orderable field we trust. */
  createdAt: string;
  /** Status.edited_at — nullable; part of the version identity. */
  editedAt?: string | null;
  /** Status.in_reply_to_id — nullable; presence is what makes this a reply. */
  inReplyToId?: string | null;
  /** Status.visibility, verbatim. */
  visibility: MastodonVisibility;
  /** Account.acct — the domain-qualified handle. `username` alone is ambiguous across servers. */
  accountAcct: string;
  /** Which endpoint produced this item. */
  source: MastodonItemSource;
}

/** Status.visibility — the four documented values, verbatim. */
export type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface MastodonPage {
  statuses: MastodonRawStatus[];
  /**
   * The marker meaning "everything in this page has been consumed" — persist
   * it, and pass it as `minId` on the next call. Null only when the page was
   * empty, in which case the previous marker stands.
   *
   * Server-supplied: a real client reads it from the response's `Link` header
   * (`rel="prev"`, which is the newer direction) rather than computing it. That
   * is deliberate and not a convenience — computing it would mean deciding which
   * returned id is newest, which means comparing ids, which this platform does
   * not permit. Delegating it keeps the one unsafe operation out of the adapter
   * entirely.
   */
  nextMinId: string | null;
  /**
   * Whether the server has more immediately available beyond this page.
   *
   * SEPARATE FROM `nextMinId` ON PURPOSE. Collapsing the two — treating a null
   * marker as "caught up" — leaves the cursor pointing at the marker used to
   * FETCH the final page rather than past its contents, so the next reconcile
   * re-reads and re-emits that page forever. The conformance kit's
   * `no-op-reconcile-emits-nothing` check catches it, which is how this was
   * found; keeping the fields distinct is what stops it coming back.
   */
  hasMore: boolean;
}

export interface MastodonReadClient {
  /**
   * Read forward from `minId`.
   *
   * `minId === null` means cold start: return the bounded initial window,
   * paginating forward from its floor. A real client establishes that floor by
   * walking `max_id` backwards first; that is an implementation detail behind
   * this port, and the adapter neither knows nor cares.
   */
  fetchNewer(minId: string | null, signal?: AbortSignal): Promise<MastodonPage>;
}

/* -------------------------------------------------------------------------- */
/* Instance discovery                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The streaming endpoint is NOT derivable from the API host.
 *
 * The registry row records this as a measured trap: an instance may serve
 * streaming from a different origin, so it must be read from
 * `configuration.urls.streaming` rather than assumed to be the API host with a
 * different scheme. Returning null when it is absent is the honest answer — a
 * guessed streaming URL fails at connect time, on a different host, which is a
 * much worse place to discover the mistake than here.
 *
 * ⚠ THE VALUE IS SUPPLIED BY THE INSTANCE, SO IT IS NOT TRUSTED (P-024). This is
 * the one place in the social lane where the host we are about to open an
 * authenticated connection to is named by the remote side. An instance that
 * advertised `wss://collector.example/` would otherwise be obeyed, and the user's
 * token would go with us. `instanceHost` is therefore REQUIRED rather than
 * optional: an optional guard is one every future call site is free to omit, and
 * this function has exactly one correct usage.
 *
 * An out-of-budget host THROWS rather than returning null, because null already
 * means "the instance advertised nothing" — collapsing "silent about it" and
 * "pointed us somewhere else" into one return value would hide the second behind
 * the first, which is the failure this whole check exists to make impossible.
 */
export function mastodonStreamingUrl(instance: unknown, instanceHost: string): string | null {
  if (!instance || typeof instance !== 'object') return null;
  const configuration = (instance as { configuration?: unknown }).configuration;
  if (!configuration || typeof configuration !== 'object') return null;
  const urls = (configuration as { urls?: unknown }).urls;
  if (!urls || typeof urls !== 'object') return null;
  const streaming = (urls as { streaming?: unknown }).streaming;
  if (typeof streaming !== 'string' || !streaming.trim()) return null;
  const advertised = streaming.trim();
  assertSocialEgressAllowed('mastodon', advertised, { connectionHost: instanceHost });
  return advertised;
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A rate-limit response.
 *
 * WHAT IS DOCUMENTED, AND WHAT DELIBERATELY IS NOT. The rate-limit page names
 * exactly three headers — `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
 * `X-RateLimit-Reset` — and `Reset` is "Timestamp when your rate limit will
 * reset", i.e. an ABSOLUTE time, not a duration. It documents no status code
 * and no `Retry-After`.
 *
 * So this class carries `resetAt` and nothing else. Modelling a `retryAfterMs`
 * the way the Bluesky error does would be inventing a field the platform does
 * not send, and code would then branch on a value that is always null.
 */
export class MastodonRateLimited extends Error {
  /** `X-RateLimit-Reset` verbatim — an absolute timestamp, or null when absent. */
  readonly resetAt: string | null;

  constructor(resetAt: string | null, message?: string) {
    super(`mastodon_rate_limited${resetAt ? `:reset_at=${resetAt}` : ''}${message ? ` — ${message}` : ''}`);
    this.name = 'MastodonRateLimited';
    this.resetAt = resetAt;
  }
}

/**
 * The longest we will block a reconcile waiting for a limit to reset.
 *
 * The account-wide budget is 300 requests / 5 minutes, but status DELETION is
 * 30 per 30 MINUTES — so a reset can legitimately be half an hour out. Sleeping
 * that long inside a reconcile would look like a hang. Past this cap the error
 * propagates instead, which is the honest signal: this is not a blip to absorb,
 * it is a "come back later" the caller needs to schedule around.
 */
export const MASTODON_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * How long to wait before retrying, or null to give up and propagate.
 *
 * Prefers the server's own reset timestamp because that is the only quantity
 * the platform actually publishes. When it is absent or unparseable we fall
 * back to bounded exponential backoff — a judgement call, flagged as such: it
 * is not derived from the docs, it is what to do when the docs give us nothing.
 */
export function mastodonRetryDelayMs(error: unknown, attempt: number, nowMs: number): number | null {
  if (!(error instanceof MastodonRateLimited)) return null;

  if (error.resetAt) {
    const resetMs = Date.parse(error.resetAt);
    if (Number.isFinite(resetMs)) {
      const wait = resetMs - nowMs;
      if (wait > MASTODON_MAX_RATE_LIMIT_WAIT_MS) return null;
      // A reset already in the past means we may retry immediately.
      return Math.max(0, wait);
    }
  }
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The dedupe key: status id plus its version marker.
 *
 * `edited_at` is the version: it is null until the first edit and changes on
 * every edit after. So a replay of an unedited status reproduces the key
 * exactly (the contract's hard requirement), while an edit produces a new key
 * and correctly re-delivers the changed content.
 *
 * THIS KEY CARRIES MORE WEIGHT HERE THAN ON BLUESKY. There, `seq > lastSeq`
 * made exactly-once structural and the key was a second line of defence. Here
 * the stream cannot replay, so every connect MUST re-read REST over a window
 * that necessarily overlaps whatever the stream already delivered. The overlap
 * is by design, and the dedupe key is the ONLY thing that collapses it.
 */
export function mastodonDedupeKey(status: Pick<MastodonRawStatus, 'id' | 'editedAt' | 'createdAt'>): string {
  return `${status.id}@${status.editedAt ?? status.createdAt}`;
}

/** Which `ext:mastodon:<event>` key this status normalizes to. */
export function mastodonEventName(status: MastodonRawStatus): string {
  if (status.source === 'notification-mention') return 'mention';
  if (status.inReplyToId) return 'reply';
  return 'post';
}

/**
 * Build the canonical `social-post` payload (D-004).
 *
 * `statusId` and `instanceHost` are NOT decoration. `resolveSocialReplyCoordinates`
 * reads exactly those two fields off the stored document to build a Mastodon
 * reply target, and throws when either is missing — so an omission here would
 * not fail during ingestion, it would fail later at every attempt to reply,
 * against a document that already looked fine. The round-trip test in this
 * adapter's suite drives the real derivation over this payload for that reason.
 */
export function normalizeMastodonStatus(
  status: MastodonRawStatus,
  instanceHost: string,
): SocialNormalizedEvent {
  const text = htmlToText(status.content);
  const payload: Record<string, unknown> = {
    id: status.uri,
    text,
    // The two fields the reply seam requires.
    statusId: status.id,
    instanceHost,
    // Verbatim, so `normalizeSocialVisibility` maps it rather than guessing.
    visibility: status.visibility,
    author: status.accountAcct,
    authorHandle: status.accountAcct,
    occurredAt: status.createdAt,
    uri: status.uri,
  };
  if (status.url) payload.url = status.url;
  if (status.editedAt) payload.editedAt = status.editedAt;
  if (status.inReplyToId) payload.replyToId = status.inReplyToId;

  return {
    externalId: status.uri,
    event: mastodonEventName(status),
    occurredAt: status.createdAt,
    payload,
    dedupeKey: mastodonDedupeKey(status),
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface MastodonAdapterDeps {
  client: MastodonReadClient;
  /** The instance this connection is bound to. Per-connection, never defaultable. */
  instanceHost: string;
  /**
   * How many pages one reconcile will walk before stopping.
   *
   * A bound, not a limit on correctness: stopping early leaves the cursor at
   * the last fully-processed page, so the next reconcile resumes exactly where
   * this one stopped. A very large gap closes over several passes instead of
   * one long one, and never by discarding its middle.
   */
  maxPages?: number;
  /** Bounded retry budget for an absorbed rate-limit response. */
  maxRetries?: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the reset-timestamp arithmetic is testable without wall-clock. */
  now?: () => number;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RETRIES = 4;

export class MastodonAdapter implements SocialAdapter {
  readonly platformId = 'mastodon' as const;

  private readonly client: MastodonReadClient;
  private readonly instanceHost: string;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: MastodonAdapterDeps) {
    if (!deps.instanceHost?.trim()) {
      // Mastodon is federated; there is no default host to fall back to, and a
      // wrong one would emit events attributed to the wrong server.
      throw new Error('mastodon_adapter_requires_instance_host');
    }
    this.client = deps.client;
    this.instanceHost = deps.instanceHost.trim();
    this.maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Absorb a rate limit rather than propagating it.
   *
   * Propagating would surface a routine throttle as a source-level failure and
   * drop the page mid-walk — which on this platform means the gap stays open,
   * because there is no stream replay to fall back on.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const delay = mastodonRetryDelayMs(error, attempt, this.now());
        if (delay === null || attempt >= this.maxRetries) throw error;
        attempt += 1;
        await this.sleep(delay);
      }
    }
  }

  async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
    const stored = isMastodonCursor(ctx.cursor) ? ctx.cursor : null;
    const cursorUnreadable = ctx.cursor !== null && stored === null;

    const collected: MastodonRawStatus[] = [];
    let marker: string | null = stored?.minId ?? null;
    let pages = 0;

    // Walk FORWARD from the stored marker, oldest unseen page first. Each page
    // hands back the next marker, so the walk terminates when the server says
    // there is nothing newer — never when a page happens to look short.
    for (;;) {
      if (ctx.signal?.aborted) break;
      const at = marker;
      const page: MastodonPage = await this.withRetry(() => this.client.fetchNewer(at, ctx.signal));
      collected.push(...page.statuses);
      pages += 1;
      // Advance on real progress, INDEPENDENTLY of whether we keep walking —
      // see the note on `hasMore`. Advancing only while more pages remain
      // leaves the cursor behind the final page and re-emits it forever.
      if (page.nextMinId) marker = page.nextMinId;
      if (!page.hasMore) break;
      if (pages >= this.maxPages) break;
    }

    const emitted = await this.emitAll(collected, ctx);

    return {
      cursor: this.nextCursor(collected, marker, stored),
      emitted,
      // See the class note: with a stored marker the REST re-read is the ONLY
      // route that closes the gap on this platform, so that is what we report.
      ...this.declarePath(stored, cursorUnreadable),
    };
  }

  /**
   * Declare which route closed the gap.
   *
   * A stored marker always produces `backfill` / `no-replay-supported`, even on
   * a pass that emitted nothing, and that is deliberate. `live-only` asserts
   * "the cursor was accepted and the provider had nothing to replay" — a claim
   * about STREAM replay that this platform cannot support. Reporting it would
   * tell an operator the stream is covering gaps when only the REST re-read is,
   * which is precisely the false comfort D-005 exists to prevent.
   *
   * The cost is that `path` stops discriminating "routine tick" from "we lost
   * the stream" ON THIS PLATFORM. That information has not been lost, it has
   * moved: `backfillReason` carries it. `no-replay-supported` is the structural
   * steady state; `cursor-expired` and `cursor-rejected` are the exceptional
   * ones. An alert keyed on the REASON stays meaningful across all three Wave A
   * platforms, where one keyed on `path === 'backfill'` would fire forever here.
   */
  private declarePath(
    stored: MastodonCursor | null,
    cursorUnreadable: boolean,
  ): Pick<SocialReconcileResult, 'path' | 'backfillReason'> {
    if (stored === null) {
      return cursorUnreadable
        ? { path: 'backfill', backfillReason: 'cursor-rejected' }
        : { path: 'cold-start' as SocialReconcilePath };
    }
    return { path: 'backfill', backfillReason: 'no-replay-supported' };
  }

  /**
   * Emit every collected status, oldest first.
   *
   * Ordered by `created_at`, NOT by id and NOT by the order the provider
   * returned them. The timelines documentation states no ordering guarantee for
   * these endpoints, and the ids are explicitly not guaranteed to be numbers —
   * so `created_at`, documented as a Datetime, is the only field that can carry
   * this. The sort is stable, so statuses sharing a timestamp keep provider
   * order rather than being shuffled.
   */
  private async emitAll(statuses: MastodonRawStatus[], ctx: SocialReconcileContext): Promise<number> {
    const ordered = [...statuses].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    // The walk can legitimately return the same status twice (the notifications
    // and timeline endpoints both carry a status that mentions us). Collapse on
    // the dedupe key, which is the same key the ingestion seam dedupes on.
    const seen = new Set<string>();
    let count = 0;
    for (const status of ordered) {
      if (ctx.signal?.aborted) break;
      const key = mastodonDedupeKey(status);
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.emit(normalizeMastodonStatus(status, this.instanceHost));
      count += 1;
    }
    return count;
  }

  /**
   * The next cursor is the LAST MARKER THE SERVER GAVE US, never a value we
   * derived by inspecting ids.
   *
   * When a pass collects nothing, the stored marker is retained unchanged — the
   * cursor must never move on a no-op, and must never move backwards.
   */
  private nextCursor(
    statuses: MastodonRawStatus[],
    marker: string | null,
    stored: MastodonCursor | null,
  ): MastodonCursor | null {
    const minId = marker ?? stored?.minId ?? null;
    if (!minId) return stored;
    const newest = statuses.reduce<string | null>(
      (latest, status) => (!latest || status.createdAt > latest ? status.createdAt : latest),
      stored?.lastEventAt ?? null,
    );
    return { minId, lastEventAt: newest };
  }
}
