/**
 * Social platform capability registry
 * (social-platform-integrations-2026-08-23 P-002, ruled by D-005).
 *
 * WHAT THIS IS. One row per social platform declaring the facts an adapter and
 * the UI both need: how it authenticates, how it is read, whether that read is
 * replayable after an offline gap, what can be written, and what the rate
 * budget is. The `social:*` verbs and the admin surface READ this; nothing
 * restates it in prose.
 *
 * WHY IT IS CURATED RATHER THAN DERIVED. The derived-truth ladder (repo
 * CLAUDE.md) says a value describing CODE must be derived, pinned or attested.
 * These rows describe EXTERNAL services, so no amount of static analysis over
 * our tree can produce them — they are tier-4 CURATED, which the ladder permits
 * only with a stated reason. That is the reason. What keeps them honest is the
 * tier-3 half: every row carries `verifiedAt` plus the exact source URLs it was
 * read from, and `assertPlatformUsable` REFUSES an unverified row rather than
 * treating it as permissive (D-005). A row nobody has checked cannot be used by
 * accident; it has to be checked first.
 *
 * VERIFICATION IS JUST-IN-TIME (D-005). Wave B and C rows are deliberately
 * `verifiedAt: null`. Platform pricing, scopes and review requirements are the
 * fastest-moving facts this plan depends on, so verifying them weeks before the
 * work starts produces a stale row that must be re-verified anyway — and a
 * stale row is worse than an absent one, because it reads as known. Each wave's
 * first item re-runs verification for its own platforms and fills its rows in.
 */

/** Platforms whose unit of content normalizes to the canonical `social-post` datatype (D-001). */
export type SocialPlatformId =
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'youtube'
  | 'facebook-pages'
  | 'instagram'
  | 'threads'
  | 'linkedin'
  | 'tiktok'
  | 'x-twitter';

/**
 * How an owner's account is connected.
 * - `self-serve-oauth`  — an OAuth app anyone can register without review.
 * - `app-password`      — a user-generated scoped credential, no app registration.
 * - `instance-oauth`    — OAuth against a per-connection host (Mastodon: client
 *                         registration happens per instance, so there is no one
 *                         client id for the platform).
 * - `app-review`        — an OAuth app that only receives its scopes after the
 *                         vendor reviews it. Owner-side work with a lead time.
 * - `paid-tier`         — access requires a paid subscription.
 */
export type SocialAuthMode =
  | 'self-serve-oauth'
  | 'app-password'
  | 'instance-oauth'
  | 'app-review'
  | 'paid-tier';

/**
 * How events are read. Both legal values are OUTBOUND-ONLY by construction —
 * D-003 forbids depending on inbound webhooks, because Papercusp is a desktop
 * app behind NAT with no public ingress. There is deliberately no 'webhook'
 * member of this union: a platform that can ONLY be read by webhook cannot be
 * expressed in this registry, which is the point. `platform-registry.test.ts`
 * pins that.
 */
export type SocialReadTransport = 'outbound-websocket' | 'poll-cursor';

/**
 * The replay classes measured in D-005 and extended by D-021. They differ in what
 * happens after the process is offline for a while, and that difference is the
 * whole reason the conformance kit exists:
 * - `bounded-cursor-window` — a stored cursor replays missed events, but only
 *   within a retention window; past it the cursor is refused and the adapter
 *   MUST fall back to a bounded backfill. (Bluesky; also Gmail's historyId.)
 * - `no-replay-rest-backfill` — the stream carries no cursor at all, so a gap
 *   is recoverable ONLY by re-reading REST with a since-marker. (Mastodon.)
 * - `poll-cursor` — there is no stream; reading IS the cursored poll. (Reddit.)
 * - `watermark-rescan` — the provider offers NO time filter and NO since-marker
 *   of any kind, so the only way to close a gap is to re-read from the newest
 *   entry and stop CLIENT-SIDE at a stored watermark. (YouTube commentThreads:
 *   its complete parameter inventory has no `publishedAfter`, verified in D-021.)
 *
 * ⚠ `watermark-rescan` is deliberately NOT folded into `no-replay-rest-backfill`.
 * They read alike and behave differently where it matters: a REST backfill has a
 * server-side since-marker, so the provider bounds the re-read. A watermark rescan
 * has none, so the CLIENT bounds it — which means cost grows with the gap, and an
 * adapter that persists a `pageToken` as if it were a resume point is silently
 * wrong (a pageToken identifies a page within one query's result set, not a
 * position in a stream). Collapsing the two classes would hide exactly the
 * distinction that makes the second one dangerous.
 */
export type SocialReplayClass =
  | 'bounded-cursor-window'
  | 'no-replay-rest-backfill'
  | 'poll-cursor'
  | 'watermark-rescan';

/**
 * How much replay guarantee each class actually carries, LOW = weakest.
 *
 * Exported because it is the derived basis for the registry invariant that a
 * platform's scalar `read` may never overstate its streams (see `SocialPlatformRow.read`).
 * Encoding the order ONCE here means the rule is checked against a single
 * declaration instead of a hand-maintained list in a test — the same reason
 * D-016's per-verb idempotency convention pins "the scalar means the weakest".
 */
export const SOCIAL_REPLAY_STRENGTH: Record<SocialReplayClass, number> = {
  // No marker at all; the client re-reads and filters. Cost grows with the gap.
  'watermark-rescan': 0,
  // A server-side since-marker bounds the re-read, but the stream itself replays nothing.
  'no-replay-rest-backfill': 1,
  // Reading IS the cursored poll: nothing to miss, no window to expire.
  'poll-cursor': 2,
  // A real stream cursor replays the gap, but only inside a retention window.
  'bounded-cursor-window': 3,
};

/** One readable stream's transport and replay behaviour. */
export interface SocialReadSpec {
  transport: SocialReadTransport;
  replay: SocialReplayClass;
  /** How a gap is recovered when the cursor is unusable. */
  backfill?: string;
}

/** Agent-facing capability verbs (D-019 Tier 1) a platform's adapter can serve. */
export type SocialWriteVerb = 'reply' | 'post' | 'delete';

/**
 * Whether the platform offers a native duplicate-suppression mechanism for
 * writes. This matters more than it looks: an adapter that retries a failed
 * write without one double-posts publicly, which is not correctable the way a
 * duplicate email is. `header` means a request header carries a caller-supplied
 * key; `unknown` means we have not verified it and a write path must therefore
 * implement its own guard.
 */
export type SocialWriteIdempotency = 'header' | 'none' | 'unknown';

/**
 * A budget that does NOT exchange with the platform's general pool (D-020).
 *
 * WHY THIS IS NOT JUST A NUMBER IN `notes`. YouTube grants 10,000 general units
 * per day AND a separate 100 `search.list` calls per day AND a separate 100
 * `videos.insert` calls per day. Unused general units cannot buy an extra upload.
 * A cap derived from the general pool is therefore not merely imprecise for
 * uploads, it is unrelated to the real constraint — so a storm policy that
 * reads one scalar is calibrated against the wrong quantity entirely.
 */
export interface SocialQuotaBucket {
  /** What draws on this bucket, in the platform's own endpoint vocabulary. */
  appliesTo: string;
  /** The hard daily ceiling, in this bucket's own unit. */
  perDay: number;
  /**
   * What `perDay` counts. `calls` is a ceiling on INVOCATIONS regardless of what
   * each costs; `units` is a ceiling on summed per-call unit costs. Recording
   * this is the whole point: YouTube's upload bucket is call-capped, and reading
   * it as unit-capped is exactly the error D-020 corrected.
   */
  unit: 'calls' | 'units';
  /**
   * Which verbs draw on this bucket.
   *
   * DECLARED rather than inferred from `appliesTo`, which is prose in the
   * platform's own endpoint vocabulary and exists to be READ BY A HUMAN. A
   * consumer that matched on it would be parsing free text to make a
   * rate-limiting decision, and would break the first time a row was reworded.
   *
   * Omitted means "not stated for any verb" — a consumer must then treat this
   * bucket as a candidate only under its own conservative fallback, never as a
   * match. See `socialStormPolicyFor`.
   */
  verbs?: SocialQuotaVerb[];
  notes?: string;
}

/**
 * The verbs a quota bucket can be drawn on by.
 *
 * `read` covers every polling/list call the read adapters make; the rest mirror
 * the registry's own `write.verbs` vocabulary so a bucket and a write
 * declaration cannot drift into two different spellings of the same verb.
 */
export type SocialQuotaVerb = 'read' | 'post' | 'reply' | 'delete';

export interface SocialRateBudget {
  /** Requests per minute, where the platform states one. */
  requestsPerMinute?: number;
  /** Daily quota in platform-specific units (e.g. YouTube quota units). */
  quotaUnitsPerDay?: number;
  /** Response headers that report remaining budget, for adaptive backoff. */
  budgetHeaders?: string[];
  /**
   * Non-fungible budgets keyed by name, for a platform whose quota is not one
   * pool (D-020). A consumer deriving a cap for a specific verb MUST prefer the
   * bucket that verb draws on over `quotaUnitsPerDay`/`requestsPerMinute`.
   */
  buckets?: Record<string, SocialQuotaBucket>;
  /**
   * Set when the platform's allowance is NOT A CONSTANT (D-028).
   *
   * WHY THIS IS A TYPED FIELD RATHER THAN PROSE IN `notes`. Every platform
   * before Facebook had a fixed budget — a requests-per-minute number, or
   * YouTube's three fixed unit buckets — so a consumer could derive a cap by
   * reading a number. Facebook's Pages allowance is "4800 * Number of Engaged
   * Users" over a rolling 24 hours: it MOVES with engagement, and is smallest
   * exactly when a Page is quiet. A cap derived from any compiled-in number is
   * therefore wrong in one direction or the other.
   *
   * Putting that in `notes` would leave the storm-policy layer free to keep
   * reading `quotaUnitsPerDay` (absent here) or `requestsPerMinute` (also
   * absent) and silently fall back to a default — the failure being guarded
   * against. A present `dynamicQuota` is a machine-readable instruction to
   * derive the cap from `usageHeader` instead, and `retryExtendsBlock` makes the
   * most dangerous fact enforceable rather than merely documented.
   */
  dynamicQuota?: {
    /** The vendor's own formula, verbatim where they state one. */
    formula: string;
    /** What the allowance scales with, in the vendor's words. */
    driver: string;
    /**
     * Response header reporting ACTUAL consumption, as percentages.
     *
     * ⚠ OPTIONAL SINCE P-018, AND THE ABSENCE IS A REAL STATE RATHER THAN AN
     * UNFILLED FIELD. This was required because the only two platforms with a
     * dynamic quota — Pages and Instagram — both report consumption in
     * `X-Business-Use-Case-Usage`, which made "has a moving allowance" and "has
     * a usage header" look like the same fact. Threads breaks that: it states
     * the same 4800-per-impression formula and publishes NO usage signal for it
     * at all. Verified twice over on the shared rate-limiting page — Threads is
     * absent from the BUC error-code table AND from the enumerated `type`
     * values of the usage header, where every sibling product appears — so this
     * is a documented exclusion, not a gap in our reading (D-037).
     *
     * ABSENT THEREFORE MEANS UNOBSERVABLE: no header carries this platform's
     * consumption, so `SocialQuotaObservation` will never be populated for it,
     * `observedPeakUsagePct` stays null for the lifetime of the integration,
     * and the cap rests on `assumedDailyFloor` ALONE and permanently. That is a
     * weaker position than a header-reporting platform, and it is stated here
     * so a consumer reads it as a property rather than inferring it from a
     * field that happens to be missing.
     */
    usageHeader?: string;
    /** The `type` value identifying this platform's rows within that header. */
    usageType?: string;
    /**
     * The smallest NON-VACUOUS daily allowance the formula can yield, in whole
     * calls. REQUIRED, and the field that makes a dynamic quota derivable at
     * all.
     *
     * WHY A FLOOR IS THE ONLY ANCHOR AVAILABLE. `usageHeader` reports
     * PERCENTAGES — "a whole number expressing the percentage" of the
     * allowance — so an observation tells a consumer what FRACTION remains and
     * never the absolute budget. Multiplying a fraction by nothing yields
     * nothing, so a cap still needs one absolute number, and the only one the
     * vendor commits to is the formula evaluated at its smallest real input
     * (for Pages: 4800 × 1 engaged user).
     *
     * Anchoring to the floor means the cap is understated whenever the Page is
     * busier than that, which is the safe direction: overstating it spends an
     * allowance whose exhaustion triggers a throttle that retrying EXTENDS.
     */
    assumedDailyFloor: number;
    /** Provider error codes meaning "throttled". */
    throttleCodes?: number[];
    /**
     * True when RETRYING A THROTTLE MAKES IT WORSE — the vendor states that
     * continuing to call increases the time before calls succeed again. A
     * consumer seeing this must park for the stated duration and schedule NO
     * retry; a generic exponential-backoff wrapper would deepen every throttle
     * it touched, which presents as the platform being flaky rather than as our
     * own retry loop being the cause.
     */
    retryExtendsBlock?: boolean;
  };
  /** Anything the numbers alone do not convey. */
  notes?: string;
}

