/**
 * Per-arm token/$ accounting + iso-budget verification. The plan's load-bearing
 * cost controls:
 *  - "coordination overhead counted in OUR own number" — every row's
 *    `tokensTotal` is already SUMMED across all roles/turns, so summing rows
 *    counts coordination overhead by construction. We never subtract it.
 *  - "iso-budget — cap every arm at the same total tokens" — `verifyIsoBudget`
 *    asserts every arm ran under the same GENERATION cap and flags any row that
 *    exceeded its cap (a runner that didn't stop at the budget is a bug).
 *  - "$ per resolved" — `costPerResolved` is the headline "more resolved per
 *    dollar" denominator.
 */

import type { TaskRunResult, CostAccount, ArmId } from './schema';
import { priceRun, type PriceTable, DEFAULT_PRICE_TABLE } from './pricing';

/**
 * The shared GENERATION iso-budget cap. Every arm must cap with the SAME logic
 * so "iso-budget" is real, not per-runner-interpreted — so the four arm runners
 * (Papercusp + Baselines A/B/C) import `budgetExceeded` and stop generation the
 * moment it returns true. Cap on tokens, $, or both (first to trip wins). A null
 * cap = uncapped (the native baseline elicited to its best).
 */
export interface IsoBudgetCap {
  /** Stop when cumulative generation tokens reach this. */
  tokens?: number | null;
  /** Stop when cumulative generation cost reaches this. */
  usd?: number | null;
  /** Stop when wall-clock reaches this (ms). The native arm (P-007) runs at its
   *  own native sampling and can't take a per-call token cap, so it caps on
   *  wall-clock; the fleet backlog runs (P-022/P-023) can cap on time too. */
  wallClockMs?: number | null;
}

/**
 * True when a run at `spent` has reached/exceeded the cap and generation should
 * stop (first dimension to trip wins). `spent.tokensTotal` is the SUMMED
 * generation tokens so far (all roles / all candidates), matching how the
 * run-result row counts them.
 */
export function budgetExceeded(
  spent: { tokensTotal: number; costUsd?: number; wallClockMs?: number },
  cap: IsoBudgetCap,
): boolean {
  if (cap.tokens != null && spent.tokensTotal >= cap.tokens) return true;
  if (cap.usd != null && spent.costUsd != null && spent.costUsd >= cap.usd) return true;
  if (cap.wallClockMs != null && spent.wallClockMs != null && spent.wallClockMs >= cap.wallClockMs) return true;
  return false;
}

/** A row counts toward accuracy only if neither generation nor grading hit an infra error. */
export function isScored(row: TaskRunResult): boolean {
  const genInfra = row.generationStatus === 'error' || row.generationStatus === 'timeout';
  const gradeInfra = row.graderStatus === 'error' || row.graderStatus === 'timeout';
  return !genInfra && !gradeInfra;
}

/**
 * Sum token/$ over a set of rows. `costUsd` is recomputed from raw tokens via
 * the price table (NOT read off the row) so the whole report uses ONE table
 * consistently — if a row was written under an older table version, the report
 * still re-prices it uniformly. ALL rows are counted (including infra-error
 * rows) for the cost/compute number: a crashed run still spent tokens, and an
 * honest cost number includes them.
 */
export function accountTokens(
  rows: readonly TaskRunResult[],
  opts: { priceTable?: PriceTable; resolvedCount?: number } = {},
): CostAccount {
  const table = opts.priceTable ?? DEFAULT_PRICE_TABLE;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensTotal = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costUsd = 0;
  for (const r of rows) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    tokensTotal += r.tokensTotal;
    tokensCacheRead += r.tokensCacheRead ?? 0;
    tokensCacheWrite += r.tokensCacheWrite ?? 0;
    costUsd += priceRun(
      {
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        tokensCacheRead: r.tokensCacheRead,
        tokensCacheWrite: r.tokensCacheWrite,
      },
      r.modelId,
      table,
    );
  }
  const n = rows.length;
  const resolved = opts.resolvedCount ?? rows.filter((r) => isScored(r) && r.resolved === true).length;
  return {
    tokensIn,
    tokensOut,
    tokensTotal,
    tokensCacheRead,
    tokensCacheWrite,
    costUsd,
    tokensPerRun: n === 0 ? 0 : tokensTotal / n,
    costPerResolved: resolved === 0 ? null : costUsd / resolved,
  };
}

export interface IsoBudgetCheck {
  ok: boolean;
  /** The single budget all arms share, or null if uncapped/mixed. */
  budgetTokens: number | null;
  /** Human-readable violations: per-arm cap disagreement, or rows over their cap. */
  violations: string[];
}

/**
 * Verify the iso-budget invariant for a suite: every arm ran under the SAME
 * generation cap, and no row's `tokensTotal` exceeded the cap it ran under
 * unless its `capped` flag is set (a row over budget with capped=false means
 * the runner failed to enforce the cap — a real bug, surfaced loudly).
 *
 * Rows with `budgetTokens == null` are treated as uncapped (e.g. the native
 * baseline elicited to its best); a suite that MIXES capped and uncapped arms
 * is reported as not-ok with the specifics, because the cost/accuracy claim
 * then needs the Pareto framing, not the iso-budget framing.
 */
export function verifyIsoBudget(rows: readonly TaskRunResult[]): IsoBudgetCheck {
  const violations: string[] = [];
  const perArmBudgets = new Map<ArmId, Set<number | null>>();
  for (const r of rows) {
    const b = r.budgetTokens ?? null;
    if (!perArmBudgets.has(r.arm)) perArmBudgets.set(r.arm, new Set());
    perArmBudgets.get(r.arm)!.add(b);
    if (b !== null && r.tokensTotal > b && !r.capped) {
      violations.push(
        `${r.arm}/${r.taskId}#${r.seed}: tokensTotal ${r.tokensTotal} > budget ${b} but capped=false (cap not enforced)`,
      );
    }
  }
  // Each arm must use exactly one budget value.
  const armBudgets: (number | null)[] = [];
  for (const [arm, budgets] of perArmBudgets) {
    if (budgets.size > 1) {
      violations.push(`${arm}: ran under multiple budgets ${[...budgets].join(', ')} (must be one)`);
    }
    armBudgets.push([...budgets][0]);
  }
  // All capped arms must share one budget; uncapped arms are allowed to coexist
  // but are flagged because they break the strict iso-budget reading.
  const cappedBudgets = new Set(armBudgets.filter((b): b is number => b !== null));
  const hasUncapped = armBudgets.some((b) => b === null);
  let shared: number | null = null;
  if (cappedBudgets.size > 1) {
    violations.push(`arms ran under different budgets ${[...cappedBudgets].join(', ')} — not iso-budget`);
  } else if (cappedBudgets.size === 1) {
    shared = [...cappedBudgets][0];
    if (hasUncapped) {
      violations.push(`some arms are uncapped while others are capped at ${shared} — use the Pareto framing, not iso-budget`);
    }
  }
  return { ok: violations.length === 0, budgetTokens: shared, violations };
}
