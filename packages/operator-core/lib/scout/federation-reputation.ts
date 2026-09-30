/**
 * federation-reputation.ts — P-009 (F3-1) outcome-weighted reputation for
 * federated Scout↔gym learning (D-004 / D-005). A foreign artifact's priming
 * weight is NOT flat: it is `winRate × tierWeight`, so a distant hive earns
 * influence over local generation only by (a) being trusted AND (b) having its
 * shared elites actually pay off once decided.
 *
 * The two anti-learning-poisoning guards (D-005):
 *   1. UNVERIFIED sources decay to ZERO weight — no verified decided outcome, or
 *      an `unverified` trust tier ⇒ weight 0 (an open-network stranger cannot
 *      steer local ideation until it has earned a verified track record).
 *   2. PER-SOURCE RATE CAPS — one source may contribute at most N federated
 *      artifacts per window, so a Sybil flood cannot dominate the map/seeds even
 *      with a good win-rate.
 *
 * Pure module — no PG, no clock. The trust TIER is resolved by the assembly from
 * REUSED stores (hive membership via `hive_policy`, verified-author standing via
 * the trust list) — this module only maps a tier to a weight and folds it with
 * the verified win-rate. The verified-outcome counts arrive from Lane A's P-014
 * device-signed outcome records (P-044 verdict shape); until P-014 lands, a
 * source simply has `verifiedDecided: 0` and decays to zero — a safe default,
 * not a special case.
 */

/**
 * The federation trust lattice — a LEARNING-trust dimension distinct from the
 * comms tier (observe<message<wake<steer, which governs wake/steer permissions,
 * not how much a peer's LEARNING is weighted). Resolved by the assembly from
 * existing trust signals; the tier→weight map below is the learning-specific part.
 */
export const FEDERATION_TRUST_TIERS = ['unverified', 'known', 'member', 'trusted'] as const;
export type FederationTrustTier = (typeof FEDERATION_TRUST_TIERS)[number];

/**
 * Tier → base priming weight in [0,1]. `unverified` is HARD ZERO (guard 1): an
 * unverified source can never prime local generation regardless of its claimed
 * win-rate. The others rise with earned standing.
 */
export const FEDERATION_TIER_WEIGHT: Readonly<Record<FederationTrustTier, number>> = Object.freeze({
  unverified: 0,
  known: 0.4,
  member: 0.7,
  trusted: 1,
});

/** A source's VERIFIED outcome tally (from device-signed outcome records, P-014). */
export interface SourceOutcomeStats {
  /** Federated elites from this source with a verified WINNING outcome. */
  verifiedWins: number;
  /** Federated elites from this source with a verified DECIDED outcome (win or loss). */
  verifiedDecided: number;
}

export interface ReputationInputs {
  tier: FederationTrustTier;
  outcomes: SourceOutcomeStats;
  /**
   * Laplace prior pseudo-count (default 2 ⇒ a neutral 0.5 smoothed rate) so a
   * source with one lucky verified win is not immediately max-weighted.
   */
  priorCount?: number;
}

export interface ReputationWeight {
  /** Final priming weight in [0,1] = winRate × tierWeight, gated by {@link verified}. */
  weight: number;
  /** Laplace-smoothed verified win-rate in [0,1]; null when no verified decided outcomes. */
  winRate: number | null;
  /** The tier's base weight (0 for unverified). */
  tierWeight: number;
  /** False ⇒ decayed to zero (unverified tier OR no verified decided outcomes). */
  verified: boolean;
}

/** Fold a source's trust tier + verified outcomes into its priming weight. Pure + total. */
export function federationReputationWeight(inp: ReputationInputs): ReputationWeight {
  const tierWeight = FEDERATION_TIER_WEIGHT[inp.tier] ?? 0;
  const prior = inp.priorCount != null && inp.priorCount > 0 ? inp.priorCount : 2;
  const decided = Math.max(0, inp.outcomes.verifiedDecided);
  const wins = Math.max(0, Math.min(inp.outcomes.verifiedWins, decided));
  const winRate = decided > 0 ? (wins + prior / 2) / (decided + prior) : null;
  // Guard 1 (anti-poisoning): an unverified tier OR no verified decided outcome
  // ⇒ zero weight. tierWeight is already 0 for 'unverified', so this is belt-and-braces.
  const verified = inp.tier !== 'unverified' && decided > 0;
  const weight = verified && winRate != null ? winRate * tierWeight : 0;
  return { weight, winRate, tierWeight, verified };
}

// ── per-source rate caps (guard 2, D-005 anti-flood) ──────────────────────────

/** Default per-source cap on federated artifacts admitted per window. */
export const DEFAULT_PER_SOURCE_RATE_CAP = 20;

export interface SourceRateInputs {
  /** Artifacts this source has already contributed in the current window. */
  usedThisWindow: number;
  /** Per-source cap per window (default {@link DEFAULT_PER_SOURCE_RATE_CAP}). */
  capPerWindow?: number;
}

/** Remaining admissions for a source this window (never negative). */
export function sourceRateRemaining(inp: SourceRateInputs): number {
  const cap = inp.capPerWindow != null && inp.capPerWindow >= 0 ? inp.capPerWindow : DEFAULT_PER_SOURCE_RATE_CAP;
  return Math.max(0, cap - Math.max(0, inp.usedThisWindow));
}

/** True iff a source has hit/exceeded its per-window cap and must be throttled. */
export function sourceRateCapExceeded(inp: SourceRateInputs): boolean {
  return sourceRateRemaining(inp) <= 0;
}
