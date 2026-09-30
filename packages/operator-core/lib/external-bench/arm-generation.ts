/**
 * `runArmGeneration` (P-005 / BRIEF 3) — the SHARED generation primitive: clone the task repo @ base commit
 * → spin a throwaway harness of `blueprintId` to DONE under the iso-budget cap → extract the final diff →
 * account cost/turns → return an {@link ArmAttempt}. ALL arms are this function with a different blueprint:
 *
 *   Papercusp (full spine)  = runArmGeneration('external-bench', …)   ← this brief
 *   Baseline A (ablation)    = runArmGeneration('coding-solo', …)      ← P-006 (one call)
 *   Baseline C (best-of-N)   = N × runArmGeneration('coding-solo', …) + verifier  ← P-008
 *
 * Holding clone / infra / budget / diff-extraction byte-identical and varying ONLY `blueprintId` is what
 * makes the A-vs-Papercusp delta provably the spine (D-002 causal isolation). Ports are injected (the
 * hive-eval live-ports pattern) so this is unit-testable with fakes before live harness-spin lands.
 */
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationPorts, GenerationStopReason, TaskCheckout } from './types';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RunArmGenerationInput {
  /** Arm id for the row (run-result vocab): 'papercusp' | 'baseline-a-ablation' | … */
  arm: string;
  /** The blueprint to spin — 'external-bench' (full spine) | 'coding-solo' (single worker) | … */
  blueprintId: string;
  task: BenchTask;
  /** This attempt's seed / predictions `prefix` (one prefix per seed). */
  seed: string;
  budget: GenerationBudget;
}

export async function runArmGeneration(input: RunArmGenerationInput, ports: GenerationPorts): Promise<ArmAttempt> {
  const { arm, blueprintId, task, seed, budget } = input;
  const base = (): Omit<ArmAttempt, 'diff' | 'tokensIn' | 'tokensOut' | 'costUsd' | 'turns' | 'wallClockMs' | 'trajectoryRef' | 'stopReason' | 'generationError'> => ({
    arm,
    blueprintId,
    instanceId: task.instanceId,
    seed,
  });

  let checkout: TaskCheckout;
  try {
    checkout = await ports.clone(task);
  } catch (e) {
    // Clone failed = an infra failure BEFORE any generation could happen.
    return {
      ...base(),
      diff: '',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      turns: 0,
      wallClockMs: 0,
      trajectoryRef: '',
      stopReason: 'error',
      generationError: `clone failed: ${errMsg(e)}`,
    };
  }

  try {
    const run = await ports.instantiate(blueprintId, task, checkout, budget);
    const t = run.telemetry;

    let diff = '';
    let stopReason: GenerationStopReason = t.stopReason;
    let generationError = t.generationError;

    // Extract the diff for any genuine termination (the harness produced something to grade). A failed run
    // has nothing to grade; a diff-extraction failure is itself an infra error.
    if (stopReason !== 'error') {
      try {
        diff = await ports.extractDiff(checkout, task);
      } catch (e) {
        stopReason = 'error';
        generationError = `extractDiff failed: ${errMsg(e)}`;
        diff = '';
      }
    }

    return {
      ...base(),
      diff,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      costUsd: t.costUsd,
      turns: t.turns,
      wallClockMs: t.wallClockMs,
      trajectoryRef: t.trajectoryRef,
      stopReason,
      generationError,
    };
  } catch (e) {
    // Harness instantiation / run threw — infra failure during generation.
    return {
      ...base(),
      diff: '',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      turns: 0,
      wallClockMs: 0,
      trajectoryRef: '',
      stopReason: 'error',
      generationError: `instantiate failed: ${errMsg(e)}`,
    };
  } finally {
    await checkout.cleanup();
  }
}

/** The FULL Papercusp arm — the multi-agent spine ON. Arm id 'papercusp', blueprint 'external-bench'. */
export function runPapercuspArm(
  task: BenchTask,
  seed: string,
  budget: GenerationBudget,
  ports: GenerationPorts,
): Promise<ArmAttempt> {
  return runArmGeneration({ arm: 'papercusp', blueprintId: 'external-bench', task, seed, budget }, ports);
}
