/**
 * RateLimitGovernor — generic, domain-independent rate-limit pacing (resilience lib).
 *
 * A shared choke point callers pass requests through to PROACTIVELY stay under a provider's
 * limits instead of bursting past them — usable by ANY rate-limited/flaky I/O (LLM calls,
 * external APIs, sync, …), not just agents. Two limit models in one:
 *   - header-driven (provider returns rate-limit headers): RPM + ITPM + OTPM budgets synced
 *     from the response, plus honor retry-after/reset.
 *   - coarse (no per-minute headroom visible, e.g. a subscription): concurrency cap + react
 *     to 429 penalties only.
 * The concurrency cap is also the lever for OPAQUE callers (e.g. subprocesses whose internal
 * calls we can't see) — capping how many run at once is the real burst fix.
 *
 * `recordHeaders` understands the common Anthropic (`anthropic-ratelimit-*`) and OpenAI
 * (`x-ratelimit-*`) header conventions. The decision logic is a PURE core (testable with a
 * fake clock); the async `acquire()` is a thin loop over it using injected `now`/`sleep`.
 *
 * WINDOW SEMANTICS: the RPM/ITPM/OTPM accounting is a TUMBLING 60s window (a window older than
 * 60s reads fresh), not a continuously-replenishing leaky bucket — so it can allow a burst right
 * after a window flips. That coarseness is intentional (cheap, fake-clock-testable); the smoother
 * controls are layered on top: a 429 `penalize()` pauses hard, and `paceDelayMs` (review #7/#8)
 * spreads requests pre-emptively as `*-remaining` drops, so we glide toward a reset rather than
 * slamming into remaining=0 and tripping the limit.
 */

export interface GovernorLimits {
  /** Max concurrent in-flight turns (the burst lever for subprocess agents). */
  maxConcurrent: number;
  /** Requests per minute (provider RPM); undefined = unknown/unlimited. */
  rpm?: number;
  /** Input tokens per minute. */
  itpm?: number;
  /** Output tokens per minute. */
  otpm?: number;
}

export interface GovernorState {
  limits: GovernorLimits;
  inFlight: number;
  windowStart: number; // epoch ms of the current 60s window
  reqInWindow: number;
  inTokInWindow: number;
  outTokInWindow: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /**
   * Pre-emptive pacing gap (ms) between acquisitions, derived from headers when a dimension's
   * `*-remaining` is running low (review #7/#8: "slow as remaining drops" rather than the
   * all-or-nothing slam into remaining=0). 0 = no soft pacing. Only set in header-driven mode.
   */
  paceDelayMs: number;
  lastAcquireAt: number; // epoch ms of the last granted acquire (anchors the pace gap)
  /** ADAPTIVE per-account RPM factor ∈ [RPM_AIMD_MIN_FACTOR, 1] (2026-06-22). Multiplies `limits.rpm` so the
   *  governor paces to the account's LEARNED sustainable rate, not just the static floor. A rate-429 halves it;
   *  it recovers linearly to 1 over RPM_AIMD_RECOVER_MS. Optional (undefined ⇒ 1 = the configured floor, legacy
   *  behaviour). Paired with `rpmFactorAt` (when it was last set) to compute the time-decayed effective value. */
  rpmFactor?: number;
  rpmFactorAt?: number; // epoch ms the rpmFactor was last DECREASED (anchors the linear recovery)
  /**
   * SMOOTH the per-minute RPM allowance into an even inter-request pace (opt-in; the inference gateway
   * sets it on its per-account governors). A SUBSCRIPTION account exposes no per-minute headers, so
   * `paceDelayMs` stays 0 at low utilization — the per-minute COUNT gate then lets the WHOLE `effRpm`
   * allowance fire as an INSTANT BURST at each window start, which trips Anthropic's sub-minute burst
   * limit (the `x-should-retry:true` bare-burst 429 storm, 2026-06-23) even though the per-minute
   * average is fine. With this on, decideRate floors the pace at WINDOW_MS/effRpm so the allowance is
   * spread evenly across the minute — throughput-NEUTRAL (the same ≤effRpm/min still passes the count
   * gate) but burst-safe. Undefined ⇒ off (legacy: the fleet concurrency governor is byte-identical).
   */
  smoothRpm?: boolean;
  /**
   * The most-constraining UNIFIED window observed from the latest response (Claude
   * Max/Pro subscription dialect — `anthropic-ratelimit-unified-*`). Subscriptions
   * expose a rolling-UTILIZATION budget (a 5-hour + 7-day window), NOT the per-minute
   * RPM/ITPM/OTPM headers, so this is the only honest "how close to the cap?" signal
   * for a subscription account. `undefined` until a unified header is seen. Observability
   * only (the pause/pace it drives lives in `pausedUntil`/`paceDelayMs`); surfaced by
   * `snapshot()` for the rate read-model (RB-009 / hive-inference-gateway P-014).
   */
  unified?: UnifiedWindowState;
}

/** The rolled-up state of the most-constraining unified (subscription) rate window. */
export interface UnifiedWindowState {
  /** Which window binds: `5h` | `7d` | `unified` (the representative claim). */
  window: string;
  /** Utilization fraction of that window (1.0 = at cap; >1 = over). */
  utilization: number;
  /** Epoch ms the binding window resets. 0 = unknown. */
  resetAt: number;
  /** Server verdict for the binding window: true once `status: rejected` was seen. */
  rejected: boolean;
  /** Epoch ms this reading was OBSERVED (the last time an upstream response actually carried this
   *  window's headers) — added for the gateway-healthz-stale-latch fix (EI-535): on an idle
   *  account/fleet, `recordHeaders` simply never runs again, so `rejected`/`utilization`/`resetAt`
   *  freeze at their last-seen values forever. A consumer reading `rejected:true` with no sense of
   *  WHEN that was observed can't tell "genuinely still rejected" from "last seen hours ago, and the
   *  window has long since rolled over" — this is that missing clock. Compare against `resetAt` (once
   *  it's in the past, the window this reading describes has already ended server-side) or against
   *  `Date.now()` for a plain staleness age. Optional so existing call sites/fixtures that construct
   *  a `UnifiedWindowState` by hand (tests, older persisted snapshots) stay valid — absence just means
   *  staleness can't be computed for that reading, not that it's fresh. */
  observedAt?: number;
  /** True when the same response said usage credits (overage) are serving this account
   *  (`anthropic-ratelimit-unified-overage-in-use: true`, or overage status allowed /
   *  allowed_warning). A `rejected` allowance window then does NOT stop the account — requests are
   *  billed from usage credits instead — so `recordHeaders` takes no pause for it, and a consumer
   *  must not read `rejected` as "cannot serve" (anthropic-credits-gateway-2026-09-30 P-008). */
  overage?: boolean;
}

export interface TokenEstimate {
  inTok?: number;
  outTok?: number;
}

export interface AcquireDecision {
  allowed: boolean;
  waitMs: number;
  reason?: 'paused' | 'concurrency' | 'rpm' | 'itpm' | 'otpm' | 'pace';
}

/** Why a bounded acquire could not admit a request. This is intentionally typed at the
 * governor boundary so callers do not infer pool state from provider prose. */
export type AdmissionDenialReason = 'rate-limit-blocked' | 'no-free-slot' | 'provider-429';

/**
 * The pre-WI-5435 spelling of `rate-limit-blocked`, retained ONLY so the ledger-read
 * boundary (scout/capacity-errors.ts `admissionDenialFrom`) can normalize rows persisted
 * before the rename. Never emit it.
 *
 * It was renamed because the name asserted a pool-wide fact the value never measured: it is
 * a static mapping over THIS ONE governor instance's own `d.reason` (see the mint site below)
 * and never reads the registry, the pool, or any sibling — a live row carried
 * `reason:'all-accounts-paused'` with `pausedAccounts:1` of `totalAccounts:2`. During a
 * failover certification that string reads as exculpatory evidence ("the pool was exhausted,
 * nothing to see here") while carrying no evidence at all, which is exactly how a genuine
 * failover defect (WI-4475) would stay hidden.
 */
