/**
 * capacity-dispatch — the Queen's capacity-aware dispatch (gateway-priority-tiers-2026-06-22 Phase 4,
 * `MUG_CAPACITY_DISPATCH`). The SOURCE-side counterpart to the gateway's priority tiers (SINK-side): before
 * a placement round the Queen reads the inference pool's live saturation (the gateway `/stats` — the SHARED
 * capacity oracle, D-007) and CLAMPS how many FRESH bees it spawns, so it stops flooding the gateway with bee
 * requests that just park/fail when the pool is capacity-scarce. The tiers ALLOCATE scarce capacity fairly;
 * this REDUCES the inflow; NEITHER creates capacity — the durable lever stays more accounts (D-006).
 *
 * `computeCapacityHeadroom` is PURE (fake-signal testable, no I/O); `queenCapacityHeadroom` adds the flag read
 * + the gateway fetch. Flag-OFF, gateway-flag-OFF, or gateway-UNREACHABLE ⇒ NO clamp (fail-safe — never strand
 * the fleet on a missing/stale signal). A `minHeadroom` floor always lets some work through so high-priority
 * tasks still flow (the gateway tiers then prioritize them); the placement planner walks the frontier in
 * importance order, so clamping the fresh-spawn headroom naturally DEFERS the lowest-priority tasks first.
 *
 * `buildCapacityReport` is the PURE read-model the Queen consumes (the `fleet:capacity` tool + the wake-brief
 * Capacity panel both project a gateway headroom snapshot through it) — it lives HERE, with the dispatch
 * domain logic, so no consumer has to depend on the agent-tool module.
 */
import { tierOf, DEFAULT_GATEWAY_PRIORITY_MAP, type PriorityTierMap } from '@papercusp/papercusp-shared/agent';
import type { GatewayHeadroom } from '../inference-gateway/observability';
import type { AccountSessionOverride } from '../deployment/account-session-override';

/** Pool-saturation signal — a projection of the gateway `/stats` headroom (observability.GatewayHeadroom). */
export interface CapacitySignal {
  /** False ⇒ the gateway is down/unreachable; the caller must fail-safe to NO clamp. */
  reachable: boolean;
  /** Milliseconds since the gateway process started, if /stats is new enough to expose it. */
  processUptimeMs?: number | null;
  /** 0..1+ utilization of the most-constraining unified budget window (1.0 = at cap). */
  utilization?: number;
  /** The whole pool is currently paused (every account rate-throttled). */
  paused?: boolean;
  /** The binding budget window is hard-rejected. */
  rejected?: boolean;
  /** Requests waiting for an admission slot right now (the backlog). */
  queueDepth?: number;
  inFlight?: number;
  /** Pool-wide healthy accounts from the gateway tier oracle. */
  healthyAccounts?: number | null;
  /** Spare slots in the bee tier: cap - inFlight - queued. */
  dispatchBudget?: number | null;
}

/**
 * Real per-provider account-pool availability — the persisted `accounts:status` projection (usage walls
 * / rate pauses / edge throttles). The gateway's OWN `priorityTiers.healthyAccounts` count can DISAGREE
 * with this: the gateway keeps an in-memory healthy/pause map that lags the store's usage-wall projection
 * (split-brain — see observability.readmitGatewayAccounts). Cross-checking the gateway's queue-slot
 * `dispatchBudget` against this catches the false-green where the gateway reports spare bee slots while
 * every real account is walled/throttled, so spawns die on their first inference call (EI-12282).
 */
export interface AccountPoolAvailability {
  /** Provider these counts are for (e.g. 'claude'). Surfaced in the exhausted advice. */
  provider?: string;
  /** Accounts that can serve right now (`available` = not rate-paused AND not usage-walled). */
  available: number;
  /** Accounts that can serve AND are not edge-throttled — the truly-usable count for a fresh spawn. */
  usable: number;
  /** Total accounts considered for the provider. */
  total: number;
  /**
   * How many accounts are edge-throttled (a live Cloudflare/per-IP bare-429 cooldown — the egress-IP
   * locus, NOT the account's own usage window). WI-5785-adjacent (EI-18664933641195210): when this is
   * the dominant reason accounts are unusable, the real fault is almost always the shared/failed egress
   * path (a down forward-proxy forcing every account onto one throttled IP), not account quota — an
   * OWNER-GATED infra problem, not something waiting-for-reset fixes. Optional: omit to skip the
   * distinction (byte-identical advice to before this field existed).
   */
  edgeThrottledCount?: number;
  /**
   * How many accounts are genuinely usage-walled (5h/7d utilization at/over cap — the account's OWN
   * budget window, unrelated to egress). When THIS dominates, the fix is "wait for reset" or "add
   * accounts", not an infra fix. Optional, same fail-safe-omit contract as `edgeThrottledCount`.
   */
  usageWalledCount?: number;
  /**
   * EI-18791793869559327: how many of the `usable` accounts are `sustainedlyLimited` (the rate
   * governor's own "this account is repeatedly hitting penalties" verdict — the scale-out trigger
   * elsewhere in the system). A `sustainedlyLimited` account is still `available`/`usable` by the
   * pause/wall/edge-throttle definitions above (it is NOT walled or edge-throttled), so it never trips
   * `poolExhausted` — but a pool where EVERY usable account is sustainedly limited is degrading in
   * practice, not abundant. Optional, same fail-safe-omit contract as the other optional fields here.
   */
  sustainedlyLimitedCount?: number;
  /**
   * EI-18683773458136367: whether the edge-throttled accounts share ONE known egress identity (proxy
   * URL / bound local IP) — the actual "down forward-proxy forcing every account onto one shared,
   * already-throttled IP" signature that justifies an owner-gated infra escalation. `true` = confirmed
   * shared identity; `false` = at least two edge-throttled accounts are confirmed on DISTINCT egress
   * identities (disproves a shared-IP failure — the throttle is per-account, not a dead egress path);
   * `undefined`/omitted = not enough identity data to conclude either way (legacy/unchanged phrasing,
   * same fail-safe-omit contract as the other optional fields on this type).
   */
  edgeThrottledSharedEgress?: boolean;
  /**
   * EI-18683773458136367: whether at least one edge-throttled account's cooldown deadline is being
   * RE-ARMED (its `edgeThrottleResetAt` advanced AND its penalty count climbed since the previous read)
   * rather than expiring — the signature of a retry/backoff loop re-hitting the edge before the cooldown
   * clears, a POLICY bug, not a dead egress path. `undefined` = no prior read to compare against yet.
   */
  edgeThrottledRearming?: boolean;
  /**
   * EI-19932168784507536: how many of `total` are excluded from actual routing by the owner's
   * session-account-override allow-list/exclude-list (account-session-override.ts), even though
   * they read `available`/`usable` by pool-health alone. The spawn admission path (spawn-env.ts
   * resolveSpawnGatewayEnv) enforces this SAME override and refuses these accounts outright — a
   * refusal that lands in 4-5ms with exit_code:null, before any real work starts. Without this,
   * `usable`/`available` silently overcounted an account that pool-health calls healthy but that
   * every real spawn into it would be rejected for, so the capacity oracle reported an abundant
   * pool while admission refused every route into the excluded slice. Optional, same
   * fail-safe-omit contract as the other optional fields here.
   */
  overrideExcludedCount?: number;
  /** The live owner session override used to derive the counts above. */
  sessionOverride?: AccountSessionOverride;
  /**
   * EI-19281217347369076 / EI-19928050541357086: how many of `total` accounts have an UNRELIABLE
   * reading feeding their `available`/`usageWalled`/`utilization` verdict — EITHER a recent,
   * UNRESOLVED `accounts:probe-capacity` 'no-reading' failure (`lastProbeFailedAt` set — the probe
   * request itself failed: network/auth/timeout, so upstream told us nothing), OR a usage-window
   * observation that has simply gone STALE from lack of a recent refresh (`readingStatus !==
   * 'fresh'` — nobody has re-probed it in a while, even though the last successful read was fine).
   * Either way the verdict rests on old or missing data, not a live measurement. When this is a
   * MAJORITY of the pool, every `available`/`usageWalled`/`utilization` verdict those accounts feed
   * into must not be reported with the same confidence as a freshly-measured quota wall — two
   * distinct traps this guards: "reports a broken egress path as pool exhausted with a quota-shaped
   * resetInSec" (a probe failure is network-shaped, not quota-shaped, and no reset clears a broken
   * network path), and "reports pool-exhausted off a 30-99-minute-old reading" (EI-19928050541357086:
   * a single accounts:probe-capacity call flipped a confident poolExhausted:true/usableAccounts:0
   * verdict to poolExhausted:false/usableAccounts:1 with no other change — the stale reading, not
   * the pool, was wrong). Optional, same fail-safe-omit contract as the other optional fields here.
   */
  blindCount?: number;
  /**
   * Per-account reset terms used to identify the constraint that gates the earliest recovery. Counts
   * alone are only a marginal fallback: one account may be both edge-throttled and usage-walled, so
   * the count with the larger population is not necessarily the term that actually binds capacity.
   */
  accountBindingTerms?: AccountBindingTerms[];
}

