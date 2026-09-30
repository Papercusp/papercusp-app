/**
 * The report builder: folds `TaskRunResult[]` → per-arm `ArmReport`s and a full
 * `SuiteReport` (cost/accuracy Pareto + Papercusp-vs-baseline deltas). This is
 * the importable surface the Evaluation UI (P-020) and the methodology doc
 * (P-016) consume — `buildSuiteReport` is the one call that produces everything
 * the surface renders.
 *
 * Statistics (plan "Statistics" + "same pass@k protocol"):
 *  - pass@1 = mean over TASKS of (resolved-rate over that task's seeds), so every
 *    task is weighted equally regardless of how many seeds it has.
 *  - The CI on pass@1 is a bootstrap over tasks (task heterogeneity dominates).
 *  - pass@k / pass^k use the SAME k's for every arm (`protocolKs`).
 *  - Only rows that passed both generation and grading infra are scored;
 *    infra-error rows are counted separately, never as genuine fails.
 */

import type {
  TaskRunResult,
  ArmReport,
  SuiteReport,
  ArmDelta,
  ParetoPoint,
  ArmId,
  BenchSuite,
  PassAtKPoint,
} from './schema';
import { meanPassAtK } from './pass-k';
import { wilsonInterval, bootstrapMeanCI } from './intervals';
import { accountTokens, verifyIsoBudget, isScored } from './cost';
import { costAccuracyFrontier } from './pareto';
import type { PriceTable } from './pricing';
import { DEFAULT_PRICE_TABLE } from './pricing';

export interface AggregateOpts {
  priceTable?: PriceTable;
  /** The k's the pass@k / pass^k protocol reports (same for every arm). Default [1, 3]. */
  protocolKs?: number[];
  /** Two-sided confidence level for all intervals. Default 0.95. */
  ci?: number;
  /** Deterministic bootstrap seed (so CIs reproduce). Default 0xBE0C. */
  bootstrapSeed?: number;
  /** Bootstrap resamples. Default 10000. */
  bootstrapIterations?: number;
  /** The treatment arm the deltas are computed against. Default 'papercusp' (SWE
   *  pilot); other benchmarks name their own (e.g. 'hive' for tau2's hive-vs-su). */
  treatmentArm?: ArmId;
}

const DEFAULT_KS = [1, 3];
const DEFAULT_SEED = 0xbe0c;

/** Per-task (n scored attempts, c resolved) for one arm. Tasks with 0 scored attempts are dropped. */
function perTaskCounts(rows: readonly TaskRunResult[]): Array<{ n: number; c: number }> {
  const byTask = new Map<string, { n: number; c: number }>();
  for (const r of rows) {
    if (!isScored(r)) continue;
    const t = byTask.get(r.taskId) ?? { n: 0, c: 0 };
    t.n += 1;
    if (r.resolved === true) t.c += 1;
    byTask.set(r.taskId, t);
  }
  return [...byTask.values()];
}

/** Aggregate ONE arm on ONE suite. `rows` must already be filtered to that (suite, arm). */
export function aggregateArm(
  rows: readonly TaskRunResult[],
  suite: BenchSuite,
  arm: ArmId,
  opts: AggregateOpts = {},
): ArmReport {
  const ks = opts.protocolKs ?? DEFAULT_KS;
  const ci = opts.ci ?? 0.95;
  const counts = perTaskCounts(rows);

  // pass@1 = mean over tasks of c/n (== meanPassAtK at k=1); CI bootstrapped over tasks.
  const perTaskPass1 = counts.map((t) => t.c / t.n);
  const passAt1 = perTaskPass1.length === 0 ? 0 : perTaskPass1.reduce((a, b) => a + b, 0) / perTaskPass1.length;
  const passAt1Ci = bootstrapMeanCI(perTaskPass1, {
    ci,
    seed: opts.bootstrapSeed ?? DEFAULT_SEED,
    iterations: opts.bootstrapIterations ?? 10_000,
  });

  // Pooled resolved-rate Wilson interval (cross-check on the raw Bernoulli stream).
  const pooledN = counts.reduce((a, t) => a + t.n, 0);
  const pooledC = counts.reduce((a, t) => a + t.c, 0);
  const resolvedRateWilson = wilsonInterval(pooledC, pooledN, ci);

  const passAtK: PassAtKPoint[] = ks.map((k) => ({ k, ...meanPassAtK(counts, k) }));
  // pass^k (reliability) reuses meanPass over a "success = all k succeed" estimator.
  const passHatK: PassAtKPoint[] = ks.map((k) => ({ k, ...meanPassHatK(counts, k) }));

  const cost = accountTokens(rows, { priceTable: opts.priceTable ?? DEFAULT_PRICE_TABLE, resolvedCount: pooledC });

  // budgetTokens for the report: the single cap these rows share, or null if mixed/uncapped.
  const budgets = new Set(rows.map((r) => r.budgetTokens ?? null));
  const budgetTokens = budgets.size === 1 ? [...budgets][0] : null;

  return {
    arm,
    suite,
    tasks: counts.length,
    attempts: rows.filter(isScored).length,
    infraErrors: rows.filter((r) => !isScored(r)).length,
    cappedRuns: rows.filter((r) => r.capped).length,
    budgetTokens,
    passAt1,
    passAt1Ci,
    resolvedRateWilson,
    passAtK,
    passHatK,
    cost,
  };
}