export const LEGACY_RATE_LIMIT_BLOCKED_REASON = 'all-accounts-paused';

/** What ATTESTED the denial. A denial without a `via` stamp is evidence-free — the capacity
 * classifier (scout/capacity-errors.ts) refuses to exclude it from the error rate, so an
 * unstamped mint site fails LOUD (counted as an error), never silent (WI-5391 Part B). */
export type AdmissionDenialVia = 'governor' | 'http-429';

/** Which concurrency gate refused a `no-free-slot` denial — see `AdmissionDenial.gate`. */
export type AdmissionDenialGate = 'bucket' | 'fleet';

export interface AdmissionDenial {
  reason: AdmissionDenialReason;
  /** Evidence stamp: which authority minted this denial. Absent ⇒ evidence-free ⇒ not capacity. */
  via?: AdmissionDenialVia;
  /** The governor's raw internal decision reason (paused/rpm/itpm/otpm/pace/concurrency) — audit trail. */
  governorReason?: string;
  /** Pool counters at denial time (caller- or registry-provided): how many of the pool's
   * buckets were paused / existed when the permit was withheld. A governor-attested denial
   * WITHOUT these is excluded from the error rate on the governor's say-so alone with
   * nothing to retro-audit (WI-5391 item 3 — evidence parity with the http-429 leg's
   * persisted poolSnapshot). */
  pausedAccounts?: number;
  totalAccounts?: number;
  /** Free slots on the gate that actually REFUSED — a measurement, never a constant. See `gate`. */
  freeSlots?: number;
  /**
   * WHICH concurrency gate withheld the permit. A `no-free-slot` denial has two independent
   * sources and, before this stamp, minted BYTE-IDENTICAL evidence for both (WI-38062):
   *
   *   'bucket' — this governor's own `inFlight >= limits.maxConcurrent` (a per-(provider,
   *              modelClass[,account]) cap from DEFAULT_FLOORS; it does NOT scale with pool size).
   *   'fleet'  — the registry's shared cross-bucket gate, `globalInFlight >= min(globalCap,
   *              aimdEff)`, i.e. the user's live `maxSimultaneousAgents`.
   *
   * The distinction is load-bearing twice over. (1) The two have OPPOSITE fixes: a bucket denial
   * is a bucket-identity/limit problem, while a fleet denial is genuine fleet-wide concurrency
   * exhaustion that no per-bucket change can relieve. (2) `no-free-slot` is deliberately kept
   * LOUD as an admission-path DEFECT (scout/capacity-errors.ts), so a fleet-gate denial counted
   * without this stamp books real capacity exhaustion as a code defect.
   *
   * Absent ⇒ the denial was not a concurrency denial (or predates the stamp) — never read a
   * missing `gate` as 'bucket'.
   */
  gate?: AdmissionDenialGate;
  /** The refusing gate's live occupancy at denial time (pairs with `gateLimit`). */
  gateInFlight?: number;
  /** The refusing gate's effective limit at denial time. `Infinity` is reported as absent. */
  gateLimit?: number;
}

const WINDOW_MS = 60_000;
const CONCURRENCY_POLL_MS = 250; // we don't know when a peer releases → short re-poll
// Cascade-aware staggered resume (rate-limit-layer-v2 D-006): waiters parked on one pause get
// ORDERED per-waiter offsets so they wake spread over a bounded window instead of re-stampeding
// the limit at the same `pausedUntil` instant. Deterministic (ticket × step, capped) — testable
// with a fake clock and no Math.random.
const RESUME_STAGGER_STEP_MS = 250;
const RESUME_STAGGER_MAX_MS = 5_000;
// "Slow as remaining drops" knobs (review #7/#8). Below this fraction of a dimension's limit we
// start spreading the remaining budget over the time-to-reset; the per-acquire gap is capped so
// soft pacing never becomes a de-facto long pause (that's what a 429 penalty is for).
const LOW_WATERMARK = 0.2;
const MAX_PACE_DELAY_MS = 5_000;
// ADAPTIVE per-account RPM (AIMD-on-rate, 2026-06-22 owner-requested predict→wait→learn→retry). A Claude-Max
// SUBSCRIPTION account exposes NO per-minute headroom headers, so `limits.rpm` is a STATIC conservative floor
// the governor can never learn DOWN — an account whose real sustainable rate is below the floor (e.g. Anthropic
// soft-throttled it) keeps getting paced at the floor and keeps 429ing. This is the per-account-RATE analog of
// the GLOBAL concurrency AIMD: a learned `rpmFactor∈[MIN,1]` multiplies the floor. A RATE 429 (transient
// burst-throttle — NOT a 5h/7d usage cap, NOT a transport stall) HALVES it ("the prediction was too high"); it
// then RECOVERS linearly back to 1 over RECOVER_MS ("probe for more headroom") so a transient throttle doesn't
// permanently cap the account. decideRate paces to `floor × effectiveRpmFactor`, so the existing rpm wait-gate
// now holds requests at each account's LEARNED rate → it stops walking into the same 429. Env-tunable.
const RPM_AIMD_DECREASE = Number(process.env.PAPERCUSP_GATEWAY_RPM_AIMD_DECREASE) || 0.5;
const RPM_AIMD_MIN_FACTOR = Number(process.env.PAPERCUSP_GATEWAY_RPM_AIMD_MIN) || 0.1;
const RPM_AIMD_RECOVER_MS = Number(process.env.PAPERCUSP_GATEWAY_RPM_AIMD_RECOVER_MS) || 5 * 60_000;
// After a REAL rejection, the utilization a rolling window must age back below before the account is
// worth re-probing — it only scales the post-rejection re-probe interval (scaledReprobeAt). It is NOT a
// pause trigger: the former predictive pause at ≥ this value on a still-ALLOWED window was removed
// (owner Avi 2026-10-01, WI-10004492 — accounts serve until an actual penalty).
const REPROBE_RECOVERY_TARGET_UTIL = 0.95;
// Rolling-utilization (subscription) windows — Claude Max 5h/7d — recover CONTINUOUSLY as old usage
// ages out, so the window `reset` is when it FULLY clears, NOT when you can next send. Pausing a
// rejection to the full multi-hour reset therefore goes stale ("paused until 09:10 with zero
// pressure" long after the window freed = false exhaustion). Instead a rejection backs off this
// bounded interval then RE-PROBES — the next response's utilization is the truth, so the fleet
// resumes the moment the window frees. A few extra 429s under genuine sustained exhaustion is the
// (cheap) cost; the failover/selector route traffic away in the meantime.
export const ROLLING_WINDOW_REPROBE_MS = 2 * 60_000;
/** Upper bound on the SCALED post-rejection re-probe (below). Even a fully-spent window re-probes at least this
 *  often, so a faster-than-estimated recovery (the fleet stopped using the account) is still caught. Env-tunable. */
export const ROLLING_WINDOW_REPROBE_MAX_MS = Number(process.env.PAPERCUSP_ROLLING_REPROBE_MAX_MS) || 30 * 60_000;

/** Re-probe horizon SCALED to a rolling window's recovery (owner-reported 2026-06-21: agents pinned to a
 *  97%-7d account 429'd repeatedly while that account's 5h window read empty). A rolling-utilization window
 *  recovers ~linearly toward 0 by `resetAt`, so the time for it to drop back below
 *  REPROBE_RECOVERY_TARGET_UTIL is ≈ (resetAt - now) × (util - target) / util. Applied ONLY after a real
 *  rejection (status `rejected`) — never to a still-allowed window. The 5h window (reset minutes-to-hours out)
 *  re-probes in minutes; a 7d window AT its cap (reset ~a day out) re-probes in ~tens of minutes — instead of
 *  the flat 2-min cadence, which on the 7d window just re-lured requests into a 429 every 2 minutes and never
 *  let the account stay parked so routing/failover could walk to one with weekly headroom. Clamped to
 *  [REPROBE_MS, REPROBE_MAX_MS]. */
