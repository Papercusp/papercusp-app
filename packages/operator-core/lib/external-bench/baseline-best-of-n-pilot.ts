/**
 * Baseline C — the PILOT driver (impartial-benchmark-suite-2026-06-15, BRIEF 6 / P-008).
 *
 * Makes the best-of-N arm ONE-COMMAND-READY for the pilot's bounded smoke (P-009): assemble the live
 * {@link BestOfNPorts} from the wave's shared live bindings and run one (task, seed) end-to-end.
 * The heavy pieces (real LLM sampling, the official Docker grader) are INJECTED — the pilot lead
 * (P-005/ec8fe) provides them; this file owns the arm wiring + the verifier.
 *
 * ── Two verifier tiers (fairness vs. smoke) ─────────────────────────────────────────────────
 *  - FAIR (the real run): the visible-tests verifier — clone + apply + run the repo's pre-existing
 *    tests (regression) in the per-instance image + an authored repro test. Owner-gated (Docker
 *    disk + spend), the same boundary the grader draws; wired at the full run, NOT in a wiring smoke.
 *  - SMOKE (this file's {@link makeApplyCheckVerifierOps}): clone + `git apply --check` only — REAL
 *    but cheap (no Docker, no LLM, no model tokens). Selects the cheapest cleanly-applying candidate.
 *    Sufficient to validate the end-to-end pipeline; it is NOT the fair test-verifier and is labeled
 *    `apply-check` in arm_meta so a scored run can never silently use it.
 *
 * Bounded-smoke discipline: this module never kicks a run itself — it builds the driver. The pilot
 * lead invokes {@link runBestOfNPilotTask} for a few tasks at 1 seed; the full multi-seed run is
 * owner-gated.
 */
import { cloneTaskRepo as liveCloneTaskRepo } from './clone';
import { liveGraderFs, liveProcExec, type ProcExec } from './grader';
import type { BenchTask, GenerationPorts, OfficialGrader, TaskCheckout } from './types';
import type { EmitRolloutInput } from './reproducibility/schema';
import {
  runBestOfNOnce,
  type BestOfNConfig,
  type BestOfNRunOutput,
} from './baseline-best-of-n';
import {
  makeLiveBestOfNPorts,
  type VisibleTask,
  type VisibleTestVerifierOps,
  type RegressionResult,
  type ReproResult,
} from './baseline-best-of-n-live';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The smoke verifier — apply-check only (real, cheap; NOT the fair test-verifier).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ApplyCheckVerifierDeps {
  /** Clone a task repo @ base (default: P-005 live `cloneTaskRepo`). Receives a VisibleTask. */
  cloneAtBase?: (task: VisibleTask) => Promise<TaskCheckout>;
  /** Shell-free process exec for `git apply --check` (default: the grader's `liveProcExec`). */
  procExec?: ProcExec;
  /** Write the candidate patch to a scratch file (default: the grader's live fs). */
  writeFile?: (path: string, data: string) => Promise<void>;
}

/** A regression/repro result for the apply-check tier — no tests run (owner-gated leaf). */
const NO_TESTS_REGRESSION: RegressionResult = {
  ok: true,
  passed: 0,
  total: 0,
  raw: 'apply-check tier: repo visible-test suite not run (owner-gated Docker leaf)',
};
const NO_REPRO: ReproResult = {
  passed: false,
  raw: 'apply-check tier: repro test not authored (owner-gated leaf)',
  tokensIn: 0,
  tokensOut: 0,
  turns: 0,
};

/**
 * The SMOKE verifier ops: clone @ base + `git apply --check` the candidate. `applied` = the patch
 * applies cleanly; the regression/repro signals are no-ops (the fair test-verifier is owner-gated).
 * Composed on the shared clone + procExec + fs seams; injectable for the wiring smoke test.
 */
export function makeApplyCheckVerifierOps(deps: ApplyCheckVerifierDeps = {}): VisibleTestVerifierOps {
  const cloneAtBase =
    deps.cloneAtBase ?? ((task: VisibleTask) => liveCloneTaskRepo({ ...task, graderMeta: {} } as BenchTask));
  const procExec = deps.procExec ?? liveProcExec;
  const writeFile = deps.writeFile ?? liveGraderFs.writeFile;

  return {
    cloneAtBase,
    async applyDiff(checkout, diff) {
      if (diff.trim() === '') return { applied: false, raw: 'empty diff' };
      const patchPath = `${checkout.dir}/.bestofn-candidate.patch`;
      await writeFile(patchPath, diff);
      // `--check` validates the patch WITHOUT mutating the worktree (the grader applies the real one).
      const r = await procExec('git', ['-C', checkout.dir, 'apply', '--check', patchPath]);
      return { applied: r.code === 0, raw: r.code === 0 ? 'applies cleanly' : r.stderr || r.stdout };
    },
    async runRegressionSuite() {
      return NO_TESTS_REGRESSION;
    },
    async runReproTest() {
      return NO_REPRO;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The one-command pilot entry.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BestOfNPilotDeps {
  /** Live clone/diff/instantiate seam for the single-agent samples (P-005 clone + P-019 instantiate). */
  generationPorts: GenerationPorts;
  /** The official arm-agnostic grader for the task's family (P-005 `getOfficialGrader`). */
  grader: OfficialGrader;
  /** The emission entry point (P-010 `emitRollout`) — derives cost_usd, writes run_result + rollout. */
  emit(input: EmitRolloutInput): Promise<{ rolloutId: string; runId: string }>;
  /** The verifier ops. Default = the apply-check SMOKE tier; the real run injects the Docker tier. */
  verifierOps?: VisibleTestVerifierOps;
  /** Wall-clock source (default Date.now). */
  now?: () => number;
}

/**
 * Run ONE best-of-N attempt for the pilot. Assembles the live {@link BestOfNPorts} from the injected
 * shared bindings (sampling, grading, emission) + the verifier, and runs {@link runBestOfNOnce}.
 * The pilot lead calls this per (task, seed); a bounded smoke uses a few tasks at 1 seed.
 *
 * `config.verifierKind` defaults to mark the tier in arm_meta — pass 'apply-check' for the smoke,
 * 'repro+regression' for the fair Docker tier.
 */
export function runBestOfNPilotTask(config: BestOfNConfig, deps: BestOfNPilotDeps): Promise<BestOfNRunOutput> {
  const verifierOps = deps.verifierOps ?? makeApplyCheckVerifierOps();
  const ports = makeLiveBestOfNPorts({
    generationPorts: deps.generationPorts,
    grader: deps.grader,
    verifierOps,
    emit: deps.emit,
    now: deps.now ?? (() => Date.now()),
  });
  return runBestOfNOnce({ ...config, verifierKind: config.verifierKind ?? 'apply-check' }, ports);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Exports for external consumption (P-009 pilot driver integration).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export {
  type BestOfNConfig,
  type BestOfNRunOutput,
  DEFAULT_BEST_OF_N,
  BASELINE_C_ARM_ID,
  type VerifierResult,
  defaultVerifierScore,
  type BestOfNArmMeta,
  runBestOfNOnce,
} from './baseline-best-of-n';

export {
  type VisibleTask,
  toVisibleTask,
  makeVisibleTestVerifier,
  makeLiveBestOfNPorts,
  type LiveBestOfNDeps,
  type VisibleTestVerifierOps,
} from './baseline-best-of-n-live';