/**
 * How a platform's API host is determined (P-024).
 *
 * - `fixed`           — the vendor serves one set of hosts for every account, so
 *                       the allowlist is a closed set this file can name.
 * - `per-connection`  — the host comes from the CONNECTION, not the platform
 *                       (a Mastodon instance, a Bluesky PDS). There is no
 *                       platform-wide host to allowlist, so the budget is
 *                       "the connection's own host, and hosts under it".
 *
 * The distinction is load-bearing rather than descriptive: a fixed-host platform
 * whose declared list is empty must DENY everything, while a per-connection one
 * with an empty list is fully operational. Collapsing them into one shape would
 * make "nothing declared" mean two opposite things.
 */
export type SocialEgressHostPolicy = 'fixed' | 'per-connection';

/**
 * The hosts one platform's adapters may reach — the P-024 allowlist.
 *
 * WHY A CALL TARGET AND A PERMALINK ARE SEPARATE FIELDS. Every adapter in this
 * directory emits payload URLs (`https://bsky.app/profile/...`,
 * `https://www.reddit.com<permalink>`) that are DISPLAY strings we never fetch,
 * and reaches API hosts (`graph.facebook.com`) it does fetch. A guard that
 * cannot tell the two apart is useless in both directions: pooled together, a
 * permalink host silently widens the call budget, and the containment gate must
 * either flag every display URL as egress or stop flagging anything. Declaring
 * them separately means the runtime allowlist consults ONLY `apiHosts`, while
 * the static gate can still account for every host literal in the source.
 *
 * Hosts are bare lowercase hostnames — no scheme, no port, no path, no wildcard.
 * A wildcard is deliberately unrepresentable: `*.facebook.com` would admit any
 * host an attacker can get provisioned under it, and every real entry here is a
 * single documented host.
 */
export interface SocialEgressSpec {
  hostPolicy: SocialEgressHostPolicy;
  /**
   * Hosts the adapter may CALL. Exhaustive for `fixed`; for `per-connection` it
   * lists only the platform-wide hosts that exist IN ADDITION to the
   * connection's own host (usually none).
   */
  apiHosts: string[];
  /**
   * Hosts that appear only inside emitted payload URLs and are never fetched.
   * Present so the containment gate can attribute a display-URL literal without
   * granting it call permission.
   */
  permalinkHosts?: string[];
  /** Where these hosts came from, or why the set is empty. */
  notes?: string;
}

export interface SocialPlatformRow {
  id: SocialPlatformId;
  label: string;
  /** Acquisition-cost wave (see the plan's Background), not a priority ranking. */
  wave: 'A' | 'B' | 'C';
  /**
   * ISO date this row's facts were last read from the cited sources, or null if
   * never verified. `assertPlatformUsable` refuses a null (D-005).
   */
  verifiedAt: string | null;
  /** Exact doc URLs the facts came from. Empty only while unverified. */
  sources: string[];
  auth: {
    mode: SocialAuthMode;
    scopes: string[];
    notes?: string;
  };
  /**
   * How this platform is read — or `null` when it CANNOT be read at any grant
   * tier we hold.
   *
   * `null` is a POSITIVE, verified declaration, not an omission or an unknown.
   * It is spelled `| null` rather than `read?:` for the same reason
   * `verifiedAt` is: an optional field can be forgotten, whereas a nullable one
   * still forces every row's author to write something deliberate.
   *
   * LinkedIn (P-021) is the first row to need it, and nothing else in this
   * union could state its situation without lying. Reading a member's own posts
   * needs `r_member_social` ("restricted ... available to approved users
   * only"); reading comments needs `r_member_social_feed` ("Restricted ...
   * granted to select developers only"). Neither appears in LinkedIn's
   * open-permissions reference, so no content read exists for us at all. The
   * nearest legal value, `poll-cursor`, means "reading IS the cursored poll:
   * nothing to miss, no window to expire" — the second-STRONGEST replay class
   * in SOCIAL_REPLAY_STRENGTH. Declaring that for a platform we cannot read
   * would have made LinkedIn look exactly like Reddit to every consumer.
   *
   * A null here means write-only, and consumers must render it as such: see
   * `socialAdminFacts`, which maps it to the `not-readable` cursor state rather
   * than letting a platform that can never sync report `never-synced` forever.
   */
  read: (SocialReadSpec & {
    /**
     * Per-stream detail, for a platform whose streams do NOT share one replay
     * guarantee (D-021 measured exactly that on YouTube: its activities stream
     * has a real `publishedAfter` time cursor, and its commentThreads stream has
     * no timestamp filter of any kind).
     *
     * When this is present the scalar fields above mean the WEAKEST stream —
     * the same convention D-016 fixed for write idempotency, reused rather than
     * reinvented. The point is directional: a scalar read can then never
     * OVERSTATE what the platform guarantees, only understate it, so a caller
     * that ignores `streams` is left conservative instead of wrong.
     * `platform-registry.test.ts` pins that against SOCIAL_REPLAY_STRENGTH.
     */
    streams?: Record<string, SocialReadSpec>;
  }) | null;
  write: {
    verbs: SocialWriteVerb[];
    idempotency: SocialWriteIdempotency;
    /**
     * ISO date the WRITE path specifically was verified against the cited
     * sources, or null.
     *
     * Separate from the row-level `verifiedAt` because the two can genuinely
     * diverge, and Bluesky is exactly that case: its read stream is fully
     * specified by atproto.com while docs.bsky.app now 301s to a client-rendered
     * host, so the createRecord shape and the app-password-vs-OAuth model are
     * unread (D-005 residue). Before this field existed that residue lived only
     * in `notes` prose, which no code can enforce — so a write verb was one
     * forgetful moment away from being issued against unverified facts.
     * `assertSocialWriteAllowed` refuses a null.
     */
    verifiedAt: string | null;
    notes?: string;
  };
  limits: SocialRateBudget;
  /**
   * The hosts this platform's adapters may reach (P-024). REQUIRED, so a new
   * platform cannot be added without stating its egress budget — an omitted
   * field would default to "unconstrained" at exactly the moment nobody has
   * thought about it.
   */
  egress: SocialEgressSpec;
  /** Automation/ToS restrictions that constrain what we may build, not just what the API allows. */
  policyNotes?: string;
  /**
   * Set when the platform is blocked on something only the owner can do. Named
   * so it surfaces in status reports instead of being rediscovered at build
   * time. `owner:` prefix marks an owner-walled action.
   */
  blockedOn?: string;
}

