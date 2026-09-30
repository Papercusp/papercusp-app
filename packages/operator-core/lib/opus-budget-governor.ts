/**
 * Fleet opus-budget governor (inference-gateway-robustness-audit-2026-06-20, gateway P2 / B-GW-4).
 *
 * The wedge this closes: when the aggregate Claude-Max **5h unified opus budget** approaches 100%,
 * the gateway throttles hard (429/503) until the rolling window frees — "blow-then-starve". The
 * fleet over-DRIVES opus into the ceiling instead of PACING under it, so recovery waits for the
 * window. This governor paces fleet opus to stay UNDER the ceiling by *reserving headroom*: as the
 * aggregate opus utilization climbs, progressively more NON-CRITICAL opus demand is shed to sonnet,
 * so the climb caps below 1.0 instead of slamming into it.
 *
 * ## The signal — aggregate opus pressure
 *
 * Each Claude-Max account has its OWN 5h (and 7d) unified window; the pool's `AccountRateState`
 * already carries the observed `utilization` per account (fed from the gateway's response headers —
 * the only process that sees them). The aggregate fleet opus capacity is the SUM of per-account
 * remaining budgets, but the question that actually gates the next opus call is *"is there ANY
 * account with headroom?"* — and the account we'd route opus to is the lowest-utilization available
 * one (`selectAccountByDrain` picks min effective util). So the fleet's opus PRESSURE is the
 * **minimum `effectiveDrainUtil` across available (not-paused), OPUS-CAPABLE (Claude) accounts** —
 * the best account we could still route opus to. A `codex`/non-Claude account cannot serve opus, so
 * it is excluded from this signal (else its opus-irrelevant 0-util would read as false headroom). While one account has a fresh 5h window, opus IS available there (pressure
 * low, correct); only when EVERY available account climbs toward its cap together does pressure
 * approach 1.0. We use `effectiveDrainUtil` (max of the 5h and 7d windows) so a fleet near its
 * WEEKLY cap paces too (the 7d "ownerhandle2 trap").
 *
 * Unknown / stale readings count as 0 (the established drain-selector convention — an un-probed
 * account is treated as most-available so a cold pool degrades to "admit everything, never pace on
 * missing data"). An empty pool yields `null` (no signal → the governor is a no-op).
 *
 * ## Graduated shedding (the pacing mechanism)
 *
 * As aggregate util crosses thresholds, MORE criticality classes shed their opus to sonnet:
 *
 *   util < reserveStart        headroom   shed nothing
 *   reserveStart ≤ util        reserve    shed `background` opus → sonnet
 *   reserveHard  ≤ util        near-cap   shed `background` + `normal`
 *   nearCap      ≤ util        exhausted  shed `background` + `normal`; `critical` → keep opus + `pace`
 *
 * `critical` opus is NEVER downgraded (the most important work always gets opus), but past `nearCap`
 * it is flagged `pace` so the admission layer can slow it. Because the bulk of fleet opus volume is
 * background+normal, shedding it as util rises is what keeps the AGGREGATE below the ceiling — the
 * fleet self-limits instead of blowing the window.
 *
 * ## Floor invariant (delegated, not re-implemented)
 *
 * This module only DECIDES whether a class should shed; the actual tier downgrade is applied by
 * `downgradeOpusTierForBudget` (model-tiers.ts), which re-resolves through `resolveTierSpec` so the
 * existing role-floor clamp guarantees a role is never dropped below its OWN opus floor (EI-7/EI-286).
 * So an opus-floored role's `critical`/`normal` work stays opus even when this governor says "shed".
 *
 * PURE — types + decisions over a plain `AccountPool` value; no PG / governor / gateway IO. The IO
 * wrapper (`evaluateOpusBudgetForSpawn`) lives in `deployment/account-pool-store.ts`, keeping this
 * core exhaustively unit-testable with no fixtures.
 */
import {
  type AccountPool,
  type ClaudeAccount,
  DRAIN_UTIL_STALE_MS,
  effectiveDrainUtil,
  isAvailable,
} from './deployment/account-pool';

/**
 * How essential opus is for a piece of work — the lever the governor sheds by. The mapping from a
 * spawn's role lives in `classifyRoleCriticality`; a caller may also pass an explicit override.
 *   - `critical`   — ship-gating or human-facing work; never downgraded (paced only at exhaustion).
 *   - `normal`     — ordinary feature/implementation work; sheds only near the cap.
 *   - `background` — exploratory / optional / batch work; sheds first, the moment headroom tightens.
 */
export type WorkCriticality = 'critical' | 'normal' | 'background';

/** The utilization zones, widening from "plenty of opus" to "reserve the last of it for critical work". */
export type OpusBudgetZone = 'headroom' | 'reserve' | 'near-cap' | 'exhausted';

