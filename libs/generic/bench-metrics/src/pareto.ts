/**
 * Directional Pareto frontier — domain-free. Generalizes the gym's
 * `dominates`/`paretoFrontier` (operator-core/lib/gym/frontier.ts, which assumes
 * every dimension is higher-better) to PER-DIMENSION directions, because the
 * impartial-benchmark-suite's headline frontier is cost/accuracy: accuracy is
 * higher-better but cost is LOWER-better (plan: "Report the cost/accuracy Pareto
 * — show Papercusp on a strictly better point, more resolved per dollar").
 */

/** Whether higher or lower is better for a Pareto dimension. */
export type Direction = 'max' | 'min';

/**
 * True iff `a` Pareto-dominates `b` under `directions`: a is no worse on every
 * dimension and strictly better on at least one. Vectors and directions must be
 * the same length.
 */
export function dominates(
  a: readonly number[],
  b: readonly number[],
  directions: readonly Direction[],
): boolean {
  if (a.length !== b.length || a.length !== directions.length) {
    throw new Error('dominates: vector and directions lengths must all match');
  }
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    const better = directions[i] === 'max' ? a[i] > b[i] : a[i] < b[i];
    const worse = directions[i] === 'max' ? a[i] < b[i] : a[i] > b[i];
    if (worse) return false;
    if (better) strictlyBetter = true;
  }
  return strictlyBetter;
}

/**
 * The non-dominated subset (the Pareto frontier), order-preserving. An item is
 * on the frontier iff no OTHER item dominates it. Items with identical vectors
 * are mutually non-dominating, so all copies are kept (the caller decides ties).
 */
export function paretoFrontier<T extends { vector: readonly number[] }>(
  items: readonly T[],
  directions: readonly Direction[],
): T[] {
  return items.filter((x) => !items.some((y) => y !== x && dominates(y.vector, x.vector, directions)));
}

/**
 * Convenience for the canonical 2-D cost/accuracy frontier: accuracy is
 * maximized, cost minimized. Returns the subset of points not dominated by any
 * other (cheaper-and-at-least-as-accurate, or more-accurate-and-no-dearer).
 */
export function costAccuracyFrontier<T extends { accuracy: number; cost: number }>(points: readonly T[]): T[] {
  return paretoFrontier(
    points.map((p) => ({ ...p, vector: [p.accuracy, p.cost] as const })),
    ['max', 'min'],
  ).map(({ vector: _v, ...rest }) => rest as unknown as T);
}