function scaledReprobeAt(now: number, util: number, resetAt: number): number {
  const recover = Math.max(0, util - REPROBE_RECOVERY_TARGET_UTIL) / Math.max(util, 0.01);
  const scaled = resetAt > now ? (resetAt - now) * recover : 0;
  return now + Math.min(ROLLING_WINDOW_REPROBE_MAX_MS, Math.max(ROLLING_WINDOW_REPROBE_MS, scaled));
}

export function initGovernorState(limits: GovernorLimits): GovernorState {
  return {
    limits: { ...limits },
    inFlight: 0,
    windowStart: 0,
    reqInWindow: 0,
    inTokInWindow: 0,
    outTokInWindow: 0,
    pausedUntil: 0,
    paceDelayMs: 0,
    lastAcquireAt: 0,
  };
}

/** Effective window usage at `now` — a window older than 60s reads as fresh (0). */
function windowUsage(s: GovernorState, now: number): { req: number; inTok: number; outTok: number } {
  if (now - s.windowStart >= WINDOW_MS) return { req: 0, inTok: 0, outTok: 0 };
  return { req: s.reqInWindow, inTok: s.inTokInWindow, outTok: s.outTokInWindow };
}

/** The time-decayed adaptive RPM factor at `now` ∈ [RPM_AIMD_MIN_FACTOR, 1] (2026-06-22). A rate-429 dropped
 *  `rpmFactor` (multiplicative decrease, anchored at `rpmFactorAt`); here it RECOVERS linearly back to 1 over
 *  RPM_AIMD_RECOVER_MS, so a transient throttle paces the account hard right after the 429 and eases back as it
 *  proves it can sustain more. Pure (no mutation) — decideRate reads it; penalize anchors a fresh decrease.
 *  Undefined `rpmFactor` ⇒ 1 (legacy: pace to the configured floor unchanged). */
export function effectiveRpmFactor(s: GovernorState, now: number): number {
  const base = s.rpmFactor;
  if (base === undefined || base >= 1) return 1;
  const since = Math.max(0, now - (s.rpmFactorAt ?? 0));
  return Math.min(1, base + since / RPM_AIMD_RECOVER_MS);
}

/** PURE: the effective per-minute REQUEST allowance at `now` = floor(rpm × time-decayed factor), or
 *  `null` when no rpm floor is configured. The per-minute COUNT gate caps the rate to this; smoothing
 *  only reshapes WHEN those requests fire within the minute. SINGLE source of truth — decideRate gates
 *  on it AND /stats surfaces it (hive-inference-gateway P-005). */
export function effectiveRpm(s: GovernorState, now: number): number | null {
  if (s.limits.rpm === undefined) return null;
  return Math.max(1, Math.floor(s.limits.rpm * effectiveRpmFactor(s, now)));
}

/** PURE: the EFFECTIVE inter-request pace (ms) the rate gate enforces between acquisitions at `now`.
 *  It is the header-driven `paceDelayMs`, RAISED to the smoothing floor WINDOW_MS/effRpm when smoothRpm
 *  is engaged (so a subscription account's per-minute allowance is spread evenly instead of firing as an
 *  instant burst that trips the sub-minute 429). 0 = no pacing enforced. SINGLE source of truth —
 *  decideRate ENFORCES this value and /stats SURFACES it, so "is pacing actually working?" is data, not
 *  inference (hive-inference-gateway P-005). */
export function effectivePaceMs(s: GovernorState, now: number): number {
  let pace = s.paceDelayMs;
  const eff = effectiveRpm(s, now);
  if (s.smoothRpm && eff !== null) {
    pace = Math.max(pace, Math.ceil(WINDOW_MS / eff));
  }
  return pace;
}

/** PURE: the CONCURRENCY gate only (the per-process burst lever). Split out from `decideAcquire`
    so the cross-process store (RB-007) can run the RATE gate against the shared row while keeping
    concurrency local. */
export function decideConcurrency(s: GovernorState): AcquireDecision {
  if (s.inFlight >= s.limits.maxConcurrent) return { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
  return { allowed: true, waitMs: 0 };
}

/** PURE: the RATE + PAUSE + pacing gate (everything except concurrency) — the account-wide
    budget that RB-007 shares cross-process. */
export function decideRate(s: GovernorState, now: number, est: TokenEstimate = {}, allowSoftPaused = false): AcquireDecision {
  // A pause blocks admission — UNLESS the caller will accept a SOFT pause (window still allowed; the gateway's
  // last-resort fallback: serve a serviceable near-cap account rather than shed). A HARD pause (real 429 /
  // rejected window) always blocks. The pace below still applies, so a soft-paused account serves SLOWLY.
  if (now < s.pausedUntil && !(allowSoftPaused && isSoftPause(s))) {
    return { allowed: false, waitMs: s.pausedUntil - now, reason: 'paused' };
  }

  const u = windowUsage(s, now);
  const msToWindowReset = now - s.windowStart >= WINDOW_MS ? 0 : s.windowStart + WINDOW_MS - now;
  const inTok = est.inTok ?? 0;
  const outTok = est.outTok ?? 0;

  if (s.limits.rpm !== undefined) {
    // ADAPTIVE rpm (2026-06-22): pace to the account's LEARNED rate (floor × time-decayed factor), not just the
    // static floor — so a soft-throttled account is held under its real sustainable rate instead of re-429ing.
    const effRpm = effectiveRpm(s, now) as number; // non-null: limits.rpm is defined here
    if (u.req + 1 > effRpm) return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'rpm' };
  }
  if (s.limits.itpm !== undefined && u.inTok + inTok > s.limits.itpm) {
    return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'itpm' };
  }
  if (s.limits.otpm !== undefined && u.outTok + outTok > s.limits.otpm) {
    return { allowed: false, waitMs: Math.max(1, msToWindowReset), reason: 'otpm' };
  }
  // Pre-emptive pacing: when remaining is low (header-driven mode) we hold a small gap between
  // acquisitions so we glide to the reset instead of slamming into remaining=0 (review #7/#8).
  // SMOOTHING (smoothRpm, 2026-06-23): the header-driven `paceDelayMs` is only set when a TOKEN window
  // is near its cap — at low utilization it is 0, so the per-minute COUNT gate above lets the whole
  // `effRpm` allowance fire as an instant burst at window start, tripping Anthropic's sub-minute burst
  // limit (the bare-burst 429 storm). When smoothRpm is on, floor the pace at WINDOW_MS/effRpm so the
  // SAME per-minute allowance is spread evenly. Throughput-neutral (the count gate still caps the rate);
  // it only reshapes the burst. effRpm follows the learned rpmFactor, so 429-learning tightens it too.
  const pace = effectivePaceMs(s, now);
  if (pace > 0) {
    const nextAllowedAt = s.lastAcquireAt + pace;
    if (now < nextAllowedAt) return { allowed: false, waitMs: nextAllowedAt - now, reason: 'pace' };
  }
  return { allowed: true, waitMs: 0 };
}

/** PURE: may this turn proceed at `now`? Concurrency first, then the rate/pause budget. If not,
    how long to wait before re-checking. */
