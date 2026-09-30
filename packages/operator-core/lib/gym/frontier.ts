/**
 * Three-tier state selection (P-019, D-005).
 *
 * The Pareto FRONTIER over per-task-category train vectors drives parent selection,
 * so diversity isn't collapsed to a single scalar (GEPA's load-bearing idea, D-007).
 * The CHAMPION is the single best on the FROZEN dev-anchor (apples-to-apples vs the
 * baseline-of-record). The third tier (promotion target = the dedicated gym harness's
 * overrides) is handled by the promotion step (P-020). Pure selection logic.
 */

/** True iff `a` Pareto-dominates `b`: ≥ on every component and > on at least one. */
export function dominates(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) throw new Error('dominates: vectors must be the same length');
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return false;
    if (a[i] > b[i]) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** The non-dominated subset (the Pareto frontier). Order-preserving. */
export function paretoFrontier<T extends { vector: readonly number[] }>(items: readonly T[]): T[] {
  return items.filter((x) => !items.some((y) => y !== x && dominates(y.vector, x.vector)));
}

/** The id with the highest dev-anchor aggregate; ties broken by id ascending. Null if empty. */
export function selectChampion<T extends { id: string; devAnchorAgg: number }>(items: readonly T[]): string | null {
  let best: T | null = null;
  for (const it of items) {
    if (
      best === null ||
      it.devAnchorAgg > best.devAnchorAgg ||
      (it.devAnchorAgg === best.devAnchorAgg && it.id < best.id)
    ) {
      best = it;
    }
  }
  return best?.id ?? null;
}
