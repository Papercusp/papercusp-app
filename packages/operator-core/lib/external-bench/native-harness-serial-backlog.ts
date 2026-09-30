/**
 * Baseline B — native-harness SERIAL-BACKLOG floor (P-024 / BRIEF 5, reframe D-010). The L1 /
 * serial-throughput FLOOR: one native Claude Code arm draining the WHOLE benchmark backlog
 * SEQUENTIALLY (concurrency 1, no parallelism). This is the denominator of the L2 speedup claim —
 * the Hive (Queen + bee fleet, P-022) drains the SAME backlog in parallel, and
 *   speedup = serial backlogDrainMs / hive backlogDrainMs
 * isolates what the fleet's parallelism + the Queen's placement buy (D-010; OpenHands async-SWE
 * framing — 1.8–3.7× speedup, diminishing past the # of parallelizable subtasks).
 *
 * It reuses the per-task native arm verbatim — {@link runNativeHarnessAttempt} (P-007) is the
 * atomic unit; this layer just loops it in order and aggregates the serial timing/cost. NOTHING
 * about the per-task arm changes (same vanilla Claude Code, same grader, same row), so the floor
 * is apples-to-apples with the fleet (each fleet worker runs the identical per-task unit).
 *
 * INTERPRETATION (deliberate, surfaced): "one Claude Code session draining the backlog" = SERIAL
 * (concurrency 1), realized as sequential INDEPENDENT per-task attempts. We do NOT reuse one
 * persistent `claude` session across tasks: benchmark tasks live in DIFFERENT repos, and a shared
 * session would leak cross-task context — an unfair, non-comparable floor (the fleet runs each task
 * fresh). The serial COST is Σ per-task regardless of process identity, so sequential-fresh is the
 * clean, faithful floor. (A persistent-session variant is possible via runAgentChat `sessionId`;
 * deferred unless the methodology asks for it.)
 *
 * Generation-only: per-task `resolved` + the resolved-throughput metrics (tasks-resolved/hr,
 * resolved/$) are derived AFTER grading by P-025's fleet metrics. This produces the serial GENERATION
 * trace + the floor timing/cost.
 */
import { BASELINE_B_ARM, type NativeHarnessConfig } from './native-harness-config';
import { runNativeHarnessAttempt, type NativeArmResult, type NativeHarnessPorts } from './native-harness-runner';
import {
  runNativeHarnessTerminalBench,
  type NativeTerminalBenchResult,
  type RunHarbor,
} from './native-harness-terminal-bench';
import type { BenchTask, GenerationBudget } from './types';
import type { BenchSuite, FleetRunSummary } from '@papercusp/bench-metrics';

/** One backlog entry — a task and the reproducibility seed this serial pass runs it under. */
export interface SerialBacklogItem {
  task: BenchTask;
  /** Seed/prefix for the per-task attempt (one serial pass = one seed across the backlog). */
  seed: string;
}

/** Per-task arm fn. Default binds {@link runNativeHarnessAttempt}; injectable for tests / the M2 (Harbor) variant. */
export type RunNativeTask = (task: BenchTask, seed: string) => Promise<NativeArmResult>;

export interface SerialBacklogOpts {
  /** Override the per-task arm (default: the M1 native attempt bound with budget+ports+config). */
  runTask?: RunNativeTask;
  /** Injected wall-clock (ms) for the TRUE serial drain time. Default: `ports.now` then `Date.now`. */
  now?: () => number;
}

/**
 * The serial-throughput FLOOR record — one arm draining the backlog sequentially. The L1 baseline
 * the Hive / Queen-ablated parallel `backlogDrainMs` is compared against (P-025 computes the
 * speedup + tasks/$ + tasks/hr from this + the graded `resolved`). It is intentionally the SAME
 * SHAPE every backlog arm should emit (serial floor / hive / queen-ablation) so they're comparable
 * — proposed to P-025 (fleet metrics) + P-022 (hive driver) for the canonical type; reconcile when
 * they publish it (swap to their import, delete this).
 */