/**
 * SOFT pause vs HARD (rejected) pause (owner-reported 2026-06-21). A SOFT pause is a pause whose last-seen
 * window is still ALLOWED (status not `rejected`) — Anthropic would STILL serve this account. (Since
 * 2026-10-01, WI-10004492, recordHeaders no longer sets a predictive pause on an allowed window at all, so a
 * soft pause now only arises when some other path — e.g. a non-window 429 via `penalize()` — paused a bucket
 * whose window still reads allowed.) A HARD pause (a `rejected` window) means the account genuinely cannot serve. This predicate lets routing SERVE a
 * soft-paused account as a last-resort fallback (`allowSoftPaused`) instead of treating "near the cap" as
 * "down" and shedding — which manufactured "all accounts throttled" from accounts that still had residual
 * budget. No `unified` recorded yet ⇒ treat as HARD (conservative: don't override an unexplained pause).
 */
export function isSoftPause(s: GovernorState): boolean {
  // `rejected` is the AUTHORITATIVE "this window is over its cap / will 429" signal — trust it over the
  // utilization FRACTION. An account at util EXACTLY 1.0 but rejected:false is still ALLOWED by Anthropic
  // (the fraction rounded up / lagged a response), so it's serviceable — the old `utilization < 1` guard
  // wrongly excluded it and SHED an account Anthropic would still serve (owner-reported 2026-06-21). When it
  // genuinely tips over, the response carries status:rejected → isSoftPause flips false → hard pause.
  return s.unified !== undefined && !s.unified.rejected;
}

export function decideAcquire(s: GovernorState, now: number, est: TokenEstimate = {}, allowSoftPaused = false): AcquireDecision {
  const c = decideConcurrency(s);
  if (!c.allowed) return c;
  return decideRate(s, now, est, allowSoftPaused);
}

/** Commit the RATE side of an acquisition: roll the window if stale, then charge req/token usage
    + stamp the pace anchor. (Concurrency is charged separately so the store can keep it local.) */
export function recordRate(s: GovernorState, now: number, est: TokenEstimate = {}): void {
  if (now - s.windowStart >= WINDOW_MS) {
    s.windowStart = now;
    s.reqInWindow = 0;
    s.inTokInWindow = 0;
    s.outTokInWindow = 0;
  }
  s.reqInWindow += 1;
  s.inTokInWindow += est.inTok ?? 0;
  s.outTokInWindow += est.outTok ?? 0;
  s.lastAcquireAt = now;
}

/** Commit a full acquisition: charge the rate budget + take a concurrency slot. */
export function recordAcquire(s: GovernorState, now: number, est: TokenEstimate = {}): void {
  recordRate(s, now, est);
  s.inFlight += 1;
}

export function recordRelease(s: GovernorState): void {
  s.inFlight = Math.max(0, s.inFlight - 1);
}

/** On a 429: pause the bucket until the server's reset/retry-after. Never SHRINKS an existing pause
    (the most-conservative reset wins). `maxPauseMs` caps the pause to `now + maxPauseMs` — the caller
    sets it for a ROLLING-window subscription cap (Claude Max 5h/7d), which recovers continuously, so
    the bucket re-probes rather than sitting on the full multi-hour reset (the false-exhaustion bug).
    A classic per-minute 429 / a hard quota omits it and the precise reset is honored. */
export function recordPenalty(
  s: GovernorState,
  now: number,
  opts: { retryAfterMs?: number; resetAt?: number; maxPauseMs?: number },
): void {
  let until = Math.max(opts.resetAt ?? 0, opts.retryAfterMs !== undefined ? now + opts.retryAfterMs : 0);
  if (opts.maxPauseMs !== undefined && until > now + opts.maxPauseMs) until = now + opts.maxPauseMs;
  if (until > s.pausedUntil) s.pausedUntil = until;
}

const LC = (h: Record<string, string | undefined>): Record<string, string | undefined> => {
  const o: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
};

/** Parse a rate-reset header to epoch ms. The classic Anthropic dialect uses ISO-8601;
    the unified (subscription) dialect uses a bare unix-SECONDS integer. Returns 0 if unparseable. */
function parseResetToMs(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n); // seconds vs already-ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** Sync limits + pause from response headers (header-driven precise mode). */
export function recordHeaders(s: GovernorState, headers: Record<string, string | undefined>, now: number): void {
  const h = LC(headers);
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const rpm = num(h['anthropic-ratelimit-requests-limit'] ?? h['x-ratelimit-limit-requests']);
  if (rpm !== undefined) s.limits.rpm = rpm;
  const itpm = num(h['anthropic-ratelimit-input-tokens-limit']);
  if (itpm !== undefined) s.limits.itpm = itpm;
  const otpm = num(h['anthropic-ratelimit-output-tokens-limit']);
  if (otpm !== undefined) s.limits.otpm = otpm;

  // Per-dimension: remaining=0 → pause to reset; 0<remaining<watermark → pre-emptively pace
  // (spread the remaining budget over the time-to-reset). [remaining, reset, limit].
  const dims: Array<[string, string, number | undefined]> = [
    ['anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset', rpm],
    ['anthropic-ratelimit-input-tokens-remaining', 'anthropic-ratelimit-input-tokens-reset', itpm],
    ['anthropic-ratelimit-output-tokens-remaining', 'anthropic-ratelimit-output-tokens-reset', otpm],
    ['anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset', undefined],
  ];
  let pace = 0; // recomputed from THIS response — healthy headroom decays it back to 0
  for (const [remK, resetK, limit] of dims) {
    const rem = num(h[remK]);
    if (rem === undefined || !h[resetK]) continue;
    const t = Date.parse(h[resetK] as string);
    if (Number.isNaN(t)) continue;
    if (rem === 0) {
      if (t > s.pausedUntil) s.pausedUntil = t;
      continue;
    }
    // Soft pacing kicks in only once we know the dimension's ceiling and we're under the
    // low-watermark fraction of it: glide the remaining `rem` requests over `t - now`.
    if (limit !== undefined && limit > 0 && rem < limit * LOW_WATERMARK) {
      const msToReset = Math.max(0, t - now);
      const spread = Math.min(MAX_PACE_DELAY_MS, Math.floor(msToReset / rem));
      if (spread > pace) pace = spread;
    }
  }

  // Unified (subscription) dialect: rolling-UTILIZATION windows (5h + 7d), not per-minute
  // buckets — a Claude Max/Pro account never returns the classic `*-limit` headers. A window
  // `status: rejected` → bounded re-probe pause; high utilization (< 1, still allowed) → no pause
  // and no pace (it serves at full rate). The most-constraining window is recorded on `s.unified`
  // for observability (P-014). Resets are unix seconds here.
  const unifiedWindows: Array<{ window: string; statusK: string; utilK: string; resetK: string }> = [
    { window: '5h', statusK: 'anthropic-ratelimit-unified-5h-status', utilK: 'anthropic-ratelimit-unified-5h-utilization', resetK: 'anthropic-ratelimit-unified-5h-reset' },
    { window: '7d', statusK: 'anthropic-ratelimit-unified-7d-status', utilK: 'anthropic-ratelimit-unified-7d-utilization', resetK: 'anthropic-ratelimit-unified-7d-reset' },
    { window: 'unified', statusK: 'anthropic-ratelimit-unified-status', utilK: 'anthropic-ratelimit-unified-utilization', resetK: 'anthropic-ratelimit-unified-reset' },
  ];
  // Usage credits (overage) serving: past the allowance, Anthropic bills the request from usage
  // credits instead of refusing it, so a `rejected` allowance window — or one predicted to reject —
  // no longer means "this account cannot serve". Pausing it would strand credits the owner enabled
  // (anthropic-credits-gateway-2026-09-30 P-008, D-003). Overage that cannot serve (status rejected,
  // a disabled reason) is NOT this case: the allowance verdict stands and pauses as before.
  const overageStatus = String(h['anthropic-ratelimit-unified-overage-status'] ?? '').toLowerCase();
  const overageServes =
    String(h['anthropic-ratelimit-unified-overage-in-use'] ?? '').toLowerCase() === 'true' ||
    overageStatus === 'allowed' ||
    overageStatus === 'allowed_warning';
  let binding: UnifiedWindowState | undefined;
  for (const w of unifiedWindows) {
    const status = h[w.statusK];
    const util = num(h[w.utilK]);
    if (status === undefined && util === undefined) continue; // window not present
    const resetAt = parseResetToMs(h[w.resetK]);
    const rejected = status === 'rejected';
    // Bounded re-probe, NOT a hard-pause to the full reset: a rolling-utilization window recovers
    // continuously, so sitting on the multi-hour reset goes stale (false exhaustion). See
    // ROLLING_WINDOW_REPROBE_MS. The real `resetAt` is still recorded on `s.unified` (observability)
    // + used by the gateway failover's rejoin time.
    if (overageServes) {
      // Usage credits carry the request past the allowance: no pause (see overageServes above).
    } else if (rejected) {
      const reprobeAt = scaledReprobeAt(now, util ?? 1, resetAt);
      if (reprobeAt > s.pausedUntil) s.pausedUntil = reprobeAt;
    }
    // NO predictive pause on a window Anthropic still ALLOWS, however high its utilization (owner Avi,
    // 2026-10-01, WI-10004492: "let the account keep going until we hit an actual penalty — no early
    // pausing at 95%"). The former ≥0.95 predictive pause re-armed a 30-min park after EVERY served
    // request on an account with weekly headroom left (ownerhandle4 at 0.96 got ~1 request per 30 min while
    // the fleet starved), idling the last few % of each allowance. Only a real rejection (above) or a
    // 429 via `penalize()` pauses now.
    // NO utilization pacing either (owner Avi, 2026-10-01, WI-10004505: "remove that. keep the burn-rate
    // shed"). The former ≥0.8 soft pace spaced requests up to 5s apart as a window filled, throttling an
    // account that still had allowance. A high-but-allowed window now serves at full rate; the burn
    // governor's projected-exhaustion shed (WI-41147, outside this function) is the only pre-penalty brake.
    // Most-constraining window wins for observability: a rejected window beats an allowed one;
    // among same-verdict windows, the higher utilization binds.
    const u = util ?? (rejected ? 1 : 0);
    if (!binding || (rejected && !binding.rejected) || (rejected === binding.rejected && u > binding.utilization)) {
      binding = { window: w.window, utilization: u, resetAt, rejected, observedAt: now, ...(overageServes ? { overage: true } : {}) };
    }
  }
  if (binding) s.unified = binding;

  s.paceDelayMs = pace;
}

