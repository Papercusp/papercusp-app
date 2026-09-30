/**
 * The shared eval-harness metric contract — so Restart and Papercusp measure
 * relevance the SAME way. These are the exact formulas behind Restart's
 * `scripts/search-eval/run-eval.ts` headline numbers (nDCG@10, P@5, accessory@5).
 *
 * Inputs are per-result graded relevance (a 0..3 LLM/human judgment, like the
 * harness), in the order the results were returned. All functions are pure.
 */

/** Discounted cumulative gain: Σ (2^gᵢ − 1) / log₂(i + 2). */
export function dcg(grades: number[]): number {
  return grades.reduce((s, gi, i) => s + (Math.pow(2, gi) - 1) / Math.log2(i + 2), 0);
}

/**
 * Normalized DCG over the full graded list (ideal = the same grades sorted
 * best-first). 0 when the ideal DCG is 0. This is the harness's `ndcg(grades)`.
 */
export function ndcg(grades: number[]): number {
  const ideal = [...grades].sort((a, b) => b - a);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(grades) / idcg;
}

/** nDCG truncated to the top `k` returned results (default 10 → "nDCG@10"). */
export function ndcgAtK(grades: number[], k = 10): number {
  return ndcg(grades.slice(0, k));
}

/**
 * Precision@k: fraction of the top `k` results that are relevant
 * (grade ≥ `threshold`). The harness's P@5 = precisionAtK(grades, 5, 2).
 */
export function precisionAtK(grades: number[], k = 5, threshold = 2): number {
  const top = grades.slice(0, k);
  return top.length ? top.filter((g) => g >= threshold).length / top.length : 0;
}

/**
 * Accessory/pollution count: how many of the top `k` are parts/irrelevant
 * (grade ≤ `threshold`). Catches accessories surfacing at #3–5 — invisible to
 * aggregate nDCG and a top-1-only guardrail. The harness's acc@5 =
 * accessoryAtK(grades, 5, 1); ≥ 2 flags a "polluted" query.
 */
export function accessoryAtK(grades: number[], k = 5, threshold = 1): number {
  return grades.slice(0, k).filter((g) => g <= threshold).length;
}