export interface SerialBacklogResult {
  /** The backlog run mode — distinguishes the serial floor from the fleet arms on the throughput record. */
  mode: 'serial-native';
  /** Grader modality of the per-task unit — M1 diff-batch here ('in-container' = the Harbor variant below). */
  modality: 'diff';
  /** Always 1 — the floor has no parallelism (the whole point of the comparison). */
  concurrency: 1;
  /** Arm id on the per-task rows (stays the locked 'baseline-b-native'). */
  arm: typeof BASELINE_B_ARM;
  /** One per backlog item, in backlog order — each is a normal per-task run-result row. */
  attempts: NativeArmResult[];
  tasksAttempted: number;
  /** TRUE serial wall-clock to drain the whole backlog (end − start) — the L2 speedup denominator. */
  backlogDrainMs: number;
  /** Σ per-task wall-clock (≈ backlogDrainMs; any gap is loop/clone overhead between tasks). */
  sumTaskWallClockMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** Σ per-task cost (no coordination overhead — it's a single serial agent). Canonical $ is re-derived from tokens. */
  totalCostUsd: number;
  startedAtMs: number;
  endedAtMs: number;
}

/**
 * Drain a backlog SEQUENTIALLY with the native Claude Code arm and return the serial-throughput
 * floor. Each task runs to completion before the next starts; the per-task arm already excludes
 * infra failures from accuracy (stopReason 'error'), so a failed task still counts toward
 * `tasksAttempted` + its (real) cost, but contributes no resolved pass — exactly how the fleet's
 * floor should read.
 *
 * @param backlog the tasks to drain, in order, each with its seed
 * @param budget  the per-task iso-budget ceiling (the serial floor caps each task identically to the fleet)
 * @param ports   the injected native-harness seam (clone / extractDiff / spawnAgent / harnessVersion)
 * @param config  elicited-to-best overrides (model pinned to the other arms' by the pilot)
 * @param opts    `runTask` override (M2/Harbor variant or a fake) + `now`
 */
export async function runNativeSerialBacklog(
  backlog: readonly SerialBacklogItem[],
  budget: GenerationBudget,
  ports: NativeHarnessPorts,
  config: Partial<NativeHarnessConfig> = {},
  opts: SerialBacklogOpts = {},
): Promise<SerialBacklogResult> {
  const now = opts.now ?? ports.now ?? Date.now;
  const runTask: RunNativeTask =
    opts.runTask ?? ((task, seed) => runNativeHarnessAttempt(task, seed, budget, ports, config));

  const startedAtMs = now();
  const attempts: NativeArmResult[] = [];
  // SEQUENTIAL by construction — the floor is "no parallelism". `for…await` (not Promise.all) so
  // backlogDrainMs is the genuine serial cost the Hive's parallel drain is divided into.
  for (const { task, seed } of backlog) {
    attempts.push(await runTask(task, seed));
  }
  const endedAtMs = now();

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let sumTaskWallClockMs = 0;
  for (const r of attempts) {
    totalTokensIn += r.attempt.tokensIn;
    totalTokensOut += r.attempt.tokensOut;
    totalCostUsd += r.attempt.costUsd;
    sumTaskWallClockMs += r.attempt.wallClockMs;
  }

  return {
    mode: 'serial-native',
    modality: 'diff',
    concurrency: 1,
    arm: BASELINE_B_ARM,
    attempts,
    tasksAttempted: attempts.length,
    backlogDrainMs: endedAtMs - startedAtMs,
    sumTaskWallClockMs,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    startedAtMs,
    endedAtMs,
  };
}

/**
 * The M2 (in-container) serial floor — same shape as {@link SerialBacklogResult} but Harbor grades
 * each task IN-SANDBOX as it finishes, so `tasksResolved` is known immediately (no post-hoc grading,
 * unlike the M1 diff floor). `results` carry the per-task grade alongside the attempt.
 */
export interface TerminalBenchSerialResult {
  mode: 'serial-native';
  modality: 'in-container';
  concurrency: 1;
  arm: typeof BASELINE_B_ARM;
  results: NativeTerminalBenchResult[];
  tasksAttempted: number;
  /** Tasks Harbor graded as resolved (excludes in-sandbox infra failures — `grade.graderError`). */
  tasksResolved: number;
  backlogDrainMs: number;
  sumTaskWallClockMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  startedAtMs: number;
  endedAtMs: number;
}

/**
 * Drain a Terminal-Bench backlog SEQUENTIALLY via Harbor's built-in `--agent claude-code` (D-008) —
 * the in-container serial floor. Nearly free vs M1 (no custom agent), and Harbor returns the grade
 * with the run, so this reports `tasksResolved` directly. The real `runHarbor` (a Docker/uv
 * `harbor run` subprocess) is injected — deferred to the pilot M2 phase; tested here with a fake.
 */
export async function runNativeSerialBacklogTerminalBench(
  backlog: readonly SerialBacklogItem[],
  budget: GenerationBudget,
  ports: { runHarbor: RunHarbor; harborVersion?: string; now?: () => number },
): Promise<TerminalBenchSerialResult> {
  const now = ports.now ?? Date.now;
  const startedAtMs = now();
  const results: NativeTerminalBenchResult[] = [];
  for (const { task, seed } of backlog) {
    results.push(await runNativeHarnessTerminalBench(task, seed, budget, ports));
  }
  const endedAtMs = now();

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let sumTaskWallClockMs = 0;
  let tasksResolved = 0;
  for (const r of results) {
    totalTokensIn += r.attempt.tokensIn;
    totalTokensOut += r.attempt.tokensOut;
    totalCostUsd += r.attempt.costUsd;
    sumTaskWallClockMs += r.attempt.wallClockMs;
    if (r.grade.resolved && !r.grade.graderError) tasksResolved += 1;
  }

  return {
    mode: 'serial-native',
    modality: 'in-container',
    concurrency: 1,
    arm: BASELINE_B_ARM,
    results,
    tasksAttempted: results.length,
    tasksResolved,
    backlogDrainMs: endedAtMs - startedAtMs,
    sumTaskWallClockMs,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    startedAtMs,
    endedAtMs,
  };
}

/* -------------------------------------------------------------------------- */
/* L2 reconciliation — project the serial floor → the LOCKED FleetRunSummary   */
/* (@papercusp/bench-metrics, P-025). The rich SerialBacklogResult stays the    */
/* per-arm record; these are the lean comparison/emit projection P-010's        */
/* emitFleetRun({ summary }) + P-025's throughputMetrics consume.               */
/* -------------------------------------------------------------------------- */

/** Fleet arm id for the native serial-backlog floor — the L2 serial baseline (FleetArmId). */
export const NATIVE_SERIAL_ARM = 'native-serial' as const;

/**
 * Project the M1 (diff) serial floor → FleetRunSummary (arm 'native-serial'), the throughput
 * baseline P-025 divides the Hive's parallel `backlogDrainMs` into. `resolved` is supplied by the
 * caller because M1 grading is POST-HOC (the pilot grades the diffs via the adapter/grader); the M2
 * variant below knows it directly. `tasksZeroHumanGate` defaults to tasksAttempted (the native arm
 * runs with no human gate). Emit via `emitFleetRun({ summary, ... })`.
 */
export function serialToFleetRunSummary(
  result: SerialBacklogResult,
  opts: { runId: string; suite: BenchSuite; resolved: number; tasksZeroHumanGate?: number },
): FleetRunSummary {
  return {
    runId: opts.runId,
    suite: opts.suite,
    arm: NATIVE_SERIAL_ARM,
    tasks: result.tasksAttempted,
    resolved: opts.resolved,
    wallClockMs: result.backlogDrainMs,
    costUsd: result.totalCostUsd,
    tokensTotal: result.totalTokensIn + result.totalTokensOut,
    tasksZeroHumanGate: opts.tasksZeroHumanGate ?? result.tasksAttempted,
    peakConcurrency: 1,
  };
}

/**
 * Project the M2 (Harbor in-container) serial floor → FleetRunSummary (arm 'native-serial').
 * `resolved` is known directly — Harbor grades in-sandbox as each task finishes.
 */
export function terminalBenchSerialToFleetRunSummary(
  result: TerminalBenchSerialResult,
  opts: { runId: string; suite: BenchSuite; tasksZeroHumanGate?: number },
): FleetRunSummary {
  return {
    runId: opts.runId,
    suite: opts.suite,
    arm: NATIVE_SERIAL_ARM,
    tasks: result.tasksAttempted,
    resolved: result.tasksResolved,
    wallClockMs: result.backlogDrainMs,
    costUsd: result.totalCostUsd,
    tokensTotal: result.totalTokensIn + result.totalTokensOut,
    tasksZeroHumanGate: opts.tasksZeroHumanGate ?? result.tasksAttempted,
    peakConcurrency: 1,
  };
}