const ROWS: Record<SocialPlatformId, SocialPlatformRow> = {
  bluesky: {
    id: 'bluesky',
    label: 'Bluesky',
    egress: {
      // The row's own write note: "POST /xrpc/com.atproto.repo.createRecord
      // against the account PDS". The PDS is a property of the ACCOUNT, so
      // there is no platform-wide API host to allowlist here.
      hostPolicy: 'per-connection',
      apiHosts: [],
      permalinkHosts: ['bsky.app'],
      notes:
        'XRPC is served by the account PDS, discovered per connection. bsky.app appears only in the emitted post URL (bluesky-adapter, bluesky-write-adapter) and is never called.',
    },
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: [
      'https://atproto.com/specs/event-stream',
      'https://atproto.com/specs/xrpc',
      'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/repo/createRecord.json',
      'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json',
      'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/repo/strongRef.json',
    ],
    auth: {
      mode: 'app-password',
      scopes: [],
      notes:
        'Read stream endpoints are documented as unauthenticated. Writes use the LEGACY HTTP Bearer scheme (OAuth is the primary scheme, but app passwords are what an owner can issue without registering an app): com.atproto.server.createSession with an identifier + app password returns accessJwt + refreshJwt; send `Authorization: Bearer <accessJwt>`. Access tokens are short-lived — refresh via com.atproto.server.refreshSession. Tokens MUST be treated as opaque strings; the spec states the internal JWT fields are explicitly NOT a stable interface, so never parse one to decide expiry. App passwords match the shape xxxx-xxxx-xxxx-xxxx.',
    },
    read: {
      transport: 'outbound-websocket',
      replay: 'bounded-cursor-window',
      backfill:
        'Reconnect with the stored integer cursor against a monotonic seq. A cursor ahead of the server is a FutureCursor error and closes the connection; a cursor older than the retention window returns an #info message and replay restarts at the oldest retained seq. The window is qualitative ("hours or days") and explicitly not the full stream history, so a long offline gap MUST fall back to a bounded REST backfill rather than trusting the cursor.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      // DOCUMENTED ABSENCE, not an unread fact. atproto.com/specs/xrpc defines
      // no idempotency mechanism for procedures: no key header, no replay-safe
      // retry semantics. `swapCommit` is NOT one — it is a compare-and-swap
      // against the current repo commit (error `InvalidSwap`), i.e. a
      // concurrency guard. So a retried createRecord after an ambiguous timeout
      // CAN double-post publicly, and the dedupe must be ours: rkey is
      // client-suppliable (record-key, maxLength 512), which is the hook a
      // replay-safe adapter uses to make a retry land on the same record.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'Write path VERIFIED 2026-08-23 from byte-serving sources after docs.bsky.app proved unreadable (it 301s to a client-rendered host returning an empty body to fetch) — the blocker was the SOURCE, not the platform. POST /xrpc/com.atproto.repo.createRecord against the account PDS. Input requires repo (at-identifier), collection (nsid), record (needs a $type); optional rkey, validate, swapCommit. Output: uri (at-uri) + cid, optional commit and validationStatus. app.bsky.feed.post requires text (maxLength 3000 / maxGraphemes 300, may be empty with embeds) and createdAt (client-declared datetime); a reply needs BOTH root and parent as com.atproto.repo.strongRef = { uri: at-uri, cid: cid }. Errors use a uniform { error, message } envelope; 501 must NOT be retried, 502-504 retry after delay, 429 may carry Retry-After.',
    },
    limits: {
      budgetHeaders: ['Retry-After'],
      notes:
        'HTTP 429 with Retry-After is documented at connection time. A consumer that falls behind receives a "too slow" error and is disconnected, so the adapter must keep up or reconnect by cursor.',
    },
  },

  mastodon: {
    id: 'mastodon',
    label: 'Mastodon',
    egress: {
      // Federated: the instance IS the host, and the adapter refuses to
      // construct without one (`mastodon_adapter_requires_instance_host`).
      hostPolicy: 'per-connection',
      apiHosts: [],
      notes:
        'The API host is the connection\'s instance. The streaming endpoint may be a DIFFERENT host advertised by the instance itself (configuration.urls.streaming) — provider-supplied, therefore checked against the connection host rather than trusted (P-024).',
    },
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: [
      'https://docs.joinmastodon.org/methods/streaming/',
      'https://docs.joinmastodon.org/methods/statuses/',
    ],
    auth: {
      mode: 'instance-oauth',
      scopes: ['read:statuses', 'read:notifications', 'write:statuses'],
      notes:
        'Client registration is per instance — there is no single platform-wide client id. The streaming host may differ from the API host: discover it from configuration.urls.streaming rather than assuming. Mastodon 4.2.0 removed app-token access to these streams; a USER token is required.',
    },
    read: {
      transport: 'outbound-websocket',
      replay: 'no-replay-rest-backfill',
      backfill:
        'The streaming API exposes NO cursor, since_id or offset on any endpoint. A disconnection gap is recoverable only by re-reading the REST timeline endpoints with a stored since-marker. Reconciliation is therefore mandatory on every connect, not an optimization.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      idempotency: 'header',
      verifiedAt: '2026-08-23',
      notes:
        'POST /api/v1/statuses; reply via in_reply_to_id; visibility is one of public|unlisted|private|direct. Send an Idempotency-Key header on EVERY write — it is retained for up to an hour and is what stops a retry from double-posting.',
    },
    limits: {
      notes: 'Not specified on the streaming page; rate limits are documented separately and are per-instance.',
    },
  },

  reddit: {
    id: 'reddit',
    label: 'Reddit',
    egress: {
      hostPolicy: 'fixed',
      // Stated verbatim by this row's own auth notes: "API calls go to
      // oauth.reddit.com, not www.reddit.com".
      apiHosts: ['oauth.reddit.com'],
      permalinkHosts: ['www.reddit.com'],
      notes:
        'www.reddit.com is a PERMALINK host only — the adapters prefix it onto thing.permalink. Calling it with a bearer token is the documented mistake this split exists to prevent.',
    },
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: [
      'https://github.com/reddit-archive/reddit/wiki/API',
      'https://github.com/reddit-archive/reddit/wiki/JSON',
      'https://github.com/reddit-archive/reddit/wiki/OAuth2',
      // P-013 read the handlers themselves after www.reddit.com refused to
      // serve its own docs (HTTP 403 to every non-browser client). These are
      // the WRITERS of the behaviour the row claims, which is why two of the
      // row's original claims did not survive contact with them — see D-016.
      'https://raw.githubusercontent.com/reddit-archive/reddit/master/r2/r2/controllers/api.py',
      'https://raw.githubusercontent.com/reddit-archive/reddit/master/r2/r2/controllers/listingcontroller.py',
      'https://raw.githubusercontent.com/reddit-archive/reddit/master/r2/r2/lib/validator/validator.py',
    ],
    auth: {
      mode: 'self-serve-oauth',
      scopes: ['identity', 'read', 'submit', 'edit'],
      notes:
        'Bearer tokens expire after 1 hour; API calls go to oauth.reddit.com, not www.reddit.com. Scope is per ' +
        'endpoint: /api/submit and /api/comment need `submit`, /api/del needs `edit`. /api/comment routes on the ' +
        'PARENT\'S TYPE — a t4_ (message) parent creates a private message and needs `privatemessages` instead, so a ' +
        'content-reply path must refuse t4_ rather than rely on scope to stop it.',
    },
    read: {
      transport: 'poll-cursor',
      replay: 'poll-cursor',
      backfill: 'Cursored listings; reading is the poll. A gap is closed by walking the listing cursor backwards to the stored marker.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      // 'none' is the WEAKEST verb's guarantee, not a claim about the platform.
      // Idempotency here is PER-VERB and this scalar cannot say so, so it is
      // pinned to the value that is SAFE to act on: guarding a verb that did not
      // need it costs a wasted check, while trusting a mechanism that does not
      // cover your verb double-posts publicly. D-016 carries the per-verb truth.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'PER-VERB, read from r2/r2/controllers/api.py — the original "no documented idempotency mechanism" was ' +
        'wrong for two of three verbs. reply (POST /api/comment): nothing at all, the guard is entirely ours. ' +
        'post (POST /api/submit): for kind=link reddit has a real DEFAULT-ON server-side duplicate check — "if a ' +
        'link with the same URL has already been submitted to the specified subreddit an error will be returned ' +
        'unless `resubmit` is true" — so a write path must send resubmit:false to keep it armed and must treat the ' +
        'refusal as success-equivalent rather than retrying; kind=self has no equivalent. delete (POST /api/del): ' +
        'IDEMPOTENT BY CONSTRUCTION (`was_deleted` guard, early return on an unresolvable thing), so it needs no ' +
        'guard — but it is @noresponse, so it cannot report WHETHER anything was removed and an adapter must ' +
        'confirm via /api/info rather than return a success the caller reads as "I deleted it".',
    },
    limits: {
      requestsPerMinute: 60,
      budgetHeaders: ['X-Ratelimit-Used', 'X-Ratelimit-Remaining', 'X-Ratelimit-Reset'],
      notes:
        'OAuth2 clients may make up to 60 requests per minute. Batch endpoints are preferred over looping single-resource calls.',
    },
    policyNotes:
      'A distinctive User-Agent of the form <platform>:<app ID>:<version> (by /u/<username>) is MANDATORY — generic agents are heavily throttled and the docs are explicit that it must not be falsified. Current free-vs-commercial terms are NOT verified (the support article refuses automated fetch); treat commercial use as unresolved.',
  },

  youtube: {
    id: 'youtube',
    label: 'YouTube',
    egress: {
      hostPolicy: 'fixed',
      // The Data API is served from www.googleapis.com — the host in this row's
      // own scopes and in the write adapter's verified endpoint
      // (`POST https://www.googleapis.com/youtube/v3/comments`).
      apiHosts: ['www.googleapis.com'],
      permalinkHosts: ['www.youtube.com'],
      notes:
        'www.youtube.com is the watch-URL host emitted in payloads; the API itself is never served from it. Video uploads use the same googleapis.com host under a different path, not a separate upload host.',
    },
    wave: 'B',
    verifiedAt: '2026-08-23',
    sources: [
      'https://developers.google.com/youtube/v3/getting-started',
      'https://developers.google.com/youtube/v3/docs/activities/list',
      'https://developers.google.com/youtube/v3/docs/commentThreads/list',
      'https://developers.google.com/youtube/v3/docs/comments/insert',
      'https://developers.google.com/youtube/v3/docs/videos/insert',
    ],
    auth: {
      mode: 'self-serve-oauth',
      // D-019: these are added to GOOGLE_WORKSPACE_ALLOWED_SCOPES and to this
      // capability's own requiredScopes — and NEVER to GOOGLE_WORKSPACE_SCOPES,
      // whose members are presumed-granted for legacy connections and would make
      // an ungranted YouTube read `connected: true` until a 403 at call time.
      scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'],
      notes:
        'Rides the SAME Google Workspace OAuth source as the landed Gmail and Calendar lanes (external-triggers D-010 one-credential-path pattern) — a scope addition with an incremental consent upgrade, never a second credential path. `youtube.force-ssl` is the ONLY scope comments.insert accepts, and it also confers delete rights, so it is requested per-capability rather than by default (D-019).',
    },
    // The scalar is the WEAKEST stream (comments), per the D-016 convention that
    // a registry scalar may understate but never overstate. Detail in `streams`.
    read: {
      transport: 'poll-cursor',
      replay: 'watermark-rescan',
      backfill: 'Re-read each stream from newest and stop client-side at the stored watermark.',
      streams: {
        activities: {
          transport: 'poll-cursor',
          replay: 'poll-cursor',
          backfill:
            'activities.list takes `publishedAfter` (ISO 8601) — "the earliest date and time that an activity could have occurred for that activity to be included" — so the stored timestamp IS a real server-side cursor and the gap is closed by the provider.',
        },
        comments: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'commentThreads.list has NO timestamp filter: its complete parameter inventory is part; one of allThreadsRelatedToChannelId/id/videoId; and optional maxResults, moderationStatus, order, pageToken, searchTerms, textFormat (D-021). So a gap is closed by ordering on `time` and re-reading from the newest entry until entries fall below the stored watermark. `pageToken` identifies a page WITHIN one query\'s result set and is never a resume point — persisting it across an offline gap is the P-013 expireCursor trap in a new costume.',
        },
      },
    },
    write: {
      verbs: ['reply'],
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'reply = comments.insert (50 units, general pool), which accepts ONLY youtube.force-ssl and offers no idempotency key or replay-safe token — so the duplicate guard is entirely ours. `post` is deliberately NOT declared: videos.insert had its QUOTA verified (D-020) but not its write shape or duplicate behaviour, and D-005 discipline is that an unverified write path is an undeclared verb, not a hopeful one.',
    },
    limits: {
      quotaUnitsPerDay: 10000,
      buckets: {
        general: {
          appliesTo: 'all endpoints except search.list and videos.insert (activities.list 1, commentThreads.list 1, comments.list 1, comments.insert 50)',
          perDay: 10000,
          unit: 'units',
          verbs: ['read', 'reply', 'delete'],
        },
        search: {
          appliesTo: 'search.list',
          perDay: 100,
          unit: 'calls',
          // No `verbs`: search.list is not reached by any declared social verb —
          // neither read adapter calls it (activities.list and
          // commentThreads.list are both general-bucket). Declaring a verb here
          // would attribute a cap to a bucket nothing actually draws on.
          notes: 'A separate allocation; unused general units cannot buy another search.',
        },
        videoUploads: {
          appliesTo: 'videos.insert',
          perDay: 100,
          unit: 'calls',
          verbs: ['post'],
          notes:
            'The "Video Uploads quota bucket". Each call costs 1 unit, NOT the widely-repeated 1600 — that figure is stale, and the real constraint is this 100-CALL ceiling, which no amount of unused general quota replenishes (D-020).',
        },
      },
      notes:
        'THREE non-fungible budgets, verified against two independent vendor pages (D-020). A cap derived from quotaUnitsPerDay alone is meaningless for uploads and searches, so a per-verb consumer must read `buckets`.',
    },
    blockedOn:
      'owner: Google incremental consent upgrade — the YouTube scopes are additive on the existing Workspace connection, so the owner must approve the incremental consent screen once before any live call. Code and simulated conformance proceed without it (D-018 posture); `include_granted_scopes=true` is already set on buildAuthorizeUrl, so the upgraded token retains the landed Gmail and Calendar grants (D-019).',
  },

  'facebook-pages': {
    id: 'facebook-pages',
    label: 'Facebook Pages',
    egress: {
      hostPolicy: 'fixed',
      // FACEBOOK_GRAPH_ORIGIN in facebook-common.ts — the single origin every
      // Pages call in this directory is built from.
      apiHosts: ['graph.facebook.com'],
      permalinkHosts: ['www.facebook.com'],
      notes:
        'www.facebook.com is the permalink host ("https://www.facebook.com/ plus the page_post_id"), never an API target.',
    },
    wave: 'B',
    verifiedAt: '2026-08-23',
    sources: [
      'https://developers.facebook.com/docs/pages-api/getting-started',
      'https://developers.facebook.com/docs/pages-api/posts',
      'https://developers.facebook.com/docs/permissions',
      'https://developers.facebook.com/docs/graph-api/results',
      'https://developers.facebook.com/docs/graph-api/reference/page/',
      'https://developers.facebook.com/docs/graph-api/reference/page/feed/',
      'https://developers.facebook.com/docs/graph-api/reference/v23.0/object/comments',
      'https://developers.facebook.com/docs/graph-api/overview/rate-limiting',
    ],
    auth: {
      mode: 'app-review',
      // D-024: resolved against the PERMISSIONS REFERENCE, not the getting-started
      // page. Meta's own tutorials name two strings that do not exist —
      // `pages_manage_read_engagement` and `pages_read_user_engagement` — and a
      // bad scope fails only at the authorize call, which sits behind the
      // owner-walled app review, so it would have looked green everywhere an
      // agent can reach and broken the moment the owner cleared review.
      scopes: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_manage_posts',
        'pages_manage_engagement',
      ],
      notes:
        'Requires a PAGE access token, which is a SECOND credential obtained from GET /{user-id}/accounts with the user token — not the token OAuth returns (D-027). `pages_manage_metadata` is deliberately NOT requested: it grants webhook subscription and Page settings writes, and D-003 declines the webhook path for v1, so requesting it would be unjustifiable privilege at review. Required Page tasks are the UNION of what two vendor pages disagreed about: CREATE_CONTENT (publish), MANAGE, and MODERATE — MODERATE is not optional, since without it comment ids are withheld while the call still succeeds.',
    },
    // The scalar is the weakest stream, per D-016. Both streams are equally weak
    // here, which is itself the finding: NEITHER has a usable cursor.
    read: {
      transport: 'poll-cursor',
      replay: 'watermark-rescan',
      backfill:
        'Re-read each stream from the top, page forward on paging.next WITHIN the pass, and filter client-side against a stored created_time watermark.',
      streams: {
        posts: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'Reads /{page-id}/published_posts ("All published posts by this page") rather than /feed, which mixes Page posts, visitor posts and tagged posts and additionally returns unpublished ones. D-025: the vendor documents NO since/until on this edge and states "Don\'t store cursors. Cursors can quickly become invalid if items are added or deleted", so there is neither a server-side time filter nor a storable cursor. The feed family is further documented as returning "approximately 600 ranked, published posts per year" — RANKED — so the adapter derives no control flow from position and never early-exits at the first below-watermark item; it filters every item individually. Termination is the absence of paging.next ONLY: a page "may be empty but contain a `next` paging link".',
        },
        comments: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'There is NO page-wide comments edge — the Page node is absent from the list of nodes carrying /comments (D-026) — so this stream is one call PER WATCHED POST and its cost scales with the watch window, not with comment volume. `filter=stream` is sent explicitly because the `toplevel` default returns only top-level comments and silently drops nested replies. The comment fields on this edge carry NO edit timestamp, so an edited comment is not re-delivered (unlike a post, which carries updated_time). An empty result is trustworthy ONLY because the Page credential and the MODERATE task are asserted before the read: with a user token this edge "returns empty data" rather than erroring (D-027).',
        },
        visitor_posts: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'VERIFIED BUT NOT YET IMPLEMENTED — declared here rather than omitted, so a reader sees a known stream that does not fire instead of assuming coverage. /{page-id}/visitor_posts "Shows all public Posts published by Page visitors on the Page": a genuinely different event from a Page-authored post (D-026), which is why it is a separate stream rather than a `from` field on the posts stream. Same replay model as the other two. Scoped out of P-016 to keep the item to two read streams plus write; picking it up needs no new verification.',
        },
      },
    },
    write: {
      verbs: ['reply', 'post'],
      // D-028: the publish reference documents no idempotency key, client token,
      // request id or dedup parameter of ANY kind, so a retried POST creates a
      // duplicate public post. Per D-016 this is a per-verb property; both verbs
      // agree here, so the scalar is honest rather than merely conservative.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'POST /{page-id}/feed requires the CREATE_CONTENT task, a Page access token, and pages_manage_posts. "Either `link` or `message` must be supplied"; `published` defaults to true; `scheduled_publish_time` "Must be date between 10 minutes and 75 days from the time of the API request". The response is `{"id":"post-id"}`. The one compensation for having no idempotency is read-after-write: "This endpoint supports read-after-write and can immediately return any fields returned by read operations", so D-008\'s server-minted, round-trip-verified post ref costs ONE call rather than a create-then-GET pair.',
    },
    limits: {
      // D-028: NOT a constant. "Calls within 24 hours = 4800 * Number of Engaged
      // Users", over a rolling 24h window, where the multiplier is the users who
      // engaged with the Page in that window. The budget therefore MOVES with
      // engagement and is smallest exactly when a Page is quiet, so any
      // compiled-in cap is wrong in one direction or the other. A consumer must
      // read X-Business-Use-Case-Usage instead.
      budgetHeaders: ['X-Business-Use-Case-Usage'],
      dynamicQuota: {
        formula: 'Calls within 24 hours = 4800 * Number of Engaged Users',
        driver: 'the number of Users who engaged with the Page per 24 hours, over a rolling 24-hour window',
        usageHeader: 'X-Business-Use-Case-Usage',
        usageType: 'pages',
        // The formula at its smallest real input: 4800 × 1 engaged user. Not a
        // guess and not a typical value — the least the vendor's own formula can
        // yield for a Page anyone is actually talking to.
        assumedDailyFloor: 4800,
        throttleCodes: [80001, 32],
        retryExtendsBlock: true,
      },
      notes:
        'The TOKEN TYPE selects the regime: "requests made with application or user access tokens are subject to Platform Rate Limits, while requests made with system user or page access tokens are subject to Business Use Case Rate Limits", and BUC wins when both could apply. So the D-027 credential mix-up does not merely return empty comments — it silently relocates the caller into a different, per-HOUR budget with a different error code, which is why BOTH 80001 (page/system-user token) and 32 (user token) are handled. ⚠ A THROTTLE MUST NOT BE RETRIED: "Continuing to make calls will continue to increase your call count, which will increase the time before calls will be successful again." Park for the header\'s `estimated_time_to_regain_access` (minutes); no fixed fallback duration is documented, so none may be invented.',
    },
    blockedOn: 'owner: Meta app review (identity, legal and business verification; multi-week lead time)',
  },

  instagram: {
    id: 'instagram',
    label: 'Instagram',
    egress: {
      hostPolicy: 'fixed',
      // INSTAGRAM_GRAPH_ORIGIN in instagram-common.ts. Instagram shares
      // Facebook's Graph host — that is a fact about the vendor, not a copied
      // constant, so both rows declare it independently.
      apiHosts: ['graph.facebook.com'],
      notes:
        'Instagram Platform is served by the Facebook Graph host. Declared on this row in its own right: if Instagram ever moves to graph.instagram.com, only this row changes.',
    },
    wave: 'B',
    verifiedAt: '2026-08-23',
    sources: [
      'https://developers.facebook.com/docs/instagram-platform/overview',
      'https://developers.facebook.com/docs/instagram-platform/content-publishing',
      'https://developers.facebook.com/docs/instagram-platform/comment-moderation',
      'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media',
      'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/',
      'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/',
      'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/',
      'https://developers.facebook.com/docs/permissions',
      'https://developers.facebook.com/docs/graph-api/overview/rate-limiting',
    ],
    auth: {
      mode: 'app-review',
      // FLAVOR CHOICE, not an omission (D-030). Two configurations exist and they
      // are separate app identities: "Instagram API with Business Login for
      // Instagram" (graph.instagram.com, an Instagram User token, no Facebook
      // Page) and "Instagram API with Facebook Login for Business"
      // (graph.facebook.com, a Facebook User or Page token, Page "Required").
      // We take the Facebook Login flavor because the Page half is already
      // landed and reviewed under P-016, and because P-018 (Threads) is
      // sequenced on sharing that same Meta app identity and review surface.
      // These scopes are therefore the instagram_* family, NOT the
      // instagram_business_* family, which belongs to the other flavor.
      scopes: [
        'instagram_basic',
        'instagram_content_publish',
        'instagram_manage_comments',
        'pages_show_list',
        'pages_read_engagement',
      ],
      notes:
        '⚠ D-024 FIRES HERE TOO — AND THIS NOTE PREVIOUSLY SAID IT DID NOT. The earlier text read "D-024 CHECK RAN AND PASSED HERE ... every scope string named by Instagram\'s tutorial pages WAS found in the permissions reference, unlike Facebook Pages". That was TRUE OF THE PAGES IT NAMED and FALSE AS THE PLATFORM-WIDE CLAIM it was written as: the probe covered the overview and tutorial pages, and the conclusion was stated about Instagram. Reading the `/replies` EDGE reference later found `page_read_engagement` — singular `page_` — listed among that edge\'s required permissions, and the permissions reference has no such entry (the real permission is the plural `pages_read_engagement`, which is also what this row requests). So Instagram\'s docs DO name a permission that does not exist; it just lives on an edge page, exactly where D-031 says the load-bearing facts hide. TWO LESSONS, and the second is the general one: (1) the edge pages carry the phantom permissions as well as the behavioural facts, so a D-024 sweep that reads only tutorials is not a sweep; (2) a probe\'s SCOPE bounds its claim — "every string on the pages I read" became "every string Instagram names" in the writing, and that widening is what made a correct measurement into a wrong statement. `ads_management` / `ads_read` are documented as needed only "if the user got a Page role through Business Manager" and are deliberately NOT requested: unjustifiable privilege at review for a capability we do not use, the same reasoning that excluded pages_manage_metadata for Pages. ACCOUNT SHAPE is a hard precondition, not a nicety: "your app users must have an Instagram professional account" (business or creator), it must be linked to a Facebook Page, and "your app user must also be able to perform admin-equivalent tasks on the linked Facebook Page". Advanced Access — required for any account we do not own — "requires App Review and Business Verification".',
    },
    read: {
      transport: 'poll-cursor',
      replay: 'watermark-rescan',
      backfill:
        'Re-read each watched media\'s comments and filter client-side against a stored timestamp watermark: "Comments cannot be filtered by timestamp" is stated verbatim on the edge reference, so there is no server-side replay of any kind. ⚠ THE EDGE IS CAPPED AND UNPAGEABLE AS DOCUMENTED — see the comments stream, where the consequence is a real loss bound rather than a performance note.',
      streams: {
        comments: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'GET /{ig-media-id}/comments — comments hang off MEDIA and no account-wide comments edge is documented, so this is one call PER WATCHED MEDIA and its cost scales with the watch window rather than with comment volume (the D-026 shape, reached independently from Instagram\'s own reference). THREE EDGE FACTS THAT ONLY THE EDGE PAGE STATES, and that the IG Media reference does NOT — reading only the latter produces a confidently wrong adapter: (1) "Returns a maximum of 50 comments per query", with NO paging cursors documented anywhere on the edge — so the result set is CAPPED and there is no documented way to ask for the next 50; (2) ordering IS guaranteed and is version-dependent — "Requests made using version 3.2+ will have results returned in reverse chronological order" — which is the OPPOSITE of the Pages feed\'s ranked ordering (D-025), so here newest-first is a real guarantee rather than an assumption; (3) the edge "Returns only top-level comments" by default, so `replies` must be requested through field expansion or every nested reply is silently absent — the same trap as Pages\' filter=stream default, by a different mechanism. TOGETHER THEY SET A LOSS BOUND, not a preference: newest-50 with no paging is exactly the right window for an incremental poll PROVIDED fewer than 50 new comments arrive between two polls, and a full 50-item page whose OLDEST item is still newer than the watermark means the window overflowed and older unseen comments are unreachable (D-031). The comment-moderation page\'s advice for this is webhooks — "We strongly recommend using webhooks to prevent rate limiting" — which D-003 declines for lack of public ingress, so the poll cost and this bound are accepted consequences of that decision, recorded rather than discovered later.',
        },
      },
    },
    write: {
      verbs: ['reply', 'post'],
      // Documented nowhere: no idempotency key, client token, request id or dedup
      // parameter. A retried publish creates a second post, exactly as on Pages.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'TWO SHAPES, NOT ONE. A reply is a single call — POST /{ig-comment-id}/replies. A POST is TWO — POST /{ig-id}/media creates a container, POST /{ig-id}/media_publish publishes it — and "The container was not published within 24 hours and has expired." THE TWO-STEP MODEL IS ALSO THE ONLY RECOVERY PATH, and it is strictly better than Pages\': when media_publish times out without returning a media id, the container\'s own `status_code` distinguishes an already-published call from a lost one (GET /{ig-container-id}?fields=status_code), where Pages\' single-call /feed leaves a timeout genuinely ambiguous. That is a DETECTION affordance, not idempotency — the retry still has to be gated on the probe, and the vendor\'s own polling guidance is "once per minute, for no more than 5 minutes".',
    },
    limits: {
      // TWO NON-FUNGIBLE REGIMES AT ONCE — the fact that forced D-030. Instagram
      // states a moving CALL budget and a fixed PUBLISHING cap, and neither can
      // be spent on the other's behalf.
      budgetHeaders: ['X-Business-Use-Case-Usage'],
      dynamicQuota: {
        // NOTE THE DRIVER, and do not read across from Facebook: the multiplier
        // is 4800 on BOTH platforms and the thing it multiplies is DIFFERENT.
        formula: 'Calls within 24 hours = 4800 * Number of Impressions',
        driver:
          'the number of times any content from the app user\'s Instagram professional account has entered a person\'s screen within the last 24 hours',
        usageHeader: 'X-Business-Use-Case-Usage',
        // Verified against the header's own documented `type` list, which reads
        // "ads_insights, ads_management, custom_audience, instagram, leadgen,
        // messenger, or pages" — so an Instagram adapter reading the `pages`
        // rows would be reading another product's budget.
        usageType: 'instagram',
        // The formula at one impression. The floor NUMBER coincides with
        // Facebook's and the reasoning does not: an account with a single
        // impression is a far smaller thing than one with a single engaged user,
        // so this is the same arithmetic on a different quantity, not a copy.
        assumedDailyFloor: 4800,
        // 80002 is Instagram's OWN BUC throttle code. Pages' 80001/32 are
        // documented as "Page calls made with a Page or System User access
        // token" and "Page calls made with a User access token" — different
        // product, and carrying them here would be inherited-not-verified.
        throttleCodes: [80002],
        retryExtendsBlock: true,
      },
      buckets: {
        publishing: {
          appliesTo: 'POST /{ig-id}/media_publish — organic feed posts (a carousel counts as one)',
          // THE VENDOR CONTRADICTS ITSELF ON THIS PAGE, so the lower figure is
          // taken and the disagreement is recorded rather than resolved by
          // preference. Under "Rate Limit": "Instagram accounts are limited to
          // 100 API-published posts within a 24-hour moving period." Under the
          // carousel limitations on the SAME page: "Accounts are limited to 50
          // published posts within a 24-hour period." Both sentences add
          // "Carousels count as a single post", so they are describing one
          // limit, not two. 50 is the safe reading; and unlike the call budget,
          // the real figure is QUERYABLE at runtime — see notes.
          perDay: 50,
          unit: 'calls',
          verbs: ['post'],
          notes:
            'Call-capped, not unit-capped: the cap counts PUBLISHES regardless of media size, and "This limit is enforced on the POST /{ig-id}/media_publish endpoint" — so container creation and status polling do not draw on it. `reply` is deliberately NOT declared here: a comment reply is not a published post and the cap is documented on media_publish alone, so replies fall to the call budget instead.',
        },
      },
      notes:
        'THE PUBLISHING CAP IS QUERYABLE AND THE CALL BUDGET IS NOT — the sharpest operational difference from Facebook Pages. GET /{ig-id}/content_publishing_limit reports "app user\'s current publishing rate limit usage" as an ABSOLUTE figure, so the 100-vs-50 documentation contradiction is resolvable at runtime by asking; the 50 above is only the compile-time floor to act on before the first answer arrives. The call budget has no such endpoint: X-Business-Use-Case-Usage reports percentages only, which is why `assumedDailyFloor` exists at all (D-029). ⚠ ONE UNRESOLVED AMBIGUITY, recorded rather than smoothed over: the Instagram overview states the call formula over "a rolling 24 hour window", while the header reference describes `call_count` as "a whole number expressing the percentage of allowed calls made by your app over a rolling one hour period". The two windows cannot both be right. It does not change the cap arithmetic — a percentage of the allowance is a headroom fraction either way — but it does change how fast headroom recovers, so no code may assume a recovery rate from it. ⚠ A THROTTLE MUST NOT BE RETRIED: "When the limit has been reached, stop making API calls. Continuing to make calls will continue to increase your call count, which will increase the time before calls will be successful again."',
    },
    blockedOn: 'owner: Meta app review (Advanced Access requires App Review and Business Verification; multi-week lead time)',
  },

  threads: {
    id: 'threads',
    label: 'Threads',
    egress: {
      hostPolicy: 'fixed',
      // THREADS_GRAPH_ORIGIN in threads-common.ts — "A THIRD HOST, not a third
      // product on a shared host", as this row's own note records.
      apiHosts: ['graph.threads.net'],
      notes:
        'Threads is served from its own Graph host, NOT graph.facebook.com. Allowlisting the Meta host here would silently re-admit the confusion the separate origin constant exists to prevent.',
    },
    wave: 'B',
    verifiedAt: '2026-08-23',
    sources: [
      'https://developers.facebook.com/docs/threads/overview',
      'https://developers.facebook.com/docs/threads/posts',
      'https://developers.facebook.com/docs/threads/reply-management',
      'https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/create-replies/',
      'https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/retrieve-replies/',
      'https://developers.facebook.com/docs/threads/retrieve-and-manage-replies/replies-and-conversations/',
      'https://developers.facebook.com/docs/threads/troubleshooting/',
      'https://developers.facebook.com/docs/permissions',
      'https://developers.facebook.com/docs/graph-api/overview/rate-limiting',
    ],
    auth: {
      mode: 'app-review',
      // A THIRD HOST, not a third product on a shared host. Threads runs on
      // graph.threads.net (graph.threads.com is documented as equivalent) at
      // v1.0 — NOT graph.facebook.com — so no Pages or Instagram URL helper,
      // version pin, or error-shape assumption transfers, however similar the
      // two-step publish looks.
      scopes: [
        'threads_basic',
        'threads_content_publish',
        'threads_manage_replies',
        'threads_read_replies',
      ],
      notes:
        '⚠ D-034 FIRED TWICE HERE, BOTH TIMES AS A MISSING SCOPE RATHER THAN A PHANTOM ONE — the inverse of Instagram, and the more dangerous direction. (1) `threads_read_replies` is documented plainly in the permissions reference ("read replies to a user\'s thread") and is NEVER named by the Threads overview, whose scope list runs threads_basic / threads_content_publish / threads_manage_replies / threads_delete / threads_location_tagging. An adapter built from the overview would ship without the one scope its entire read path needs — and per D-027 an under-privileged read on these surfaces returns EMPTY rather than erroring, so the failure would present as "this account has no replies", permanently and silently. A phantom permission fails loudly at the authorize call; a missing one fails silently forever. (2) The create-replies ENDPOINT page adds a gate no overview states: "To reply to a thread, you must meet one of the following permission requirements" — "You are the owner of the root thread post" OR "You have either the threads_keyword_search or the threads_manage_mentions permission." That is a SEPARATE gate from the capability scope: threads_manage_replies is still required to create a reply at all, and no amount of it entitles you to reply under someone else\'s root post. NEITHER review-heavy scope is requested, and that is a deliberate scope decision (D-039): v1 replies only under root posts this profile owns, which is exactly what the conversation-edge read feeds it, so ownership satisfies the gate for the real workload. Requesting a mentions or keyword-search scope would ask review for privilege the feature does not exercise — the same reasoning that excluded ads_management on Instagram and pages_manage_metadata on Pages. The adapter ENFORCES the boundary before the call rather than discovering it at runtime. `threads_delete`, `threads_location_tagging`, `threads_manage_insights`, `threads_business_basic`, `threads_profile_discovery` and `threads_share_to_instagram` all exist and are deliberately not requested. ACCOUNT TYPE IS NOT DOCUMENTED on any page read: the overview never states whether a linked Facebook Page or Instagram account is a precondition, unlike Instagram where the linked-Page requirement is stated outright. Recorded as unknown rather than assumed absent — an assumption in either direction is a review-time surprise.',
    },
    read: {
      transport: 'poll-cursor',
      replay: 'watermark-rescan',
      backfill:
        'Re-read the conversation edge newest-first and stop CLIENT-SIDE at a stored timestamp watermark: neither media-level edge documents a since/until filter, so there is no server-side replay to ask for. ⚠ UNLIKE INSTAGRAM, THE RESCAN IS PAGEABLE AND THEREFORE COMPLETE — see the replies stream, where this is a correctness property rather than a throughput note.',
      streams: {
        replies: {
          transport: 'poll-cursor',
          replay: 'watermark-rescan',
          backfill:
            'TWO EDGES EXIST AND THE CHOICE BETWEEN THEM IS LOAD-BEARING. "GET {media-id}/replies only returns the top-level replies under the Threads ID provided in the request, while GET {media-id}/conversation returns all replies, regardless of the depth" — the latter being "a paginated and flattened list of all top-level and nested replies". The adapter takes `conversation`: a flattened all-depth read is exactly the ingestion shape, and the alternative is chasing `has_replies` down the tree with one call per level. Its stated caveat is respected — "This endpoint is only intended to be used on the root-level threads with replies" — so it is called on root media only. ⚠⚠ THE CLASS IS INSTAGRAM\'S AND THE CONSEQUENCE IS NOT (D-036). Both platforms are `watermark-rescan`, because neither offers a time filter and the client must stop at its own watermark. But Instagram\'s edge is capped at 50 with NO paging, which converts that into a permanent LOSS BOUND (D-031); both Threads edges are documented as paginated, both return paging.cursors.before/after, and NO cap phrase ("returns a maximum of N") appears anywhere on the page. So the Threads rescan can page backwards until it reaches the watermark: cost grows with the gap, and nothing falls off the end. THE ADAPTER THEREFORE NEVER SETS `lossRisk`, and that absence is a verified fact rather than an adapter declining to compute the predicate. ⚠ THE PROVIDER CURSOR IS NOT A RESUME POINT and must not be persisted as one: the docs never state how to pass a cursor in a request (cursors appear only in sample responses), and an `after` on a reverse-chronological list addresses a position within one result set, not a position in a stream — the same trap this registry already records against YouTube\'s pageToken. Ordering IS controllable: `reverse` is documented on both edges, "true if replies should be sorted in reverse chronological order", defaulting to true. Fields carry `root_post` ("Media ID of the top-level post or original thread in the reply tree") and `replied_to` ("Media ID of the immediate parent of the reply"), so the tree is reconstructable client-side from a flat list.',
        },
      },
    },
    write: {
      verbs: ['reply', 'post'],
      // Documented nowhere across the eight pages read: no idempotency key,
      // client token, request id or dedup parameter. A retried publish creates
      // a second post, exactly as on Pages and Instagram.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        '⚠ ONE SHAPE, NOT TWO — AND THIS IS WHERE COPYING P-017 WOULD GO WRONG (D-035). Instagram is asymmetric: a reply is ONE call (POST /{ig-comment-id}/replies) and a post is TWO. Threads collapses both into the SAME two-step flow — POST /{threads-user-id}/threads to build a container, then POST /{threads-user-id}/threads_publish with `creation_id` — differing only by one container parameter, `reply_to_id`. An adapter modelled on Instagram would invent a distinction the vendor does not have. SECOND, AND OPPOSITE TO INSTAGRAM: nested replies are addressable. "Use the reply_to_id parameter to reply to a specific reply under the root post." D-031 recorded that Instagram silently RE-PARENTS a reply-to-a-reply onto the top-level comment; Threads honours the exact parent, so the id is passed through verbatim rather than normalised up to a root. TIMING — TWO CONSTANTS, ONE SHARED WITH INSTAGRAM AND ONE NOT, so both are cited rather than either being read across (D-005): Threads states "It is recommended to wait on average 30 seconds before publishing a Threads media container" (Threads-only; Instagram states no such pre-wait), while its troubleshooting page states "We recommend querying a container\'s status once per minute, for no more than 5 minutes" — the SAME polling cadence Instagram documents. CONTAINER EXPIRY IS 24h AND WAS VERIFIED ON THREADS\' OWN PAGE rather than inherited: the container status endpoint GET /{threads-container-id} documents EXPIRED as "The container was not published within 24 hours and has expired", alongside ERROR, FINISHED, IN_PROGRESS and PUBLISHED. That status endpoint is the same DETECTION affordance Instagram has and Pages lacks — a publish that times out without returning an id can be disambiguated by asking the container what happened — but it is detection, not idempotency (D-033): the retry still has to be gated on the probe. TEXT-PRIMARY, THE OPPOSITE OF INSTAGRAM (D-032, asked rather than assumed): media_type is TEXT | IMAGE | VIDEO (CAROUSEL for the parent container only), `text` is "Required for media_type=TEXT", and the posts page\'s own worked example is "Create a media container with text only". So a Threads post needs NO media, and an adapter copied from instagram-write-adapter would have refused every valid text post. Text caps at 500 characters; carousels take 2–20 children; links cap at 5; link_attachment and gif_attachment are TEXT-ONLY and "will not work with image, video, or carousel posts".',
    },
    limits: {
      // NO `budgetHeaders`, DELIBERATELY AND VERIFIABLY (D-037). Pages and
      // Instagram both report budget as a percentage in
      // X-Business-Use-Case-Usage; Threads publishes no usage header at all.
      // This is a documented exclusion rather than an unread page: Threads is
      // absent from the BUC error-code table AND from the enumerated `type`
      // values of that header, where every sibling product is listed.
      dynamicQuota: {
        formula: 'Calls within 24 hours = 4800 * Number of Impressions',
        driver:
          'the number of times the app user\'s Threads content has entered a person\'s screen within the last 24 hours',
        // ⚠ NOT 4800 — AND THE DIFFERENCE FROM INSTAGRAM IS DOCUMENTED, NOT AN
        // ERROR IN EITHER ROW (D-038). Threads states "The minimum value for
        // impressions is 10 (so if the impressions is less than 10 we default
        // to 10)", so the formula's smallest real value is 4800 × 10. That
        // clause appears ONLY under Threads on the shared rate-limiting page;
        // the Instagram section carries the identical formula sentence with no
        // minimum, which is why Instagram's floor stays 4800. Harmonising the
        // two would have made Instagram's assumed budget ten times too
        // GENEROUS — the direction that fails only under real load.
        assumedDailyFloor: 48_000,
        // No `usageHeader` and no `throttleCodes`: Threads documents neither, so
        // consumption is UNOBSERVABLE and a live throttle is UNCLASSIFIABLE.
        // Instagram's 80002 and Pages' 80001/32 stay where they are — carrying
        // either here would mean watching for a code this host never emits and
        // parsing a header that is not sent, both of which read as "healthy".
        retryExtendsBlock: true,
      },
      // FOUR NON-FUNGIBLE PER-PROFILE BUCKETS over a rolling 24h — the richest
      // bucket picture of any platform in this registry, and the case D-030's
      // amended rule was written for: a bucket declaring a verb wins for that
      // verb. Note `replies` DECLARES ITS OWN BUCKET here, where on Instagram
      // replies were undeclared and fell through to the call budget.
      buckets: {
        publishing: {
          appliesTo:
            'POST /{threads-user-id}/threads_publish — "Threads profiles are limited to 250 published posts within a 24-hour moving period" (a carousel counts as one)',
          perDay: 250,
          unit: 'calls',
          verbs: ['post'],
          notes:
            'Call-capped, not unit-capped: the cap counts PUBLISHES regardless of media size, and is enforced on threads_publish — so container creation and status polling do not draw on it. Unlike Instagram, the vendor does not contradict itself on this figure.',
        },
        replies: {
          appliesTo:
            'the reply half of POST /{threads-user-id}/threads_publish — "Threads profiles are limited to 1,000 replies within a 24-hour moving period"',
          perDay: 1_000,
          unit: 'calls',
          verbs: ['reply'],
          notes:
            'DECLARED, WHERE INSTAGRAM\'S WAS NOT. A Threads reply publishes through the same endpoint as a post but draws on a separate, four-times-larger allowance, so a reply may NOT be rationed against the publishing bucket and vice versa. This is exactly the pairing D-030 amended D-029 for.',
        },
        deletions: {
          appliesTo: 'post deletion — 100 within a 24-hour moving period',
          perDay: 100,
          unit: 'calls',
          verbs: ['delete'],
          notes:
            'Recorded although `delete` is NOT in this row\'s write.verbs and threads_delete is not requested: the bucket is documented, and omitting it would leave a later item to rediscover it. Declaring a bucket is not declaring the capability.',
        },
        locationSearch: {
          appliesTo: 'location search — 500 within a 24-hour moving period',
          perDay: 500,
          unit: 'calls',
          notes:
            'No `verbs`: location search maps to no verb in this registry\'s vocabulary, and per SocialQuotaBucket an omitted `verbs` means "not stated for any verb" — a consumer must never match it. Recorded for completeness only.',
        },
      },
      notes:
        '⚠⚠ THE WEAKEST OBSERVABILITY POSITION OF ANY PLATFORM IN THIS REGISTRY, and it is worth stating plainly because the row otherwise looks richer than Instagram\'s. THE BUCKETS ARE QUERYABLE AND THE CALL BUDGET IS NOT OBSERVABLE AT ALL. GET /{threads-user-id}/threads_publishing_limit returns ABSOLUTE figures for all four buckets (quota_usage/config, reply_quota_usage/reply_config, delete_*, location_search_*, each with quota_duration 86400) — strictly better than Instagram, whose header reports only percentages. But the 4800-per-impression CALL budget has neither an endpoint nor a header: nothing reports its consumption, so `observedPeakUsagePct` can never become non-null and the cap rests on assumedDailyFloor permanently. Combined with the absence of any documented throttle code, this means a Threads throttle can be neither predicted nor recognised — only avoided by rationing. THAT is why retryExtendsBlock is set: the "stop making API calls / continuing to make calls will continue to increase your call count, which will increase the time before calls will be successful again" guidance is stated in the Best Practices of BOTH the Platform and Business Use Case rate-limit systems, not scoped to any single product, so it governs Threads even though Threads appears in neither the error-code table nor the header type list. A generic exponential-backoff wrapper here would deepen every throttle it touched while presenting as provider flakiness. CPU-time limits scale the same way: 720000 × impressions for total_cputime, 2880000 × impressions for total_time.',
    },
    blockedOn:
      'owner: Meta app review (shares the Meta app identity with Instagram and Facebook Pages; threads_read_replies and threads_manage_replies both require review, and the account-type precondition is undocumented)',
  },

  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    egress: {
      hostPolicy: 'fixed',
      // TWO hosts, and the split is not cosmetic: every API call goes to
      // api.linkedin.com, while the ENTIRE OAuth surface lives on
      // www.linkedin.com (authorization, accessToken, JWKS, the OIDC discovery
      // document). Assuming one host for both — the shape most platforms here
      // have — breaks token exchange, so both are declared.
      apiHosts: ['api.linkedin.com', 'www.linkedin.com'],
      // ⚠ www.linkedin.com is NOT repeated here even though every emitted post
      // permalink is on it. `permalinkHosts` means "appears in payload URLs and
      // is NEVER fetched", and this host IS fetched for OAuth — so listing it
      // in both would make the separation meaningless (a reader would take it
      // as a real restriction while the host stayed callable anyway).
      // media.licdn-ei.com is the genuine case: it appears only inside a
      // userinfo `picture` value and nothing here ever retrieves it.
      permalinkHosts: ['media.licdn-ei.com'],
      notes:
        'api.linkedin.com serves /rest/*, /v2/* and the /mediaUpload/* URL returned by assets?action=registerUpload. www.linkedin.com serves ONLY /oauth/* (authorization, accessToken, openid/jwks, .well-known/openid-configuration) — verified 2026-08-23 against the 3-legged OAuth guide and the OIDC discovery document, not inferred from api.linkedin.com.',
    },
    wave: 'C',
    verifiedAt: '2026-08-23',
    sources: [
      'https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access',
      'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin',
      'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2',
      'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api',
      'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/comments-api',
      'https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits',
      'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow',
    ],
    auth: {
      mode: 'self-serve-oauth',
      // EXACTLY the open-permissions set, enumerated from the endpoints this
      // adapter actually calls (D-034). `openid`/`profile` are needed because
      // the author URN is built from userinfo's `sub`; `w_member_social` is the
      // only open WRITE permission LinkedIn grants. `email` is deliberately NOT
      // requested — nothing here reads an address, and LinkedIn's own guide
      // says to request the least number of scopes.
      scopes: ['openid', 'profile', 'w_member_social'],
      notes:
        'Access tokens last 60 days (expires_in 5184000) and PROGRAMMATIC REFRESH IS PARTNER-ONLY ("available for a limited set of partners"). A self-serve integration therefore has no unattended renewal path: re-authorisation is a browser round-trip, silent only while the member is still logged into linkedin.com AND the current token has not yet expired. An unattended LinkedIn connection self-expires every 60 days by design — see blockedOn.',
    },
    // WRITE-ONLY. Not an omission — see the field docs on SocialPlatformRow.read.
    read: null,
    write: {
      // 'reply' is ABSENT and that is the single most important fact in this
      // row. LinkedIn's open-permissions reference lists exactly three
      // self-serve member scopes — profile, email, w_member_social — and the
      // Comments API, the endpoint that actually creates a comment, declares
      // `w_member_social_feed`, which is not among them.
      //
      // CONTESTED, and left contested rather than guessed: w_member_social's
      // own DESCRIPTION (in both the Posts API table and the permissions
      // reference) reads "Post, comment and like posts on behalf of an
      // authenticated member" — the scope's prose claims comment while the
      // commenting endpoint names a different scope. D-030's rule one level up
      // (the surface that DECLARES a verb wins for that verb) resolves it
      // toward the endpoint, so reply stays undeclared until a live call
      // settles it. Declaring it on the strength of the prose would put a
      // failing write on the owner's real public identity.
      verbs: ['post', 'delete'],
      // Asymmetric by verb, so the scalar means the WEAKEST (D-016): CREATE has
      // no idempotency mechanism of any kind, while DELETE is explicitly
      // idempotent ("Deletion requests for a previously deleted UGC Post will
      // return a 204").
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'CREATE HAS NO IDEMPOTENCY KEY AND THE DOCS TELL YOU TO RETRY ANYWAY: the Posts API error table lists 409 CONFLICT as "A write conflict occurred. Retry the request." Following that on a non-idempotent create is a duplicate-public-post generator, so linkedin-write-adapter.ts refuses to auto-retry a create and surfaces the ambiguity instead. DELETE is safe to retry (idempotent, 204 on already-deleted). Two documented create paths exist for the same grant — POST /rest/posts (versioned, current) and POST /v2/ugcPosts (legacy, still what the self-serve Share on LinkedIn page itself documents); the adapter uses /rest/posts and pins the version header.',
    },
    limits: {
      // The only ABSOLUTE figures LinkedIn publishes anywhere, and they are on
      // the Share on LinkedIn page specifically. Everything else is unpublished:
      // "Standard rate limits are not published in documentation" — they are
      // visible only in the Developer Portal Analytics tab, and only for
      // endpoints already called at least once that day.
      // TWO NON-FUNGIBLE BUDGETS (D-020), not one pool: burning the member
      // allowance does not touch the application allowance and vice versa, so a
      // single scalar would misreport both. The member bucket is the binding
      // one for a single owner — it is ~667x smaller — which is what a storm
      // policy must ration against.
      buckets: {
        member: {
          appliesTo: 'a single member per application, resetting midnight UTC',
          perDay: 150,
          unit: 'calls',
          verbs: ['post', 'delete'],
          notes:
            'The binding limit for one owner. Note this counts REQUESTS, not posts: a create is one call, so an adapter that also polled would spend the same 150.',
        },
        application: {
          appliesTo: 'the whole application across all members, resetting midnight UTC',
          perDay: 100_000,
          unit: 'calls',
          verbs: ['post', 'delete'],
        },
      },
      notes:
        'Member 150 requests/day, Application 100,000 requests/day, both resetting at midnight UTC. The member limit is the binding one for a single owner, so it is the floor here. ⚠ ZERO API-SIDE OBSERVABILITY: no response header reports quota or usage, and unlike Threads there is no limits ENDPOINT either, so observedPeakUsagePct can never become non-null and this floor is permanent. The only feedback loop is an email alert at 75% of quota — application-level only, explicitly not real-time ("delay of approximately 1-2 hours"), and therefore useless to the adapter. Throttling surfaces as HTTP 429, which is also returned "in rare cases ... as part of infrastructure protection", so a 429 is not proof the daily cap was reached. SECOND, INDEPENDENT THROTTLE: comment creation carries a "short term 1 minute rate limit" (429 "Comment create throttled: creation rate limit exceeded for member") — LinkedIn must not be modelled as daily-only, even though this adapter does not comment today.',
    },
    // ⚠ NO `blockedOn`, DELIBERATELY, AND THIS IS THE SUBTLEST LINE IN THE ROW.
    //
    // Setting it would have been the natural thing to do — LinkedIn genuinely
    // has owner-walled capabilities (reading anything, organization/page
    // access, and a recurring 60-day re-authorisation). But `blockedOn` is not
    // a notes field: `assertSocialPlatformUsable` THROWS on any row that
    // carries one, before it ever reaches the write gate. So describing those
    // walls here would have made the whole platform unusable — including the
    // self-serve personal posting path this item exists to deliver, and which
    // is verified above. The adapter would have been unreachable at runtime
    // while every unit test passed.
    //
    // Per the field's own definition ("blocked on something only the owner can
    // do"), nothing blocks what this row DECLARES. It declares post and delete
    // against the member's own profile; both are self-serve today. The walls
    // are already expressed structurally where they bind — `read: null` for the
    // read wall, the absent verbs for reply and organization posting — and in
    // prose in `auth.notes` (the 60-day re-authorisation) and `policyNotes`.
    //
    // KNOWN GAP this exposes rather than papers over: `blockedOn` is both the
    // hard usability gate AND the only owner-visible prose the admin pane
    // renders, so a platform that is USABLE but carries an operational caveat
    // has nowhere to say so. That conflation is a registry limitation, not a
    // LinkedIn one; the 60-day expiry is the first caveat to hit it.
    policyNotes:
      'The self-serve grant is write-only against the authenticated member\'s OWN profile. Organization/page posting (w_organization_social) and any read of posts or comments (r_member_social, r_member_social_feed) require approval — "Open Permissions are the only permissions that are available to all developers without special approval." Personal-profile posting itself needs no review. ⚠ OPERATIONAL: an unattended connection stops working every 60 days until the member re-authorises in a browser, because programmatic refresh tokens are partner-only.',
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    egress: {
      hostPolicy: 'fixed',
      // ONE API host for everything this row uses: open.tiktokapis.com serves
      // /v2/video/list/ and /v2/user/info/ (Display API) and the whole
      // /v2/post/publish/* family. open-upload.tiktokapis.com is deliberately
      // ABSENT: it is only ever reached by the FILE_UPLOAD write path, and this
      // row declares no write verbs, so granting it would be permission for a
      // call nothing here can make.
      apiHosts: ['open.tiktokapis.com'],
      permalinkHosts: ['www.tiktok.com'],
      notes:
        'open.tiktokapis.com verified 2026-08-23 against the v2 video-list reference and the Content Posting API reference (both name it as the host). www.tiktok.com appears only inside emitted permalink/embed values and is never fetched.',
    },
    wave: 'C',
    verifiedAt: '2026-08-23',
    sources: [
      'https://developers.tiktok.com/doc/tiktok-api-v2-video-list',
      'https://developers.tiktok.com/doc/display-api-get-started/',
      'https://developers.tiktok.com/doc/tiktok-api-scopes/',
      'https://developers.tiktok.com/doc/content-posting-api-get-started/',
      'https://developers.tiktok.com/doc/content-posting-api-reference-upload-video/',
      'https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status/',
      'https://developers.tiktok.com/doc/content-sharing-guidelines/',
    ],
    auth: {
      mode: 'app-review',
      // Enumerated from the endpoints this adapter ACTUALLY calls (D-034), not
      // copied from a product page. tiktok-videos-adapter calls exactly one
      // endpoint, POST /v2/video/list/, whose reference names `video.list`.
      // `user.info.basic` is here because the Display API prerequisites require
      // it alongside video.list for the authorization to be granted at all
      // ("You will need to set scope=user.info.basic,video.list").
      //
      // The three write scopes TikTok documents — video.publish, video.upload —
      // are deliberately NOT requested. This row declares no write verbs, and
      // TikTok's own guidance is to request the least number of scopes.
      scopes: ['user.info.basic', 'video.list'],
      notes:
        'Display API access requires app registration plus product approval for Login Kit and the Display API ("Approval for both a Login Kit and TikTok API products"). That is ordinary product onboarding and is SEPARATE from the Content Posting API audit, which gates posting visibility only and is irrelevant to this row because no write verb is declared.',
    },
    read: {
      transport: 'poll-cursor',
      // `watermark-rescan`, NOT `poll-cursor`, and the difference is the whole
      // correctness argument for this platform.
      //
      // TikTok DOES return a `cursor`, which is exactly why the honest class is
      // the weak one. Verbatim from the v2 video-list reference: "the cursor
      // value is a UTC Unix timestamp in milli-seconds. You can pass in a
      // customized timestamp to fetch the user's videos posted BEFORE the
      // provided timestamp" — and the list is "sorted by create_time in
      // descending order".
      //
      // So the cursor pages BACKWARD IN TIME. It is a paging token for one
      // descending scan, not a resumable forward position. Handing it your
      // stored watermark asks for everything you have ALREADY seen and never
      // the new items — and because `has_more` stays true while it walks into
      // ancient history, that inversion looks exactly like healthy paging while
      // emitting nothing new forever. Declaring `poll-cursor` here ("reading IS
      // the cursored poll: nothing to miss, no window to expire") would assert
      // precisely the resumability the vendor does not offer.
      replay: 'watermark-rescan',
      backfill:
        'Every pass restarts at the newest page (NO cursor) and walks backward via response.cursor while has_more, emitting items with create_time > the stored watermark and TERMINATING on the first item at or below it. Early termination is licensed here — unlike D-025 Facebook Pages, whose /feed is RANKED — because descending create_time order is documented. The persisted cursor is our OWN watermark (max create_time seen), never TikTok\'s cursor, which is valid only inside a single pass. Cold start bounds the walk by page count rather than paging all history.',
    },
    write: {
      // EMPTY, and this is a POSITIVE verified finding rather than an unwritten
      // row — the exact mirror of LinkedIn's `read: null` one wave earlier.
      // TikTok is the registry's first READ-ONLY platform.
      //
      // reply/delete: no such capability exists at this grant tier. The scopes
      // reference is a complete table and lists exactly three video scopes —
      // video.list, video.publish, video.upload — plus user.info.*; there is no
      // comment scope and no delete scope anywhere in it, and the Display API
      // surface is user info + video list + video query only. (That table
      // returning the video scopes IS the positive control for the absence:
      // the instrument answered, it just answered "not present".) The Research
      // API does document a comments query, but that is a separate
      // vetted-researcher product, not this grant.
      //
      // post: TikTok has TWO working write endpoints and NEITHER can honestly
      // implement this verb.
      //   1. Direct Post (/v2/post/publish/video/init/) works while unaudited —
      //      the plan item's premise that it does not is FALSE, verified on two
      //      pages — but "Unaudited API Clients can only post contents in
      //      SELF_ONLY viewership". SocialVisibility is
      //      'direct'|'followers'|'unlisted'|'public' with no self-only member,
      //      and VISIBILITY_ALIASES maps 'private' to 'followers'. So every
      //      caller's requested visibility would be silently DOWNGRADED to
      //      invisible. The codebase throws SocialVisibilityWidened to stop
      //      accidental WIDENING; this is that hazard's unguarded mirror, and a
      //      reply nobody can see is worse than a refusal because it reads as
      //      success.
      //   2. Draft/inbox (/v2/post/publish/inbox/video/init/) creates no post at
      //      all. It returns a publish_id and drops media in the creator's
      //      inbox; it reaches SEND_TO_USER_INBOX and becomes a post only if a
      //      HUMAN opens the notification and finishes it in TikTok's editor.
      //      SocialPostOutcome.externalId is "Platform id of the created post"
      //      and `ref` exists "so the caller can address it later" — a
      //      publish_id is neither.
      //
      // No contract change was needed to say this: socialWriteRefusal already
      // refuses an undeclared verb with "platform declares [], not 'post'",
      // which is the accurate report. Adding a `draft` verb for the inbox
      // handoff was considered and rejected — nothing in the mention/reply
      // workflow this plan exists to serve would call it.
      verbs: [],
      // No write verb is declared, so there is no write to deduplicate. Stated
      // as 'none' rather than 'unknown' because this is a verified reading of
      // the posting docs, not an unread fact: neither publish endpoint
      // documents an idempotency key or a replay-safe retry.
      idempotency: 'none',
      verifiedAt: '2026-08-23',
      notes:
        'READ-ONLY BY VERIFICATION, not by omission. Unaudited direct posting is SELF_ONLY viewership, requires every posting account to be private at the time of posting, and is capped at 5 users per 24h; the draft/inbox path publishes nothing without a human finishing it in the app. Neither is representable as `post`. If the owner ever completes the Content Posting API audit, the SELF_ONLY blocker on Direct Post lifts and `post` becomes declarable — the inbox path never does.',
    },
    limits: {
      // Deliberately NOT a made-up number. The Display API reference and its
      // get-started page state no rate limit anywhere, and the only published
      // figures on TikTok's side belong to the Content Posting API endpoints
      // this row does not call (inbox init 6/min, status fetch 30/min per user
      // access token). Inventing a requestsPerMinute for /v2/video/list/ would
      // put a guess where a storm policy reads a fact.
      notes:
        'NO rate limit is documented for the Display API (/v2/video/list/) on either its reference or its get-started page — verified 2026-08-23, an absence rather than an unread field. The published TikTok limits (6 req/min inbox init, 30 req/min status fetch, both per user access_token) belong to Content Posting endpoints this read-only row never calls. max_count is the one hard documented bound on this endpoint: default 10, maximum 20.',
    },
    policyNotes:
      'The Content Posting API audit is real owner-side work but it walls only capabilities this row does not declare, so per D-054 it is NOT set as blockedOn — doing so would refuse the whole platform including the read path that does work. Passing the audit lifts SELF_ONLY and the 5-user cap but not the per-creator posting cap (~15 posts/day/creator, shared across all Direct Post clients) or the 24-hour active-creator cap. Note also that /v2/video/list/ returns only the user\'s own PUBLIC videos: TikTok can therefore never serve the mention-triage or comment-digest workflows, because it exposes no comment surface at all.',
  },

  'x-twitter': {
    id: 'x-twitter',
    label: 'X (Twitter)',
    egress: {
      hostPolicy: 'fixed',
      apiHosts: [],
      notes: 'Not yet verified — P-020 is parked on an owner cost decision (D-002). Empty means DENY, not "unconstrained".',
    },
    wave: 'C',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'paid-tier', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['reply', 'post', 'delete'], idempotency: 'unknown', verifiedAt: null },
    limits: {},
    policyNotes:
      'D-002 rejected the alternatives on record: no scraping or unofficial client (against terms, and it would be the only integration not riding a sanctioned API), and no free-tier write-only adapter (it cannot serve the mention-triage or comment-digest workflows, so it would ship a hollow row that reads as support).',
    blockedOn: 'owner: paid-tier purchase authorization — a recurring cost outside agent authority under any mode (D-002)',
  },
};