export interface OpusBudgetPolicy {
  /** At/above this aggregate opus util, begin shedding `background` opus → sonnet (default 0.75). */
  reserveStart: number;
  /** At/above this, also shed `normal` opus → sonnet (default 0.88). */
  reserveHard: number;
  /** At/above this, the fleet is reserving headroom for `critical` only; `critical` opus is `pace`d
   *  (default 0.95 — mirrors `DRAIN_FULL_UTIL` 0.97's neighborhood, a notch below to reserve). */
  nearCap: number;
  /** A utilization reading older than this (ms) is ignored (treated as unknown → 0). Default 10 min
   *  (`DRAIN_UTIL_STALE_MS`) — the same staleness the drain selector uses. */
  staleMs: number;
}

export const DEFAULT_OPUS_BUDGET_POLICY: OpusBudgetPolicy = {
  reserveStart: 0.75,
  reserveHard: 0.88,
  nearCap: 0.95,
  staleMs: DRAIN_UTIL_STALE_MS,
};

export interface OpusBudgetDecision {
  /** Aggregate opus pressure: the best (min) effective util across available accounts; `null` when
   *  there is no signal at all (empty pool) → the governor is a no-op. */
  aggregateUtil: number | null;
  /** Reserve headroom remaining under the `nearCap` target: `max(0, nearCap - aggregateUtil)`; `null`
   *  when `aggregateUtil` is unknown. Surfaced for observability. */
  headroom: number | null;
  /** Which utilization zone the fleet is in. */
  zone: OpusBudgetZone;
  /** Whether THIS criticality's opus should be shed to sonnet right now. */
  downgrade: boolean;
  /** Advisory: even a NON-downgraded (`critical`) opus call should be paced (the admission layer may
   *  delay it) because the fleet is at/over `nearCap`. */
  pace: boolean;
  /** Human-readable why (for the spawn log / telemetry). */
  reason: string;
}

/**
 * Roles whose work is CRITICAL — ship-gating, decision-making, or human-facing. Their opus is never
 * downgraded by the budget governor (paced only past `nearCap`). Anything not here and not in
 * `BACKGROUND_ROLES` is `normal`.
 */
export const CRITICAL_ROLES: ReadonlySet<string> = new Set([
  'operator',
  'su',
  'mug',
  'kettle',
  'architect',
  'validator',
  'reviewer',
  'security-reviewer',
  'infra-reviewer',
  'auditor',
  'crosscheck',
  'release-manager',
]);

/**
 * Roles whose work is BACKGROUND — exploratory, optional, post-ship, or batch. Their opus sheds to
 * sonnet first (the moment the reserve zone opens), since they tolerate a weaker model under budget
 * pressure far better than ship-gating work does.
 */
export const BACKGROUND_ROLES: ReadonlySet<string> = new Set([
  'scout',
  'gym',
  'papercup',
  'ui-qa',
  'curator',
  'documenter',
]);

/**
 * Classify a spawn's role into a criticality (the default mapping; a caller may override per-spawn).
 * Plugin-namespaced roles (`<plugin>:<role>`) classify on the bare role. Unknown ⇒ `normal`.
 */
export function classifyRoleCriticality(role: string | null | undefined): WorkCriticality {
  const r = (role ?? '').trim().toLowerCase();
  const bare = r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r;
  if (CRITICAL_ROLES.has(bare)) return 'critical';
  if (BACKGROUND_ROLES.has(bare)) return 'background';
  return 'normal';
}

/**
 * The aggregate fleet opus pressure — the MIN effective (5h⊔7d) utilization across AVAILABLE
 * accounts (the best account we could still route opus to). Returns:
 *   - `null` when the pool is empty (no signal → no-op),
 *   - `1` when accounts exist but NONE are available (all paused → fully exhausted),
 *   - otherwise the min effective util among available accounts (unknown/stale readings = 0, so a
 *     cold pool reads as full headroom).
 */
export function aggregateOpusUtil(pool: AccountPool, now: number, staleMs = DRAIN_UTIL_STALE_MS): number | null {
  if (pool.accounts.length === 0) return null;
  // Only OPUS-CAPABLE (Claude) accounts factor into opus pressure. A `codex`/non-Claude account cannot
  // serve Claude opus, so counting its (opus-irrelevant, usually 0) drain util as the MIN reads as a
  // false "opus headroom" and suppresses shedding while Claude opus is actually exhausted pool-wide —
  // the observed WI-1073 failure: a codex account in the pool pinned aggregateUtil to 0 (zone
  // `headroom`) even though every Claude account was near its 5h/7d cap, so the governor never shed
  // background/normal opus → sonnet and the fleet 429-looped. Legacy rows without `provider` are Claude.
  const opusCapable = pool.accounts.filter((a) => (a.provider ?? 'claude') === 'claude');
  if (opusCapable.length === 0) return null; // no Claude accounts → no opus signal → governor no-op
  const available = opusCapable.filter((a) => isAvailable(a, now));
  if (available.length === 0) return 1; // every Claude account paused → no opus headroom anywhere
  let min = Infinity;
  for (const a of available) {
    const u = effectiveOpusUtilFresh(a, now, staleMs);
    if (u < min) min = u;
  }
  return min;
}