/** Fired when a pause is newly SET or EXTENDED (the 429/backpressure transition) — the hook a
    host uses to surface "rate-limited — paused until <reset>" to telemetry/UI (RB-009). Stays
    domain-free: the governor knows nothing about coord/PG/toasts; the host subscribes. */
export interface GovernorPauseEvent {
  pausedUntil: number;
  /** What drove the pause: a real rate `penalty` (429/usage-cap), the provider's window `headers`, or a
   *  `transport` failure (egress-proxy circuit). `transport` is NOT a budget/rate signal — it pauses the
   *  account only to route around a bad PROXY (the gateway's pin-yield reads pausedUntil) — so rate-limit
   *  consumers (account-pool exhaustion/scale-out, the "rate-limited" toast) MUST skip it, else a flaky
   *  proxy falsely reads as the account being rate-exhausted (2026-06-22 healthy-account-marked-exhausted bug). */
  source: 'penalty' | 'headers' | 'transport';
}

/**
 * Cross-process store seam (RB-007). The RATE + PAUSE budget (the account-wide part that causes
 * 429s when the fleet co-bursts) lives behind this so multiple processes share ONE budget;
 * CONCURRENCY stays per-process (a per-runner burst lever — cross-process concurrency would need
 * leasing, and the shared rate window already bounds aggregate request rate). `transact` does an
 * ATOMIC load→mutate→persist on the bucket's shared row (e.g. PG `SELECT … FOR UPDATE`); the
 * mutate runs the pure rate decision/record on the loaded state. Default = no store = pure
 * in-memory (the fast path, byte-identical to before).
 */
export interface GovernorStore {
  transact(key: string, floor: GovernorLimits, mutate: (s: GovernorState) => void): Promise<GovernorState>;
}

/**
 * Fleet-wide concurrency gate (rate-limit-layer-v2 D-004). A single shared counter+cap that
 * EVERY governor consults on top of its own per-bucket `maxConcurrent`, so the TOTAL in-flight
 * turns across all `(provider, modelClass)` buckets is bounded by the user's live
 * `maxSimultaneousAgents`. The same gate object is injected into every governor (by the
 * registry) so they share one counter. Domain-free: the governor knows only "ask before a slot,
 * give it back on release". Omit = no global cap (per-bucket behavior, byte-identical to before).
 */
/**
 * WHO observed a global-gate AIMD signal (capless-inference-gateway P-009).
 *
 * The gate's contraction used to be causally blind: any bucket's provider 429 halved the ONE
 * fleet-wide window, so a single exhausted account shrank every healthy sibling's admission.
 * With a multi-account pool that is not just unfair, it is UNSOUND — one account's 429 is
 * evidence about THAT account's budget, not about the pool's. This event carries the lane so a
 * gate can tell the two apart.
 */
export interface GlobalFeedbackEvent {
  /** Bucket key that observed it: `provider:modelClass` (pool-wide) or `provider:modelClass@accountId`. */
  lane?: string;
  /**
   * True when `lane` is ACCOUNT-KEYED — the observation belongs to one account's budget and must
   * NOT contract the fleet-wide window. That lane is already governed, and already recovers, by
   * its own per-bucket state (`rpmFactor` + `effectiveRpmFactor`'s linear recovery, and the
   * bounded re-probe pause) — so scoping here removes a DOUBLE penalty, it does not remove
   * governance. False/omitted = an account-blind or genuinely local-saturation signal, which
   * legitimately contracts the whole fleet (event-loop / connection pressure).
   */
  accountScoped?: boolean;
}

export interface GlobalConcurrencyGate {
  /**
   * Atomically take a global slot iff the caller's admission band has headroom.
   * `priorityTier` is optional so bare cap-only gates remain byte-compatible.
   */
  tryAcquire(opts?: { priorityTier?: number }): boolean;
  /** Return a global slot (paired 1:1 with a successful tryAcquire). */
  release(): void;
  /**
   * AIMD feedback (rate-limit-layer-v2 D-005). The governor reports each turn's health so the
   * gate can adapt its EFFECTIVE concurrency under the hard cap: `noteClean` after a release
   * whose turn saw no account-wide penalty (additive increase: +1 per N clean turns);
   * `notePenalty` on every account-wide penalize (multiplicative decrease: halve toward the
   * floor). Optional so a bare cap-only gate (tests, simple hosts) stays valid.
   *
   * CAUSAL SCOPE (capless-inference-gateway P-009, spec capless-p009-provider-governor@1):
   * the event carries WHICH lane observed the signal. A gate must contract only the causally
   * affected lane — an ACCOUNT-KEYED observation is one account's fact, never evidence about
   * its siblings, so it must not shrink the fleet-wide window. Omitting the argument keeps the
   * legacy account-blind meaning (a pool-wide signal), so existing gates stay byte-compatible.
   */
  noteClean?(ev?: GlobalFeedbackEvent): void;
  notePenalty?(ev?: GlobalFeedbackEvent): void;
  /**
   * The gate's live occupancy vs its effective limit for the caller's band — read ONLY to give a
   * fleet-gate denial real numbers instead of a constant (WI-38062). Best-effort and side-effect
   * free: a throw or undefined return mints the denial without them and never blocks admission.
   * Optional so a bare cap-only gate (tests, simple hosts) stays valid.
   */
  snapshot?(opts?: { priorityTier?: number }): { inFlight: number; limit: number } | undefined;
}

