/**
 * Baseline C — minimal smoke test runner (P-008 / WI-190).
 *
 * ONE-COMMAND ready-to-run smoke for the pilot lead (P-009): assembles STUBBED
 * deps (no real LLM / grader / git spend) and runs the end-to-end best-of-N
 * orchestration to validate wiring before the full owner-gated run.
 *
 * This file is the BINDING — shows exactly how to provide the {@link BestOfNPilotDeps}
 * to {@link runBestOfNPilotTask}. For the real run, the pilot lead replaces the stubs
 * with live implementations (real clone/grader/emit).
 *
 * Exit codes:
 *   0 = smoke passed, pipeline is sound
 *   1 = smoke failed or error
 */

import { runBestOfNPilotTask, DEFAULT_BEST_OF_N, BASELINE_C_ARM_ID, type BestOfNPilotDeps, makeApplyCheckVerifierOps } from './baseline-best-of-n-pilot';
import { type BestOfNConfig, type BestOfNRunOutput } from './baseline-best-of-n';
import type { BenchTask, GradeResult, OfficialGrader, TaskCheckout, GenerationPorts } from './types';
import type { EmitRolloutInput } from './reproducibility/schema';
import type { SingleAgentAttempt } from './single-agent-attempt';

/**
 * Minimal stubbed deps for smoke testing (all-fake, zero spend).
 */
function makeSmokeDeps(): BestOfNPilotDeps {
  let callCount = 0;

  const fakeCheckout: TaskCheckout = {
    dir: '/tmp/smoke-checkout',
    repo: 'test/repo',
    baseCommit: 'a'.repeat(40),
    cleanup: async () => {},
  };

  const generationPorts: GenerationPorts = {
    clone: async () => fakeCheckout,
    extractDiff: async () => 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n',
    instantiate: async () => ({
      worktreePath: '/tmp/smoke-work',
      telemetry: {
        tokensIn: 50,
        tokensOut: 50,
        costUsd: 0.01,
        turns: 1,
        wallClockMs: 100,
        trajectoryRef: `traj://smoke-${callCount++}`,
        stopReason: 'done' as const,
      },
    }),
  };

  const grader: OfficialGrader = {
    family: 'swe-bench-pro',
    modality: 'diff',
    async grade(submissions, tasks) {
      const result: GradeResult = {
        instanceId: tasks[0].instanceId,
        prefix: '0',
        resolved: true,
        rawGraderOutput: { test_pass_rate: 0.5 },
        graderFamily: 'swe-bench-pro',
        graderVersion: 'v1',
      };
      return [result];
    },
  };

  const emit = async (input: EmitRolloutInput) => ({
    rolloutId: `rollout-smoke-${Date.now()}`,
    runId: input.runId,
  });

  return {
    generationPorts,
    grader,
    emit,
    verifierOps: makeApplyCheckVerifierOps({
      cloneAtBase: async () => fakeCheckout,
      procExec: async () => ({ stdout: '', stderr: '', code: 0 }),
      writeFile: async () => {},
    }),
    now: (() => {
      let t = 1000;
      return () => (t += 10);
    })(),
  };
}

/**
 * A minimal test task.
 */
function makeSmokeTask(): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: 'smoke_test_instance',
    problemStatement: 'Fix a bug in the example repo.',
    repo: 'test/repo',
    baseCommit: 'a'.repeat(40),
    language: 'python',
    graderMeta: {
      FAIL_TO_PASS: ['test_example.py::test_fix'],
      PASS_TO_PASS: [],
      testFiles: ['test_example.py'],
    },
  };
}

/**
 * Run the smoke test.
 */
async function runSmoke() {
  console.log('[smoke] Baseline C best-of-N pipeline smoke test');
  console.log(`[smoke] runner: apply-check verifier (real wiring, zero spend)`);

  const config: BestOfNConfig = {
    runId: `smoke-run-${Date.now()}`,
    preregHash: 'smoke-prereg',
    suite: 'swe-bench-pro',
    modelId: 'claude-opus-4-8-smoke',
    harnessVersion: 'baseline-best-of-n-smoke@0.1.0',
    task: makeSmokeTask(),
    seed: 0,
    n: 2, // minimal: 2 samples
    budgetTokens: 1000,
  };

  console.log(`[smoke] config: seed=${config.seed}, n=${config.n}, budgetTokens=${config.budgetTokens}`);
  console.log('[smoke] starting run…');

  let out: BestOfNRunOutput;
  try {
    out = await runBestOfNPilotTask(config, makeSmokeDeps());
  } catch (e) {
    console.error('[smoke] FAILED with error:', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log('\n[smoke] ===== RESULTS =====');
  console.log(`[smoke] arm: ${out.emitted.arm}`);
  console.log(`[smoke] generation.status: ${out.emitted.generation.status}`);
  console.log(`[smoke] generation.tokensIn: ${out.emitted.generation.tokensIn}`);
  console.log(`[smoke] generation.tokensOut: ${out.emitted.generation.tokensOut}`);
  console.log(`[smoke] samples_run: ${out.armMeta.samples_run}/${out.armMeta.n}`);
  console.log(`[smoke] selected_candidate: ${out.armMeta.selected_candidate}`);
  console.log(`[smoke] grading.resolved: ${out.emitted.grading.resolved}`);
  console.log(`[smoke] rolloutId: ${out.rolloutId}`);

  // Basic smoke assertions.
  const ok =
    out.emitted.arm === BASELINE_C_ARM_ID &&
    out.emitted.generation.status === 'completed' &&
    out.armMeta.samples_run === 2 &&
    out.armMeta.selected_candidate >= 0 &&
    out.emitted.grading.resolved;

  if (ok) {
    console.log('\n[smoke] ✓ PASSED — pipeline wiring is sound, ready for pilot run');
    process.exit(0);
  } else {
    console.log('\n[smoke] ✗ FAILED — pipeline invariant violated');
    console.log('[smoke] full output:', JSON.stringify(out, null, 2));
    process.exit(1);
  }
}

runSmoke().catch((e) => {
  console.error('[smoke] uncaught error:', e);
  process.exit(1);
});
