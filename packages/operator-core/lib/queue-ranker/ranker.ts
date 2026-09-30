/**
 * queue-ranker — THE one ranking pipeline for attention queues
 * (self-learning-frontier-2026-06-12 P-040 / FB-12, enforcing D-005).
 *
 * Every economic signal that wants to influence a queue's order lands here as
 * a NAMED FEATURE with an inspectable weight — never as an independent
 * re-ranker layered on top. The score of a ranked item is a plain weighted
 * sum, and every item carries its full per-feature breakdown, so "why does
 * this rank here?" is always answerable from the data itself:
 *
 *   score(item) = Σ feature.weight × feature.value(item)
 *
 * Feature #1 is consume-edges B-08's blocking-impact module
 * (blocking-impact-feature.ts — consumed, not rebuilt). Calibration (P-041),
 * deferral interest (P-042), and the owner preference model (P-043) land as
 * further features in the registry, weights tunable from evidence.
 *
 * The core is domain-free on purpose (generic over the item + context types):
 * a future queue (work-item triage, plan attention) reuses it by assembling
 * its own feature registry — and it lifts to libs/generic/ cleanly if a
 * second domain materialises.
 *
 * Failure semantics (the Learning tab must never 500 because one signal
 * source hiccuped): a feature whose `score` throws degrades to a zero
 * contribution for the whole queue — the remaining features still rank.
 */

/** One feature's per-item output. */
export interface FeatureValue {
  /** The raw feature value (pre-weight). May be negative (a demoting signal). */
  value: number;
  /** Human-readable "why" lines this feature contributes to the item. */
  reasons?: readonly string[];
  /** Extra fields merged onto the ranked item (e.g. blocking-impact attaches
   *  its full `impact` struct for existing consumers). Keys must not collide
   *  across features — prefer one namespaced key per feature. */
  attach?: Record<string, unknown>;
}

/**
 * A named, weighted ranking feature. `score` is batch-shaped on purpose:
 * features typically need one IO pass over the whole queue (link degrees,
 * calibration tables), never per-item IO.
 */
export interface QueueFeature<TItem, TCtx> {
  /** Stable kebab-case identity — what the breakdown + any UI names. */
  name: string;
  /** Multiplier applied to the feature's value. An exported tunable. */
  weight: number;
  /** One line: what this feature measures. */
  description: string;
  /**
   * Score the whole queue. Returns per-item values keyed by the ranker's
   * `getKey`; a missing key reads as value 0. IO inside must degrade
   * gracefully (catch + warn) when partial signal is better than none.
   */
  score: (
    items: readonly TItem[],
    ctx: TCtx,
  ) => Promise<ReadonlyMap<string, FeatureValue>> | ReadonlyMap<string, FeatureValue>;
}

/** One feature's share of an item's score — the inspectable unit. */
export interface FeatureContribution {
  feature: string;
  value: number;
  weight: number;
  /** value × weight — the number that actually moved the rank. */
  contribution: number;
  reasons: string[];
}

/** The full explanation of one ranked item's position. */
export interface RankBreakdown {
  /** Σ contributions. Higher = attend sooner. */
  score: number;
  /** Every REGISTERED feature, in registry order — zero contributions
   *  included, so the shape is stable and "feature X saw nothing" is visible. */
  features: FeatureContribution[];
}

export type Ranked<TItem> = TItem & { rank: RankBreakdown };

export interface RankQueueOptions<TItem, TCtx> {
  features: readonly QueueFeature<TItem, TCtx>[];
  /** Stable per-item key the feature maps are joined on (usually the id). */
  getKey: (item: TItem) => string;
  /**
   * Deterministic ordering among equal scores (e.g. prior triage score, then
   * id). Without one, ties keep input order (Array#sort is stable).
   */
  tieBreak?: (a: TItem, b: TItem) => number;
}

/** The registry view — every feature's name/weight/description as data. */
export function describeFeatures<TItem, TCtx>(
  features: readonly QueueFeature<TItem, TCtx>[],
): Array<{ name: string; weight: number; description: string }> {
  return features.map((f) => ({ name: f.name, weight: f.weight, description: f.description }));
}

/**
 * Rank a queue: batch-score every feature, join per item, sort by the
 * weighted sum (descending). Deterministic given inputs and feature outputs.
 */
export async function rankQueue<TItem, TCtx>(
  items: readonly TItem[],
  ctx: TCtx,
  opts: RankQueueOptions<TItem, TCtx>,
): Promise<Ranked<TItem>[]> {
  if (items.length === 0) return [];

  const valueMaps: ReadonlyMap<string, FeatureValue>[] = [];
  for (const feature of opts.features) {
    try {
      valueMaps.push(await feature.score(items, ctx));
    } catch (err) {
      console.warn(
        `[queue-ranker] feature "${feature.name}" failed — contributing 0 for this pass:`,
        err instanceof Error ? err.message : err,
      );
      valueMaps.push(new Map());
    }
  }

  const ranked = items.map<Ranked<TItem>>((item) => {
    const key = opts.getKey(item);
    let score = 0;
    const attaches: Record<string, unknown>[] = [];
    const features = opts.features.map<FeatureContribution>((feature, fi) => {
      const v = valueMaps[fi].get(key) ?? { value: 0 };
      const contribution = v.value * feature.weight;
      score += contribution;
      if (v.attach) attaches.push(v.attach);
      return {
        feature: feature.name,
        value: v.value,
        weight: feature.weight,
        contribution,
        reasons: v.reasons ? [...v.reasons] : [],
      };
    });
    return Object.assign({}, item, ...attaches, { rank: { score, features } satisfies RankBreakdown });
  });

  return ranked.sort((a, b) => b.rank.score - a.rank.score || (opts.tieBreak?.(a, b) ?? 0));
}
