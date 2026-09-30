/**
 * Baseline C — the LIVE binding (impartial-benchmark-suite-2026-06-15, BRIEF 6 / P-008).
 *
 * Assembles the {@link BestOfNPorts} the pure runner ({@link runBestOfNOnce}) drives, wiring the
 * four seams to the wave's real machinery:
 *   - `sample` → P-006 `runSingleAgentAttempt` (the shared `coding-solo` single-agent unit)
 *   - `verify` → THIS file's visible-tests-only test-verifier (the genuinely-new piece — mine)
 *   - `grade`  → P-005 `OfficialGrader.grade` (arm-agnostic; wrapped to one (submission,task))
 *   - `emit`   → P-010 `emitRollout` (injected — the ONE row+rollout entry point)
 *
 * Like hive-eval's `live-ports.ts`, the actual IO (git clone/apply, test exec, LLM repro-authoring)
 * lives behind an injected {@link VisibleTestVerifierOps} seam so the verifier's ORCHESTRATION is
 * unit-tested with fakes; the exec impl is the owner-gated leaf (real spend; reached only by the
 * pilot run P-009), exactly the boundary hive-eval drew at P-051.
 *
 * ── Fairness invariant #2, enforced STRUCTURALLY here ────────────────────────────────────────
 * The verifier scores a candidate from VISIBLE signal only and must NEVER see the hidden grader
 * inputs. We enforce that in the TYPE SYSTEM: the verifier ops receive a {@link VisibleTask} —
 * `BenchTask` with `graderMeta` REMOVED — so the visible-test runner literally cannot read
 * `FAIL_TO_PASS` / `PASS_TO_PASS` / `test_patch`. The regression gate runs the repo's OWN test
 * command (repo-native discovery, the same a developer would), and the reproduction test is
 * authored from `problemStatement` — both signal the arm could legitimately produce itself.
 */
import type {
  BenchTask,
  GenerationBudget,
  GenerationPorts,
  GradeResult,
  OfficialGrader,
  TaskCheckout,
} from './types';
import { runSingleAgentAttempt } from './single-agent-attempt';
import {
  defaultVerifierScore,
  type BestOfNPorts,
  type EmitRolloutInput,
  type EmitRolloutResult,
  type SingleAgentAttempt,
  type VerifierResult,
} from './baseline-best-of-n';

/** A benchmark task with the HIDDEN grader inputs removed — all the verifier may ever see (#2). */
export type VisibleTask = Omit<BenchTask, 'graderMeta'>;

/** Strip `graderMeta` so the visible-test verifier cannot leak the held-out grading criterion. */
export function toVisibleTask(task: BenchTask): VisibleTask {
  const { graderMeta: _omit, ...visible } = task;
  return visible;
}

/** The outcome of running the repo's pre-existing test suite (the regression gate). */
export interface RegressionResult {
  /** The repo's existing suite still passes (no regressions introduced by the candidate). */
  ok: boolean;
  passed: number;
  total: number;
  raw: string;
}

/** The outcome of authoring + running a reproduction test from the problem statement. */
export interface ReproResult {
  passed: boolean;
  raw: string;
  /** Model tokens the verifier spent authoring the repro (counted in the arm's summed budget). */
  tokensIn: number;
  tokensOut: number;
  turns: number;
}

/** The injected IO the visible-tests verifier needs. Real impl = the owner-gated pilot leaf. */
export interface VisibleTestVerifierOps {
  /** A CLEAN checkout @ base commit (separate from the generation worktree). Reuses P-005 clone. */
  cloneAtBase(task: VisibleTask): Promise<TaskCheckout>;
  /** Apply the candidate diff to the clean checkout (git apply + fallbacks). */
  applyDiff(checkout: TaskCheckout, diff: string): Promise<{ applied: boolean; raw: string }>;
  /** Run the repo's PRE-EXISTING test suite via repo-native discovery — NOT the grader's tests. */
  runRegressionSuite(checkout: TaskCheckout, task: VisibleTask): Promise<RegressionResult>;
  /** Author (from `problemStatement`) + run a reproduction test — the decisive visible signal. */
  runReproTest(checkout: TaskCheckout, task: VisibleTask): Promise<ReproResult>;
}

