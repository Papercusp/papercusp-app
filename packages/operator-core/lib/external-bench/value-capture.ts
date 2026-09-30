/**
 * L3 value-capture layer (P-027 / Phase 5) — the GRADER-AGNOSTIC half: a $-weighted benchmark task
 * (SWE-Lancer; D-010/D-011) carries a payout, and a RESOLVED task "captures" that $. This reuses the whole
 * P-005 adapter unchanged — it only STAMPS the task's payout onto the emitted row (`arm_meta.valueUsd`) so
 * the value-captured-under-fixed-budget metric (P-025, su-4ac61) can sum captured $ over resolved rows, and
 * the Hive's $-aware placement (P-022, su-1226c) can rank a backlog by value.
 *
 * The SWE-Lancer GRADER backend (M1 diff, E2E $-graded, feasibility doc §6) lands in ./grader/swe-lancer.ts;
 * this layer is grader-agnostic and works with any {@link OfficialGrader}.
 */
import { runTaskThroughAdapter, type AdapterRowResult, type RunTaskInput } from './adapter';
import type { ArmAttempt, BenchTask } from './types';

/** The task's $-payout: the typed `valueUsd`, else `graderMeta.payoutUsd`, else 0 (a non-value task). */
export function taskValueUsd(task: BenchTask): number {
  if (typeof task.valueUsd === 'number' && Number.isFinite(task.valueUsd)) return task.valueUsd;
  const meta = task.graderMeta?.['payoutUsd'];
  return typeof meta === 'number' && Number.isFinite(meta) ? meta : 0;
}

/**
 * Run one $-weighted task through the adapter, stamping its payout onto the emitted row so a resolved row's
 * captured value is recoverable downstream. A RESOLVED row "captures" `valueUsd`; an unresolved / infra row
 * captures $0 (the metric reads `resolved` + `arm_meta.valueUsd`). Grader-agnostic; reuses runTaskThroughAdapter.
 */
export function runValueCaptureTask(input: RunTaskInput): Promise<AdapterRowResult> {
  const valueUsd = taskValueUsd(input.task);
  const generate = async (task: BenchTask, seed: string): Promise<ArmAttempt> => {
    const attempt = await input.generate(task, seed);
    return { ...attempt, armMeta: { ...(attempt.armMeta ?? {}), valueUsd } };
  };
  return runTaskThroughAdapter({ ...input, generate });
}