/** Mean pass^k across tasks (uses the passHatK estimator; same skip semantics as meanPassAtK). */
function meanPassHatK(
  tasks: ReadonlyArray<{ n: number; c: number }>,
  k: number,
): { value: number; tasksUsed: number; skipped: number } {
  // Imported lazily to keep the pure estimator in pass-k.ts; re-derive here.
  let sum = 0;
  let used = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (t.n < k) {
      skipped++;
      continue;
    }
    // pass^k = C(c,k)/C(n,k); reuse the closed form.
    if (t.c < k) {
      used++;
      continue; // contributes 0
    }
    let prod = 1;
    for (let i = 0; i < k; i++) prod *= (t.c - i) / (t.n - i);
    sum += prod;
    used++;
  }
  return { value: used === 0 ? 0 : sum / used, tasksUsed: used, skipped };
}

const PAPERCUSP: ArmId = 'papercusp';

/**
 * Build the full per-suite report: an `ArmReport` per arm, the cost/accuracy
 * Pareto across arms, Papercusp-vs-each-baseline deltas, and the iso-budget
 * invariant check. `rows` is every run-result for the suite (all arms × seeds).
 */
export function buildSuiteReport(rows: readonly TaskRunResult[], opts: AggregateOpts = {}): SuiteReport {
  if (rows.length === 0) {
    throw new Error('buildSuiteReport: no rows');
  }
  const suite = rows[0].suite;
  const runId = rows[0].runId;
  const ks = opts.protocolKs ?? DEFAULT_KS;

  const armIds = [...new Set(rows.map((r) => r.arm))];
  const arms = armIds.map((arm) =>
    aggregateArm(
      rows.filter((r) => r.arm === arm),
      suite,
      arm,
      opts,
    ),
  );

  // Cost/accuracy Pareto: accuracy = pass@1, cost = mean $ per task-attempt.
  const rawPoints = arms.map((a) => ({
    arm: a.arm,
    accuracy: a.passAt1,
    cost: a.attempts === 0 ? 0 : a.cost.costUsd / a.attempts,
    costPerResolved: a.cost.costPerResolved,
  }));
  const frontierArms = new Set(costAccuracyFrontier(rawPoints).map((p) => p.arm));
  const frontier: ParetoPoint[] = rawPoints.map((p) => ({ ...p, onFrontier: frontierArms.has(p.arm) }));

  // treatment − each baseline. The treatment arm defaults to 'papercusp' (the
  // SWE pilot); other benchmarks (tau2 etc.) name their own via opts.treatmentArm.
  const treatmentArm = opts.treatmentArm ?? PAPERCUSP;
  const byArm = new Map(arms.map((a) => [a.arm, a]));
  const treatment = byArm.get(treatmentArm);
  const deltas: ArmDelta[] = [];
  if (treatment) {
    const tPoint = rawPoints.find((p) => p.arm === treatmentArm)!;
    for (const a of arms) {
      if (a.arm === treatmentArm) continue;
      const bPoint = rawPoints.find((p) => p.arm === a.arm)!;
      deltas.push({
        suite,
        treatment: treatmentArm,
        baseline: a.arm,
        accuracyDelta: treatment.passAt1 - a.passAt1,
        costRatio:
          treatment.cost.costPerResolved !== null && a.cost.costPerResolved !== null && a.cost.costPerResolved !== 0
            ? treatment.cost.costPerResolved / a.cost.costPerResolved
            : null,
        costFraction: bPoint.cost === 0 ? null : tPoint.cost / bPoint.cost,
        paretoDominates: treatment.passAt1 >= a.passAt1 && tPoint.cost <= bPoint.cost && (treatment.passAt1 > a.passAt1 || tPoint.cost < bPoint.cost),
      });
    }
  }

  const iso = verifyIsoBudget(rows);

  return {
    runId,
    suite,
    arms,
    frontier,
    deltas,
    isoBudget: { ok: iso.ok, budgetTokens: iso.budgetTokens, violations: iso.violations },
    protocolKs: ks,
  };
}