/**
 * Build the verifier port from injected ops. Pure orchestration: clone clean → apply the candidate
 * → (if it applied) run the repo's existing suite (regression gate) + the authored repro test →
 * score with {@link defaultVerifierScore}. A non-applying candidate scores 0 (it cannot be
 * evaluated, but is still eligible for the runner's best-effort fallback submission). The ops only
 * ever receive a {@link VisibleTask}, so invariant #2 holds by construction.
 */
export function makeVisibleTestVerifier(ops: VisibleTestVerifierOps): BestOfNPorts['verify'] {
  return async ({ task, attempt }): Promise<VerifierResult> => {
    const visible = toVisibleTask(task);
    let checkout: TaskCheckout | undefined;
    try {
      checkout = await ops.cloneAtBase(visible);
      const applied = await ops.applyDiff(checkout, attempt.diff);
      if (!applied.applied) {
        return {
          applied: false,
          reproPassed: false,
          regressionsPassed: false,
          visiblePassed: 0,
          visibleTotal: 0,
          score: 0,
          rawOutput: applied.raw,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          turns: 0,
        };
      }
      const [regression, repro] = [await ops.runRegressionSuite(checkout, visible), await ops.runReproTest(checkout, visible)];
      const visiblePassed = (repro.passed ? 1 : 0) + regression.passed;
      const visibleTotal = 1 + regression.total; // the repro test + the regression suite
      const score = defaultVerifierScore({
        applied: true,
        reproPassed: repro.passed,
        regressionsPassed: regression.ok,
        visiblePassed,
        visibleTotal,
      });
      return {
        applied: true,
        reproPassed: repro.passed,
        regressionsPassed: regression.ok,
        visiblePassed,
        visibleTotal,
        score,
        rawOutput: `repro:${repro.raw}\nregression:${regression.raw}`,
        tokensIn: repro.tokensIn,
        tokensOut: repro.tokensOut,
        costUsd: 0, // derived at emit via priceRun
        turns: repro.turns,
      };
    } catch (e) {
      // A verifier infra failure must not crash the run — return an un-scoreable result so the
      // candidate falls to the runner's best-effort fallback (the diff may still grade-resolve).
      return {
        applied: false,
        reproPassed: false,
        regressionsPassed: false,
        visiblePassed: 0,
        visibleTotal: 0,
        score: 0,
        rawOutput: '',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        turns: 0,
        generationError: e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (checkout) await checkout.cleanup().catch(() => {});
    }
  };
}

/** The dependencies the live `BestOfNPorts` assembly needs. */
export interface LiveBestOfNDeps {
  /** P-005 clone/diff/instantiate seam — `runSingleAgentAttempt` consumes it per sample. */
  generationPorts: GenerationPorts;
  /** The arm-agnostic official grader (P-005). The same instance grades every arm for a (task,seed). */
  grader: OfficialGrader;
  /** The verifier's injected IO (the owner-gated exec leaf). */
  verifierOps: VisibleTestVerifierOps;
  /** P-010's `emitRollout` — writes the run_result row + rollout card, derives cost_usd. */
  emit(input: EmitRolloutInput): Promise<EmitRolloutResult>;
  /** Wall-clock source (Date.now in production; a virtual clock in tests). */
  now(): number;
}

/**
 * Assemble the live {@link BestOfNPorts}. `sample` runs the shared single-agent unit (re-stamped to
 * `baseline-c-bestofn` at emit by the runner, recording each sample in arm_meta); `grade` wraps the
 * batch grader to one submission; `verify` is the visible-tests verifier; `emit` is P-010's entry.
 */
export function makeLiveBestOfNPorts(deps: LiveBestOfNDeps): BestOfNPorts {
  return {
    now: () => deps.now(),
    async sample({ task, seed, budgetTokens }): Promise<SingleAgentAttempt> {
      const budget: GenerationBudget = { maxTokens: budgetTokens };
      return runSingleAgentAttempt(task, seed, budget, deps.generationPorts);
    },
    verify: makeVisibleTestVerifier(deps.verifierOps),
    async grade({ task, patch, prefix }): Promise<GradeResult> {
      const submission = { modality: 'diff' as const, instanceId: task.instanceId, patch, prefix };
      const [result] = await deps.grader.grade([submission], [task]);
      return result;
    },
    emit: deps.emit,
  };
}
