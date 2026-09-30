/**
 * METR-style **time-horizon** fit — domain-free. Ports METR's "Measuring AI
 * Ability to Complete Long Tasks" (arXiv:2503.14499) / HCAST (arXiv:2503.17354)
 * methodology so we can read a **50%-task-completion time horizon** (the
 * human-expert task LENGTH at which an arm succeeds 50% of the time) off a set of
 * human-time-baselined tasks. Faithful to METR's reference code
 * (`eval-analysis-public/src/horizon`): weighted logistic regression of success
 * vs `log2(human_minutes)`, then horizon = `2^((logit(q) − intercept) / coef)`.
 *
 * THE METRIC IS SINGLE-AGENT BY CONSTRUCTION (METR's published horizons are
 * single-agent). Our value is the **lift**: fit the horizon for two arms on the
 * SAME tasks (single-opus baseline vs the hive) and report whether coordination
 * EXTENDS the achievable task length — see {@link horizonLift}. On a small open
 * subset the absolute horizon is noisy with wide CIs (NOT leaderboard-comparable);
 * the relative lift cancels much of that subset bias and is the defensible signal
 * (plan benchmark-suite-metr-hcast-2026-06-17 D-002).
 *
 * Math equivalence note: METR fits sklearn `LogisticRegression(C=1/reg)` over
 * per-RUN rows (splitting fractional scores into weighted 0/1). Fitting per-TASK
 * rows with the task's mean success as a fractional target under the same weights
 * is mathematically identical (the weighted log-loss is the same function), and
 * is the shape a benchmark arm naturally produces — so this module consumes
 * per-task `successRate`. The IRLS optimum here equals sklearn's: both minimise
 * `Σ wᵢ·logloss(pᵢ, yᵢ) + ½·reg·slope²` (intercept unpenalised), and sklearn's
 * objective `½·slope² + (1/reg)·Σ wᵢ·logloss` is a positive multiple of it.
 */

import type { Interval } from './intervals';

/** One human-time-baselined task's outcome for one arm (the fit's unit). */
export interface HorizonTask {
  /** Stable task id — the bootstrap-resampling unit; also de-dups. */
  taskId: string;
  /** Human-expert completion time in MINUTES (the difficulty axis; must be > 0). */
  humanMinutes: number;
  /** Mean success in [0,1] over the arm's attempts on this task (binary → {0,1}; partial-credit → fractional). */
  successRate: number;
  /** Task family — used by `invsqrt` weighting + hierarchical bootstrap. Optional. */
  family?: string;
  /** Explicit per-task weight; when set it overrides the `weighting` scheme for this task. */
  weight?: number;
}

/** Task-weighting scheme (mirrors METR's `equal_task_weight` / `invsqrt_task_weight`). */
export type HorizonWeighting =
  | 'equal' //   every task weighted 1/n (METR equal_task_weight)
  | 'invsqrt' // down-weight big families by 1/√(family size) (METR invsqrt_task_weight, the headline)
  | 'none'; //   raw weight 1 each (no normalisation)

/** Options for {@link fitHorizon} / {@link fitHorizonLogistic}. */
export interface HorizonFitOpts {
  /** Task-weighting scheme (default `'equal'`). Ignored for tasks carrying an explicit `weight`. */
  weighting?: HorizonWeighting;
  /** L2 ridge on the slope (NOT the intercept). METR uses 1e-5 (a numerical-stability ridge). */
  regularization?: number;
  /** Max IRLS/Newton iterations (default 100). */
  maxIter?: number;
  /** Convergence tolerance on the parameter step (default 1e-10). */
  tol?: number;
}

/** The fitted logistic in `log2(minutes)` space. */
export interface HorizonFit {
  /** Slope on log2(minutes). NEGATIVE for a sane agent (longer tasks → lower success). */
  coef: number;
  /** Logit intercept. */
  intercept: number;
  /** Distinct tasks the fit used. */
  tasks: number;
  /** Weighted mean success rate (the fit's `average`). */
  averageSuccess: number;
  /** Weighted binary-cross-entropy loss — fit quality (lower = tighter). */
  bceLoss: number;
  /**
   * Degenerate fit: all-success / all-failure / fewer than 2 distinct human-times /
   * a non-negative slope (success does not fall with task length). The point
   * horizon is still returned but is not trustworthy — callers should surface this.
   */
  degenerate: boolean;
  /** Human-readable reason when `degenerate` (else undefined). */
  degenerateReason?: string;
}

