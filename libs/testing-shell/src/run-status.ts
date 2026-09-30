/**
 * parseRunnerStatus — the per-runner result→ChipStatus contract.
 *
 * P-013 of testing-shell-cross-project-2026-06-01. A consumer's backend
 * (the operator harness route, Restart's dataSource, …) runs a test via
 * one of the {@link TestRunner} kinds, then calls this to turn the raw
 * process result into the {@link ChipStatus} the panel renders. Keeping it
 * here — pure, framework-tagged, side-effect-free — is what lets every
 * backend report status the same way instead of each re-deriving vitest's
 * exit-code semantics (which is all the harness run route knows today).
 *
 * The signal is the exit code, refined per framework: 0 → pass (unless the
 * framework printed a "ran nothing" marker → skip), a signal-kill code →
 * cancelled, null → still running, anything else → fail.
 */
import { type ChipStatus } from './data-source';

/** The runner families a result can come from (mirrors TestRunner kinds + node:test). */
export type RunnerFramework = 'vitest' | 'playwright' | 'cargo' | 'k6' | 'node';

export interface RunnerResult {
  /** Process exit code; null while the run is still in flight. */
  exitCode: number | null;
  /** Captured stdout/stderr tail, used for framework-specific refinement. */
  output?: string;
  /** Set by the runner when the run was deliberately aborted/killed. */
  cancelled?: boolean;
}

/** 128 + {SIGINT=2, SIGTERM=15, SIGKILL=9} — a killed process, not a real failure. */
const SIGNAL_EXIT_CODES = new Set([130, 143, 137]);

/** Markers a framework prints when it exited 0 having matched no tests. */
const NO_TESTS_MARKERS: Partial<Record<RunnerFramework, RegExp>> = {
  vitest: /no test files found/i,
  node: /tests 0\b/i,
};

export function parseRunnerStatus(framework: RunnerFramework, result: RunnerResult): ChipStatus {
  const { exitCode, cancelled, output } = result;

  if (cancelled) return 'cancelled';
  if (exitCode === null) return 'running';
  if (SIGNAL_EXIT_CODES.has(exitCode)) return 'cancelled';

  if (exitCode === 0) {
    const noTests = NO_TESTS_MARKERS[framework];
    if (noTests && output && noTests.test(output)) return 'skip';
    return 'pass';
  }

  return 'fail';
}