export type CapacityBindingCause = 'edge-throttle' | 'usage-wall' | 'rate-pause';

/** Active reset terms for one account, projected from AccountStatusRow by the capacity reader. */
export interface AccountBindingTerms {
  id: string;
  /** Binding 5h/7d usage-window reset, when this account is usage-walled. */
  usageResetAt?: number;
  /** Live edge-throttle cooldown reset, when this account is edge-throttled. */
  edgeThrottleResetAt?: number;
  /** Bounded local rate-governor pause reset, when this account is rate-paused. */
  ratePausedUntil?: number;
}

const BINDING_CAUSE_TIE_PRIORITY: Record<CapacityBindingCause, number> = {
  // A usage wall is a non-escalating quota diagnosis and is the safest tie-break when two terms
  // recover at the same instant. An edge-throttle tie must never manufacture an owner escalation.
  'usage-wall': 3,
  'rate-pause': 2,
  'edge-throttle': 1,
};

/**
 * PURE: identify the cause on the account(s) that recover first. An account's binding term is the
 * latest of its active reset terms; the pool's gating account is the one with the earliest such
 * recovery. Equal reset times use the non-escalating cause priority above.
 */
export function deriveCapacityBindingCause(accounts: AccountBindingTerms[]): CapacityBindingCause | null {
  const gates = accounts.flatMap((account) => {
    const terms = ([
      { cause: 'usage-wall', resetAt: account.usageResetAt ?? 0 },
      { cause: 'edge-throttle', resetAt: account.edgeThrottleResetAt ?? 0 },
      { cause: 'rate-pause', resetAt: account.ratePausedUntil ?? 0 },
    ] satisfies Array<{ cause: CapacityBindingCause; resetAt: number }>).filter(
      (term) => Number.isFinite(term.resetAt) && term.resetAt > 0,
    );
    if (terms.length === 0) return [];
    const bindingResetAt = Math.max(...terms.map((term) => term.resetAt));
    const bindingCause = terms
      .filter((term) => term.resetAt === bindingResetAt)
      .sort((a, b) => BINDING_CAUSE_TIE_PRIORITY[b.cause] - BINDING_CAUSE_TIE_PRIORITY[a.cause])[0].cause;
    return [{ bindingResetAt, bindingCause }];
  });
  if (gates.length === 0) return null;
  const earliestRecoveryAt = Math.min(...gates.map((gate) => gate.bindingResetAt));
  return gates
    .filter((gate) => gate.bindingResetAt === earliestRecoveryAt)
    .sort((a, b) => BINDING_CAUSE_TIE_PRIORITY[b.bindingCause] - BINDING_CAUSE_TIE_PRIORITY[a.bindingCause])[0]
    .bindingCause;
}

/** One account's edge-throttle state, as read at ONE point in time — the pure input to
 *  {@link deriveEdgeThrottleEvidence}. Kept separate from `AccountStatusRow` so this stays testable
 *  without importing the whole account-pool-store IO surface. */
export interface EdgeThrottleAccountSample {
  id: string;
  edgeThrottled: boolean;
  edgeThrottleResetAt?: number;
  penaltyCount: number;
  /**
   * This account's egress identity — see {@link egressIdentityOf}, which is how callers should build it.
   *
   * `undefined` means GENUINELY UNKNOWN (the binding could not be read) and NOTHING ELSE. It must NOT be
   * used for "no explicit binding", because an account with neither `proxyUrl` nor `localAddress` is not
   * unknown — it is definitively on the box's DEFAULT SHARED egress, which is the single most informative
   * value this field can carry: if every throttled account is on the shared default, the throttle is a
   * property of the IP, not of the accounts.
   *
   * That conflation was a real blind spot (P-009). The doc here used to read "or undefined when the
   * account's egress binding is unknown/default-shared", and capacity.ts populated it as
   * `proxyUrl ?? localAddress ?? undefined` — so with NO proxies configured, every account reported
   * `undefined`, `knownIdentities` came back empty, and {@link deriveEdgeThrottleEvidence} could never
   * conclude `sharedEgress` either way. The pool-wide collapse it exists to explain was therefore
   * undiagnosable in precisely the configuration that produced it (2026-08-08: proxy entries pulled,
   * all accounts on one box egress IP, `usableAccounts 1 / factor 0` while only 1 of 4 was truly walled).
   * Owner directive 2026-08-09 makes default-shared egress the STANDING configuration, so this is not a
   * transient state to tolerate — it is the normal one.
   */
  egressIdentity?: string;
}

/** The egress identity of an account with no proxy and no bound source IP: the box's own default egress,
 *  shared by every such account. Same spelling the gateway already uses for this case (its `egDesc`), so
 *  a reader comparing a capacity verdict against a gateway log sees one vocabulary, not two. */
export const DEFAULT_SHARED_EGRESS_IDENTITY = 'default-egress';

/**
 * Build an {@link EdgeThrottleAccountSample.egressIdentity} from an account's egress binding.
 *
 * TOTAL by design — it always returns a string, because for an account row we actually hold, the binding
 * IS known: `proxyUrl` if set, else `src <localAddress>` if bound, else the default shared egress. Callers
 * should therefore never pass `undefined` through to `egressIdentity` on the strength of "no binding";
 * reserve that for the case where no row could be read at all.
 *
 * EI-20613616736215896: `egressPool` SUPERSEDES the singular `egress` (account-pool.ts) — so an identity
 * derived from the singular alone collapses EVERY pool-routed account onto the same
 * {@link DEFAULT_SHARED_EGRESS_IDENTITY} fallback. `deriveEdgeThrottleEvidence` then reads those identical
 * identities as the down-proxy signature and sets `sharedEgress: true`, which is what emits the
 * "the egress path itself is broken → OWNER-GATED, escalate" advice. Measured live on a pool spread across
 * THREE distinct proxies while 2/6 accounts were answering upstream 200s — i.e. the exact opposite of a
 * shared-IP fault. Note the regression shape: P-009 made this function total to escape an all-`undefined`
 * case that left the diagnosis unreachable; under pool routing that same fallback turns an honest
 * UNDETERMINED into a confidently WRONG `true`. So the pool is consulted FIRST, and only a genuinely
 * empty pool falls through to the singular binding.
 */
