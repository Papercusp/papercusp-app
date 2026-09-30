/**
 * Reciprocal Rank Fusion — combines multiple ranked lists without
 * requiring score normalization between rankers. score(d) = Σ 1/(k+rank).
 * Pure function; unit-testable without DB.
 */

export interface RankedItem<T> {
  /** Stable identity across rankers — used to merge across lists. */
  key: string;
  /** Ranker-native score; not used by RRF, kept for inspection. */
  score: number;
  /** Whatever payload callers want to carry through. */
  row: T;
}

export interface FusedItem<T> {
  row: T;
  /** Sum of RRF contributions across all rankers that found the item. */
  score: number;
  /** Names of rankers that returned this item, in insertion order. */
  rankers: string[];
}

export const RRF_K_DEFAULT = 60;

export function rrfCombine<T>(
  inputs: Array<{
    name: string;
    list: Array<RankedItem<T>>;
    /**
     * Rank at which this list's positions START, for a list that is a
     * CONTINUATION of another ranking rather than a ranking in its own right.
     *
     * RRF derives a contribution purely from a row's INDEX WITHIN ITS OWN
     * LIST, which silently assumes every list ranks the same field over the
     * same population. A list built by re-querying a NARROWER population (a
     * time window, a shard) breaks that assumption: its rows were already
     * beaten by the main list, yet re-indexing them from 0 hands its best row
     * `1/(k+1)` — the exact contribution the single best row in the whole
     * corpus receives. Offsetting by the length of the list it continues puts
     * those rows where they actually stand, so such a leg can widen the
     * candidate pool (its purpose) without inflating relevance.
     *
     * Omitted / 0 ⇒ unchanged behaviour: an independent ranking starts at 0.
     */
    rankOffset?: number;
  }>,
  k = RRF_K_DEFAULT,
): Array<FusedItem<T>> {
  const acc = new Map<string, { row: T; score: number; rankers: string[] }>();
  for (const { name, list, rankOffset } of inputs) {
    const offset = rankOffset && rankOffset > 0 ? rankOffset : 0;
    list.forEach((entry, idx) => {
      const rrf = 1 / (k + offset + idx + 1);
      const existing = acc.get(entry.key);
      if (existing) {
        existing.score += rrf;
        if (!existing.rankers.includes(name)) existing.rankers.push(name);
      } else {
        acc.set(entry.key, { row: entry.row, score: rrf, rankers: [name] });
      }
    });
  }
  return Array.from(acc.values()).sort((a, b) => b.score - a.score);
}
