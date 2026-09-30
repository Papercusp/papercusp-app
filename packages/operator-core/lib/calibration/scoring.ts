/**
 * Pure Brier-style scoring for calibration markets (P-041 / FB-13). No IO —
 * store.ts aggregates the SQL side and hands counts here; the ranker feature
 * and calibration:summary share these exact transforms so a weight always
 * means the same thing everywhere.
 */

/** Mean (p − outcome)² over scored bets. 0 perfect; 0.25 = constant-0.5 noise. */
export function brierScore(bets: readonly { probability: number; outcome: boolean }[]): number {
  if (bets.length === 0) return Number.NaN;
  let sum = 0;
  for (const b of bets) sum += (b.probability - (b.outcome ? 1 : 0)) ** 2;
  return sum / bets.length;
}

/** The benefit-of-the-doubt weight for a predictor with no scored history. */
export const NEUTRAL_WEIGHT = 0.5;
/** Pseudo-count of neutral history mixed in — small n barely moves the weight. */
export const WEIGHT_PRIOR_N = 6;

/**
 * Trust weight in [0,1] from a Brier score + sample size. Skill maps brier
 * linearly against the 0.25 constant-0.5 reference (perfect → 1, coin-flip or
 * worse → 0), then shrinks toward NEUTRAL_WEIGHT by WEIGHT_PRIOR_N
 * pseudo-bets — so an unknown predictor reads 0.5, a proven-noisy one decays
 * toward 0, and a proven-sharp one earns its way toward 1.
 */
export function calibrationWeight(brier: number, n: number): number {
  if (!Number.isFinite(brier) || n <= 0) return NEUTRAL_WEIGHT;
  const skill = Math.max(0, Math.min(1, 1 - brier / 0.25));
  return (n * skill + WEIGHT_PRIOR_N * NEUTRAL_WEIGHT) / (n + WEIGHT_PRIOR_N);
}

/**
 * P(bad outcome) implied by an open bet, per domain direction: for
 * flake-recurrence the claim ("it recurs") IS the bad outcome, so p reads
 * straight; everywhere else (fix-survival, plan-ship, future claim-true-is-good
 * domains) the bad outcome is the claim failing — 1 − p.
 */
export function badOutcomeExpectation(domain: string, probability: number): number {
  const p = Math.max(0, Math.min(1, probability));
  return domain === 'flake-recurrence' ? p : 1 - p;
}
