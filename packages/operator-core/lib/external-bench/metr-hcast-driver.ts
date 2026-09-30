/**
 * METR HCAST two-arm DRIVER (plan benchmark-suite-metr-hcast-2026-06-17 P-005).
 *
 * Orchestrates the full suite: run each ARM over the task backlog for `samplesPerTask` independent seeds, fold
 * the per-(task×seed) {@link MetrHcastTaskResult}s per arm, and build the horizon report (per-arm 50%/80%
 * horizons + the hive-vs-single-opus LIFT + the mandatory caveats). The ops for each arm are injected via
 * `opsFor(arm)` — the CLI binds the live docker+gateway ops; tests bind fakes. Pure orchestration (no docker /
 * no spend of its own) so the arm loop, the seed loop, and the result-merge are unit-testable.
 */
import type { BenchTask, GenerationBudget } from './types';
import { runMetrHcastBacklog, type MetrHcastRunnerOps, type MetrHcastTaskResult } from './metr-hcast-runner';
import {
  buildMetrHcastReport,
  type MetrHcastReport,
  type MetrHcastReportOpts,
} from './metr-hcast-report';

export interface MetrHcastDriverOpts {
  tasks: BenchTask[];
  /** Arms to run (default both: single-opus baseline + hive). */
  arms?: string[];
  /** Independent attempts per (task × arm) — METR runs many rollouts for stable rates (default 1). */
  samplesPerTask?: number;
  /** Generation budget per attempt. */
  budget?: GenerationBudget;
  /** Build the runner ops for one arm (binds the arm's driver + the shared docker/gateway lifecycle). */
  opsFor: (arm: string) => MetrHcastRunnerOps;
  workspaceId?: string;
  /** Horizon-report options (weighting / quantiles / bootstrap / ci / seed). */
  report?: MetrHcastReportOpts;
  /** Per-arm per-sample progress callback (for the CLI's live log). */
  onProgress?: (e: { arm: string; sample: number; done: number; total: number }) => void;
  /** Fired the instant each task settles (per arm) — the CLI appends it to a per-arm accumulation JSONL so a
   *  partial/killed run banks its completed rows (P-005 under intermittent opus). */
  onResult?: (arm: string, r: MetrHcastTaskResult) => void | Promise<void>;
  /** Prior accumulated results to FOLD INTO the report (rows banked by earlier partial runs). */
  priorResultsByArm?: Record<string, MetrHcastTaskResult[]>;
}

export interface MetrHcastDriverResult {
  resultsByArm: Record<string, MetrHcastTaskResult[]>;
  report: MetrHcastReport;
}

export const DEFAULT_METR_HCAST_ARMS = ['baseline-a-ablation', 'papercusp'];

/**
 * Run the two-arm METR HCAST suite. For each arm, run `samplesPerTask` backlog passes (seeds 0..N-1),
 * concatenating the results, then build the horizon report. Never throws on a task failure (the runner's
 * never-throw contract handles it — those rows come back resolved=null and are excluded from the fit).
 */
export async function runMetrHcastSuite(opts: MetrHcastDriverOpts): Promise<MetrHcastDriverResult> {
  const arms = opts.arms ?? DEFAULT_METR_HCAST_ARMS;
  const samples = Math.max(1, opts.samplesPerTask ?? 1);
  const budget = opts.budget ?? {};
  const workspaceId = opts.workspaceId ?? 'metr-hcast';

  const resultsByArm: Record<string, MetrHcastTaskResult[]> = {};
  // Seed with any prior accumulated rows so the report reflects cumulative progress across partial runs.
  for (const [arm, rows] of Object.entries(opts.priorResultsByArm ?? {})) resultsByArm[arm] = [...rows];

  for (const arm of arms) {
    const ops = opts.opsFor(arm);
    const acc: MetrHcastTaskResult[] = resultsByArm[arm] ?? [];
    for (let sample = 0; sample < samples; sample++) {
      const seedResults = await runMetrHcastBacklog(ops, {
        backlog: opts.tasks,
        arm,
        budget,
        seed: String(sample),
        workspaceId,
        onResult: opts.onResult ? (r) => opts.onResult!(arm, r) : undefined,
      });
      acc.push(...seedResults);
      opts.onProgress?.({ arm, sample, done: acc.length, total: opts.tasks.length * samples });
    }
    resultsByArm[arm] = acc;
  }

  const report = buildMetrHcastReport(resultsByArm, opts.report);
  return { resultsByArm, report };
}
