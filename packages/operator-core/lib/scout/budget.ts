/**
 * budget.ts — Scout P-008: the per-cycle budget bound (hive-creative-ideation
 * D-010, "per-cycle budget bound"; the plan's "deliberately cheap — directed
 * search, not brute-force evolution").
 *
 * A Scout cycle fans out N ideators (one LLM call per lens slot) + critics per
 * idea + a recombine pass — so its cost is bounded by capping the fan-out and by
 * a hard USD ceiling the cycle checks between steps. Pure ⇒ the cycle (cb4b9's
 * runScoutCycle) and the scheduler both consult these without IO, and P-014 can
 * assert "an over-budget cycle stops fanning out" deterministically.
 *
 * Distinct from the gym autoloop's LOOP-level budget (gym_autoloop_config
 * budget_usd/spent_usd, migration 110): that bounds a long optimization run; this
 * bounds ONE Scout ideation cycle.
 */

export interface ScoutBudget {
  /** Hard cap on one cycle's LLM spend (USD). 0 = no spend (EI-305). Default 1.0. */
  maxCostUsd?: number;
  /** Cap on ideators per cycle (one call per lens slot). Default 6. */
  maxIdeators?: number;
  /** Cap on critics run per idea. Default 2 (the novelty + feasibility critics, D-005). */
  maxCriticsPerIdea?: number;
}

export const DEFAULT_SCOUT_BUDGET: Required<ScoutBudget> = {
  maxCostUsd: 1.0,
  maxIdeators: 6,
  maxCriticsPerIdea: 2,
};

export interface ScoutBudgetVerdict {
  /** May the cycle keep spending (spent strictly below the cap)? */
  proceed: boolean;
  reason?: 'cost-exhausted';
  spentUsd: number;
  /** USD left before the cap (0 when exhausted). */
  remainingUsd: number;
  /** spentUsd / maxCostUsd, clamped to [0,1]. */
  fractionUsed: number;
}

/** Merge a partial budget with the defaults, clamping every field non-negative. */
export function resolveScoutBudget(b?: ScoutBudget): Required<ScoutBudget> {
  return {
    // 0 is a VALID cap — "no LLM spend this cycle" (EI-305). Negative/NaN fall back.
    maxCostUsd: nonneg(b?.maxCostUsd, DEFAULT_SCOUT_BUDGET.maxCostUsd),
    maxIdeators: Math.floor(pos(b?.maxIdeators, DEFAULT_SCOUT_BUDGET.maxIdeators)),
    maxCriticsPerIdea: Math.floor(pos(b?.maxCriticsPerIdea, DEFAULT_SCOUT_BUDGET.maxCriticsPerIdea)),
  };
}

/**
 * The gate the cycle consults BEFORE each costed step: proceed only while spend
 * is strictly under the cap. Once exhausted, the cycle should stop fanning out
 * and finish with what it has (graceful, not an error).
 */
export function checkScoutBudget(spentUsd: number, b?: ScoutBudget): ScoutBudgetVerdict {
  const budget = resolveScoutBudget(b);
  const spent = Math.max(0, spentUsd);
  const remaining = Math.max(0, budget.maxCostUsd - spent);
  const proceed = spent < budget.maxCostUsd;
  return {
    proceed,
    ...(proceed ? {} : { reason: 'cost-exhausted' as const }),
    spentUsd: spent,
    remainingUsd: remaining,
    fractionUsed: budget.maxCostUsd > 0 ? Math.min(1, spent / budget.maxCostUsd) : 1,
  };
}

/** Clamp a requested ideator count to the per-cycle cap (and to ≥0). */
export function boundIdeatorCount(requested: number, b?: ScoutBudget): number {
  const budget = resolveScoutBudget(b);
  return Math.max(0, Math.min(Math.floor(requested), budget.maxIdeators));
}

/** Clamp a requested critics-per-idea count to the cap. */
export function boundCriticsPerIdea(requested: number, b?: ScoutBudget): number {
  const budget = resolveScoutBudget(b);
  return Math.max(0, Math.min(Math.floor(requested), budget.maxCriticsPerIdea));
}

/**
 * Estimate one cycle's cost: one call per ideator + criticsPerIdea calls per
 * idea + one recombine pass, at an average per-call USD. Used to pre-flight a
 * cycle's fan-out against the cap (and to size the fan-out down to fit).
 */
export function projectedCycleCostUsd(
  ideators: number,
  criticsPerIdea: number,
  perCallCostUsd: number,
): number {
  const calls = ideators + ideators * criticsPerIdea + 1; // +1 recombine pass
  return Math.max(0, calls) * Math.max(0, perCallCostUsd);
}

/** Does a planned fan-out fit the per-cycle cap at the given per-call cost? */
export function fitsCycleBudget(
  ideators: number,
  criticsPerIdea: number,
  perCallCostUsd: number,
  b?: ScoutBudget,
): boolean {
  const budget = resolveScoutBudget(b);
  return projectedCycleCostUsd(ideators, criticsPerIdea, perCallCostUsd) <= budget.maxCostUsd;
}

function pos(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
}

function nonneg(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;
}
