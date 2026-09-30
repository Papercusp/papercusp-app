/**
 * Exit-code decision for an `llm-test` run.
 *
 * Split out of `apps/operator/bin/llm-test.ts` so it is importable — and
 * therefore testable — without executing that file's top-level `main()`.
 *
 * The invariant encoded here (EI-22032714687384561): **exit 0 means "the
 * scenarios you asked for ran and passed", never "nothing happened."** A run
 * whose scenarios were all skipped measured nothing, and an instrument that
 * measured nothing must not be indistinguishable from a passing one. Claim
 * contention is the common case under fleet load, not a rare one: two agents
 * reach for the same scenario exactly when that scenario becomes relevant.
 */

/** What one scenario did, as far as the exit code is concerned. */
export type ScenarioOutcome = 'failed' | 'executed' | 'skipped';

export const LLM_TEST_EXIT_OK = 0;
export const LLM_TEST_EXIT_FAILED = 1;
/** Distinct from 1 so a caller can tell an un-run suite from a failing one. */
export const LLM_TEST_EXIT_NOTHING_RAN = 3;

export interface RunTally {
  requested: number;
  executed: number;
  skipped: number;
  failed: number;
}

export function tallyOutcomes(outcomes: readonly ScenarioOutcome[]): RunTally {
  return {
    requested: outcomes.length,
    executed: outcomes.filter((o) => o === 'executed').length,
    skipped: outcomes.filter((o) => o === 'skipped').length,
    failed: outcomes.filter((o) => o === 'failed').length,
  };
}

/**
 * Resolve the process exit code from what the scenarios actually did.
 *
 * A partial skip (something ran, something was skipped) still exits 0 — the
 * caller got a real measurement — but `runSummaryLine` makes the skip visible
 * in the output.
 */
export function llmTestExitCode(outcomes: readonly ScenarioOutcome[]): number {
  const { requested, executed, failed } = tallyOutcomes(outcomes);
  if (failed > 0) return LLM_TEST_EXIT_FAILED;
  if (requested > 0 && executed === 0) return LLM_TEST_EXIT_NOTHING_RAN;
  return LLM_TEST_EXIT_OK;
}

/** One-line tally for the terminal, so the OUTPUT is unambiguous too. */
export function runSummaryLine(outcomes: readonly ScenarioOutcome[]): string {
  const { requested, executed, skipped, failed } = tallyOutcomes(outcomes);
  return `${executed} executed, ${skipped} skipped, ${failed} failed, ${requested} requested`;
}