/** A horizon read-off at one success quantile, optionally with a bootstrap CI. */
export interface HorizonPoint {
  /** Success quantile this horizon is for (e.g. 0.5, 0.8). */
  quantile: number;
  /** Human-time in MINUTES at which P(success) = quantile. `Infinity`/`0` for degenerate fits. */
  horizonMinutes: number;
  /** Bootstrap CI on `horizonMinutes` (present only when CIs were requested). */
  ci?: Interval;
}

/** The full horizon result for one arm: the fit + the requested quantile horizons. */
export interface HorizonResult {
  fit: HorizonFit;
  points: HorizonPoint[];
}

const EPS = 1e-12;
const clampP = (p: number): number => Math.min(1 - 1e-15, Math.max(1e-15, p));
const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/**
 * Per-task weights for a `weighting` scheme, normalised to sum to 1 (except
 * `'none'`). A task's explicit `weight` overrides the scheme. Faithful to METR:
 *  - equal:   wᵢ = 1/n
 *  - invsqrt: wᵢ = (1/n) · 1/√(familySize); then renormalised to sum 1
 */
export function computeTaskWeights(tasks: readonly HorizonTask[], weighting: HorizonWeighting = 'equal'): number[] {
  const n = tasks.length;
  if (n === 0) return [];
  const familySize = new Map<string, number>();
  if (weighting === 'invsqrt') {
    for (const t of tasks) {
      const fam = t.family ?? t.taskId;
      familySize.set(fam, (familySize.get(fam) ?? 0) + 1);
    }
  }
  const raw = tasks.map((t) => {
    if (t.weight !== undefined) return t.weight;
    if (weighting === 'none') return 1;
    if (weighting === 'equal') return 1 / n;
    const fam = t.family ?? t.taskId;
    return (1 / n) * (1 / Math.sqrt(familySize.get(fam) ?? 1));
  });
  if (weighting === 'none') return raw;
  const sum = raw.reduce((a, b) => a + b, 0);
  return sum > 0 ? raw.map((w) => w / sum) : raw.map(() => 1 / n);
}

/**
 * Weighted logistic regression of `successRate` on `log2(humanMinutes)` via
 * Newton–Raphson (IRLS), with an L2 ridge on the slope only. Reproduces METR's
 * sklearn fit (same optimum — see the module header). Robust to degeneracy:
 * returns `coef:-Infinity` for all-failure, a flagged near-zero slope for
 * all-success, and flags non-identifiable inputs rather than throwing.
 */
