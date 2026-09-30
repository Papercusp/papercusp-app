/**
 * Continuous-score aggregation for FrontierSWE-style suites — domain-free, no schema coupling (plan
 * `benchmark-suite-frontier-swe-2026-06-18` P-011). The SWE-bench family is BOOLEAN (pass-k.ts); FrontierSWE
 * scores each task on a CONTINUOUS [0,1] scale over 5 trials and reports **mean@k / best@k** per task, then ranks
 * arms across tasks by **AVG RANK** (mean leaderboard position, lower = better) + **dominance** (win rate vs a
 * random opponent on a task). These metrics do not exist in pass-k.ts (pass@k = "≥1 of k resolves", binary) or
 * pareto.ts (Pareto-dominance over cost/accuracy — a different notion), so they live here.
 *
 * All inputs are plain numbers in [0,1]; callers map their rows to these shapes. Mirrors pass-k.ts's
 * skip-and-surface discipline: a task with fewer than k trials is SKIPPED (cannot estimate @k) and counted, so a
 * caller never silently averages over a shrinking denominator.
 */

/**
 * Unbiased estimator of **mean@k** for ONE task from its trial scores: the expected mean of a uniformly random
 * size-k subset of the n trials. Because every trial is equally likely to appear in a random subset, this equals
 * the mean of all n trials (for n ≥ k). Returns `null` when n < k (cannot estimate @k).
 */
export function meanAtK(scores: readonly number[], k: number): number | null {
  assertK(k);
  const n = scores.length;
  if (n < k) return null;
  let sum = 0;
  for (const s of scores) sum += s;
  return sum / n;
}

/**
 * Unbiased estimator of **best@k** for ONE task: the expected MAXIMUM of a uniformly random size-k subset of the
 * n trial scores. With the trials sorted ascending x[0..n-1],
 *
 *   best@k = Σ_{j=k-1}^{n-1} x[j] · C(j, k-1) / C(n, k)
 *
 * (the j-th order statistic is the subset-max iff the other k-1 are drawn from the j elements below it). This is
 * the continuous analogue of pass@k's unbiased subsampling: best@1 = mean, best@n = max. Returns `null` when n < k.
 */
export function bestAtK(scores: readonly number[], k: number): number | null {
  assertK(k);
  const n = scores.length;
  if (n < k) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const denom = comb(n, k);
  let acc = 0;
  for (let j = k - 1; j < n; j++) {
    acc += sorted[j] * (comb(j, k - 1) / denom);
  }
  return acc;
}

/** Mean over many tasks of each task's {@link meanAtK} — the per-arm mean@k headline. Skips tasks with < k trials. */
export function armMeanAtK(taskTrials: ReadonlyArray<readonly number[]>, k: number): AggAtK {
  return aggregateAtK(taskTrials, k, meanAtK);
}

/** Mean over many tasks of each task's {@link bestAtK} — the per-arm best@k headline. Skips tasks with < k trials. */
export function armBestAtK(taskTrials: ReadonlyArray<readonly number[]>, k: number): AggAtK {
  return aggregateAtK(taskTrials, k, bestAtK);
}

export interface AggAtK {
  /** Equal-weighted mean of the per-task @k value over the tasks that had ≥ k trials. 0 when none qualify. */
  value: number;
  tasksUsed: number;
  skipped: number;
}

function aggregateAtK(
  taskTrials: ReadonlyArray<readonly number[]>,
  k: number,
  perTask: (scores: readonly number[], k: number) => number | null,
): AggAtK {
  let sum = 0;
  let used = 0;
  let skipped = 0;
  for (const trials of taskTrials) {
    const v = perTask(trials, k);
    if (v === null) {
      skipped++;
      continue;
    }
    sum += v;
    used++;
  }
  return { value: used === 0 ? 0 : sum / used, tasksUsed: used, skipped };
}

/**
 * Per-task scalar per arm — the input to the cross-arm leaderboard metrics. One entry per task; `scores` maps an
 * arm id to its leaderboard scalar for that task (typically its best@k). An arm absent from a task's `scores` is
 * simply not ranked on that task (it ran fewer arms / was skipped) — never imputed.
 */
export interface PerTaskArmScores {
  taskId: string;
  tier?: string;
  scores: Readonly<Record<string, number>>;
}

/**
 * **AVG RANK** per arm (the FrontierSWE leaderboard headline; lower = better). On each task the arms present are
 * ranked by score descending (higher = rank 1); ties share the average rank (standard fractional ranking). An
 * arm's AVG RANK is the mean of its per-task ranks over the tasks it appears on.
 */
export function avgRank(perTask: readonly PerTaskArmScores[]): {
  avgRank: Record<string, number>;
  tasksRanked: Record<string, number>;
} {
  const rankSum: Record<string, number> = {};
  const count: Record<string, number> = {};
  for (const t of perTask) {
    const entries = Object.entries(t.scores);
    if (entries.length === 0) continue;
    // Sort by score DESC; assign average ranks to ties.
    const sorted = [...entries].sort((a, b) => b[1] - a[1]);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++;
      // Ranks i+1 .. j+1 (1-indexed) tie → average rank.
      const avg = (i + 1 + (j + 1)) / 2;
      for (let m = i; m <= j; m++) {
        const arm = sorted[m][0];
        rankSum[arm] = (rankSum[arm] ?? 0) + avg;
        count[arm] = (count[arm] ?? 0) + 1;
      }
      i = j + 1;
    }
  }
  const out: Record<string, number> = {};
  for (const arm of Object.keys(rankSum)) out[arm] = rankSum[arm] / count[arm];
  return { avgRank: out, tasksRanked: count };
}

