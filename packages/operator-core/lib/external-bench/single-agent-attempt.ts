/**
 * Port 2 (P-006 / BRIEF 4, su-136a4): `runSingleAgentAttempt` — the named single-agent
 * generation entry point for the impartial benchmark suite (`impartial-benchmark-suite-2026-06-15`).
 *
 * ONE single-worker, NO-MULTI-AGENT-SPINE attempt at a benchmark task — the clean causal
 * isolation of Baseline A (internal ablation). It is a THIN WRAPPER over BRIEF 3's shared
 * {@link runArmGeneration} primitive, pinned to the `coding-solo` blueprint (a single
 * end-to-end worker, run-to-DONE — spine OFF) and the locked `baseline-a-ablation` arm id:
 *
 *   the full Papercusp arm = runArmGeneration({ blueprintId: 'external-bench' })  ← runPapercuspArm
 *   Baseline A (ablation)   = runArmGeneration({ blueprintId: 'coding-solo'   })  ← THIS (one call)
 *   Baseline C (best-of-N)  = N × this + a verifier + select                       ← P-008 (su-6c5c4)
 *
 * Delegating (rather than re-implementing clone/instantiate/extract/error-handling) is
 * deliberate: A and the Papercusp arm run through the EXACT SAME function, differing only in
 * the `blueprintId` argument — so the A-vs-Papercusp accuracy/cost delta is provably the
 * spine and nothing else (D-002 causal isolation; D-004 fairness). One orchestration, no drift.
 *
 *   - Baseline A → exactly ONE call (arm 'baseline-a-ablation').
 *   - Baseline C → N calls; the caller re-stamps the SELECTED candidate as 'baseline-c-bestofn'
 *     at emit and records the per-sample candidates in arm_meta.
 *
 * Ports (clone / instantiate / extractDiff) are injected (hive-eval live-ports pattern); see
 * {@link runArmGeneration} for the cost-accounting + infra-error semantics (an infra failure
 * is captured as `generationError` + `stopReason:'error'`, never scored as a task failure —
 * METR: retry infra failures, don't score them).
 */
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationPorts } from './types';
import { runArmGeneration } from './arm-generation';

/** Baseline A's arm id on the run-result row — the LOCKED vocab (P-011/P-010 schema, su-66ad9). */
export const BASELINE_A_ARM = 'baseline-a-ablation';

/** The single-worker, spine-OFF blueprint this attempt always runs (this brief authored it). */
export const SINGLE_AGENT_BLUEPRINT = 'coding-solo';

/**
 * Alias to the canonical generation unit (BRIEF 3's {@link ArmAttempt} in ./types). Baseline C
 * (su-6c5c4) currently mirrors a local `SingleAgentAttempt`; this re-export makes its
 * swap-to-canonical-import a no-op (the schema-lock follow-up it tracks).
 */
export type SingleAgentAttempt = ArmAttempt;

export interface SingleAgentAttemptOpts {
  /**
   * Arm id to stamp on the produced attempt. Defaults to 'baseline-a-ablation' (Baseline A's
   * own row). Baseline C normally leaves this default and re-stamps the SELECTED candidate as
   * 'baseline-c-bestofn' when it emits — the per-sample candidates live in arm_meta.
   */
  arm?: string;
}

/**
 * Run ONE single-worker (spine-OFF) attempt at `task` via the `coding-solo` blueprint.
 *
 * @param task   the normalized benchmark task (BRIEF 3's `BenchTask`)
 * @param seed   reproducibility seed — becomes the predictions-JSON `prefix` (one per seed)
 * @param budget the iso-budget ceiling for THIS generation (BRIEF 7 owns enforcement)
 * @param ports  the injected clone / instantiate / extractDiff seam (fakes in tests)
 */
export function runSingleAgentAttempt(
  task: BenchTask,
  seed: string,
  budget: GenerationBudget,
  ports: GenerationPorts,
  opts: SingleAgentAttemptOpts = {},
): Promise<ArmAttempt> {
  return runArmGeneration(
    { arm: opts.arm ?? BASELINE_A_ARM, blueprintId: SINGLE_AGENT_BLUEPRINT, task, seed, budget },
    ports,
  );
}