/** Every platform row, in registry order. */
export function listSocialPlatforms(): SocialPlatformRow[] {
  return Object.values(ROWS);
}

/** One row by id, or undefined when the id is not a known platform. */
export function getSocialPlatform(id: string): SocialPlatformRow | undefined {
  return ROWS[id as SocialPlatformId];
}

/** Rows in a given acquisition wave. */
export function listSocialPlatformsByWave(wave: SocialPlatformRow['wave']): SocialPlatformRow[] {
  return listSocialPlatforms().filter((row) => row.wave === wave);
}

/** True when the row has been verified against its cited sources. */
export function isSocialPlatformVerified(row: SocialPlatformRow): boolean {
  return typeof row.verifiedAt === 'string' && row.verifiedAt.length > 0 && row.sources.length > 0;
}

export class SocialPlatformUnusableError extends Error {
  readonly platformId: string;
  readonly reason:
    | 'unknown-platform'
    | 'unverified'
    | 'owner-blocked'
    | 'write-unverified'
    | 'write-verb-unsupported';

  constructor(platformId: string, reason: SocialPlatformUnusableError['reason'], detail: string) {
    super(`social_platform_unusable:${platformId}:${reason}: ${detail}`);
    this.name = 'SocialPlatformUnusableError';
    this.platformId = platformId;
    this.reason = reason;
  }
}

