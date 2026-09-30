/**
 * Gateway wedge / sustained-throttle DETECTOR — inference-gateway-robustness-audit-2026-06-20 P3
 * (B-GW-5: "Wedge metrics/alerting").
 *
 * The gateway watchdog (`watchdog.mjs`) DETECTS the wedge signature and auto-restarts the
 * :8788 service — but SILENTLY (it only logs to journald). This module is the VISIBILITY half:
 * a pure, unit-tested detector that turns a `/stats` snapshot (+ a prior sample for the temporal
 * "frozen" confirmation) into a structured metric bag + a wedge/throttle verdict the operator
 * surfaces on the Health tab's tokens/gateway panel AND the overwatch brief (the alert path).
 * "Complements the watchdog — it auto-restarts; this makes it VISIBLE."
 *
 * PURE by construction (no I/O, no clock except the injected `now`) so the signatures are trivially
 * testable — `detectGatewayWedge` on a simulated wedge snapshot is the acceptance test.
 *
 * DEPLOY-SKEW SAFE: the `/stats` JSON parsed at runtime comes from whatever gateway BINARY is live
 * on :8788, which may predate the B-GW-1 AIMD fields (`aimd`, `shedAllThrottled`, `concurrencyCap`).
 * Every field beyond the original `/stats` contract is therefore OPTIONAL here and read with a
 * default — so the detector works against both the pre-AIMD and post-AIMD gateway.
 */

/** The subset of the gateway `/stats` payload the detector reads. Fields added by B-GW-1 (AIMD) are
 *  OPTIONAL: a not-yet-redeployed gateway omits them (deploy-skew), so we never hard-depend on them. */
export interface RawGatewayStats {
  totalRequests?: number;
  inFlight?: number;
  queueDepth?: number;
  admission?: { running?: number; queued?: number; maxConcurrent?: number };
  upstream429?: number;
  /** Live per-account Cloudflare/per-IP bare-429 evidence, optional for deploy-skew readers. */
  edgeThrottleByAccount?: Record<
    string,
    { edgeThrottled?: boolean; cooldownUntil?: number; cooledIpCount?: number; bare429Streak?: number }
  >;
  queued429?: number;
  shed429?: number;
  upstreamErrors?: number;
  failovers?: number;
  /** unified-window utilization fraction (1.0 = at cap). */
  unified?: { utilization?: number };
  // ── B-GW-1 (AIMD) additions — optional until that gateway build is live ──────────────────────
  /** Count of 429s shed at admission because the WHOLE pool was throttled (fail-fast path). */
  shedAllThrottled?: number;
  /** The CONFIGURED admission-concurrency ceiling (AIMD recovers toward it). */
  concurrencyCap?: number;
  /** AIMD admission-concurrency state — `effective < cap` = currently throttled (sustained storm). */
  /** `decreases` is scoped by `countersSinceMs` (epoch-ms of its last reset) and is NOT a lifetime count —
   *  the gateway's per-lane view restarts it on every process restart. Both stay optional for deploy-skew:
   *  a pre-EI-21842988251907640 gateway omits `countersSinceMs`, and absent must be read as UNKNOWN scope,
   *  never as "lifetime". Do not difference `decreases` across two samples whose epochs differ. */
  aimd?: { effective?: number; cap?: number; floor?: number; decreases?: number; countersSinceMs?: number };
  /** P-005/W3 slot-leak recurrence guard (D-001): count of self-heal sweeps where the held-slot counter
   *  and the in-flight registry disagreed in a way the valve could not reclaim — a leaked admission slot
   *  surfaced as a COUNTED signal. Optional (deploy-skew): a pre-P-005 gateway omits it → read as 0. */
  slotReconcileMismatch?: number;
  /** EI-19303809952284205: the gateway's DURABLE-PATH health (db-health.ts). `ok:false` = its
   *  Postgres side-paths have been failing long enough that the account pool cannot reload, usage-window
   *  writes are dropped, and the gateway has silently fallen back to a single synthetic credential.
   *
   *  Optional for deploy-skew: `/admin/stats` is parsed off a REMOTE gateway process that may predate
   *  this field, and a long-lived gateway is EXACTLY the process this condition afflicts (the incident's
   *  gateway had been up 13.7 days). Absence means UNKNOWN — never healthy. */
  db?: {
    ok?: boolean;
    observed?: boolean;
    connectionLevel?: boolean;
    failingOps?: string[];
    unhealthyForMs?: number | null;
    lastError?: string | null;
  };
}