export interface GovernorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called (best-effort, synchronously) only when `pausedUntil` increases. Must not throw. */
  onPause?: (ev: GovernorPauseEvent) => void;
  /** Cross-process shared-budget store (RB-007). Omit for in-memory (per-process) governance. */
  store?: GovernorStore;
  /** Bucket key for the store (e.g. "anthropic:opus"). Required when `store` is set. */
  storeKey?: string;
  /** Fleet-wide concurrency gate (D-004) shared across all buckets. Omit = no global cap. */
  globalGate?: GlobalConcurrencyGate;
  /** Pool-wide counters stamped onto denials (WI-5391 item 3). The governor itself is ONE
   * bucket and cannot see its siblings; the registry (which can) injects this. Best-effort:
   * a throw or undefined return mints the denial without counters, never blocks admission. */
  poolCounters?: () => { pausedAccounts: number; totalAccounts: number } | undefined;
}

export interface AcquireOpts {
  /** Abort the wait (interactive callers) — acquire resolves to null. */
  signal?: AbortSignal;
  /** Give up (resolve null) rather than wait longer than this in total. */
  maxWaitMs?: number;
  /** Admit through a SOFT (predictive) pause — the bucket is paused but its window is still ALLOWED (see
   *  isSoftPause). The gateway sets this in its last-resort fallback to SERVE a serviceable near-cap account
   *  rather than shed (a HARD/rejected pause still blocks). The pace still applies, so it serves slowly. */
  allowSoftPaused?: boolean;
  /** Receives the typed reason when a bounded acquire gives up. */
  onDenied?: (denial: AdmissionDenial) => void;
  /**
   * Existing gateway priority tier for this call. The process-local global gate
   * uses it to preserve tier-1 headroom when AIMD sheds lower-priority traffic.
   */
  priorityTier?: number;
}

/** Async façade over the pure core: `acquire()` blocks until allowed, then returns a
    release fn. `recordResponse(headers)` and `penalize(opts)` feed the limiter. */
export class RateLimitGovernor {
  readonly state: GovernorState;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onPause?: (ev: GovernorPauseEvent) => void;
  private readonly store?: GovernorStore;
  private readonly storeKey?: string;
  private readonly globalGate?: GlobalConcurrencyGate;
  private readonly poolCounters?: () => { pausedAccounts: number; totalAccounts: number } | undefined;
  private readonly floor: GovernorLimits;
  /** Bumped on every account-wide penalty — lets a release decide whether its turn was CLEAN
      (no penalty between acquire and release) for the AIMD feedback (D-005). */
  private penaltySeq = 0;
  /** Staggered-resume bookkeeping (D-006): one ordered ticket per waiter per pause epoch. */
  private pauseEpochUntil = 0;
  private pauseTickets = 0;

  constructor(limits: GovernorLimits, deps: GovernorDeps = {}) {
    this.state = initGovernorState(limits);
    this.floor = { ...limits };
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onPause = deps.onPause;
    this.store = deps.store;
    this.storeKey = deps.storeKey;
    this.globalGate = deps.globalGate;
    this.poolCounters = deps.poolCounters;
    if (this.store && !this.storeKey) throw new Error('RateLimitGovernor: storeKey is required when a store is set');
  }

  /** Pull the shared RATE+PAUSE fields from a store-loaded state into the local snapshot (so
      `snapshot()` / observability reflect the shared budget; concurrency stays local). */
  private syncSharedInto(shared: GovernorState): void {
    const before = this.state.pausedUntil;
    this.state.windowStart = shared.windowStart;
    this.state.reqInWindow = shared.reqInWindow;
    this.state.inTokInWindow = shared.inTokInWindow;
    this.state.outTokInWindow = shared.outTokInWindow;
    this.state.pausedUntil = shared.pausedUntil;
    this.state.paceDelayMs = shared.paceDelayMs;
    this.state.lastAcquireAt = shared.lastAcquireAt;
    // C1 (inference-gateway-audit-2026-06-23): carry the persisted adaptive-RPM learned factor back into the
    // local snapshot, so decideRate paces at the LEARNED rate cross-process (not the static floor) — the whole
    // point of persisting it. The pair (factor + its decrease anchor) always moves together.
    this.state.rpmFactor = shared.rpmFactor;
    this.state.rpmFactorAt = shared.rpmFactorAt;
    this.state.limits = { ...this.state.limits, ...shared.limits, maxConcurrent: this.state.limits.maxConcurrent };
    this.notifyPauseIfExtended(before, 'penalty');
  }

  /** A point-in-time copy of the state (for observability — RB-009). */
  snapshot(): GovernorState {
    return { ...this.state, limits: { ...this.state.limits } };
  }

  /**
   * Re-base this bucket's CONSERVATIVE cold-start floor live (live-configurability-audit P-021,
   * the per-provider `fleet:governor_floors` override). An operator-chosen floor is taken DIRECTLY
   * into both the stored seed (`this.floor`, the store-transact fallback) and the live `state.limits`
   * — semantically "use THIS floor now", exactly as a cold start; header auto-tune then re-raises rpm
   * from here on the next response (recordResponse). `maxConcurrent` is the hard concurrency cap.
   * Only the provided, valid fields are applied; omitted fields keep their current value.
   */
  setFloor(next: Partial<GovernorLimits>): void {
    if (typeof next.maxConcurrent === 'number' && next.maxConcurrent >= 1) {
      const mc = Math.floor(next.maxConcurrent);
      this.floor.maxConcurrent = mc;
      this.state.limits.maxConcurrent = mc;
    }
    if ('rpm' in next) {
      const rpm = typeof next.rpm === 'number' && next.rpm > 0 ? next.rpm : undefined;
      this.floor.rpm = rpm;
      this.state.limits.rpm = rpm;
    }
  }

  /** Fire onPause iff the pause moved later (a real new/extended backpressure transition). */
  private notifyPauseIfExtended(before: number, source: GovernorPauseEvent['source']): void {
    if (!this.onPause) return;
    const after = this.state.pausedUntil;
    if (after > before && after > this.now()) {
      try {
        this.onPause({ pausedUntil: after, source });
      } catch {
        /* observability must never break the limiter */
      }
    }
  }