/**
 * Resolve a platform for USE, refusing anything not fit to run against.
 *
 * This is the enforcement half of D-005's ruling that an unverified row is
 * UNUSABLE rather than permissive. Adapters and the `social:*` verbs call this
 * instead of reading `getSocialPlatform` directly, so an unverified or
 * owner-blocked platform fails loudly at the seam rather than producing a
 * plausible-looking call against facts nobody checked.
 */
export function assertSocialPlatformUsable(id: string): SocialPlatformRow {
  const row = getSocialPlatform(id);
  if (!row) {
    throw new SocialPlatformUnusableError(id, 'unknown-platform', 'no such platform in the registry');
  }
  if (!isSocialPlatformVerified(row)) {
    throw new SocialPlatformUnusableError(
      id,
      'unverified',
      'row has no verifiedAt + sources; run this wave\'s just-in-time verification first (D-005)',
    );
  }
  if (row.blockedOn) {
    throw new SocialPlatformUnusableError(id, 'owner-blocked', row.blockedOn);
  }
  return row;
}

/** True when the WRITE path specifically has been verified against its sources. */
export function isSocialWriteVerified(row: SocialPlatformRow): boolean {
  return typeof row.write.verifiedAt === 'string' && row.write.verifiedAt.length > 0;
}

/**
 * Resolve a platform for a WRITE, refusing anything we cannot correctly call.
 *
 * Stricter than `assertSocialPlatformUsable` in one specific way, and the
 * distinction is the whole reason this exists: a row can be verified for
 * READING while its write path is not. Bluesky is that case today — the event
 * stream is exhaustively specified, so the ingest adapter is buildable now,
 * while the createRecord shape is unread and any write we emitted would be a
 * guess dressed as an integration.
 *
 * Failing here is CHEAP and loud. Not failing here means discovering the guess
 * at the moment it publishes to the owner's real public identity, where it is
 * neither cheap nor reversible.
 */
