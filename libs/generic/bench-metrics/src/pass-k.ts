/**
 * Unbiased pass@k and pass^k estimators over a set of independent Bernoulli
 * attempts. Domain-free — no benchmark/schema coupling. Given `n` independent
 * samples of one task of which `c` resolved, these estimate the metrics you'd
 * get from a much larger sample, with no schema dependency.
 *
 * pass@k  — probability that AT LEAST ONE of k samples resolves (success metric).
 * pass^k  — probability that ALL of k samples resolve (reliability/consistency).
 *
 * References: Chen et al. 2021 (HumanEval, the numerically-stable pass@k);
 * "Large Language Monkeys" (Brown et al. 2024, arXiv 2407.21787, repeated
 * sampling); the impartial-benchmark-suite plan's "same pass@k protocol across
 * arms" + "pass^k if reliability is part of the story".
 */

/**
 * Unbiased estimator of pass@k from `n` samples of which `c` resolved.
 *
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 *
 * computed in the numerically-stable product form (never builds a binomial
 * coefficient, so it is exact for large n):
 *
 *   pass@k = 1 - Π_{i=n-c+1..n} (1 - k/i)
 *
 * @param n total independent samples for the task (must be ≥ k)
 * @param c number of those samples that resolved (0 ≤ c ≤ n)
 * @param k the k in pass@k (k ≥ 1)
 */
export function passAtK(n: number, c: number, k: number): number {
  assertSampleArgs(n, c, k);
  // If fewer than k samples failed, every size-k subset contains a success.
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) {
    prod *= 1 - k / i;
  }
  return 1 - prod;
}

/**
 * Unbiased estimator of pass^k — the probability that a uniformly random
 * size-k subset of the n samples is ALL successes (reliability):
 *
 *   pass^k = C(c, k) / C(n, k) = Π_{i=0..k-1} (c - i) / (n - i)
 *
 * Returns 0 when c < k (you cannot draw k successes). This is the natural
 * counterpart to pass@k for "does the system succeed CONSISTENTLY, not just
 * once-in-k", per the plan's pass^k note.
 */
export function passHatK(n: number, c: number, k: number): number {
  assertSampleArgs(n, c, k);
  if (c < k) return 0;
  let prod = 1;
  for (let i = 0; i < k; i++) {
    prod *= (c - i) / (n - i);
  }
  return prod;
}

function assertSampleArgs(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) {
    throw new Error(`pass@k: n, c, k must be integers (got n=${n}, c=${c}, k=${k})`);
  }
  if (k < 1) throw new Error(`pass@k: k must be ≥ 1 (got ${k})`);
  if (n < k) throw new Error(`pass@k: need at least k samples (n=${n} < k=${k})`);
  if (c < 0 || c > n) throw new Error(`pass@k: c must be in [0, n] (got c=${c}, n=${n})`);
}

/**
 * Mean pass@k across many tasks — the per-arm headline at a given k. Each task
 * contributes its own (n_i, c_i); the estimate is the simple average of the
 * per-task pass@k (every task weighted equally, the SWE-bench convention).
 *
 * Tasks with fewer than k samples are SKIPPED (cannot estimate pass@k) and
 * reported via `skipped` so a caller never silently averages over a shrinking
 * denominator — surface it.
 */
export function meanPassAtK(
  tasks: ReadonlyArray<{ n: number; c: number }>,
  k: number,
): { value: number; tasksUsed: number; skipped: number } {
  let sum = 0;
  let used = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (t.n < k) {
      skipped++;
      continue;
    }
    sum += passAtK(t.n, t.c, k);
    used++;
  }
  return { value: used === 0 ? 0 : sum / used, tasksUsed: used, skipped };
}
