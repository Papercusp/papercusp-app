/**
 * The autonomy risk model — the graded risk scale + the authority axis + the
 * pure needs-human gate.
 *
 * The SHARED SEAM for queen-autonomy-policy-2026-06-13 (Brief B-01): plan items
 * carry `riskTier`/`authority` (parser.ts); coord escalations + the harness
 * escalations table map their severity onto `risk_tier` (operator-core); the
 * per-category autonomy-policy store (B-03) types its ceiling as an
 * {@link AutonomyCeiling}; the Queen decider (B-12) calls {@link deriveNeedsHuman}.
 * Everyone imports THIS — there is one definition of the scale, not two.
 *
 * Three axes, kept SEPARATE on purpose (D-002): `risk_tier` (likelihood-of-error,
 * the earned dial), `authority` (the owner's by right, a categorical override),
 * and — built by P-012, not here — `reversibility` (blast radius). A single
 * multiplied "risk" scalar would let a confident-but-catastrophic action and a
 * shaky-but-trivial-reversible action collapse to the same handling; keeping the
 * axes separate is the failure mode D-002 avoids.
 *
 * `risk_tier` is ALSO kept distinct from `importance` (parser.ts): the ranker
 * consumes `importance` ("which to pick up next"), the autonomy gate consumes
 * `risk_tier` ("may the Queen decide this without asking") — D-002 / P-014.
 *
 * Pure, zero I/O — same tier as the parser.
 */

/**
 * The graded autonomy risk scale (D-001). `needs-human` is no longer a distinct
 * kind — it is the DERIVED top band of this scale (a tier above the effective
 * per-category ceiling). Ordered ascending risk; the array index doubles as the
 * comparison rank (trivial = 0 … critical = 4).
 */
export const RISK_TIERS = ['trivial', 'low', 'moderate', 'high', 'critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Comparison rank — index in {@link RISK_TIERS}, ascending risk (trivial=0 … critical=4). */
export function riskTierRank(t: RiskTier): number {
  return RISK_TIERS.indexOf(t);
}

/** Negative if `a` is less risky than `b`, 0 if equal, positive if more risky. */
export function compareRiskTier(a: RiskTier, b: RiskTier): number {
  return riskTierRank(a) - riskTierRank(b);
}

/** True when `t` is at least as risky as `floor`. */
export function riskTierAtOrAbove(t: RiskTier, floor: RiskTier): boolean {
  return riskTierRank(t) >= riskTierRank(floor);
}

/**
 * Decision authority (P-011 / D-002). `owner` means the call is the owner's by
 * right — it ALWAYS gates to a human regardless of the computed risk. `system`
 * is the default (the Queen may auto-run it once risk ≤ the category ceiling).
 */
export const AUTHORITY_LEVELS = ['system', 'owner'] as const;
export type Authority = (typeof AUTHORITY_LEVELS)[number];
/** Default when an item carries no `authority:` annotation. */
export const DEFAULT_AUTHORITY: Authority = 'system';

/**
 * A per-category autonomy CEILING (D-003 / D-005): the highest `risk_tier` the
 * Queen may auto-run within for that category. `'never-auto'` sits BELOW
 * `trivial` — nothing in the category auto-runs. Every category ships at
 * `'never-auto'` (D-007), and the never-auto "protected" set (release/deploy ·
 * spend/budget · credentials/auth · system-control) is just categories whose
 * ceiling is LOCKED there — unifying "never-auto" and "per-category ceiling"
 * into one mechanism.
 */
export const AUTONOMY_CEILINGS = ['never-auto', ...RISK_TIERS] as const;
export type AutonomyCeiling = (typeof AUTONOMY_CEILINGS)[number];

export interface NeedsHumanInput {
  /** The item's graded risk. null/undefined ⇒ unknown ⇒ fail-safe to the top band. */
  riskTier?: RiskTier | null;
  /** `owner` ALWAYS gates regardless of computed risk (P-011, D-002). */
  authority?: Authority | null;
  /**
   * The EFFECTIVE per-category ceiling — `min(owner cap, graduated level)` (D-004).
   * Consulted only on the ARMED path. Defaults to `'never-auto'`.
   */
  ceiling?: AutonomyCeiling | null;
  /**
   * The legacy stored `needs-human` token (a plan item whose status is
   * `needs-human`). The behavior-neutral fallback until the policy is ARMED.
   */
  storedNeedsHuman?: boolean;
  /**
   * Whether the autonomy policy is ARMED (the owner's P-092 gate). Until armed,
   * the derivation IS the stored token, so behavior is identical to today (D-007).
   * No caller arms before P-092. Default false.
   */
  armed?: boolean;
}

/**
 * The needs-human half of the unified gating function (D-004):
 *
 *   auto ⟺ risk_tier ≤ min(ceiling, graduated) ∧ reversible ∧ ¬authority_owner ∧ ¬protected
 *   needs_human ⟺ ¬auto
 *
 * B-01 supplies the `risk_tier` + `authority` + `ceiling` inputs; reversibility
 * (P-012) and the protected set (B-03, modeled as `ceiling = 'never-auto'`)
 * compose in later via the same function.
 *
 * BEHAVIOR-NEUTRAL by default (D-007): with `armed === false` (no caller arms
 * before P-092) the result is exactly `storedNeedsHuman`. The single exception is
 * `authority === 'owner'`, which gates unconditionally — and since no item sets
 * `authority` today, that branch is never taken until the model is deliberately
 * used, so the migration still lands behavior-identical to today.
 */
export function deriveNeedsHuman(input: NeedsHumanInput): boolean {
  // The owner's call, by right (P-011) — gates armed or not.
  if (input.authority === 'owner') return true;
  // Behavior-neutral until armed (D-007): the stored token drives, exactly as today.
  if (!input.armed) return input.storedNeedsHuman ?? false;
  // Armed path (consumed by P-072 / B-12 once the policy store + decider land).
  const ceiling: AutonomyCeiling = input.ceiling ?? 'never-auto';
  if (ceiling === 'never-auto') return true; // locked-at-zero / unmapped ⇒ never auto
  const tier: RiskTier = input.riskTier ?? 'critical'; // unknown risk ⇒ fail-safe (D-002)
  return riskTierRank(tier) > riskTierRank(ceiling); // tier above ceiling ⇒ needs human
}