  /**
   * Acquire a permit, blocking until allowed. Returns a release fn, or `null` if it GAVE
   * UP — the abort signal fired, or the cumulative wait would exceed `opts.maxWaitMs`. The
   * null path is what lets an INTERACTIVE caller bail (surface "rate-limited until <reset>"
   * + escalate) instead of inheriting a far-off shared pause (e.g. a 5-hour-limit penalty
   * set by the gym) and freezing for hours (reviewer #3 / D-002). Unattended callers pass a
   * large maxWaitMs (or none → Infinity) and just wait.
   */
  async acquire(est: TokenEstimate = {}, opts: AcquireOpts = {}): Promise<(() => void) | null> {
    const maxWait = opts.maxWaitMs ?? Infinity;
    let waited = 0;
    let pauseTicket: number | undefined; // staggered-resume ticket for THIS waiter (D-006)
    const mkRelease = (): (() => void) => {
      const seqAtAcquire = this.penaltySeq;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        recordRelease(this.state);
        // AIMD feedback (D-005): a turn with no account-wide penalty in between is CLEAN.
        // P-009: the clean signal carries the same lane identity as the penalty, so a gate that
        // scopes contraction can scope recovery the same way and cannot drift between the two.
        if (this.penaltySeq === seqAtAcquire) {
          this.globalGate?.noteClean?.({
            lane: this.storeKey,
            accountScoped: this.storeKey?.includes('@') ?? false,
          });
        }
        this.globalGate?.release(); // give the fleet-wide slot back too (D-004)
      };
    };
    for (;;) {
      if (opts.signal?.aborted) return null;
      let d: AcquireDecision;
      // WHICH gate produced a `reason:'concurrency'` decision THIS iteration (WI-38062). Declared
      // inside the loop so a later iteration can never inherit an earlier one's attribution. Only
      // the two fleet-gate refusals below set it; every other concurrency decision comes from this
      // bucket's own decideConcurrency/decideAcquire, so the mint site reads an unset value as
      // 'bucket'. Attribute at the SOURCE — the two are indistinguishable by the time `d` is read.
      let concurrencyGate: AdmissionDenialGate | undefined;
      if (!this.store) {
        // IN-MEMORY fast path: decide + record SYNCHRONOUSLY (no await between the check and the
        // increment) so concurrency stays atomic under many interleaved callers.
        d = decideAcquire(this.state, this.now(), est, opts.allowSoftPaused);
        if (d.allowed) {
          // Fleet-wide cap (D-004): this bucket has room AND rate budget — now take a global slot.
          // If the fleet is at its cap, wait + re-poll (don't charge the bucket). Released in mkRelease.
          if (this.globalGate && !this.globalGate.tryAcquire({ priorityTier: opts.priorityTier })) {
            d = { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
            concurrencyGate = 'fleet'; // the FLEET cap refused, not this bucket (it had room)
          } else {
            recordAcquire(this.state, this.now(), est);
            return mkRelease();
          }
        }
      } else {
        // CROSS-PROCESS path (RB-007): concurrency is local; reserve the slot atomically (right
        // after the sync check, before any await), then run the RATE gate against the shared row.
        const c = decideConcurrency(this.state);
        if (c.allowed && this.globalGate && !this.globalGate.tryAcquire({ priorityTier: opts.priorityTier })) {
          // Bucket has room but the fleet-wide cap is reached (D-004) → wait, charge nothing.
          d = { allowed: false, waitMs: CONCURRENCY_POLL_MS, reason: 'concurrency' };
          concurrencyGate = 'fleet'; // the FLEET cap refused, not this bucket (it had room)
        } else if (c.allowed) {
          this.state.inFlight += 1; // reserve the local concurrency slot now
          let rateAllowed = false;
          let rateWait = CONCURRENCY_POLL_MS;
          let rateReason: AcquireDecision['reason'];
          try {
            const shared = await this.store.transact(this.storeKey!, this.floor, (s) => {
              // Local runtime shaping flags are process configuration, not persisted budget state.
              // Apply them to the shared row before deciding, or PG-backed gateway governors silently
              // lose smoothRpm and can still fire a sub-minute burst.
              s.smoothRpm = this.state.smoothRpm;
              const rd = decideRate(s, this.now(), est, opts.allowSoftPaused);
              rateAllowed = rd.allowed;
              rateWait = rd.waitMs;
              rateReason = rd.reason;
              if (rd.allowed) recordRate(s, this.now(), est);
            });
            this.syncSharedInto(shared);
          } finally {
            if (!rateAllowed) {
              this.state.inFlight -= 1; // give the reservation back on a rate denial
              this.globalGate?.release(); // and the fleet-wide slot taken just above (D-004)
            }
          }
          if (rateAllowed) return mkRelease();
          d = { allowed: false, waitMs: rateWait, reason: rateReason };
        } else {
          d = c;
        }
      }
      let w = Math.max(1, d.waitMs);
      // Staggered resume (D-006): every waiter parked on the SAME pause takes one ordered ticket;
      // its wake is offset by ticket × step (capped) so the fleet re-enters spread over a bounded
      // window instead of re-stampeding (and re-tripping) the limit at the reset instant.
      if (d.reason === 'paused') {
        if (pauseTicket === undefined || this.state.pausedUntil !== this.pauseEpochUntil) {
          if (this.state.pausedUntil !== this.pauseEpochUntil) {
            this.pauseEpochUntil = this.state.pausedUntil;
            this.pauseTickets = 0;
          }
          pauseTicket = this.pauseTickets++;
        }
        w += Math.min(pauseTicket * RESUME_STAGGER_STEP_MS, RESUME_STAGGER_MAX_MS);
      }
      if (waited + w > maxWait) {
        // Preserve the admission fact at the boundary. The registry-injected poolCounters give
        // the denial its retro-audit evidence (how many sibling buckets were walled, of how
        // many) — without them a governor-attested exclusion is unauditable (WI-5391 item 3).
        let counters: { pausedAccounts: number; totalAccounts: number } | undefined;
        try {
          counters = this.poolCounters?.();
        } catch {
          /* best-effort — counters must never block or break admission */
        }
        // WI-38062: attribute a concurrency denial to the gate that actually refused, and report
        // that gate's REAL occupancy. `freeSlots` was previously the literal 0 at this site — a
        // constant that measured nothing and read identically for both gates, which is the same
        // defect class as the LEGACY_RATE_LIMIT_BLOCKED_REASON rename above (a name asserting a
        // fact the value never measured). Bucket numbers are read from local state; fleet numbers
        // come from the registry gate's optional snapshot (best-effort — never blocks admission).
        const gate: AdmissionDenialGate | undefined = d.reason === 'concurrency' ? (concurrencyGate ?? 'bucket') : undefined;
        let gateInFlight: number | undefined;
        let gateLimit: number | undefined;
        if (gate === 'bucket') {
          gateInFlight = this.state.inFlight;
          gateLimit = this.state.limits.maxConcurrent;
        } else if (gate === 'fleet') {
          try {
            const snap = this.globalGate?.snapshot?.({ priorityTier: opts.priorityTier });
            if (snap) {
              gateInFlight = snap.inFlight;
              gateLimit = snap.limit;
            }
          } catch {
            /* best-effort evidence — must never block or break admission */
          }
        }
        // An unbounded cap carries no information as a number and must not serialize as `null`.
        if (gateLimit !== undefined && !Number.isFinite(gateLimit)) gateLimit = undefined;
        const freeSlots =
          gateInFlight !== undefined && gateLimit !== undefined ? Math.max(0, gateLimit - gateInFlight) : undefined;
        opts.onDenied?.({
          // A CLASS label over this bucket's own decision — "blocked for a rate-limit-ish
          // reason" vs "...for a concurrency reason". Deliberately NOT a pool claim: the
          // pool-aware evidence on the same row is `pausedAccounts`/`totalAccounts` below,
          // which come from a different read (governor-registry poolCounters). WI-5435.
          reason: d.reason === 'paused' || d.reason === 'rpm' || d.reason === 'itpm' || d.reason === 'otpm' || d.reason === 'pace'
            ? 'rate-limit-blocked'
            : 'no-free-slot',
          via: 'governor',
          ...(d.reason ? { governorReason: d.reason } : {}),
          ...(gate ? { gate } : {}),
          ...(gateInFlight !== undefined ? { gateInFlight } : {}),
          ...(gateLimit !== undefined ? { gateLimit } : {}),
          ...(freeSlots !== undefined ? { freeSlots } : {}),
          ...(counters ? { pausedAccounts: counters.pausedAccounts, totalAccounts: counters.totalAccounts } : {}),
        });
        return null; // would wait too long → give up, let the caller decide
      }
      waited += w;
      await this.sleep(w);
    }
  }

  recordResponse(headers: Record<string, string | undefined>): void {
    const before = this.state.pausedUntil;
    recordHeaders(this.state, headers, this.now());
    this.notifyPauseIfExtended(before, 'headers');
    // Converge the shared budget too (best-effort; the shared row is authoritative cross-process).
    if (this.store) void this.store.transact(this.storeKey!, this.floor, (s) => recordHeaders(s, headers, this.now())).catch(() => {});
  }

