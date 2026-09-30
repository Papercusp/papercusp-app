/**
 * Confidence intervals — domain-free. The impartial-benchmark-suite reports
 * "pass@1 averaged over ≥3 seeds WITH confidence intervals" because these
 * benchmarks are noisy (plan: "Statistics" + fairness trap "Noise"). Two
 * complementary intervals:
 *
 *  - `wilsonInterval` — the score interval for ONE binomial proportion. Correct
 *    near p=0/1 and for small n (where the normal approximation fails). Use for
 *    the pooled resolved-rate of an arm (all task×seed outcomes as Bernoulli).
 *  - `bootstrapMeanCI` — a percentile bootstrap over a sample of values. Use to
 *    put a CI on a per-arm mean that is itself an average of per-TASK rates,
 *    where task heterogeneity (not just within-task seed noise) is the dominant
 *    variance — the methodologically correct interval for "mean over tasks of
 *    per-task pass@1" (cf. "AI Agents That Matter", arXiv 2407.01502). It is
 *    DETERMINISTIC: seed the PRNG so a re-run reproduces the same interval.
 *
 * PAIRED designs get their own two, because using the unpaired forms on paired
 * data is a real and costly mistake — it discards the pairing and can hide an
 * effect several times larger than it can see:
 *
 *  - `pairedBootstrapCI` — resamples PAIRS (indices), not the two samples
 *    independently, so the shared per-item difficulty cancels. When the two
 *    arms correlate at rho, the sd of the difference is σ√(2(1-rho)) rather
 *    than σ√2 — at rho=0.95 that is a ~4.5x tighter interval than treating
 *    the arms as independent.
 *  - `mcnemarExact` — the paired test for BINARY outcomes, which reads only
 *    the discordant pairs (the items where the two arms disagree). Items both
 *    arms get right, or both get wrong, carry no evidence about which is
 *    better and are correctly ignored.
 *
 * Both report what an underpowered null actually means: `halfWidth` (what this
 * sample resolved) and `mde80` (the effect it would have caught 80% of the
 * time). A null without one of those beside it is indistinguishable from
 * evidence of equivalence, which is the most common way a benchmark reaches a
 * confidently wrong conclusion.
 */

export interface Interval {
  /** Point estimate the interval is centered on / drawn around. */
  point: number;
  lower: number;
  upper: number;
  /** Two-sided confidence level, e.g. 0.95. */
  ci: number;
}

/** z critical values for common two-sided confidence levels. */
const Z: Record<string, number> = {
  '0.90': 1.6448536269514722,
  '0.95': 1.959963984540054,
  '0.99': 2.5758293035489004,
};

function zFor(ci: number): number {
  const z = Z[ci.toFixed(2)];
  if (z === undefined) {
    throw new Error(`bench-metrics: unsupported ci ${ci}; use one of ${Object.keys(Z).join(', ')}`);
  }
  return z;
}

/**
 * Wilson score interval for a binomial proportion p̂ = successes / n.
 *
 *   center = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = (z / (1 + z²/n)) · √( p̂(1-p̂)/n + z²/4n² )
 *
 * `point` is the raw p̂ (not the Wilson center) so callers report the observed
 * rate; the interval bounds use the Wilson shrinkage. n=0 → a degenerate
 * [0,1] interval with point 0.
 */
export function wilsonInterval(successes: number, n: number, ci = 0.95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new Error(`wilsonInterval: successes and n must be integers (got ${successes}, ${n})`);
  }
  if (n < 0 || successes < 0 || successes > n) {
    throw new Error(`wilsonInterval: need 0 ≤ successes ≤ n (got successes=${successes}, n=${n})`);
  }
  if (n === 0) return { point: 0, lower: 0, upper: 1, ci };
  const z = zFor(ci);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    ci,
  };
}

/** Arithmetic mean and standard error of the mean (σ/√n, sample sd). */
export function meanStderr(values: readonly number[]): { mean: number; stderr: number; n: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stderr: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, stderr: 0, n: 1 };
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, stderr: Math.sqrt(variance / n), n };
}

/** mulberry32 — a tiny deterministic PRNG so bootstrap CIs are reproducible. */
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

/**
 * Percentile bootstrap CI for the MEAN of `values`. Resamples the sample with
 * replacement `iterations` times, takes the mean each time, and reads the
 * (α/2, 1-α/2) percentiles of the bootstrap distribution. Deterministic given
 * `seed`. `point` is the observed mean of `values`.
 *
 * Use this on the per-TASK pass@1 vector (one value per task) so the interval
 * reflects task-to-task variance — the dominant noise on these suites.
 */
export function bootstrapMeanCI(
  values: readonly number[],
  opts: { ci?: number; iterations?: number; seed?: number } = {},
): Interval {
  const ci = opts.ci ?? 0.95;
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 12345;
  const n = values.length;
  if (n === 0) return { point: 0, lower: 0, upper: 0, ci };
  const observed = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { point: observed, lower: observed, upper: observed, ci };

  const rng = mulberry32(seed);
  const means = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(rng() * n)];
    }
    means[it] = sum / n;
  }
  means.sort();
  const alpha = (1 - ci) / 2;
  return {
    point: observed,
    lower: percentile(means, alpha),
    upper: percentile(means, 1 - alpha),
    ci,
  };
}