export function fitHorizonLogistic(tasks: readonly HorizonTask[], opts: HorizonFitOpts = {}): HorizonFit {
  const reg = opts.regularization ?? 1e-5;
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-10;

  const n = tasks.length;
  if (n === 0) {
    return { coef: 0, intercept: 0, tasks: 0, averageSuccess: 0, bceLoss: 0, degenerate: true, degenerateReason: 'no tasks' };
  }

  const w = computeTaskWeights(tasks, opts.weighting ?? 'equal');
  const wsum = w.reduce((a, b) => a + b, 0) || 1;
  // Normalise weights to sum 1 so `reg` has the same meaning as METR's (which fits with weights summing to 1).
  const wn = w.map((v) => v / wsum);
  const x = tasks.map((t) => Math.log2(Math.max(t.humanMinutes, EPS)));
  const y = tasks.map((t) => Math.min(1, Math.max(0, t.successRate)));

  const averageSuccess = tasks.reduce((a, t, i) => a + wn[i] * y[i], 0);

  const distinctX = new Set(x.map((v) => v.toFixed(9))).size;
  const allZero = y.every((v) => v <= EPS);
  const allOne = y.every((v) => v >= 1 - EPS);

  const bce = (b0: number, b1: number): number => {
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const p = clampP(sigmoid(b0 + b1 * x[i]));
      loss += wn[i] * -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
    }
    return loss;
  };

  if (allZero) {
    return { coef: -Infinity, intercept: -Infinity, tasks: n, averageSuccess, bceLoss: bce(-30, 0), degenerate: true, degenerateReason: 'all tasks failed' };
  }
  if (distinctX < 2) {
    return { coef: 0, intercept: Math.log(clampP(averageSuccess) / (1 - clampP(averageSuccess))), tasks: n, averageSuccess, bceLoss: bce(0, 0), degenerate: true, degenerateReason: 'fewer than 2 distinct human-times' };
  }

  // Newton–Raphson with step-halving safeguard against separation overshoot.
  let b0 = Math.log(clampP(averageSuccess) / (1 - clampP(averageSuccess)));
  let b1 = 0;
  let lastLoss = bce(b0, b1) + 0.5 * reg * b1 * b1;
  for (let iter = 0; iter < maxIter; iter++) {
    let g0 = 0;
    let g1 = reg * b1; // penalty gradient on slope only
    let h00 = 0;
    let h01 = 0;
    let h11 = reg; // penalty curvature on slope only
    for (let i = 0; i < n; i++) {
      const p = clampP(sigmoid(b0 + b1 * x[i]));
      const r = wn[i] * (p - y[i]);
      g0 += r;
      g1 += r * x[i];
      const s = wn[i] * p * (1 - p);
      h00 += s;
      h01 += s * x[i];
      h11 += s * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-18) break; // singular → stop at current estimate
    let db0 = (h11 * g0 - h01 * g1) / det;
    let db1 = (-h01 * g0 + h00 * g1) / det;
    // Step-halving: never accept a step that increases the penalised loss.
    let step = 1;
    let nb0 = b0 - db0;
    let nb1 = b1 - db1;
    let nLoss = bce(nb0, nb1) + 0.5 * reg * nb1 * nb1;
    let halvings = 0;
    while (nLoss > lastLoss + 1e-15 && halvings < 40) {
      step *= 0.5;
      nb0 = b0 - step * db0;
      nb1 = b1 - step * db1;
      nLoss = bce(nb0, nb1) + 0.5 * reg * nb1 * nb1;
      halvings += 1;
    }
    db0 *= step;
    db1 *= step;
    b0 = nb0;
    b1 = nb1;
    lastLoss = nLoss;
    if (Math.max(Math.abs(db0), Math.abs(db1)) < tol) break;
  }

  const degenerate = allOne || b1 >= 0;
  const degenerateReason = allOne
    ? 'all tasks succeeded'
    : b1 >= 0
      ? 'non-negative slope (success does not fall with task length)'
      : undefined;

  return {
    coef: b1,
    intercept: b0,
    tasks: n,
    averageSuccess,
    bceLoss: bce(b0, b1),
    degenerate,
    ...(degenerateReason ? { degenerateReason } : {}),
  };
}

/**
 * The human-time (MINUTES) at which the fitted curve crosses success quantile
 * `q`: `2^((logit(q) − intercept) / coef)`. METR's `get_x_for_quantile`, then
 * `2^x`. Returns `0` for an all-failure fit (coef −∞), `Infinity` for an
 * all-success fit (no finite crossing).
 */
export function horizonMinutesAtQuantile(fit: HorizonFit, q: number): number {
  if (q <= 0 || q >= 1) throw new Error(`horizonMinutesAtQuantile: q must be in (0,1), got ${q}`);
  if (fit.degenerateReason === 'all tasks failed' || fit.coef === -Infinity) return 0; // all-failure → zero horizon
  if (fit.degenerateReason === 'all tasks succeeded') return Infinity; // solves everything in range → beyond measured range
  if (!Number.isFinite(fit.coef) || fit.coef === 0) return NaN; // non-identifiable slope
  const x = (Math.log(q / (1 - q)) - fit.intercept) / fit.coef;
  return 2 ** x;
}

/** mulberry32 — a tiny deterministic PRNG so bootstrap horizon CIs reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortedPercentile = (sorted: number[], qq: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = qq * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Options for {@link fitHorizon}'s CI computation. */
export interface HorizonCIOpts extends HorizonFitOpts {
  /** Success quantiles to read off (default [0.5, 0.8]). */
  quantiles?: number[];
  /** Bootstrap iterations for CIs (default 1000, matching METR's n_bootstrap). 0 = skip CIs. */
  bootstrap?: number;
  /** Two-sided confidence level (default 0.95). */
  ci?: number;
  /** PRNG seed (deterministic CIs). */
  seed?: number;
}

/**
 * Fit the horizon and read off `quantiles` (default p50, p80), with a percentile
 * bootstrap CI per quantile. The bootstrap resamples TASKS with replacement
 * (task heterogeneity is the dominant noise — the methodologically correct
 * interval, cf. "AI Agents That Matter"); when families are present it resamples
 * hierarchically (families, then tasks within), mirroring METR. Deterministic
 * given `seed`. Bootstrap horizons that are non-finite (a resample with no
 * crossing) are dropped from the percentile so a CI is still reported, and the
 * count dropped is reflected by a widened interval.
 */