export function egressIdentityOf(
  egress: { proxyUrl?: string; localAddress?: string } | undefined,
  egressPool?: readonly ({ proxyUrl?: string; localAddress?: string } | undefined)[],
): string {
  if (egressPool && egressPool.length > 0) {
    // Order-insensitive and deduped: two accounts rotating over the SAME set of IPs genuinely share an
    // egress and must compare equal, whatever order the store happens to hand the entries back in. An
    // unbound entry is not unknown — it is the box default, named so it participates in the comparison.
    const ids = egressPool.map((e) =>
      e?.proxyUrl ? e.proxyUrl : e?.localAddress ? `src ${e.localAddress}` : DEFAULT_SHARED_EGRESS_IDENTITY,
    );
    return [...new Set(ids)].sort().join('|');
  }
  if (egress?.proxyUrl) return egress.proxyUrl;
  if (egress?.localAddress) return `src ${egress.localAddress}`;
  return DEFAULT_SHARED_EGRESS_IDENTITY;
}

/** Per-account state from the PREVIOUS read, carried by the caller (capacity.ts keeps this in a
 *  process-local Map — this module stays pure and takes/returns snapshots explicitly). */
export interface EdgeThrottleSnapshotEntry {
  resetAt?: number;
  penaltyCount: number;
}

/**
 * PURE: derive the `edgeThrottledSharedEgress` / `edgeThrottledRearming` evidence from a set of
 * per-account samples + the previous read's snapshot (EI-18683773458136367). Two independent,
 * falsifiable signals — a bare edge-throttled COUNT proves neither on its own:
 *  - sharedEgress: do the throttled accounts actually share ONE egress IP (the down-proxy signature)?
 *  - rearming: is a throttled account's cooldown deadline advancing rather than expiring (a backoff loop)?
 */
export function deriveEdgeThrottleEvidence(
  samples: EdgeThrottleAccountSample[],
  prevSnapshot: ReadonlyMap<string, EdgeThrottleSnapshotEntry>,
): {
  sharedEgress?: boolean;
  rearming?: boolean;
  nextSnapshot: Map<string, EdgeThrottleSnapshotEntry>;
} {
  const throttled = samples.filter((s) => s.edgeThrottled);

  let sharedEgress: boolean | undefined;
  const knownIdentities = throttled.map((s) => s.egressIdentity).filter((x): x is string => !!x);
  if (throttled.length >= 2 && knownIdentities.length >= 2) {
    const distinct = new Set(knownIdentities);
    if (distinct.size >= 2) {
      sharedEgress = false; // proven distinct — at least two known, different identities
    } else if (knownIdentities.length === throttled.length) {
      sharedEgress = true; // every throttled account's identity is known AND identical
    }
    // else: some identities unknown and the known ones agree — not enough to conclude either way.
  }

  let anyComparable = false;
  let anyRearming = false;
  const nextSnapshot = new Map<string, EdgeThrottleSnapshotEntry>();
  for (const s of throttled) {
    const prev = prevSnapshot.get(s.id);
    if (prev) {
      anyComparable = true;
      const resetAdvanced =
        s.edgeThrottleResetAt != null && prev.resetAt != null && s.edgeThrottleResetAt > prev.resetAt;
      const penaltyClimbed = s.penaltyCount > prev.penaltyCount;
      if (resetAdvanced && penaltyClimbed) anyRearming = true;
    }
    nextSnapshot.set(s.id, { resetAt: s.edgeThrottleResetAt, penaltyCount: s.penaltyCount });
  }

  return { sharedEgress, rearming: anyComparable ? anyRearming : undefined, nextSnapshot };
}

export interface CapacityDispatchConfig {
  /** Floor — always allow at least this many FRESH spawns so high-priority work still flows (the gateway
   *  tiers then prioritize it); prevents a full placement stall under total exhaustion. Env:
   *  `QUEEN_CAPACITY_MIN_HEADROOM`. Default 2. */
  minHeadroom: number;
  /** `queueDepth` at which the queue leg of the factor reaches 0 (full throttle). Env:
   *  `QUEEN_CAPACITY_QUEUE_SOFT_CAP`. Default 24. */
  queueSoftCap: number;
  /** Utilization above which the budget leg starts throttling (linearly to 0 at util ≥ 1.0). Env:
   *  `QUEEN_CAPACITY_UTIL_HIGH`. Default 0.85. */
  utilizationHigh: number;
  /** Grace window after gateway process start where a paused/zero-capacity snapshot is treated as recovering,
   *  not sustained pool exhaustion. Env: `QUEEN_CAPACITY_RESTART_GRACE_MS`. Default 30s. */
  restartRecoveryWindowMs: number;
  /** EI-18791793869559327: ceiling on `factor` (the read-model only — see `buildCapacityReport`) when every
   *  `usable` account is `sustainedlyLimited`: the pool is degrading even though nothing is walled/paused, so
   *  it must not read as full-headroom `abundant`. Env: `QUEEN_CAPACITY_DEGRADED_FACTOR_CAP`. Default 0.25
   *  (the same threshold the advice text already uses to mean "scarce — place top-ranked only").*/
  degradedFactorCap: number;
}

export const DEFAULT_CAPACITY_DISPATCH_CONFIG: CapacityDispatchConfig = {
  minHeadroom: 2,
  queueSoftCap: 24,
  utilizationHigh: 0.85,
  restartRecoveryWindowMs: 30_000,
  degradedFactorCap: 0.25,
};