/** Outcome of a paired comparison of two arms measured on the SAME items. */
export interface PairedComparison {
  /** Number of pairs. */
  n: number;
  /** Mean of the baseline arm. */
  meanA: number;
  /** Mean of the candidate arm. */
  meanB: number;
  /** CI on the DIFFERENCE (candidate − baseline); `point` is the observed delta. */
  delta: Interval;
  /**
   * Pearson correlation between the paired values. Reported rather than
   * assumed: it is what governs the interval width, so a caller can see
   * WHY the CI came out as wide as it did (and whether the pairing bought
   * anything at all — rho≈0 means it did not).
   */
  rho: number;
  /** Half-width of the delta CI — the effect size this sample could resolve. */
  halfWidth: number;
  /**
   * Smallest |delta| this design would detect 80% of the time at this ci.
   * Strictly larger than `halfWidth` (a CI that merely excludes zero is a
   * coin-flip's worth of power), and it is the number to quote beside a null:
   * "no effect detected, and we could have seen one of ±mde80".
   */
  mde80: number;
  /** True when the delta CI excludes zero at the requested confidence. */
  significant: boolean;
}

/**
 * Percentile bootstrap CI for the difference of means between two arms scored
 * on the SAME items, resampling PAIRS so the pairing is preserved.
 *
 * `a` and `b` must be index-aligned: `a[i]` and `b[i]` are the two arms' scores
 * on the same item. Deterministic given `seed`.
 */
export function pairedBootstrapCI(
  a: readonly number[],
  b: readonly number[],
  opts: { ci?: number; iterations?: number; seed?: number } = {},
): PairedComparison {
  if (a.length !== b.length) {
    throw new Error(`pairedBootstrapCI: arms must be index-aligned (got ${a.length} vs ${b.length})`);
  }
  const ci = opts.ci ?? 0.95;
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 12345;
  const n = a.length;
  if (n === 0) {
    return {
      n: 0,
      meanA: 0,
      meanB: 0,
      delta: { point: 0, lower: 0, upper: 0, ci },
      rho: 0,
      halfWidth: 0,
      mde80: 0,
      significant: false,
    };
  }
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  const observed = meanB - meanA;

  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  // Zero variance in either arm ⇒ correlation is undefined, not zero-ish; 0 is
  // the honest report (the pairing provably bought nothing).
  const rho = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;

  if (n === 1) {
    return {
      n,
      meanA,
      meanB,
      delta: { point: observed, lower: observed, upper: observed, ci },
      rho,
      halfWidth: 0,
      mde80: 0,
      significant: false,
    };
  }

  const rng = mulberry32(seed);
  const deltas = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // ONE index for both arms — this is what makes the bootstrap paired.
      const k = Math.floor(rng() * n);
      sum += b[k] - a[k];
    }
    deltas[it] = sum / n;
  }
  deltas.sort();
  const alpha = (1 - ci) / 2;
  const lower = percentile(deltas, alpha);
  const upper = percentile(deltas, 1 - alpha);

  // Bootstrap sd of the delta ≈ its standard error; power at 80% needs
  // (z_{α/2} + z_{0.80}) standard errors of separation.
  let m = 0;
  for (let i = 0; i < iterations; i++) m += deltas[i];
  m /= iterations;
  let v = 0;
  for (let i = 0; i < iterations; i++) v += (deltas[i] - m) * (deltas[i] - m);
  const stderr = Math.sqrt(v / Math.max(iterations - 1, 1));
  const Z80 = 0.8416212335729143;

  return {
    n,
    meanA,
    meanB,
    delta: { point: observed, lower, upper, ci },
    rho,
    halfWidth: (upper - lower) / 2,
    mde80: (zFor(ci) + Z80) * stderr,
    significant: lower > 0 || upper < 0,
  };
}

/** Outcome of McNemar's exact test on paired binary outcomes. */
export interface McNemarResult {
  /** Pairs where only the BASELINE succeeded. */
  onlyA: number;
  /** Pairs where only the CANDIDATE succeeded. */
  onlyB: number;
  /** Concordant pairs (both right or both wrong) — carry no evidence. */
  concordant: number;
  /** Exact two-sided binomial p-value over the discordant pairs. */
  p: number;
}

/**
 * McNemar's EXACT test for two binary arms on the same items. Exact (binomial)
 * rather than the chi-square approximation because the discordant count is
 * routinely small here, which is exactly where the approximation misleads.
 *
 * With no discordant pairs the arms are indistinguishable on this sample and
 * p = 1 — which, note, is a statement about power, not about equivalence.
 */
export function mcnemarExact(a: readonly boolean[], b: readonly boolean[]): McNemarResult {
  if (a.length !== b.length) {
    throw new Error(`mcnemarExact: arms must be index-aligned (got ${a.length} vs ${b.length})`);
  }
  let onlyA = 0;
  let onlyB = 0;
  let concordant = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) concordant++;
    else if (a[i]) onlyA++;
    else onlyB++;
  }
  const nd = onlyA + onlyB;
  if (nd === 0) return { onlyA, onlyB, concordant, p: 1 };

  // Two-sided exact binomial: 2·P(X ≤ min(onlyA,onlyB)), X ~ Bin(nd, 0.5).
  // Summed in log space — nd can exceed the range where C(nd,k) is finite.
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  let logC = 0; // log C(nd, 0) = 0
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((nd - i + 1) / i);
    tail += Math.exp(logC - nd * Math.LN2);
  }
  return { onlyA, onlyB, concordant, p: Math.min(1, 2 * tail) };
}

/** Linear-interpolated percentile of a pre-SORTED Float64Array. q ∈ [0,1]. */
function percentile(sorted: Float64Array, q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
