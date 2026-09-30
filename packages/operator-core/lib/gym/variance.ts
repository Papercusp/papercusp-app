/**
 * Variance + threshold derivation (P-025 / D-013).
 *
 * The gym is doubly-stochastic (the pipeline AND the judge), so accept thresholds
 * ε/δ and a minimum repeat count are DERIVED from measured judge-composite variance
 * (at the P-014 milestone), not guessed. Pure stats; P-014 feeds in real measurements
 * and P-025 promotes repeats-per-task into v1 if 1-run proves too noisy.
 */

export interface Stats {
  mean: number;
  /** Population standard deviation. */
  sd: number;
  n: number;
}

export function meanStdDev(values: readonly number[]): Stats {
  const n = values.length;
  if (n === 0) return { mean: 0, sd: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

export interface DeriveOpts {
  /** ε/δ = sigmaMultiple × SD (margin above the noise floor). */
  sigmaMultiple: number;
  /** Min repeats so the standard error sd/√n ≤ this. */
  targetStandardError: number;
}

export interface DerivedThresholds {
  epsilon: number;
  delta: number;
  minRepeats: number;
}

export function deriveThresholds(sd: number, opts: DeriveOpts): DerivedThresholds {
  const margin = opts.sigmaMultiple * sd;
  // sd/√n ≤ targetSE  ⇒  n ≥ (sd/targetSE)^2
  const minRepeats =
    sd <= 0 || opts.targetStandardError <= 0 ? 1 : Math.max(1, Math.ceil((sd / opts.targetStandardError) ** 2));
  return { epsilon: margin, delta: margin, minRepeats };
}

/** Summarize a task's repeat composites. */
export function aggregateRepeats(composites: readonly number[]): Stats {
  return meanStdDev(composites);
}
