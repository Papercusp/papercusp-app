/**
 * Pure verdict logic for the P-008 rerank-reach measurement
 * (`corpus-rerank-reach-cli.ts` — see that file's header for what is measured
 * and why). Split out for the reason the sibling `paired-leg-report.ts` is:
 * the CLI half talks to Postgres and the search engine, so nothing in it can be
 * unit-tested, and these two functions are where the run's CONCLUSIONS are
 * formed.
 *
 * ⚠ BOTH FUNCTIONS EXIST BECAUSE THEY SHIPPED WRONG FIRST, and each produced a
 * confident, well-formed, WRONG conclusion rather than an obvious failure —
 * the expensive shape. They are unit-tested (`corpus-rerank-reach.test.ts`)
 * with controls that fail against the earlier, narrower rules:
 *
 *   1. `confined` was reported whenever the top agreement tier filled the page,
 *      WITHOUT requiring a second tier to exist. In the BM25-only arm — which
 *      is single-tier by construction, since no embedder means every hit is
 *      1-ranker — that made "the reranker is locked out of lower-tier hits"
 *      read 47.4% when the true answer is 0% by construction: there IS no lower
 *      tier to be locked out of.
 *
 *   2. The sensitivity verdict was thresholded on the pooled rate with no
 *      reference to tier structure, so the BM25-only arm's HIGH sensitivity
 *      printed "this FALSIFIES the reach-ceiling concern" — exactly backwards.
 *      That arm cannot exhibit the override at all; its high sensitivity is the
 *      CONTROL confirming pool order reaches the page when nothing outranks it.
 *
 * The common root, worth stating because it generalises past this file: a
 * statistic was reported over a population that could not, even in principle,
 * exhibit the effect being measured. Condition the verdict on whether the
 * effect is REACHABLE in the sample, never on the statistic alone.
 */

/** Survivor tier structure for one query. */
export interface TierShape {
  /** survivor count by `rankers.length`, e.g. { 1: 9, 2: 4 }. */
  tiers: Record<number, number>;
  /** Size of the highest agreement tier. */
  topTierSize: number;
  /** Every survivor has the same ranker count ⇒ agreement cannot outrank anything. */
  singleTier: boolean;
  /**
   * The top tier alone fills the page, so no lower-tier hit is reachable at any
   * rerank score. REQUIRES ≥2 tiers — see hazard 1 in the header.
   */
  confined: boolean;
}

/**
 * Bucket survivors by agreement (`rankers.length`) and derive the reach shape.
 *
 * `pageSize` is the leg's admitted cap (`CORPUS_MAX_ITEMS`), passed rather than
 * imported so the confinement rule is testable at any page size.
 */
export function tierShape(
  rankerCounts: readonly number[],
  pageSize: number,
): TierShape {
  const tiers: Record<number, number> = {};
  for (const raw of rankerCounts) {
    const n = raw > 0 ? raw : 1;
    tiers[n] = (tiers[n] ?? 0) + 1;
  }
  const keys = Object.keys(tiers).map(Number).sort((a, b) => b - a);
  const topTierSize = keys.length ? tiers[keys[0]] : 0;
  return {
    tiers,
    topTierSize,
    singleTier: keys.length <= 1,
    // ⚠ `keys.length > 1` is load-bearing, not defensive — see hazard 1.
    confined: keys.length > 1 && topTierSize >= pageSize,
  };
}

export type SensitivityVerdict = 'not-a-test' | 'low' | 'high';

/**
 * What the permutation sensitivity means, given how much of the sample could
 * exhibit the override at all.
 *
 * `multiTierCount` is the number of queries with ≥2 agreement tiers — the ONLY
 * queries where agreement can outrank array order. When it is zero the run is
 * structurally incapable of testing the effect and NO rate, however extreme,
 * licenses a verdict about it (hazard 2).
 *
 * `multiTierTop1Rate` is the top-1 change rate restricted to those queries —
 * never the pooled rate, which single-tier queries dominate and inflate.
 */
export function sensitivityVerdict(
  multiTierCount: number,
  multiTierTop1Rate: number,
  lowThreshold = 0.25,
): SensitivityVerdict {
  if (multiTierCount <= 0) return 'not-a-test';
  return multiTierTop1Rate < lowThreshold ? 'low' : 'high';
}