export function assertSocialWriteAllowed(id: string, verb: SocialWriteVerb): SocialPlatformRow {
  const row = assertSocialPlatformUsable(id);
  const refusal = socialWriteRefusal(row, verb);
  if (refusal) throw refusal;
  return row;
}

/**
 * The write-gate decision for an ALREADY-USABLE row, returned as a value rather
 * than thrown. `null` means the write is allowed.
 *
 * Split out of `assertSocialWriteAllowed` so the refusal logic can be exercised
 * against SYNTHETIC rows, and that is not a testing convenience — it closes a
 * coverage cliff that opened the moment Wave A finished verifying.
 *
 * As of 2026-08-23 every Wave A row is write-verified and every other row
 * carries `blockedOn`, which `assertSocialPlatformUsable` refuses FIRST. So
 * zero real registry rows reach the `write-unverified` branch below (measured,
 * not assumed — `platform-registry.test.ts` asserts the population). The branch
 * is the guard that stops a guessed write from reaching the owner's real public
 * identity, so leaving it reachable only by real data would have meant leaving
 * it untested until some future platform happened to verify its read path
 * before its write path — exactly the moment it must work.
 */
export function socialWriteRefusal(
  row: SocialPlatformRow,
  verb: SocialWriteVerb,
): SocialPlatformUnusableError | null {
  if (!row.write.verbs.includes(verb)) {
    return new SocialPlatformUnusableError(
      row.id,
      'write-verb-unsupported',
      `platform declares [${row.write.verbs.join(', ')}], not '${verb}'`,
    );
  }
  if (!isSocialWriteVerified(row)) {
    return new SocialPlatformUnusableError(
      row.id,
      'write-unverified',
      `the row is verified for reading but its WRITE path is not (write.verifiedAt is null)${
        row.write.notes ? ` — ${row.write.notes}` : ''
      }`,
    );
  }
  return null;
}