/** The structured gateway metrics surfaced on the dashboard (the "emit structured metrics" half). */
export interface GatewayMetrics {
  totalRequests: number;
  inFlight: number;
  queueDepth: number;
  /** Live effective admission cap (AIMD-adjusted when AIMD is active; the configured cap otherwise). */
  maxConcurrent: number;
  /** Configured admission ceiling (AIMD recovers toward it); null on a pre-AIMD gateway. */
  concurrencyCap: number | null;
  shed429: number;
  /** Fail-fast all-throttled shed count; 0 on a pre-AIMD gateway. */
  shedAllThrottled: number;
  failovers: number;
  upstream429: number;
  upstreamErrors: number;
  /** Unified-window utilization %, rounded; null when not seen. */
  utilizationPct: number | null;
  /** AIMD effective concurrency; null on a pre-AIMD gateway. */
  aimdEffective: number | null;
  /** AIMD ceiling; null on a pre-AIMD gateway. */
  aimdCap: number | null;
  /** AIMD multiplicative-decrease count SINCE `aimdCountersSinceMs` — NOT a lifetime count (EI-21842988251907640).
   *  A climbing value across samples with the SAME epoch = an active storm; null pre-AIMD. */
  aimdDecreases: number | null;
  /** Epoch-ms that bounds `aimdDecreases` — when that counter last reset (gateway process restart / lane
   *  registration). REQUIRED so the bounded number can never travel without its bound; `null` means the
   *  gateway did not report one, which is UNKNOWN scope, never "lifetime". A change in this value between
   *  two samples means the counter RESET, so a drop in `aimdDecreases` is a restart, not a recovery. */
  aimdCountersSinceMs: number | null;
  /** P-005/W3 slot-leak recurrence guard (D-001): count of un-reclaimable slot-reconcile mismatches. 0 on a
   *  pre-P-005 gateway (deploy-skew) or in healthy operation; any positive value = a leaked admission slot. */
  slotReconcileMismatch: number;
}

/** A minimal rolling sample the detector compares against to confirm the TEMPORAL wedge signature
 *  (frozen `totalRequests`) + a climbing-shed throttle. Persisted in-process by the collector. */
export interface GatewaySample {
  totalRequests: number;
  shed429: number;
  shedAllThrottled: number;
  /** Cumulative upstream TRANSPORT failures (stalls / connect-fails / token-refresh hangs). Its delta
   *  surfaces a transport-STALL storm (fault #5) — the dominant gateway failure under an Anthropic-wide
   *  hold-storm, which NEVER increments upstream429 (the gateway absorbs/rotates instead of 429-shedding)
   *  and so is otherwise invisible to the throttle detector. Optional so a partial/legacy prior (one
   *  built before this field existed) is simply skipped by trigger (d) rather than mis-compared. */
  upstreamErrors?: number;
  at: number; // epoch ms the sample was taken
}

