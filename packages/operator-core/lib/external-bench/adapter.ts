/**
 * The grader adapter orchestration (P-005 / BRIEF 3): grade a batch of generation attempts and emit each as
 * a per-(task × arm × seed) run-result row. The EMIT MAPPING (ArmAttempt + GradeResult → the locked
 * run-result + rollout) is OWNED by P-010's `emitFromAttempt` (reproducibility/emit.ts) — the single source
 * of truth. This adapter does NOT mirror the run-result schema; it orchestrates grading and DELEGATES every
 * emission to that one function, so there is no snake_case mirror to drift out of sync.
 *
 * SCORING CONTRACT (enforced by emitFromAttempt): a row is scoreable only when generation `completed` AND the
 * grader returned passed|failed. An infra-failed generation (stopReason 'error') is NOT graded → resolved=null
 * (excluded from accuracy). A budget-/turn-capped run still `completed` + `capped` (graded; capped ≠ a fail).
 */
import type { ArmId } from '@papercusp/bench-metrics';
import { diffSubmission, isScoredStopReason, type ArmAttempt, type BenchTask, type GradeResult, type OfficialGrader } from './types';
import type { EmitFromAttemptInput, EmitOptions } from './reproducibility/emit';

export type { EmitFromAttemptInput } from './reproducibility/emit';

/** Stable per-seed prefix (the predictions-JSON `prefix`) from an integer seed index. */
export function seedPrefix(seedIndex: number): string {
  return `seed-${seedIndex}`;
}

/**
 * The injected emit port — the live binding is `emitFromAttempt` (reproducibility/emit.ts); tests inject a
 * fake. Delegating to it means the run-result shape + the stop-reason→status / METR-exclusion mapping live
 * in ONE place (P-010), never mirrored here.
 */
export type EmitRollout = (input: EmitFromAttemptInput, opts?: EmitOptions) => Promise<{ rolloutId: string; runId: string }>;

export interface BatchEntry {
  attempt: ArmAttempt;
  task: BenchTask;
  seedIndex: number;
}

export interface BatchContext {
  runId: string;
  preregHash: string;
  modelId: string;
  harnessVersion: string;
  /** GENERATION iso-budget token cap recorded on each row (null = uncapped / native). */
  budgetTokens?: number | null;
  /** The L2 fleet run that placed these tasks (Phase 5 / D-010); null for standalone L1 arms. */
  fleetRunId?: string | null;
  provenance?: EmitFromAttemptInput['provenance'];
}

export interface AdapterRowResult {
  attempt: ArmAttempt;
  /** The real grade — undefined when the attempt's generation infra-failed (never genuinely graded). */
  grade?: GradeResult;
  rollout: { rolloutId: string; runId: string };
}

/**
 * True when an attempt produced a submission worth grading (a genuine capability termination, not an
 * external/transient/infra failure). FAIRNESS (benchmark-fairness-fix): excludes 'error' AND the new
 * non-scored terminals 'timeout' (wall-clock under contention) + 'infra-failed' (429/contention spawn /
 * drain-unsettled) — those never produced a fairly-given submission → resolved=null, never a fail.
 */
function isScoreable(attempt: ArmAttempt): boolean {
  return isScoredStopReason(attempt.stopReason);
}

/** A placeholder grade for an attempt whose generation infra-failed — emitFromAttempt forces resolved=null. */
function ungradedPlaceholder(attempt: ArmAttempt, grader: OfficialGrader): GradeResult {
  return {
    instanceId: attempt.instanceId,
    prefix: attempt.seed,
    resolved: false,
    rawGraderOutput: null,
    graderFamily: grader.family,
    graderVersion: '',
  };
}

function emitInputFor(entry: BatchEntry, grade: GradeResult, ctx: BatchContext): EmitFromAttemptInput {
  return {
    runId: ctx.runId,
    preregHash: ctx.preregHash,
    // The runner sets the canonical arm on the attempt; PG stores `arm` as text, so this is exact at rest.
    arm: entry.attempt.arm as ArmId,
    seed: entry.seedIndex,
    task: entry.task,
    attempt: entry.attempt,
    grade,
    modelId: ctx.modelId,
    harnessVersion: ctx.harnessVersion,
    budgetTokens: ctx.budgetTokens ?? null,
    tokensCacheRead: entry.attempt.tokensCacheRead ?? null,
    tokensCacheWrite: entry.attempt.tokensCacheWrite ?? null,
    fleetRunId: ctx.fleetRunId ?? null,
    provenance: ctx.provenance,
  };
}

/**
 * Batch-grade the scoreable attempts once (M1 grading is most efficient batched + arm-agnostic), then emit
 * every row via the injected `emit` (= emitFromAttempt). Infra-failed attempts are not graded but still emit
 * (with a placeholder grade → resolved=null). The run-loop (P-019) and the fleet arms (P-022/P-028) call this.
 */
export async function gradeAndEmitBatch(
  entries: BatchEntry[],
  grader: OfficialGrader,
  emit: EmitRollout,
  ctx: BatchContext,
): Promise<AdapterRowResult[]> {
  const toGrade = entries.filter((e) => isScoreable(e.attempt));
  const submissions = toGrade.map((e) => diffSubmission(e.attempt));
  const tasks = toGrade.map((e) => e.task);

  const grades = submissions.length > 0 ? await grader.grade(submissions, tasks) : [];
  const gradeByKey = new Map(grades.map((g) => [`${g.instanceId}__${g.prefix}`, g]));

  const results: AdapterRowResult[] = [];
  for (const entry of entries) {
    const realGrade = isScoreable(entry.attempt)
      ? gradeByKey.get(`${entry.attempt.instanceId}__${entry.attempt.seed}`)
      : undefined;
    const gradeForEmit = realGrade ?? ungradedPlaceholder(entry.attempt, grader);
    const rollout = await emit(emitInputFor(entry, gradeForEmit, ctx));
    results.push({ attempt: entry.attempt, grade: realGrade, rollout });
  }
  return results;
}

export interface RunTaskInput {
  task: BenchTask;
  ctx: BatchContext & { seedIndex: number };
  /** Generate the attempt (e.g. `(t,seed) => runPapercuspArm(t, seed, budget, ports)`). */
  generate: (task: BenchTask, seed: string) => Promise<ArmAttempt>;
  grader: OfficialGrader;
  emit: EmitRollout;
}

/**
 * Run ONE benchmark task end-to-end: generate → grade (M1 grader handles a batch of one) → emit. The unit
 * the brief promises: "an adapter that takes one task id and produces a graded, costed result."
 */
export async function runTaskThroughAdapter(input: RunTaskInput): Promise<AdapterRowResult> {
  const { task, ctx, generate, grader, emit } = input;
  const attempt = await generate(task, seedPrefix(ctx.seedIndex));
  const [result] = await gradeAndEmitBatch([{ attempt, task, seedIndex: ctx.seedIndex }], grader, emit, ctx);
  return result;
}