  penalize(opts: { retryAfterMs?: number; resetAt?: number; maxPauseMs?: number; transport?: boolean; rateLimited?: boolean }): void {
    const before = this.state.pausedUntil;
    // ADAPTIVE rpm (2026-06-22): a RATE 429 (a transient per-minute/burst throttle) means the prediction was too
    // HIGH — multiplicatively DECREASE this account's learned rpm factor so decideRate paces future requests under
    // its real sustainable rate (and the existing rpm wait-gate retries at that paced rate). Excluded: a usage-CAP
    // 429 (5h/7d is a token-budget dimension → utilization/switch-account handles it, NOT rpm) and a transport
    // stall (a proxy fault, not a rate signal). The factor recovers toward 1 over time (effectiveRpmFactor).
    if (opts.rateLimited && !opts.transport) {
      const tnow = this.now();
      this.state.rpmFactor = Math.max(RPM_AIMD_MIN_FACTOR, effectiveRpmFactor(this.state, tnow) * RPM_AIMD_DECREASE);
      this.state.rpmFactorAt = tnow;
    }
    this.penaltySeq += 1; // any in-flight turn that releases after this is NOT clean (D-005)
    // ROLLING-WINDOW FALSE-PAUSE FIX (2026-06-17): a 429 carrying a MULTI-HOUR reset must NEVER pause the
    // FLEET-WIDE bucket for hours. On 2026-06-17 a transient opus 429 (util still ALLOWED) carrying the
    // Claude-Max 7d rolling-window reset pinned every ACCOUNT-BLIND anthropic bucket ~16h out, locking the
    // whole fleet out of opus with $0/0-rpm (and it recurred from a fresh process that 429s before recording
    // a unified header). Cap the pause to a bounded re-probe — but ONLY for the account-blind (fleet-wide)
    // bucket. An ACCOUNT-KEYED bucket (`storeKey` carries '@<accountId>') is ONE account's state: there a
    // SUSTAINED 429 pattern is the genuine exhaustion signal the account-scale-out observer needs (each
    // penalty EXTENDS the pause → onPause re-fires → scale out — account-pool-store P-019/P-021), and a
    // per-account pause only gates that account (gateway failover routes around it), so it is left intact.
    // A governor with no key (direct construction / pre-store) is treated as fleet-wide → capped. The cap
    // is baked into `opts` HERE so the cross-process PG write below inherits it (the persisted row carries
    // no dialect). A caller's own TIGHTER maxPauseMs still wins.
    const accountKeyed = this.storeKey?.includes('@') ?? false;
    // RE-PROBE HORIZON for the PARK — two tiers, NEVER uncapped (2026-06-23 ownerhandle 12h over-park fix).
    //  • FAST (ROLLING_WINDOW_REPROBE_MS ~2min): a TRANSIENT rate-429 (`opts.rateLimited`, x-should-retry:true =
    //    "capacity exists, retry") OR a fleet-wide bucket. Not exhaustion → re-probe quickly.
    //  • SLOW (ROLLING_WINDOW_REPROBE_MAX_MS ~30min): an account-keyed USAGE-CAP (a genuine 5h/7d token-budget
    //    exhaustion). This used to be UNCAPPED — parked to the full multi-hour reset — which STRANDED an account
    //    whose rolling window had since aged back under cap, OR that was mis-classified as a hard cap, for up to
    //    12h despite having live budget (ownerhandle: a bare x-should-retry 429 yet pausedUntil ~12h out). A genuine
    //    cap simply re-penalizes on the ~30min re-probe (it 429s again → another ≤30min park), so penaltyCount
    //    still accrues and the sustained-exhaustion scale-out signal is preserved (it fires on each re-extend) —
    //    only the over-long PARK is bounded, reclaiming a recovered account's capacity within ~30min. A caller's
    //    own TIGHTER maxPauseMs still wins (the Math.min). Disable by raising PAPERCUSP_ROLLING_REPROBE_MAX_MS.
    const reprobeCapMs =
      !accountKeyed || opts.rateLimited === true ? ROLLING_WINDOW_REPROBE_MS : ROLLING_WINDOW_REPROBE_MAX_MS;
    const eff = { ...opts, maxPauseMs: Math.min(opts.maxPauseMs ?? Infinity, reprobeCapMs) };
    recordPenalty(this.state, this.now(), eff);
    // AIMD multiplicative decrease (D-005) — once per DISTINCT backpressure event (a pause that
    // actually extends), so N agents co-failing on the same 429 halve the fleet once, not N times.
    // A TRANSPORT pause is exempt: a flaky egress PROXY on one account is not provider rate pressure,
    // so it must not shrink the WHOLE fleet's concurrency (which would punish every healthy account for
    // one bad Rayobyte proxy). The pause is still set on this account's state (recordPenalty above) so
    // the gateway's pin-yield routes around the proxy; it just isn't a fleet-wide rate signal.
    // CAUSAL SCOPE (P-009, spec capless-p009-provider-governor@1): the lane identity rides along so the
    // gate can refuse to contract the FLEET on one account's observation. `accountKeyed` is the same
    // storeKey('@') test used for the re-probe tier above — an account-keyed bucket is ONE account's
    // budget, so its 429 is not evidence about its siblings. That lane still contracts: `rpmFactor` was
    // already multiplicatively decreased above and `recordPenalty` already parked it, both of which
    // recover on their own clock. Only the fleet-wide DOUBLE penalty is dropped.
    if (!opts.transport && this.state.pausedUntil > before) {
      this.globalGate?.notePenalty?.({ lane: this.storeKey, accountScoped: accountKeyed });
    }
    this.notifyPauseIfExtended(before, opts.transport ? 'transport' : 'penalty');
    // A 429 anywhere pauses the WHOLE account → push to the shared row so every process backs off.
    // The cross-process write must ALSO replay the rpmFactor multiplicative-decrease onto the SHARED row (C1,
    // 2026-06-23): recordPenalty alone carries only window/pause, so without this the persisted rpmFactor never
    // moves and every transact-loaded gate keeps reading factor 1 (adaptive-RPM dead in PG mode). Mirrors the
    // local decrease above; rateLimited-only (a usage-cap / transport is not an rpm signal).
    if (this.store)
      void this.store
        .transact(this.storeKey!, this.floor, (s) => {
          if (opts.rateLimited && !opts.transport) {
            s.rpmFactor = Math.max(RPM_AIMD_MIN_FACTOR, effectiveRpmFactor(s, this.now()) * RPM_AIMD_DECREASE);
            s.rpmFactorAt = this.now();
          }
          recordPenalty(s, this.now(), eff);
        })
        .catch(() => {});
  }

  /** Lift a TRANSPORT pause (an egress-proxy circuit pause) the MOMENT the proxy recovers — the dual of the
   *  egress circuit's `penalize`. A transport failure is NOT a budget/rate signal, so unlike a 429 pause
   *  (take-MAX, never shortened — it tracks real exhaustion) a transport pause MUST clear as soon as the
   *  proxy is healthy again, or a token-healthy account sits needlessly out of rotation for the full circuit
   *  window (owner-reported 2026-06-21: a flaky proxy recovering in seconds kept its account out 60s →
   *  empty-pool "all throttled" sheds). `setUntil` is the pause the egress circuit set; we only lift if the
   *  current pause is still ≤ that (i.e. a longer REAL rate-limit pause hasn't superseded it since). */
  liftTransportPause(setUntil: number): void {
    const now = this.now();
    if (this.state.pausedUntil > now && this.state.pausedUntil <= setUntil) {
      this.state.pausedUntil = now;
    }
  }

  /** Is this bucket SOFT-paused right now — paused, but its last-seen window was still ALLOWED (a predictive
   *  pause, not a real 429)? The gateway routes traffic AWAY from a soft-paused account when a healthier one
   *  exists, but SERVES it (via `acquire({allowSoftPaused:true})`) as a last resort instead of shedding —
   *  it still has residual budget Anthropic will honor. See {@link isSoftPause}. */
  softPaused(now: number = this.now()): boolean {
    return this.state.pausedUntil > now && isSoftPause(this.state);
  }
}