/** An account's effective opus util, honoring `staleMs` (a reading older than that is unknown → 0). */
function effectiveOpusUtilFresh(a: ClaudeAccount, now: number, staleMs: number): number {
  const at = a.rate.utilizationAt;
  if (at !== undefined && now - at > staleMs) return 0; // stale → treat as un-probed headroom
  // effectiveDrainUtil applies its OWN DRAIN_UTIL_STALE_MS staleness; the extra guard above lets a
  // caller widen/narrow the window independently of the drain selector's fixed one.
  return effectiveDrainUtil(a, now);
}

/** Classify an aggregate util into a zone. `null` (no signal) ⇒ `headroom` (the no-op zone). */
export function classifyOpusZone(util: number | null, policy: OpusBudgetPolicy = DEFAULT_OPUS_BUDGET_POLICY): OpusBudgetZone {
  if (util === null) return 'headroom';
  if (util >= policy.nearCap) return 'exhausted';
  if (util >= policy.reserveHard) return 'near-cap';
  if (util >= policy.reserveStart) return 'reserve';
  return 'headroom';
}

/** The zone at/after which a criticality class begins shedding its opus to sonnet. `critical` never
 *  sheds (it returns a zone past `exhausted` so the comparison is always false). */
function shedsFromZoneRank(criticality: WorkCriticality): number {
  switch (criticality) {
    case 'background':
      return ZONE_RANK.reserve;
    case 'normal':
      return ZONE_RANK['near-cap'];
    case 'critical':
      return Number.POSITIVE_INFINITY; // never shed
  }
}

const ZONE_RANK: Record<OpusBudgetZone, number> = {
  headroom: 0,
  reserve: 1,
  'near-cap': 2,
  exhausted: 3,
};

export interface EvaluateOpusBudgetArgs {
  pool: AccountPool;
  criticality: WorkCriticality;
  now: number;
  policy?: OpusBudgetPolicy;
}

/**
 * Decide whether a piece of opus work of the given criticality should be shed to sonnet right now,
 * given the live account pool. Pure — composes `aggregateOpusUtil` + `classifyOpusZone` + the
 * per-criticality shed threshold. See the module header for the zone → shed mapping.
 */
export function evaluateOpusBudget(args: EvaluateOpusBudgetArgs): OpusBudgetDecision {
  const policy = args.policy ?? DEFAULT_OPUS_BUDGET_POLICY;
  const util = aggregateOpusUtil(args.pool, args.now, policy.staleMs);
  const zone = classifyOpusZone(util, policy);
  const headroom = util === null ? null : Math.max(0, policy.nearCap - util);
  const zoneRank = ZONE_RANK[zone];
  const downgrade = zoneRank >= shedsFromZoneRank(args.criticality);
  // `critical` is never downgraded but is paced once the fleet is reserving headroom for it.
  const pace = zone === 'exhausted' && !downgrade;
  const pct = util === null ? 'unknown' : `${Math.round(util * 100)}%`;
  const reason = downgrade
    ? `opus budget ${pct} (${zone}) ≥ ${args.criticality} shed threshold — routing ${args.criticality} work to sonnet to reserve 5h headroom`
    : pace
      ? `opus budget ${pct} (${zone}) — pacing critical opus to stay under the 5h ceiling`
      : `opus budget ${pct} (${zone}) — ${args.criticality} work keeps opus`;
  return { aggregateUtil: util, headroom, zone, downgrade, pace, reason };
}

/** The whole-fleet opus-budget state — the observability shape the read-model surfaces. */
export interface OpusBudgetStatus {
  /** Aggregate opus pressure (min effective util across available accounts); `null` = no signal. */
  aggregateUtil: number | null;
  /** Reserve headroom remaining under `nearCap`; `null` when unknown. */
  headroom: number | null;
  zone: OpusBudgetZone;
  /** The active policy thresholds (for the UI to render the zone bands). */
  thresholds: { reserveStart: number; reserveHard: number; nearCap: number };
  /** Which criticality classes are currently shedding their opus → sonnet. */
  shedding: Record<WorkCriticality, boolean>;
  /** True when `critical` opus is being paced (zone = exhausted). */
  pacingCritical: boolean;
}

/**
 * Summarize the fleet opus-budget state across all criticality classes (for the rate-status
 * read-model / `dev:rate_governor_status` / the top-bar). Pure — one decision per criticality.
 */
export function summarizeOpusBudget(pool: AccountPool, now: number, policy: OpusBudgetPolicy = DEFAULT_OPUS_BUDGET_POLICY): OpusBudgetStatus {
  const decisions = (['background', 'normal', 'critical'] as WorkCriticality[]).map((c) => [c, evaluateOpusBudget({ pool, criticality: c, now, policy })] as const);
  const byClass = Object.fromEntries(decisions) as Record<WorkCriticality, OpusBudgetDecision>;
  const base = byClass.normal; // util/zone/headroom are class-independent
  return {
    aggregateUtil: base.aggregateUtil,
    headroom: base.headroom,
    zone: base.zone,
    thresholds: { reserveStart: policy.reserveStart, reserveHard: policy.reserveHard, nearCap: policy.nearCap },
    shedding: {
      background: byClass.background.downgrade,
      normal: byClass.normal.downgrade,
      critical: byClass.critical.downgrade,
    },
    pacingCritical: byClass.critical.pace,
  };
}
