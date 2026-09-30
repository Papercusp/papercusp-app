/**
 * Quality-diversity parent selection (P-011, D-008 of hive-creative-ideation).
 *
 * The baseline gym selects the next parent by *fitness headroom* alone — the
 * frontier member with the lowest train aggregate (most room to improve; see
 * `selectParent` in ./gate-engine.ts). That is pure hill-climbing: it never
 * prefers parents in under-explored regions of behaviour space, so the search
 * stays on the nearest hill.
 *
 * Novelty search / MAP-Elites (Lehman & Stanley; the quality-diversity
 * literature this plan cites) says: bias selection *partly* toward
 * distance-from-archive — parents in sparse niches — so the evolutionary rail
 * leaps and preserves stepping stones, on the same compute.
 *
 * `selectParentQD` blends the two with a single weight `noveltyWeight` (w ∈ [0,1]):
 *
 *     curiosity = (1 - w) · headroom + w · novelty
 *
 * where `headroom ∈ [0,1]` is the frontier-relative *competition rank* of
 * train-aggregate (1 at the lowest trainAgg — the member `selectParent` would
 * pick — descending to 0 at the highest) and
 * `novelty ∈ [0,1]` is the precomputed distance-from-archive (the P-010
 * ArchiveAPI's `sparseness(descriptor)` — see ./archive.ts). The most-curious
 * frontier member wins; ties break by `variantId` ascending (deterministic).
 *
 * Note on the fitness term: the blend uses *headroom* (inverse normalised
 * trainAgg), NOT raw fitness, precisely so the w=0 case reproduces the existing
 * `selectParent` "mutate the under-served member" heuristic. The plan asks to
 * select "partly for distance-from-archive … not fitness alone" — i.e. ADD
 * novelty to the existing selection, not flip its direction.
 *
 * INVARIANT (the one b6c3f's testable-invariants contract asserts): at w = 0 —
 * or whenever every member has equal novelty (empty / degenerate archive) — the
 * pick is *identical* to `selectParent`. So turning QD on can never regress the
 * existing gym behaviour unless `noveltyWeight > 0` is set explicitly.
 *
 * Pure + synchronous by design: the async `ArchiveAPI.sparseness`/`noveltyScore`
 * is gathered per frontier member at the loop layer (loop.ts), then handed here
 * as the precomputed `novelty` field. This keeps selection deterministic and
 * unit-testable with no archive, no PG, and no clock.
 */

/** A frontier member augmented with its precomputed novelty (distance-from-archive). */
export interface QdFrontierMember {
  variantId: string;
  /** Mean judge composite on the train pool — the reward (lower ⇒ more headroom). */
  trainAgg: number;
  /**
   * Precomputed distance-from-archive in [0,1] (the ArchiveAPI's
   * `sparseness(descriptor)`); higher ⇒ in a more under-explored region. Values
   * outside [0,1] are clamped at selection time.
   */
  novelty: number;
}

export interface QdSelectionConfig {
  /**
   * Novelty weight w ∈ [0,1]. 0 ⇒ pure fitness-headroom (≡ `selectParent`);
   * 1 ⇒ pure novelty search. Values outside [0,1] are clamped.
   */
  noveltyWeight: number;
}

/** Clamp to the closed unit interval. */
function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Frontier-relative headroom score in [0,1] via *competition rank* of trainAgg:
 * 1 at the lowest trainAgg (most headroom — the `selectParent` pick), descending
 * to 0 at the highest. A member's rank is the count of strictly-lower members,
 * so equal trainAggs share a headroom (the worst tier all gets 1; the
 * `variantId` tie-break then decides among them, exactly like `selectParent`).
 *
 * Why rank, not min-max normalisation `1 - (trainAgg-min)/range`: the latter
 * subtracts then divides, so two distinct-but-close trainAggs can collapse to
 * the same float (FP underflow relative to a wide range) and reorder the pick —
 * which silently breaks the w=0 ≡ selectParent invariant. Competition rank uses
 * only comparisons, so distinct trainAgg ⇒ distinct headroom, always. It is also
 * outlier-robust: one extreme-fitness member no longer squashes everyone else's
 * headroom signal in the blend.
 */
function headroomScores(members: readonly QdFrontierMember[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = members.length;
  if (n === 1) {
    out.set(members[0]!.variantId, 1);
    return out;
  }
  for (const m of members) {
    let strictlyLower = 0;
    for (const other of members) {
      if (other.trainAgg < m.trainAgg) strictlyLower++;
    }
    // strictlyLower=0 (lowest tier) ⇒ 1; =n-1 (unique max) ⇒ 0. Integer ratio,
    // so distinct ranks map to distinct floats (no normalisation collapse).
    out.set(m.variantId, (n - 1 - strictlyLower) / (n - 1));
  }
  return out;
}

/**
 * Select the next parent from the frontier by blending fitness-headroom with
 * novelty (P-011). Returns null for an empty frontier. Deterministic: ties on
 * the blended curiosity score break by `variantId` ascending.
 *
 * At `noveltyWeight === 0` this is identical to `selectParent` (headroom-only,
 * same tie-break) — see the module invariant.
 */
export function selectParentQD<T extends QdFrontierMember>(
  frontier: readonly T[],
  config: QdSelectionConfig,
): T | null {
  if (frontier.length === 0) return null;
  const w = clamp01(config.noveltyWeight);
  const headroom = headroomScores(frontier);
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const m of frontier) {
    const score = (1 - w) * headroom.get(m.variantId)! + w * clamp01(m.novelty);
    if (best === null || score > bestScore || (score === bestScore && m.variantId < best.variantId)) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}