/**
 * **Dominance** per arm in [0,1] — "win rate vs a random opponent on a task" (the FrontierSWE leaderboard's
 * second axis). Over every task and every OTHER arm present on it, the fraction of pairings where this arm's
 * score is strictly higher (a tie counts 0.5). 1.0 = beats everyone on every task; 0.5 = even.
 */
export function dominance(perTask: readonly PerTaskArmScores[]): Record<string, number> {
  const wins: Record<string, number> = {};
  const games: Record<string, number> = {};
  for (const t of perTask) {
    const entries = Object.entries(t.scores);
    for (let a = 0; a < entries.length; a++) {
      for (let b = 0; b < entries.length; b++) {
        if (a === b) continue;
        const [armA, sA] = entries[a];
        const sB = entries[b][1];
        wins[armA] = (wins[armA] ?? 0) + (sA > sB ? 1 : sA === sB ? 0.5 : 0);
        games[armA] = (games[armA] ?? 0) + 1;
      }
    }
  }
  const out: Record<string, number> = {};
  for (const arm of Object.keys(games)) out[arm] = games[arm] === 0 ? 0 : wins[arm] / games[arm];
  return out;
}

/** One arm's FrontierSWE rollup across the suite. */
export interface FrontierArmSummary {
  arm: string;
  /** Equal-weighted mean over tasks of the arm's per-task mean@k. */
  meanAtK: number;
  /** Equal-weighted mean over tasks of the arm's per-task best@k (the leaderboard scalar source). */
  bestAtK: number;
  /** Mean leaderboard position across tasks (lower = better), ranked on per-task best@k. */
  avgRank: number;
  /** Win rate vs a random opponent on a task, in [0,1]; NaN when the arm had no opponents on any task. */
  dominance: number;
  /** Tasks with ≥ k trials for this arm. */
  tasksUsed: number;
}

/** One arm's per-task trial scores: `trials[arm]` is that arm's ≤k trial scores on the task. */
export interface ArmTaskTrials {
  taskId: string;
  tier?: string;
  /** arm id → that arm's trial scores on this task (length up to k). */
  trials: Readonly<Record<string, readonly number[]>>;
}

/**
 * The FrontierSWE suite rollup: per-task best@k/mean@k per arm → per-arm mean@k, best@k, AVG RANK, dominance.
 * The leaderboard ranks arms on per-task **best@k** (FrontierSWE's headline for the implementation tasks where no
 * model fully solves anything). Pass `tierFilter` to restrict to one category (per-tier reporting, fairness C8).
 */
export function frontierRankReport(
  tasks: readonly ArmTaskTrials[],
  k: number,
  opts: { tierFilter?: string } = {},
): { k: number; arms: FrontierArmSummary[]; perTaskBestAtK: PerTaskArmScores[] } {
  assertK(k);
  const used = opts.tierFilter ? tasks.filter((t) => t.tier === opts.tierFilter) : tasks;

  // Per-task best@k (the leaderboard scalar) + per-arm accumulation of mean@k/best@k.
  const perTaskBestAtK: PerTaskArmScores[] = [];
  const meanAcc: Record<string, { sum: number; n: number }> = {};
  const bestAcc: Record<string, { sum: number; n: number }> = {};

  for (const t of used) {
    const best: Record<string, number> = {};
    for (const [arm, trials] of Object.entries(t.trials)) {
      const b = bestAtK(trials, k);
      const m = meanAtK(trials, k);
      if (b !== null) {
        best[arm] = b;
        bestAcc[arm] = { sum: (bestAcc[arm]?.sum ?? 0) + b, n: (bestAcc[arm]?.n ?? 0) + 1 };
      }
      if (m !== null) meanAcc[arm] = { sum: (meanAcc[arm]?.sum ?? 0) + m, n: (meanAcc[arm]?.n ?? 0) + 1 };
    }
    if (Object.keys(best).length > 0) perTaskBestAtK.push({ taskId: t.taskId, tier: t.tier, scores: best });
  }

  const { avgRank: ranks } = avgRank(perTaskBestAtK);
  const dom = dominance(perTaskBestAtK);

  const arms: FrontierArmSummary[] = Object.keys(bestAcc).map((arm) => ({
    arm,
    meanAtK: meanAcc[arm] ? meanAcc[arm].sum / meanAcc[arm].n : Number.NaN,
    bestAtK: bestAcc[arm].sum / bestAcc[arm].n,
    avgRank: ranks[arm] ?? Number.NaN,
    // NaN (not 0) when the arm had no opponent on any task — "no comparison possible", not "lost everything"
    // (e.g. a per-bucket filter leaving one arm). 0 would falsely rank it below a 50-50 arm.
    dominance: dom[arm] ?? Number.NaN,
    tasksUsed: bestAcc[arm].n,
  }));
  // Sort by AVG RANK ascending (the leaderboard order).
  arms.sort((a, b) => a.avgRank - b.avgRank);
  return { k, arms, perTaskBestAtK };
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new Error(`frontier-rank: k must be an integer ≥ 1 (got ${k})`);
}

/** Numerically-tame binomial coefficient C(n, k) as a float (trial counts are small). Returns 0 for k>n or k<0. */
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}
