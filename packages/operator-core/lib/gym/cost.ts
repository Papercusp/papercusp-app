/**
 * Cost instrumentation (P-027, D-017) — deterministic $ accounting, never fed to the
 * judge (cost is compared by us). Produces $/run, $/cycle, and a $/converged-run
 * estimate (a required P-014 deliverable before the loop runs). Pure aggregation; the
 * per-run token→cost numbers come from agent_runs_consolidated (the PG-read adapter).
 */

export interface RunCost {
  /** Cost of the harness pipeline run (sum of its agent spawns). */
  pipelineUsd: number;
  /** Cost of the frozen judge call for that run. */
  judgeUsd: number;
}

export function runTotalUsd(c: RunCost): number {
  return c.pipelineUsd + c.judgeUsd;
}

/** Total cost of one optimization cycle: all run costs + the proposer call. */
export function cycleCostUsd(runs: readonly RunCost[], proposerUsd = 0): number {
  return runs.reduce((sum, r) => sum + runTotalUsd(r), 0) + proposerUsd;
}

export function meanRunCostUsd(runs: readonly RunCost[]): number {
  if (runs.length === 0) return 0;
  return runs.reduce((sum, r) => sum + runTotalUsd(r), 0) / runs.length;
}

export interface ConvergenceEstimate {
  costPerCycle: number;
  expectedCyclesPerAccept: number;
  costPerConvergedRun: number;
}

/** $/converged-run ≈ $/cycle × expected cycles per accept (geometric, 1/acceptRate). */
export function estimateConvergence(costPerCycle: number, acceptRate: number): ConvergenceEstimate {
  const expectedCyclesPerAccept = acceptRate > 0 ? 1 / acceptRate : Infinity;
  return {
    costPerCycle,
    expectedCyclesPerAccept,
    costPerConvergedRun: costPerCycle * expectedCyclesPerAccept,
  };
}
