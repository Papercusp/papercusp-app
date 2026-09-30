/**
 * policy.ts — the per-category autonomy policy value type + the pure gate
 * arithmetic over it (queen-autonomy-policy-2026-06-13 B-03 / Phase 2).
 *
 * The risk vocabulary (RISK_TIERS · AUTONOMY_CEILINGS · AutonomyCeiling ·
 * Authority · deriveNeedsHuman) is THE shared seam in
 * `@papercusp/plan-parser` (B-01's risk-model.ts) — imported here, never
 * redeclared (D-008: one definition of the scale, not two). This module adds the
 * B-03 composition: a category's stored policy row, and its EFFECTIVE ceiling
 * (`min(owner cap, graduated level)`, with `locked` ⇒ `never-auto`) — the value
 * the Queen decider (B-12) feeds as the `ceiling` input to `deriveNeedsHuman`.
 *
 * The category taxonomy lives in {@link ./categories} (B-04); the DB access in
 * {@link ./policy-store}. Pure — no DB, no IO.
 */
import { type AutonomyCeiling, AUTONOMY_CEILINGS } from '@papercusp/plan-parser';
import { type AutonomyCategory, isProtectedCategory } from './categories';

/** Rank of a ceiling on the autonomy scale (never-auto=0 … critical=5). */
export function ceilingRank(c: AutonomyCeiling): number {
  return AUTONOMY_CEILINGS.indexOf(c);
}

/** Type guard for the ceiling vocabulary (never-auto + the 5 risk tiers). */
export function isAutonomyCeiling(s: string): s is AutonomyCeiling {
  return (AUTONOMY_CEILINGS as readonly string[]).includes(s);
}

/** The lower-autonomy (smaller-rank) of two ceilings — the gate's `min`. */
export function minCeiling(a: AutonomyCeiling, b: AutonomyCeiling): AutonomyCeiling {
  return ceilingRank(a) <= ceilingRank(b) ? a : b;
}

/**
 * One category's autonomy policy — the value shape of a
 * `harness_shared.autonomy_policy` row (B-03 / P-021), minus the storage
 * bookkeeping (workspace_id / updated_by / updated_at).
 */
export interface AutonomyCategoryPolicy {
  category: AutonomyCategory;
  /** Owner-set risk ceiling (the cap; D-003). `never-auto` = nothing auto-runs. */
  ceiling: AutonomyCeiling;
  /**
   * Never-auto regardless of ceiling/graduation (D-005). Protected categories
   * ship `true`; the gate treats `locked` as an effective ceiling of `never-auto`.
   */
  locked: boolean;
  /**
   * The graduation engine's earned level (B-16 / D-005). Moves only WITHIN the
   * owner ceiling — never raises autonomy above `ceiling` (the store clamps it).
   * Defaults to `never-auto`.
   */
  graduatedLevel: AutonomyCeiling;
  /** Per-class threshold overrides (forward slot for B-16). Default `{}`. */
  thresholdOverrides: Record<string, unknown>;
  /**
   * Owner's explicit override directive, or null. When `{ pinned: true }` the
   * graduation engine (B-16) must not move `graduatedLevel`. Stored verbatim by
   * B-03; honored by B-16. Null = governed by ceiling + graduation.
   */
  ownerOverride: Record<string, unknown> | null;
}

/**
 * The EFFECTIVE auto-decide ceiling for a category — D-004's
 * `min(category_ceiling, graduated_level)`, with `locked` as a hard floor:
 *   - `locked`  ⇒ `never-auto`
 *   - otherwise ⇒ `min(ceiling, graduatedLevel)`
 *
 * `graduatedLevel` can never exceed `ceiling` (the store clamps on write), so the
 * `min` is defensive. This is the value B-12 passes as `deriveNeedsHuman`'s
 * `ceiling` input; the reversibility/authority hard gates apply alongside it.
 */
export function effectiveCeiling(p: AutonomyCategoryPolicy): AutonomyCeiling {
  if (p.locked) return 'never-auto';
  return minCeiling(p.ceiling, p.graduatedLevel);
}

/** Is auto-decide ever possible for this category right now? (effective > never-auto) */
export function autoEverAllowed(p: AutonomyCategoryPolicy): boolean {
  return effectiveCeiling(p) !== 'never-auto';
}

/**
 * The behavior-neutral DEFAULT policy for a category (D-007): ceiling
 * `never-auto`, graduation `never-auto`, and `locked` iff the category is
 * protected (D-005). The store returns this for any category with no stored row
 * — so every workspace is never-auto by default without a per-workspace seed
 * (the fail-safe: a missing/unknown category never auto-decides).
 */
export function defaultPolicyFor(category: AutonomyCategory): AutonomyCategoryPolicy {
  return {
    category,
    ceiling: 'never-auto',
    locked: isProtectedCategory(category),
    graduatedLevel: 'never-auto',
    thresholdOverrides: {},
    ownerOverride: null,
  };
}