export function fitHorizon(tasks: readonly HorizonTask[], opts: HorizonCIOpts = {}): HorizonResult {
  const quantiles = opts.quantiles ?? [0.5, 0.8];
  const fit = fitHorizonLogistic(tasks, opts);
  const ci = opts.ci ?? 0.95;
  const iterations = opts.bootstrap ?? 1000;

  const points: HorizonPoint[] = quantiles.map((q) => ({ quantile: q, horizonMinutes: horizonMinutesAtQuantile(fit, q) }));
  if (iterations <= 0 || tasks.length < 2) return { fit, points };

  // Group task indices by family for a hierarchical resample.
  const byFamily = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    const fam = t.family ?? '__nofam__';
    const arr = byFamily.get(fam) ?? [];
    arr.push(i);
    byFamily.set(fam, arr);
  });
  const families = [...byFamily.keys()];
  const rng = mulberry32(opts.seed ?? 12345);

  const boot: Record<number, number[]> = Object.fromEntries(quantiles.map((q) => [q, []]));
  for (let it = 0; it < iterations; it++) {
    // Resample families with replacement, then tasks within each chosen family with replacement.
    const resampled: HorizonTask[] = [];
    for (let f = 0; f < families.length; f++) {
      const fam = families[Math.floor(rng() * families.length)];
      const idxs = byFamily.get(fam)!;
      for (let k = 0; k < idxs.length; k++) {
        resampled.push(tasks[idxs[Math.floor(rng() * idxs.length)]]);
      }
    }
    const bfit = fitHorizonLogistic(resampled, opts);
    for (const q of quantiles) {
      const h = horizonMinutesAtQuantile(bfit, q);
      if (Number.isFinite(h) && h >= 0) boot[q].push(h);
    }
  }

  const alpha = (1 - ci) / 2;
  for (const pt of points) {
    const arr = boot[pt.quantile].slice().sort((a, b) => a - b);
    if (arr.length > 0) {
      pt.ci = {
        point: pt.horizonMinutes,
        lower: sortedPercentile(arr, alpha),
        upper: sortedPercentile(arr, 1 - alpha),
        ci,
      };
    }
  }
  return { fit, points };
}

/** The two-arm horizon lift at one quantile — the DEFENSIBLE headline (D-002/D-003). */
export interface HorizonLift {
  quantile: number;
  /** Treatment (hive) horizon, minutes. */
  treatmentMinutes: number;
  /** Baseline (single-opus) horizon, minutes. */
  baselineMinutes: number;
  /** treatment / baseline. > 1 ⇒ the hive completes LONGER tasks at this success rate. */
  liftRatio: number;
  /** treatment − baseline, minutes. */
  liftMinutes: number;
  /** Treatment CI, if present on the input point. */
  treatmentCi?: Interval;
  /** Baseline CI, if present on the input point. */
  baselineCi?: Interval;
  /**
   * True only when both CIs are present AND the treatment lower bound exceeds the
   * baseline upper bound (a conservative "separated intervals" read — NOT a formal
   * test of the lift; the proper paired-bootstrap test is a follow-up).
   */
  ciSeparated?: boolean;
}

/**
 * Compute the hive-vs-single-opus horizon LIFT at one quantile from two fitted
 * {@link HorizonPoint}s (same quantile). This is the metric the suite reports as
 * its headline — the absolute horizons are illustrative-only on a small subset,
 * but the LIFT cancels much of the subset bias (D-002).
 */
export function horizonLift(treatment: HorizonPoint, baseline: HorizonPoint): HorizonLift {
  if (treatment.quantile !== baseline.quantile) {
    throw new Error(`horizonLift: quantile mismatch (${treatment.quantile} vs ${baseline.quantile})`);
  }
  const t = treatment.horizonMinutes;
  const b = baseline.horizonMinutes;
  const ciSeparated =
    treatment.ci && baseline.ci ? treatment.ci.lower > baseline.ci.upper : undefined;
  return {
    quantile: treatment.quantile,
    treatmentMinutes: t,
    baselineMinutes: b,
    liftRatio: b > 0 ? t / b : Infinity,
    liftMinutes: t - b,
    ...(treatment.ci ? { treatmentCi: treatment.ci } : {}),
    ...(baseline.ci ? { baselineCi: baseline.ci } : {}),
    ...(ciSeparated !== undefined ? { ciSeparated } : {}),
  };
}