export interface CapacityDecision {
  /** The clamped fresh-spawn headroom to pass to the placement planner. */
  headroom: number;
  /** The applied capacity factor in [0,1] (1 = no clamp). */
  factor: number;
  /** True when the clamp reduced the headroom below the raw value. */
  throttled: boolean;
  /** Human-readable reason (logged + surfaced on the placement result for observability). */
  reason: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function hasTieredBeeCapacity(signal: CapacitySignal): boolean {
  return (signal.healthyAccounts ?? 0) > 0 && (signal.dispatchBudget ?? 0) > 0;
}

function isFreshGatewayRestart(signal: CapacitySignal, config: CapacityDispatchConfig): boolean {
  const uptime = signal.processUptimeMs;
  if (uptime == null || !Number.isFinite(uptime) || uptime < 0) return false;
  if (uptime > Math.max(0, config.restartRecoveryWindowMs)) return false;
  return (signal.paused === true || signal.rejected === true) && !hasTieredBeeCapacity(signal);
}

/**
 * PURE + HEADROOM-INDEPENDENT: the pool's spare-capacity FACTOR in [0,1] (1 = full headroom, 0 = no fresh
 * capacity). `factor = min(budgetLeg, queueLeg)`, forced to 0 when the pool is paused/rejected. This is the
 * single throttle curve `computeCapacityHeadroom` scales the raw headroom by; it is also read directly by the
 * Queen's `fleet:capacity` tool to report saturation without committing to a specific headroom. Gateway-
 * unreachable ⇒ 1 (fail-safe — never clamp on a missing/stale signal).
 */
export function capacityFactor(
  signal: CapacitySignal,
  config: CapacityDispatchConfig = DEFAULT_CAPACITY_DISPATCH_CONFIG,
): number {
  if (!signal.reachable) return 1;
  const tieredSpareCapacity = hasTieredBeeCapacity(signal);
  const accountWindowBlocked = signal.paused === true || signal.rejected === true;
  if (isFreshGatewayRestart(signal, config)) return 1;
  // With priority tiers, `/stats.{unified,paused,rejected}` describe the currently-BOUND account,
  // NOT the pool. If that account is paused/exhausted while the tier oracle still reports healthy
  // accounts AND bee-tier spare slots, pool capacity exists — a bound-account block must not gate
  // placement. (Originally this covered only `rejected`; a weekly-capped account reports BOTH
  // paused:true AND rejected:true, which re-armed the false-saturation gate and stalled the whole
  // autonomous loop — capacity-oracle-false-saturation-2026-06-29.)
  const boundAccountBlockedButPoolHasCapacity = accountWindowBlocked && tieredSpareCapacity;
  const util = boundAccountBlockedButPoolHasCapacity ? 0 : (signal.utilization ?? 0);
  const queueDepth = Math.max(0, signal.queueDepth ?? 0);
  // Budget leg: 1 up to utilizationHigh, then linearly to 0 as util → 1.0 (at cap).
  const span = Math.max(1e-6, 1 - config.utilizationHigh);
  const budgetLeg = util <= config.utilizationHigh ? 1 : clamp01(1 - (util - config.utilizationHigh) / span);
  // Queue leg: 1 at an empty queue, → 0 as queueDepth → queueSoftCap.
  const queueLeg = clamp01(1 - queueDepth / Math.max(1, config.queueSoftCap));
  let factor = Math.min(budgetLeg, queueLeg);
  if (accountWindowBlocked && !boundAccountBlockedButPoolHasCapacity) factor = 0; // no fresh capacity at all → throttle to the floor
  return factor;
}

/**
 * PURE: clamp the fresh-spawn `beeHeadroom` to the pool's spare capacity. The result is floored at
 * `minHeadroom` (but never raised above the raw headroom), so high-priority work always flows.
 * Gateway-unreachable ⇒ NO clamp (fail-safe).
 */
export function computeCapacityHeadroom(
  beeHeadroom: number,
  signal: CapacitySignal,
  config: CapacityDispatchConfig = DEFAULT_CAPACITY_DISPATCH_CONFIG,
): CapacityDecision {
  if (!signal.reachable) {
    return { headroom: beeHeadroom, factor: 1, throttled: false, reason: 'gateway unreachable → no clamp (fail-safe)' };
  }
  const util = signal.utilization ?? 0;
  const queueDepth = Math.max(0, signal.queueDepth ?? 0);
  const factor = capacityFactor(signal, config);
  const freshRestart = isFreshGatewayRestart(signal, config);
  const floor = Math.max(0, Math.floor(config.minHeadroom));
  // Floor lifts the clamp toward minHeadroom, but the result is never MORE than the raw headroom (a 0-slot
  // pool stays 0 — the floor lets high-priority work flow, it doesn't manufacture slots that don't exist).
  const headroom = Math.min(beeHeadroom, Math.max(floor, Math.floor(beeHeadroom * factor)));
  const throttled = headroom < beeHeadroom;
  const pct = Math.round(util * 100);
  return {
    headroom,
    factor,
    throttled,
    reason: freshRestart
      ? `capacity-recovering: gateway restarted ${Math.round((signal.processUptimeMs ?? 0) / 1000)}s ago → no clamp on startup snapshot`
      : throttled
      ? `capacity-throttle: ${beeHeadroom}→${headroom} fresh bees (util ${pct}%, queue ${queueDepth}` +
        `${signal.paused ? ', POOL PAUSED' : ''}${signal.rejected ? ', rejected' : ''}, factor ${factor.toFixed(2)}, floor ${floor})`
      : `capacity-ok: ${beeHeadroom} fresh bees (util ${pct}%, queue ${queueDepth})`,
  };
}

/** Resolve the config from env (`QUEEN_CAPACITY_*`) over optional explicit overrides over the defaults. */
export function resolveCapacityConfig(
  over?: Partial<CapacityDispatchConfig>,
  env: NodeJS.ProcessEnv = process.env,
): CapacityDispatchConfig {
  const num = (raw: string | undefined, fallback: number, min = 0): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    minHeadroom: Math.floor(
      num(env.QUEEN_CAPACITY_MIN_HEADROOM, over?.minHeadroom ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.minHeadroom),
    ),
    queueSoftCap: num(env.QUEEN_CAPACITY_QUEUE_SOFT_CAP, over?.queueSoftCap ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.queueSoftCap, 1),
    utilizationHigh: num(env.QUEEN_CAPACITY_UTIL_HIGH, over?.utilizationHigh ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.utilizationHigh),
    restartRecoveryWindowMs: num(
      env.QUEEN_CAPACITY_RESTART_GRACE_MS,
      over?.restartRecoveryWindowMs ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.restartRecoveryWindowMs,
    ),
    degradedFactorCap: clamp01(
      num(
        env.QUEEN_CAPACITY_DEGRADED_FACTOR_CAP,
        over?.degradedFactorCap ?? DEFAULT_CAPACITY_DISPATCH_CONFIG.degradedFactorCap,
      ),
    ),
  };
}

/**
 * The Queen-side entry: flag-gated (`MUG_CAPACITY_DISPATCH`) capacity clamp on the fresh-spawn headroom.
 * Reads the gateway `/stats` (the shared oracle) unless a `signal` is injected (tests). Flag-OFF,
 * gateway-flag-OFF, or gateway-unreachable ⇒ NO clamp (returns the raw headroom).
 */
