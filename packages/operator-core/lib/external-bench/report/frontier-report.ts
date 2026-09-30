/**
 * FrontierSWE report transform (plan benchmark-suite-frontier-swe-2026-06-18 P-016): fold graded run rows
 * (`suite='frontier-swe'`) into the `suiteData['frontier-swe']` payload the Evaluation UI renders — per-arm
 * mean@5 / best@5 + AVG-RANK + dominance (overall + per bucket), plus the mandatory caveats and the excluded
 * (infra-non-completion) count. Pure: `TaskRunResult[]` in → a plain object out (no DB, no run). The report
 * builder / run path attaches the result under `BenchReportBundle.suiteData['frontier-swe']`.
 *
 * Denominator discipline (C1/C6): a genuine capability outcome (a numeric `score`, incl. 0) COUNTS; an infra
 * non-completion (generation/grader error/timeout) is EXCLUDED + surfaced via `excludedCount`, never scored 0.
 */
import type { ArmTaskTrials, FrontierArmSummary, TaskRunResult } from '@papercusp/bench-metrics';
import { frontierRankReport } from '@papercusp/bench-metrics';

const BUCKETS = ['implementation', 'performance', 'research'] as const;

/** The mandatory FrontierSWE reporting caveats (plan D-002 / D-003 / C6 / C8). Shown with every number. */
export const FRONTIER_SWE_CAVEATS: readonly string[] = [
  'Absolute AVG RANK / dominance are illustrative only unless the full FrontierSWE competitor pool was run — ' +
    'the defensible signal is the within-pool coordination-topology comparison on the same tasks + iso-budget (D-002).',
  'FrontierSWE is ultra-long-horizon, small-N (17 tasks) — always report trials/seeds; a single-run gap inside ' +
    'the noise band is not significant (C8).',
  'Infra non-completions are EXCLUDED (not scored 0) and disclosed symmetrically across arms (C6) — see excludedCount.',
];

export interface FrontierSweSuiteData {
  k: number;
  /** Distinct tasks with ≥1 scored row. */
  taskCount: number;
  /** Scored rows folded in (a numeric score). */
  trialCount: number;
  /** frontier-swe rows dropped as infra non-completions (generation/grader error/timeout) — surfaced, not scored 0. */
  excludedCount: number;
  /** Per-arm rollup over all tasks, sorted by AVG RANK ascending. */
  arms: FrontierArmSummary[];
  /** Per-bucket (implementation/performance/research) per-arm rollups, when tasks carry a bucket. */
  perBucket: Record<string, FrontierArmSummary[]>;
  caveats: readonly string[];
}

/** True iff a row was genuinely graded (a numeric capability score), not an infra non-completion. */
function isScoredFrontierRow(r: TaskRunResult): boolean {
  return (
    r.generationStatus === 'completed' &&
    r.graderStatus !== 'error' &&
    r.graderStatus !== 'timeout' &&
    typeof r.score === 'number' &&
    Number.isFinite(r.score)
  );
}

/**
 * Build the `frontier-swe` suiteData from run rows. `k` defaults to 5 (the FrontierSWE trial protocol).
 * `taskBucket` maps taskId → 'implementation'|'performance'|'research' (from the corpus graderMeta.bucket) to
 * enable per-bucket reporting; omit it and `perBucket` is empty (overall still computed).
 */
export function buildFrontierSweSuiteData(
  rows: readonly TaskRunResult[],
  opts: { k?: number; taskBucket?: Record<string, string> } = {},
): FrontierSweSuiteData {
  const k = opts.k ?? 5;
  const fsRows = rows.filter((r) => r.suite === 'frontier-swe');
  const scored = fsRows.filter(isScoredFrontierRow);
  const excludedCount = fsRows.length - scored.length;

  // taskId → arm → trial scores
  const byTask = new Map<string, Map<string, number[]>>();
  for (const r of scored) {
    const arms = byTask.get(r.taskId) ?? new Map<string, number[]>();
    const arr = arms.get(r.arm) ?? [];
    arr.push(r.score as number);
    arms.set(r.arm, arr);
    byTask.set(r.taskId, arms);
  }

  const tasks: ArmTaskTrials[] = [];
  for (const [taskId, arms] of byTask) {
    const trials: Record<string, number[]> = {};
    for (const [arm, scores] of arms) trials[arm] = scores;
    tasks.push({ taskId, tier: opts.taskBucket?.[taskId], trials });
  }

  const report = frontierRankReport(tasks, k);
  const perBucket: Record<string, FrontierArmSummary[]> = {};
  for (const b of BUCKETS) {
    if (tasks.some((t) => t.tier === b)) perBucket[b] = frontierRankReport(tasks, k, { tierFilter: b }).arms;
  }

  return {
    k,
    taskCount: byTask.size,
    trialCount: scored.length,
    excludedCount,
    arms: report.arms,
    perBucket,
    caveats: FRONTIER_SWE_CAVEATS,
  };
}