/** The wedge/throttle verdict — the alert payload. */
export interface GatewayWedgeVerdict {
  /** Instantaneous wedge-RISK: at the live slot ceiling with work queued (the spatial half of the
   *  signature). On its own → a warn; CONFIRMED into a `wedge` once `totalRequests` also freezes. */
  saturated: boolean;
  /** CONFIRMED wedge: saturated AND `totalRequests` not advancing vs a recent prior — the exact
   *  signature the watchdog restarts on (frozen counter + every slot pinned + a growing queue). */
  wedge: boolean;
  /** Sustained upstream throttle: AIMD cut concurrency below its cap, or the pool is fail-fast
   *  shedding (all accounts throttled), or the admission backlog is overflowing. */
  sustainedThrottle: boolean;
  /** P-005/W3 (D-001): a leaked admission slot the self-heal valve could NOT reclaim — the gateway's
   *  own slot-reconcile guard counted a mismatch. Surfaces the leak as a signal BEFORE/ALONGSIDE the
   *  wedge it would otherwise silently ride to (watchdog restart). */
  slotLeak: boolean;
  /** WI-3565 (2026-07-09 admission-starvation incident): instantaneous risk that the admission
   *  backlog is deep relative to the LIVE ceiling — `queueDepth > ADMISSION_STARVATION_QUEUE_RATIO x
   *  maxConcurrent`. Deliberately DISTINCT from `saturated`: saturated requires `inFlight >=
   *  maxConcurrent` (every live slot pinned), but a starved queue can sit BELOW the ceiling the whole
   *  time (paced by a per-account/governor floor below the admission cap) — exactly the 2026-07-09
   *  incident (`running:1` against `maxConcurrent:2` with 24 queued for 50 unalarmed minutes). A lone
   *  reading can be a normal burst; the caller (gateway-sample-cache.ts) confirms SUSTAINED persistence
   *  before treating it as an alert. */
  admissionStarvationRisk: boolean;
  /** WI-3565: `admissionStarvationRisk` CONFIRMED sustained (persisted ≥
   *  `ADMISSION_STARVATION_MIN_PERSIST_MS` continuously) — the alert-worthy signal, mirroring how
   *  `wedge` confirms `saturated`. Always `false` from the pure `detectGatewayWedge()` call (it has
   *  no cross-tick history); only `gateway-sample-cache.ts#readGatewayWedge` (which tracks the
   *  streak) ever sets it `true`. */
  admissionStarved: boolean;
  /** Human reasons (each surfaced on the panel / overwatch anomaly). */
  reasons: string[];
}

/** WI-3565: the admission backlog must exceed this multiple of the live ceiling to count as a
 *  starvation RISK (a normal, brief queue bump is not itself a signal). Env-tunable. */
export const ADMISSION_STARVATION_QUEUE_RATIO =
  Number(process.env.PAPERCUSP_GATEWAY_ADMISSION_STARVATION_RATIO) || 4;

/** A prior older than this can no longer CONFIRM a freeze (a long-quiet gateway legitimately has a
 *  flat `totalRequests`; only a RECENT flat-while-saturated reading is the wedge). */
export const WEDGE_FREEZE_PRIOR_MAX_AGE_MS = 5 * 60_000;

/** Min increase in cumulative upstream TRANSPORT failures between two samples to flag a transport-STALL
 *  STORM (fault #5). Higher than the shed triggers' delta-of-1 because a lone proxy blip is normal churn —
 *  only a CLUSTER is the storm. The stall storm is the DOMINANT gateway failure under an Anthropic-wide
 *  hold-storm, yet it never increments `upstream429` (the gateway absorbs/rotates rather than 429-shedding)
 *  and doesn't shrink AIMD (429-driven) — so without a dedicated trigger it slips past (a)-(c) and the
 *  owner's health view reads "429-calm" while every account TTFB-stalls (the
 *  rate-limit-is-account-routing-not-capacity insight, fault #5). Env-tunable. */
export const STALL_STORM_DELTA = Number(process.env.PAPERCUSP_GATEWAY_STALL_STORM_DELTA) || 5;