export async function queenCapacityHeadroom(
  beeHeadroom: number,
  opts: {
    flagOverride?: boolean;
    signal?: CapacitySignal;
    config?: Partial<CapacityDispatchConfig>;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CapacityDecision> {
  const noClamp = (reason: string): CapacityDecision => ({ headroom: beeHeadroom, factor: 1, throttled: false, reason });
  let on = opts.flagOverride;
  if (on === undefined) {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    on = await getFlag(FLAGS.MUG_CAPACITY_DISPATCH, 'system').catch(() => false);
  }
  if (!on) return noClamp('MUG_CAPACITY_DISPATCH off → no clamp');

  const config = resolveCapacityConfig(opts.config, opts.env);
  let signal = opts.signal;
  if (!signal) {
    // The gateway is the shared capacity oracle (D-007) — only consult it when the gateway is actually on.
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system').catch(() => false);
    if (!gwOn) return noClamp('inference gateway off → no capacity oracle, no clamp (fail-safe)');
    const { fetchGatewayHeadroom } = await import('../inference-gateway/observability');
    const gw = await fetchGatewayHeadroom({ timeoutMs: opts.timeoutMs ?? 1200 });
    const beeTier = tierOf('cup', DEFAULT_GATEWAY_PRIORITY_MAP);
    const beeRow = gw.priorityTiers?.tiers.find((t) => t.tier === beeTier) ?? null;
    const dispatchBudget =     beeRow && beeRow.minShare != null
      ? Math.max(0, beeRow.minShare - beeRow.inFlight - beeRow.queued)
      : null;
    signal = {
      reachable: gw.reachable,
      utilization: gw.utilization,
      paused: gw.paused,
      rejected: gw.rejected,
      queueDepth: gw.queueDepth,
      inFlight: gw.inFlight,
      processUptimeMs: gw.processUptimeMs,
      healthyAccounts: gw.priorityTiers?.healthyAccounts ?? null,
      dispatchBudget,
    };
  }
  return computeCapacityHeadroom(beeHeadroom, signal, config);
}

// ── Capacity read-model (queen-capacity-aware-dispatch-2026-06-22 P-002/P-003) ──────────────────────
// The PURE projection the Queen consumes — the `fleet:capacity` tool returns it whole; the wake-brief
// Capacity panel renders its digest. Composes the SAME `capacityFactor` / `computeCapacityHeadroom` the
// placement path enforces, so what the Queen READS matches what placement DOES.

export interface CapacityReport {
  /** False ⇒ the gateway is down/unreachable; the Queen should place at her normal ceiling (no clamp). */
  reachable: boolean;
  /** Whether the gateway's per-tier layer is active (GATEWAY_PRIORITY_TIERS) — `priorityTiers` present. */
  tierLayer: boolean;
  /** Whether the Queen's automatic placement clamp is armed (MUG_CAPACITY_DISPATCH). */
  clampArmed: boolean;
  utilization: number | null;
  utilizationPct: number | null;
  paused: boolean;
  rejected: boolean;
  resetInSec: number | null;
  /**
   * EI-19281217347369076: false when the pool reading is `blind` (see below) — `resetInSec` is still
   * SURFACED (never destroyed — it may be genuine, and deleting it hides real information from a caller
   * who wants it anyway), but the reader must not treat it as an actionable "wait until this many
   * seconds pass" figure: the probe that would confirm/refresh it could not complete, so the number may
   * describe a window that will never clear (e.g. every account collapsed onto one down/throttled
   * egress IP — no quota reset fixes that). True whenever `blind` is false, including when `blind`
   * cannot be determined (no accountAvailability cross-check supplied) — same fail-safe-omit posture as
   * every other cross-check-only field.
   */
  resetInSecActionable: boolean;
  healthyAccounts: number | null;
  tier1Reserve: number | null;
  /** The admission tier bee work maps to (default 3) — the band `dispatchBudget` is measured in. */
  beeTier: number;
  /** Spare bee-tier slots right now = minShare − inFlight − queued (D-001). null when the tier layer is off.
   *
   *  ⚠ This is a CONSERVATIVE floor, not the pool's true headroom: `minShare` is the tier's guaranteed
   *  minimum share, and since WI-4541 a tier at its share may still borrow idle slots when no
   *  higher tier is waiting. A zero here therefore means "no guaranteed slots left", not "no capacity". */
  dispatchBudget: number | null;
  /** Real usable accounts for the bee provider from the account-pool projection (accounts:status), when
   *  supplied — the count that is `available` AND not edge-throttled. null when no cross-check was passed. */
  usableAccounts: number | null;
  /** Real available accounts (`available`, ignoring edge-throttle) from the account-pool projection, when
   *  supplied. null when no cross-check was passed. */
  availableAccounts: number | null;
  /**
   * EI-19932168784507536: how many provider accounts are excluded from routing by the owner's
   * session-account-override (allow-list/exclude-list) — already subtracted OUT of `usableAccounts`/
   * `availableAccounts` above, so this is visibility, not a further adjustment. A nonzero value here
   * while `poolExhausted`/`degraded` look surprising is the tell that the pool is smaller than raw
   * pool-health would suggest because the owner has steered spawns away from part of it. null when no
   * cross-check was passed or the accountAvailability omitted the count.
   */
  overrideExcludedAccounts: number | null;
  /** The active owner session override used for the account-pool cross-check, when available. */
  activeSessionOverride: AccountSessionOverride | null;
  /** LOUD contradiction flag (EI-12282): the gateway reports spare bee slots (dispatchBudget > 0) while the
   *  real account pool has ZERO usable accounts for the provider — a fresh spawn will die on its first call.
   *  When true, `factor` is forced to 0, `recommendedHeadroom` to the floor, and `advice` is the loud hold. */
  poolExhausted: boolean;
  /** Why the usable set is empty, when poolExhausted is true. */
  exhaustionReason: 'session-override' | 'edge-throttle' | 'usage-wall' | 'rate-pause' | 'unknown' | null;
  /** Real usable accounts (from the account-pool projection) that are `sustainedlyLimited`, when supplied.
   *  null when no cross-check was passed or the accountAvailability omitted the count (EI-18791793869559327). */
  sustainedlyLimitedAccounts: number | null;
  /** DEGRADED tier (EI-18791793869559327): `usable > 0` but EVERY usable account is `sustainedlyLimited` — not
   *  `poolExhausted` (nothing is walled/edge-throttled), but not abundant either. When true, `factor` is
   *  capped at `degradedFactorCap` and `advice` says place conservatively instead of "abundant". */
  degraded: boolean;
  /**
   * EI-19281217347369076: true when a MAJORITY (>=50%) of the cross-checked `accountAvailability` pool
   * carries an unresolved `accounts:probe-capacity` no-reading failure — the verdict this report is
   * built on rests on stale/unrefreshable readings, not a live measurement. Distinct from `poolExhausted`
   * (which is about zero USABLE accounts) and `degraded` (about sustained rate-limiting): `blind` is
   * about NOT KNOWING, and can co-occur with either. False (never true) when no `accountAvailability`
   * cross-check (or no `blindCount` on it) was supplied — same fail-safe-omit default as
   * `poolExhausted`/`degraded` already use for a missing cross-check.
   */
  blind: boolean;
  /** The `blindCount` this report's `blind` verdict was computed from. null when not supplied. */
  blindAccounts: number | null;
  capByTier: { tier: number; minShare: number | null; inFlight: number; queued: number }[] | null;
  inFlight: number | null;
  queueDepth: number | null;
  /** Milliseconds since the gateway process started, when the stats payload exposes it. */
  processUptimeMs: number | null;
  /** True when a blocked/zero-capacity reading is within the fresh-gateway restart grace window. */
  restartRecovering: boolean;
  /** Pool spare-capacity factor in [0,1] (1 = full headroom, 0 = no fresh capacity). */
  factor: number;
  /** When `headroom` was supplied: that raw fresh-spawn count clamped to spare capacity. */
  recommendedHeadroom: number | null;
  throttled: boolean | null;
  /** One-line dispatch advice for the Queen. */
  advice: string;
  /**
   * P-001 (knowledge-at-symptom-time-2026-08-09): what is ALREADY KNOWN about this symptom, delivered
   * ON the call that reports it. Present only on the alarming branches (exhausted / blocked / degraded),
   * absent otherwise so a healthy read is byte-identical.
   *
   * Why this exists: on 2026-08-09 an su read `degraded: true` + "place conservatively", took it at face
   * value, and told the owner the only remaining lever was to BUY MORE ACCOUNTS. It was wrong — three
   * of four accounts were fine and the pool had collapsed on a shared-egress TRANSPORT throttle. The
   * correct reading was already written down in three `agent-insights` pages AND in two standing facts
   * that had been folded into that same agent's second tool call of the session — where they were
   * excerpted mid-imperative ("...ALWAYS cross-read acco…") and skimmed past. Knowledge that arrives at
   * wake-time competes with everything else the agent is doing; knowledge that arrives ON the symptom
   * does not. `dev:pg_query`'s inline advisories demonstrably corrected that same agent twice in the
   * same session, which is the pattern this reuses (D-001).
   */
  symptomKnowledge?: {
    /** The imperative first — this is the part a truncating reader must not lose. */
    before: string;
    /** Why the verdict above cannot validate itself. */
    why: string;
    /** Pages that already explain this symptom class. */
    insights: string[];
  };
}

export interface FleetSizingAdvisory {
  requestedMembers: number;
  healthyHeadroom: number;
  extraMembers: number;
  message: string;
}

/**
 * PURE: project a gateway headroom snapshot into the Queen's capacity decision read-model. Testable with a
 * fabricated `GatewayHeadroom` (no I/O). `headroom` is an optional proposed fresh-spawn count to clamp.
 */
export function buildCapacityReport(
  hr: GatewayHeadroom,
  opts: {
    clampArmed: boolean;
    headroom?: number;
    config?: CapacityDispatchConfig;
    tierMap?: PriorityTierMap;
    /** Real account-pool availability (accounts:status) for the bee provider — cross-checks the gateway's
     *  queue-slot dispatchBudget against actual serve-ability (EI-12282). Omit to skip the cross-check. */
    accountAvailability?: AccountPoolAvailability;
  },
): CapacityReport {
  const config = opts.config ?? resolveCapacityConfig();
  const tierMap = opts.tierMap ?? DEFAULT_GATEWAY_PRIORITY_MAP;
  const beeTier = tierOf('cup', tierMap);

  const signal: CapacitySignal = {
    reachable: hr.reachable,
    utilization: hr.utilization,
    paused: hr.paused,
    rejected: hr.rejected,
    queueDepth: hr.queueDepth,
    inFlight: hr.inFlight,
    processUptimeMs: hr.processUptimeMs,
  };

  if (!hr.reachable) {
    return {
      reachable: false, tierLayer: false, clampArmed: opts.clampArmed,
      utilization: null, utilizationPct: null, paused: false, rejected: false, resetInSec: null,
      resetInSecActionable: true,
      healthyAccounts: null, tier1Reserve: null, beeTier,
      dispatchBudget: null,
      usableAccounts: opts.accountAvailability?.usable ?? null,
      availableAccounts: opts.accountAvailability?.available ?? null,
      overrideExcludedAccounts: opts.accountAvailability?.overrideExcludedCount ?? null,
      activeSessionOverride: opts.accountAvailability?.sessionOverride ?? null,
      poolExhausted: false,
      exhaustionReason: null,
      sustainedlyLimitedAccounts: opts.accountAvailability?.sustainedlyLimitedCount ?? null,
      degraded: false,
      blind: false,
      blindAccounts: opts.accountAvailability?.blindCount ?? null,
      capByTier: null, inFlight: null, queueDepth: null,
      processUptimeMs: null, restartRecovering: false,
      factor: 1, recommendedHeadroom: opts.headroom ?? null, throttled: opts.headroom != null ? false : null,
      advice: 'gateway unreachable → place at your normal ceiling (fail-safe, no capacity clamp)',
    };
  }

  const pt = hr.priorityTiers;
  const capByTier = pt?.tiers ?? null;
  const beeRow = pt?.tiers.find((t) => t.tier === beeTier) ?? null;
  const dispatchBudget =     beeRow && beeRow.minShare != null
      ? Math.max(0, beeRow.minShare - beeRow.inFlight - beeRow.queued)
      : null;
  signal.healthyAccounts = pt?.healthyAccounts ?? null;
  signal.dispatchBudget = dispatchBudget;
  let factor = capacityFactor(signal, config);
  const restartRecovering = isFreshGatewayRestart(signal, config);
  // EI-12282: the gateway's queue-slot `dispatchBudget` (and its in-memory `healthyAccounts`) can report
  // spare capacity while the REAL account pool (accounts:status) has zero usable accounts — a split-brain
  // that produces a false-green ("tightening → place broadly; ~13 slots free") so a caller spawns cups that
  // die on their first inference call. When a cross-check is supplied and shows ZERO usable provider
  // accounts while the gateway still claims spare slots, trust the more-conservative usage-wall-aware store.
  // Suppressed during the fresh-restart grace (the store may not be the cause, and restart-recovery already
  // means "place at ceiling, re-check next wake").
  const acct = opts.accountAvailability;
  // EI-19281217347369076: a MAJORITY of the cross-checked pool having an unresolved probe-capacity
  // no-reading failure means the available/usageWalled/utilization verdicts feeding poolExhausted/
  // degraded/resetInSec are themselves unmeasured — not suppressed by restart-grace (a fresh-restart
  // gateway snapshot says nothing about whether the STORE's own account readings are stale).
  const blind = acct != null && acct.total > 0 && (acct.blindCount ?? 0) / acct.total >= 0.5;
  const poolExhausted =
    !restartRecovering && acct != null && acct.total > 0 && acct.usable <= 0 && (dispatchBudget ?? 0) > 0;
  if (poolExhausted) factor = 0;
  const sessionOverrideExhausted =
    poolExhausted &&
    acct?.sessionOverride != null &&
    acct.overrideExcludedCount === acct.total &&
    acct.total > 0;
  const bindingCause = acct?.accountBindingTerms ? deriveCapacityBindingCause(acct.accountBindingTerms) : null;
  // EI-18791793869559327: `poolExhausted` is a binary all-dead check (usable<=0) against a failure mode
  // that is fundamentally gradual — an account can be fully `usable` (not walled, not edge-throttled) and
  // still be `sustainedlyLimited` (the rate governor's own "repeatedly hitting penalties" verdict, already
  // the system's scale-out trigger elsewhere). A pool where every usable account is sustainedly limited is
  // degrading, not abundant, but the old binary check reported it exactly as "abundant → place broadly" —
  // the reading a Mug's capacity-dispatch actually saw. Cap (never RAISE) the factor so a genuinely-scarcer
  // signal elsewhere still wins; suppressed by restart-grace/poolExhausted for the same reason those are.
  const degraded =
    !restartRecovering &&
    !poolExhausted &&
    acct != null &&
    acct.usable > 0 &&
    (acct.sustainedlyLimitedCount ?? 0) >= acct.usable;
  if (degraded) factor = Math.min(factor, config.degradedFactorCap);
  const tieredSpareCapacity = hasTieredBeeCapacity(signal);
  // A weekly-capped account reports BOTH paused:true and rejected:true; trust the tier oracle
  // (healthy accounts + bee-tier spare slots) over the bound-account block — same rationale as
  // capacityFactor (capacity-oracle-false-saturation-2026-06-29).
  const boundAccountBlockedButPoolHasCapacity = (hr.rejected || hr.paused) && tieredSpareCapacity;
  const poolBlocked = (hr.paused || hr.rejected) && !boundAccountBlockedButPoolHasCapacity;
  // Keep the blind-reading remedy scoped to the same provider as the reading. The probe tool defaults to
  // Claude for backwards compatibility, so an unqualified call from a Codex capacity report refreshes the
  // wrong pool and can make the caller believe the blind verdict was resolved when it was not.
  const blindRefreshInstruction =
    acct?.provider === 'codex'
      ? "RE-RUN accounts:probe-capacity { provider:'codex' } first"
      : acct?.provider === 'claude' || acct?.provider == null
        ? "RE-RUN accounts:probe-capacity { provider:'claude' } first"
        : `no provider-scoped capacity probe is registered for '${acct.provider}' — do not treat this reading as resolved`;

  let recommendedHeadroom: number | null = null;
  let throttled: boolean | null = null;
  if (opts.headroom != null) {
    if (poolExhausted) {
      // Real pool has zero usable accounts → clamp to the floor regardless of the gateway's queue-slot
      // signal (the floor still lets top-ranked tier-1 work attempt; broad placement is held).
      const floor = Math.max(0, Math.floor(config.minHeadroom));
      recommendedHeadroom = Math.min(opts.headroom, floor);
      throttled = recommendedHeadroom < opts.headroom;
    } else if (degraded) {
      // `computeCapacityHeadroom` recomputes its own factor from `signal` alone (it has no
      // accountAvailability visibility), so it would ignore the degraded cap applied above — clamp
      // directly using the already-capped `factor` instead, same floor/min shape as that helper.
      const floor = Math.max(0, Math.floor(config.minHeadroom));
      recommendedHeadroom = Math.min(opts.headroom, Math.max(floor, Math.floor(opts.headroom * factor)));
      throttled = recommendedHeadroom < opts.headroom;
    } else {
      const decision = computeCapacityHeadroom(opts.headroom, signal, config);
      recommendedHeadroom = decision.headroom;
      throttled = decision.throttled;
    }
  }

  // EI-18664933641195210: name the DOMINANT cause of the exhaustion when the caller supplied the
  // edge-throttle / usage-wall breakdown — the two causes need OPPOSITE operator responses
  // (egress-throttle ⇒ escalate to the owner about the proxy/egress path; usage-wall ⇒ just wait
  // for the reset), and a bare "walled/rate-paused/edge-throttled" phrase reads as generic quota
  // exhaustion either way, which sent a real egress-proxy outage down the wrong (quota) diagnosis.
  const exhaustionCause = ((): string | null => {
    if (!poolExhausted) return null;
    if (sessionOverrideExhausted) {
      return (
        ` — SESSION OVERRIDE: all ${acct!.total} ${acct!.provider ?? 'claude'} account(s) are fenced off by ` +
        `the active forced/excluded account steer, so no route can succeed. Revise or clear the override; ` +
        `this is not quota exhaustion.`
      );
    }
    const bindingTerms = acct!.accountBindingTerms ?? [];
    const edge = acct!.edgeThrottledCount ?? bindingTerms.filter((terms) => terms.edgeThrottleResetAt != null).length;
    const wall = acct!.usageWalledCount ?? bindingTerms.filter((terms) => terms.usageResetAt != null).length;
    const ratePause = acct!.accountBindingTerms
      ? bindingTerms.filter((terms) => terms.ratePausedUntil != null).length
      : 0;
    // Counts are only a marginal fallback: they cannot prove which constraint's reset actually gates
    // recovery when an account can be both edge-throttled and usage-walled. Use the per-account binding
    // term when the reader supplied one; retain the legacy count rule for older callers/tests.
    const countBasedCause: CapacityBindingCause | null =
      edge > 0 && edge > wall ? 'edge-throttle' : wall > 0 ? 'usage-wall' : null;
    const cause = bindingCause ?? countBasedCause;
    if (cause == null) return null; // no breakdown supplied → unchanged generic phrasing
    if (cause === 'edge-throttle') {
      // EI-18683773458136367: a bare edge-throttled COUNT proves neither "shared/down egress IP" nor
      // "escalate to the owner" — both are falsifiable claims that need the shared-egress evidence
      // below. `sharedEgress === false` (proven DISTINCT egress IPs among the throttled accounts) is
      // the opposite of a down-proxy signature; asserting one there manufactured false owner escalations
      // for a condition the owner cannot fix. Unknown/unsupplied evidence keeps the legacy phrasing
      // (fail-safe-omit, same contract as the other optional fields on AccountPoolAvailability).
      if (acct!.edgeThrottledSharedEgress === false) {
        return acct!.edgeThrottledRearming === true
          ? ` — ${edge}/${acct!.total} edge-throttled on DISTINCT egress IPs, cooldowns RE-ARMING rather ` +
              `than expiring (deadline advancing while the penalty count climbs — a retry/backoff loop ` +
              `re-hitting the edge before the cooldown clears). This is a POLICY/backoff bug, not a dead ` +
              `egress path — fix the retry cadence; this is NOT an owner-gated infra issue, do not escalate.`
          : ` — ${edge}/${acct!.total} edge-throttled on DISTINCT egress IPs (the opposite of a shared-IP ` +
              `failure signature — a real down/shared proxy would show roughly uniform pressure across ` +
              `accounts, not divergent per-account throttling). Investigate the per-account throttle cause ` +
              `before escalating; do NOT assume a down egress proxy from this count alone.`;
      }
      // WI-36943: real incident — `fleet:capacity` asserted "DOMINANT CAUSE: 3/3 edge-throttled →
      // egress path broken → escalate (OWNER-GATED)" while `accounts:status` measured only 1/3
      // edge-throttled and 2/3 holding real weekly budget; `inFlight` climbed 1→3 in the same window
      // (traffic WAS flowing). The pool was saturated by the LOCAL rate governor re-pausing accounts
      // (self-clearing in seconds), not a dead egress proxy. `edge + wall < total` is a PROVABLE lower
      // bound (independent of any overlap between the two counts) that at least one account is neither
      // edge-throttled nor usage-walled — i.e. the marginal counts alone cannot explain why it is
      // unusable, so something else (a rate-governor pause) must be the real driver. Combined with
      // `inFlight > 0` (the gateway IS passing traffic right now — a dead/unreachable forward-proxy
      // cannot be doing that), this directly disproves "the egress path itself is broken" — do not
      // instruct an owner-gated escalation off the edge-throttle count alone. `poolExhausted` stays
      // real (HOLD placements); only the causal/escalation claim is suppressed.
      if ((hr.inFlight ?? 0) > 0 && edge + wall < acct!.total) {
        const neither = acct!.total - edge - wall;
        return (
          ` — ${edge}/${acct!.total} edge-throttled (a live per-IP/Cloudflare bare-429 cooldown), but ` +
          `${hr.inFlight} request(s) are IN FLIGHT right now and at least ${neither}/${acct!.total} ` +
          `account(s) are neither edge-throttled nor usage-walled — the egress path IS passing traffic, ` +
          `so this reads as a transient/self-clearing cooldown or local rate-governor pause, NOT a dead/` +
          `unreachable forward-proxy. Do NOT escalate on this alone; re-read shortly. Only treat this as ` +
          `an owner-gated egress fault if usableAccounts stays at 0 while inFlight also drops to 0 (no ` +
          `traffic passing at all).`
        );
      }
      // fleet-lead-instrumentation-audit-2026-08-09 P-007: a BLIND reading cannot support an
      // owner escalation, by construction. `blindCaveat` below already prepends "do NOT treat an
      // owner-escalation reading below as confirmed until you have RE-RUN accounts:probe-capacity"
      // — but the clause it is warning about was still emitted, at full imperative confidence, in
      // the same string ("escalate rather than waiting"). One advice string thus carried both
      // "distrust this" and "escalate now", and the confident imperative is the one that gets
      // acted on: measured live 2026-08-09T05:11Z on fleet nonp2p-bug-drain, this branch fired
      // with blind:true / usableAccounts:0 / factor:0 while a live accounts:probe-capacity moments
      // later found THREE OF FOUR accounts answering 200. Relaying it would have sent the owner
      // after an egress path that was not broken — the second such false escalation in one session
      // (the first is WI-36943, whose inFlight guard above covers a DIFFERENT axis: it disproves a
      // dead proxy from live traffic, whereas this one refuses to make the claim at all when the
      // underlying per-account measurements are stale/missing).
      //
      // Same discipline as the sharedEgress and inFlight branches above: `poolExhausted` stays
      // real (HOLD placements is still correct); only the causal attribution and the escalation
      // instruction are withheld, and the reader is sent to the one call that resolves it.
      if (blind) {
        return (
          ` — ${edge}/${acct!.total} edge-throttled, which WOULD point at a broken egress path — but ` +
          `${acct!.blindCount}/${acct!.total} account(s) currently have an UNRELIABLE reading, so this ` +
          `count is not measured, it is inferred from stale/missing data. NOT an owner escalation: ` +
          `${blindRefreshInstruction} and re-read this advice. A merely-stale reading is ` +
          `indistinguishable from a real wall until you re-measure (2026-08-09: a blind read here ` +
          `asserted an owner-gated egress fault while 3 of 4 accounts answered 200).`
        );
      }
      return (
        ` — DOMINANT CAUSE: ${edge}/${acct!.total} edge-throttled (a live per-IP/Cloudflare bare-429 ` +
        `cooldown, NOT account quota). This usually means the egress path itself is broken (a down/` +
        `unreachable forward-proxy forcing accounts onto one shared, already-throttled IP) — an ` +
        `OWNER-GATED infra issue (egress proxies are owner-provisioned), not something that clears on ` +
        `its own; escalate rather than waiting for a quota reset.`
      );
    }
    if (cause === 'rate-pause') {
      return (
        ` — dominant cause: ${ratePause}/${acct!.total} rate-paused (bounded local rate-governor cooldowns) ` +
        `→ re-read shortly as the pauses clear; no owner/egress escalation needed.`
      );
    }
    return (
      ` — dominant cause: ${wall}/${acct!.total} usage-walled (their own 5h/7d budget window is at cap) ` +
      `→ this clears on the window reset; adding accounts or waiting is the fix, no infra escalation needed.`
    );
  })();
  // EI-19281217347369076: a majority-blind pool means the reading THIS advice is about to render
  // confidently rests on stale/unrefreshable measurements — surface that BEFORE the confident verdict,
  // not as a footnote, and name the concrete unstick (re-probe or check egress) instead of a bare
  // "distrust this" flag. Composes with every branch below (restart-grace already means "re-check next
  // wake" regardless, so it is deliberately excluded).
  const blindCaveat = blind
    ? `⚠ BLIND READING: ${acct!.blindCount}/${acct!.total} ${acct!.provider ?? 'claude'} account(s) have an ` +
      `UNRELIABLE reading (an unresolved accounts:probe-capacity 'no-reading' failure, and/or a usage-window ` +
      `observation that has simply gone stale from lack of a recent refresh) — their available/usageWalled ` +
      `verdict rests on OLD OR MISSING data, not a live measurement. Do NOT wait on resetInSec or treat a ` +
      `quota-exhaustion or owner-escalation reading below as confirmed until you ${blindRefreshInstruction} ` +
      `and re-read this advice — a merely-stale-but-fine reading looks identical to ` +
      `a real wall until you re-measure it (EI-19928050541357086: one probe call flipped poolExhausted from ` +
      `true to false here with no other change). accounts:test-egress on the affected accounts checks for a ` +
      `shared/down egress IP if the refreshed reading still looks exhausted. `
    : '';
  // EI-22510899908612251: the launch-on-plan path uses dispatchBudget as the hard
  // concurrent-new-member cap, while factor/recommendedHeadroom describe pool health
  // and weekly-budget pressure. Keep the healthy-pool advice, but state the cap in the
  // same payload so "place broadly" cannot hide a one-member launch clamp.
  const launchClampNote =
    opts.clampArmed && dispatchBudget != null
      ? `; launch clamp caps new members at ${dispatchBudget} per wave (dispatchBudget=${dispatchBudget})`
      : '';
  const advice = blindCaveat + (restartRecovering
    ? `gateway restarting (uptime ${Math.round((hr.processUptimeMs ?? 0) / 1000)}s) → startup capacity snapshot is recovering; place at normal ceiling and re-check next wake`
    : poolExhausted
    ? sessionOverrideExhausted
      ? `pool EXHAUSTED: gateway reports ~${dispatchBudget ?? 0} bee slots but the active session override fences all ${acct!.total} ${acct!.provider ?? 'claude'} accounts (0/${acct!.total} routable) → HOLD placements; revise or clear the override before spawning${exhaustionCause ?? ''}`
      : `pool EXHAUSTED: gateway reports ~${dispatchBudget ?? 0} bee slots but ${acct!.usable}/${acct!.total} ${acct!.provider ?? 'claude'} accounts are usable (rest walled/rate-paused/edge-throttled) → HOLD placements; dispatchBudget is a QUEUE figure, not real inference capacity (fresh spawns will die on their first call)${exhaustionCause ?? ''}`
    : poolBlocked
    ? 'pool SATURATED (paused/rejected) → place ONLY top-ranked tier-1 work; hold bee batch until it recovers'
    : degraded
    ? `DEGRADED: all ${acct!.usable}/${acct!.total} usable ${acct!.provider ?? 'claude'} account(s) are sustainedly rate-limited (repeated governor penalties) — not exhausted, but not abundant either → place conservatively (top-ranked only), prefer a warm-inject over a fresh spawn`
    : factor <= 0.25
      ? `scarce (factor ${factor.toFixed(2)}) → place the top-ranked items only, hold the rest${dispatchBudget != null ? `; ~${dispatchBudget} bee slots free` : ''}`
      : factor < 1
        ? `tightening (factor ${factor.toFixed(2)}) → trim low-priority placements${dispatchBudget != null ? `; ~${dispatchBudget} bee slots free` : ''}`
        : `abundant → place broadly up to your ceiling${launchClampNote}`);

  // P-001: the imperative LEADS. The two standing facts that would have prevented the 2026-08-09
  // misdiagnosis were excerpted at 180 chars and both lost their verb, so the instruction has to be
  // the first thing in the payload, not a trailing footnote after the evidence.
  const symptomKnowledge =
    poolExhausted || poolBlocked || degraded
      ? {
          before:
            'ALWAYS cross-read accounts:status before escalating, holding placements, or telling an owner to add accounts — this verdict is NOT self-validating.',
          why: 'These counts collapse THREE different failures that need OPPOSITE responses: a TRANSPORT/edge throttle (shared or down egress — route around it, it is not account exhaustion), a per-minute RATE 429 (transient, pace it), and a token-budget USAGE WALL (the only one that means real quota is gone). An account excluded for the first two still holds quota, so "usable" can read 1 while three accounts are fine. Confirm which one you are looking at (usageWalled vs edgeThrottled vs sustainedlyLimited, per account) before acting.',
          insights: [
            '/internal/docs/agent-insights/inference-gateway-three-rate-signals-not-one',
            '/internal/docs/agent-insights/rate-limit-is-usually-account-routing-not-capacity',
            '/internal/docs/agent-insights/llm-429-check-the-transport-not-the-account',
          ],
        }
      : undefined;

  const edgeCount = acct?.edgeThrottledCount ?? 0;
  const wallCount = acct?.usageWalledCount ?? 0;
  const countBasedCause: CapacityBindingCause | null =
    edgeCount > 0 && edgeCount > wallCount ? 'edge-throttle' : wallCount > 0 ? 'usage-wall' : null;
  const exhaustionReason: CapacityReport['exhaustionReason'] = !poolExhausted
    ? null
    : sessionOverrideExhausted
      ? 'session-override'
      : bindingCause ?? countBasedCause ?? 'unknown';

  return {
    reachable: true,
    ...(symptomKnowledge ? { symptomKnowledge } : {}),
    tierLayer: !!pt,
    clampArmed: opts.clampArmed,
    utilization: hr.utilization ?? null,
    utilizationPct: hr.utilizationPct ?? null,
    paused: !!hr.paused,
    rejected: !!hr.rejected,
    resetInSec: hr.resetInSec ?? null,
    resetInSecActionable: !blind,
    healthyAccounts: pt?.healthyAccounts ?? null,
    tier1Reserve: pt?.tier1Reserve ?? null,
    beeTier,
    dispatchBudget,
    usableAccounts: acct?.usable ?? null,
    availableAccounts: acct?.available ?? null,
    overrideExcludedAccounts: acct?.overrideExcludedCount ?? null,
    activeSessionOverride: acct?.sessionOverride ?? null,
    poolExhausted,
    exhaustionReason,
    sustainedlyLimitedAccounts: acct?.sustainedlyLimitedCount ?? null,
    degraded,
    blind,
    blindAccounts: acct?.blindCount ?? null,
    capByTier,
    inFlight: hr.inFlight ?? null,
    queueDepth: hr.queueDepth ?? null,
    processUptimeMs: hr.processUptimeMs ?? null,
    restartRecovering,
    factor,
    recommendedHeadroom,
    throttled,
    advice,
  };
}

/**
 * PURE: warn when a requested fleet member count exceeds the pool's CURRENT healthy-account
 * headroom. This is a sizing advisory only — not an admission gate — because extra members can
 * still launch, but they'll likely thrash rotation against the same few healthy accounts.
 */
export function buildFleetSizingAdvisory(
  requestedMembers: number,
  report: Pick<CapacityReport, 'reachable' | 'healthyAccounts'>,
): FleetSizingAdvisory | null {
  const requested = Math.max(0, Math.floor(requestedMembers));
  const healthyHeadroom =
    report.reachable && Number.isFinite(report.healthyAccounts)
      ? Math.max(0, Math.floor(report.healthyAccounts ?? 0))
      : null;
  if (healthyHeadroom == null || requested <= healthyHeadroom) return null;
  const extraMembers = requested - healthyHeadroom;
  const accountLabel = healthyHeadroom === 1 ? 'healthy account' : 'healthy accounts';
  const memberLabel = extraMembers === 1 ? 'member' : 'members';
  return {
    requestedMembers: requested,
    healthyHeadroom,
    extraMembers,
    message:
      `Sizing advisory: requested ${requested} fleet members, but only ${healthyHeadroom} ${accountLabel} ` +
      `are currently routable. All ${requested} members WILL still launch — ONE account paces many concurrent ` +
      `Claude sessions through the gateway, so account count is NOT a per-member cap. The only caution is ` +
      `rate-limit churn: the ${extraMembers} ${memberLabel} beyond the routable accounts share account rotation ` +
      `and may hit 429s under sustained load. To reduce churn (optional) add healthy accounts or lower the count — ` +
      `you are NOT limited to ${healthyHeadroom} member${healthyHeadroom === 1 ? '' : 's'}.`,
  };
}