function n(v: number | undefined, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Project a raw `/stats` payload into the structured metric bag (deploy-skew safe). */
export function summarizeGatewayMetrics(stats: RawGatewayStats): GatewayMetrics {
  // Prefer the admission snapshot's live values; fall back to the top-level mirrors.
  const inFlight = n(stats.admission?.running, n(stats.inFlight));
  const queueDepth = n(stats.admission?.queued, n(stats.queueDepth));
  const maxConcurrent = n(stats.admission?.maxConcurrent, n(stats.aimd?.cap, n(stats.concurrencyCap)));
  const util = stats.unified?.utilization;
  return {
    totalRequests: n(stats.totalRequests),
    inFlight,
    queueDepth,
    maxConcurrent,
    concurrencyCap: typeof stats.concurrencyCap === 'number' ? stats.concurrencyCap
      : typeof stats.aimd?.cap === 'number' ? stats.aimd.cap
      : null,
    shed429: n(stats.shed429),
    shedAllThrottled: n(stats.shedAllThrottled),
    failovers: n(stats.failovers),
    upstream429: n(stats.upstream429),
    upstreamErrors: n(stats.upstreamErrors),
    utilizationPct: typeof util === 'number' && Number.isFinite(util) ? Math.round(util * 100) : null,
    aimdEffective: typeof stats.aimd?.effective === 'number' ? stats.aimd.effective : null,
    aimdCap: typeof stats.aimd?.cap === 'number' ? stats.aimd.cap : null,
    aimdDecreases: typeof stats.aimd?.decreases === 'number' ? stats.aimd.decreases : null,
    // EI-21842988251907640: carry the EPOCH alongside the counter. Extracting `decreases` without it is
    // what let a per-process 0 be read as "never contracted"; a pre-fix gateway omits it → null = UNKNOWN.
    aimdCountersSinceMs: typeof stats.aimd?.countersSinceMs === 'number' ? stats.aimd.countersSinceMs : null,
    slotReconcileMismatch: n(stats.slotReconcileMismatch),
  };
}

/** Capture the minimal rolling sample from the current metrics (for the next tick's comparison). */
export function sampleGateway(metrics: GatewayMetrics, now: number): GatewaySample {
  return {
    totalRequests: metrics.totalRequests,
    shed429: metrics.shed429,
    shedAllThrottled: metrics.shedAllThrottled,
    upstreamErrors: metrics.upstreamErrors,
    at: now,
  };
}

/**
 * Detect the wedge + sustained-throttle signatures from the current metrics and an optional prior
 * sample. PURE — no I/O. The `prior` lets us confirm the TEMPORAL half of the wedge signature
 * (frozen `totalRequests`); without a prior the verdict reports only the instantaneous `saturated`
 * (a warn), never a false `wedge`.
 *
 * `opts.minFreezeMs` (default 0) requires the prior to be at least that old before a frozen-while-
 * saturated reading counts as a confirmed `wedge` — the caller passes the freeze-ANCHOR sample
 * (held stable since the freeze began) so the wedge only fires once the freeze has PERSISTED that
 * long (defends against a near-simultaneous double-read seeing a ~0ms "frozen" gap).
 */
export function detectGatewayWedge(
  metrics: GatewayMetrics,
  prior: GatewaySample | undefined,
  now: number,
  opts: { minFreezeMs?: number } = {},
): GatewayWedgeVerdict {
  const minFreezeMs = opts.minFreezeMs ?? 0;
  const reasons: string[] = [];

  // ── Saturation (spatial half): every live slot is taken AND work is waiting. ──────────────────
  const saturated = metrics.maxConcurrent > 0 && metrics.inFlight >= metrics.maxConcurrent && metrics.queueDepth > 0;
  if (saturated) {
    reasons.push(`at slot ceiling: inFlight ${metrics.inFlight}/${metrics.maxConcurrent} with ${metrics.queueDepth} queued`);
  }

  // ── Wedge (spatial + temporal): saturated AND totalRequests not advancing vs a PERSISTED prior. ─
  let wedge = false;
  const priorAge = prior ? now - prior.at : -1;
  const priorUsable = !!prior && priorAge >= minFreezeMs && priorAge <= WEDGE_FREEZE_PRIOR_MAX_AGE_MS;
  if (saturated && prior && priorUsable && metrics.totalRequests === prior.totalRequests) {
    wedge = true;
    reasons.push(
      `totalRequests frozen @${metrics.totalRequests} for ${Math.round(priorAge / 1000)}s while saturated — wedge signature (watchdog will auto-restart)`,
    );
  }

  // ── Sustained throttle: the upstream is throttling the pool. ──────────────────────────────────
  let sustainedThrottle = false;
  // (a) AIMD has cut effective concurrency below its configured cap → a sustained 429 storm.
  if (metrics.aimdEffective != null && metrics.aimdCap != null && metrics.aimdEffective < metrics.aimdCap) {
    sustainedThrottle = true;
    reasons.push(`AIMD throttled concurrency to ${metrics.aimdEffective}/${metrics.aimdCap} (sustained upstream 429s)`);
  }
  // (b) Fail-fast all-throttled shedding climbing vs the prior → the whole pool is throttled.
  if (prior && metrics.shedAllThrottled > prior.shedAllThrottled) {
    sustainedThrottle = true;
    reasons.push(`shed ${metrics.shedAllThrottled - prior.shedAllThrottled} request(s) fast — all accounts throttled`);
  }
  // (c) Admission backlog overflowing (load-shed climbing) → the queue can't drain fast enough.
  if (prior && metrics.shed429 > prior.shed429) {
    sustainedThrottle = true;
    reasons.push(`load-shed ${metrics.shed429 - prior.shed429} request(s) — admission backlog full`);
  }
  // (d) Transport-STALL storm (fault #5): cumulative upstream TRANSPORT failures climbing by a CLUSTER
  //     vs the prior. This is the DOMINANT gateway failure under an Anthropic-wide hold-storm, yet it
  //     NEVER increments upstream429 (the gateway absorbs/rotates, not 429-sheds) and doesn't shrink AIMD
  //     (429-driven) — so without this clause it slips past (a)-(c) and the health view reads "429-calm"
  //     while every account TTFB-stalls. Surfacing it makes the real (capacity) fix — add account
  //     headroom — actionable instead of buried in the journal (the documented fault-#5 blind spot).
  if (prior && prior.upstreamErrors != null && metrics.upstreamErrors > prior.upstreamErrors + STALL_STORM_DELTA) {
    sustainedThrottle = true;
    reasons.push(
      `transport-stall storm — ${metrics.upstreamErrors - prior.upstreamErrors} upstream stalls/transport-fails; pool throttled at the transport layer (not 429s — add account headroom)`,
    );
  }

  // ── Slot leak (P-005/W3, D-001): the gateway's OWN reconcile guard counted a held slot the self-heal
  //    valve could not reclaim. This is a confirmed leak the gateway cannot self-heal — surfaced here so it
  //    becomes a VISIBLE signal (panel warn + overwatch anomaly) instead of silently riding to the wedge /
  //    watchdog restart. Purely a function of the gateway-reported counter (already de-bounced there), so it
  //    needs no prior sample. ──────────────────────────────────────────────────────────────────────────
  const slotLeak = metrics.slotReconcileMismatch > 0;
  if (slotLeak) {
    reasons.push(
      `slot-leak reconcile mismatch ×${metrics.slotReconcileMismatch} — a held admission slot the self-heal valve cannot reclaim (leak, not a rate throttle)`,
    );
  }

  // ── Admission starvation (WI-3565, spatial half): a deep backlog vs the LIVE ceiling — distinct
  //    from `saturated` above, which requires inFlight AT the ceiling. A starved queue can sit BELOW
  //    the ceiling the whole time (paced by a lower per-account/provider floor), so `saturated` alone
  //    never fires and the queue silently deepens. Confirmed into a sustained alert by the caller. ──
  const admissionStarvationRisk =
    metrics.maxConcurrent > 0 && metrics.queueDepth > ADMISSION_STARVATION_QUEUE_RATIO * metrics.maxConcurrent;
  if (admissionStarvationRisk) {
    reasons.push(
      `admission backlog ${metrics.queueDepth} deep vs live ceiling ${metrics.maxConcurrent} (>${ADMISSION_STARVATION_QUEUE_RATIO}x) — starvation risk if sustained`,
    );
  }

  return { saturated, wedge, sustainedThrottle, slotLeak, admissionStarvationRisk, admissionStarved: false, reasons };
}
