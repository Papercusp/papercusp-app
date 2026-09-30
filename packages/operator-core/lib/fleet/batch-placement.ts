/**
 * fleet/batch-placement — the PURE one-wake batch planner for the Queen
 * (queen-autonomous-execution-2026-06-13, B-07 / P-001).
 *
 * Turns the Queen's SERIAL "for each ready task pick placement" loop into a
 * single batch: given the ranked ready frontier (importance order — the Queen /
 * B-08 supply it), the live bees, and the free-slot headroom, decide a placement
 * for each task in ONE pass —
 *
 *   warm-inject (affinity) → fresh spawn (free slot) → unplaced (queue back)
 *
 * — the queen.md ladder, minus EVICT (a judgment + drain-coordination call left
 * to the Queen). The planner is pure: side-effect execution (spawn, claim,
 * reorder, coord-wake) lives in the fleet:place_batch tool, which feeds this its
 * gathered inputs and acts on the returned decisions.
 *
 * Affinity scoring is delegated to placement-affinity.ts (P-002).
 */
import {
  rankBeesForTask,
  type AffinityKind,
  type AffinityScore,
  type AffinityWeights,
  type PlacementBee,
  type PlacementTask,
} from './placement-affinity';

export type Disposition = 'warm-inject' | 'spawn' | 'unplaced';

export interface PlacementDecision {
  task: PlacementTask;
  disposition: Disposition;
  /** Target bee ownerId — set for warm-inject. */
  bee?: string;
  /** The chosen affinity score — set for warm-inject. */
  affinity?: AffinityScore;
  /** 0-based rank to inject at within the bee's work-list (head-of-line region). */
  rank?: number;
  /** Short why for this disposition. */
  reason: string;
}

export interface BatchPlacementInput {
  /** Ready frontier in IMPORTANCE order (index 0 = highest). */
  tasks: PlacementTask[];
  /** Live bees (the tool filters to role='bee' before mapping). */
  bees?: PlacementBee[];
  /** WI-3920: post-bee→cup-lexicon-rename alias for `bees` (mid-flight rename,
   *  owned by the cup-lexicon-rename effort — this planner accepts either key
   *  rather than forcing every caller/fixture to update in lockstep). When both
   *  are supplied, `bees` wins. */
  cups?: PlacementBee[];
  /** Free concurrency slots = the fresh-spawn budget (getSpawnHeadroom). */
  headroom: number;
  /** Hard cap on TOTAL placements this batch. Default = tasks.length. */
  max?: number;
  /** A bee whose projected load reaches this is no longer a warm-inject target. Default 3. */
  injectLoadThreshold?: number;
  /** Minimum affinity score to PREFER a warm-inject over a fresh spawn. Default 1
   *  (≈ one fully-fired low-tier signal, e.g. same-harness queue-similarity, or any
   *  stronger signal) — below it, a fresh spawn is preferred when headroom exists. */
  minInjectAffinity?: number;
  /** Max items to warm-inject onto a SINGLE bee in one batch. Default 2. */
  maxInjectPerBee?: number;
  weights?: AffinityWeights;
  /** The hive blueprint's `affinity.kind` (hive-blueprint-generalization P-011) — selects
   *  the weight preset (file-overlap = coding default; topic/entity for a generic hive).
   *  An explicit `weights` still wins. The fleet:place_batch tool reads it from the hive
   *  blueprint config. */
  affinityKind?: AffinityKind;
  /** Injected clock for the recency signal (epoch ms). */
  now?: number;
}

export interface BatchPlacementPlan {
  decisions: PlacementDecision[];
  spawnCount: number;
  injectCount: number;
  unplacedCount: number;
  /** Projected per-bee work-item load AFTER the batch (ownerId → load). */
  projectedLoad: Record<string, number>;
  /** Fresh-spawn slots still free after the batch. */
  remainingHeadroom: number;
}

const DEFAULT_INJECT_LOAD_THRESHOLD = 3;
const DEFAULT_MIN_INJECT_AFFINITY = 1;
const DEFAULT_MAX_INJECT_PER_BEE = 2;

/**
 * Plan a batch of placements. Walks the frontier in importance order; for each
 * task picks the cheapest viable rung:
 *
 *  1. warm-inject onto the best-affinity live bee that (a) scores ≥
 *     minInjectAffinity, (b) is below the load threshold counting THIS batch's
 *     injects, and (c) is under the per-bee inject cap;
 *  2. else a fresh spawn while headroom remains;
 *  3. else unplaced — it stays on the frontier for the next wake.
 *
 * Bounded by `max` total placements. Deterministic for a fixed `now`.
 */
export function planBatchPlacement(input: BatchPlacementInput): BatchPlacementPlan {
  const injectLoadThreshold = input.injectLoadThreshold ?? DEFAULT_INJECT_LOAD_THRESHOLD;
  const minInjectAffinity = input.minInjectAffinity ?? DEFAULT_MIN_INJECT_AFFINITY;
  const maxInjectPerBee = input.maxInjectPerBee ?? DEFAULT_MAX_INJECT_PER_BEE;
  const max = input.max ?? input.tasks.length;
  // WI-3920: accept either `bees` (current production callers) or `cups`
  // (post-rename test fixtures / future callers) — see BatchPlacementInput.
  const bees = input.bees ?? input.cups ?? [];

  // Live projected load + per-bee injects accrued during this batch, so the
  // second inject onto a bee sees the first (no over-stuffing a warm bee).
  const projectedLoad: Record<string, number> = {};
  for (const b of bees) projectedLoad[b.ownerId] = b.load;
  const injectsOnBee = new Map<string, number>();

  let remainingHeadroom = Math.max(0, input.headroom);
  let placed = 0;
  const decisions: PlacementDecision[] = [];

  for (const task of input.tasks) {
    if (placed >= max) {
      decisions.push({ task, disposition: 'unplaced', reason: `batch cap reached (max ${max})` });
      continue;
    }

    // 1. Best warm-inject candidate: highest affinity with headroom in its list.
    const ranked = rankBeesForTask(task, bees, {
      weights: input.weights,
      affinityKind: input.affinityKind,
      now: input.now,
    });
    const best = ranked.find((s) => {
      if (s.score < minInjectAffinity) return false;
      const load = projectedLoad[s.bee] ?? 0;
      if (load >= injectLoadThreshold) return false;
      if ((injectsOnBee.get(s.bee) ?? 0) >= maxInjectPerBee) return false;
      return true;
    });

    if (best) {
      const priorInjects = injectsOnBee.get(best.bee) ?? 0;
      decisions.push({
        task,
        disposition: 'warm-inject',
        bee: best.bee,
        affinity: best,
        // Head-of-line region: this bee's Nth batch-inject lands at rank N.
        rank: priorInjects,
        reason: `warm-inject → ${best.bee} (${best.reasons.join(', ') || 'affinity'})`,
      });
      projectedLoad[best.bee] = (projectedLoad[best.bee] ?? 0) + 1;
      injectsOnBee.set(best.bee, priorInjects + 1);
      placed++;
      continue;
    }

    // 2. Fresh spawn while slots remain.
    if (remainingHeadroom > 0) {
      decisions.push({
        task,
        disposition: 'spawn',
        reason: ranked.length === 0 ? 'fresh spawn (no live bees)' : 'fresh spawn (no warm bee with headroom)',
      });
      remainingHeadroom--;
      placed++;
      continue;
    }

    // 3. Nothing left — queue it back to the frontier.
    decisions.push({
      task,
      disposition: 'unplaced',
      reason: 'no headroom and no warm bee with capacity — queued back to the frontier',
    });
  }

  const spawnCount = decisions.filter((d) => d.disposition === 'spawn').length;
  const injectCount = decisions.filter((d) => d.disposition === 'warm-inject').length;
  const unplacedCount = decisions.filter((d) => d.disposition === 'unplaced').length;
  return { decisions, spawnCount, injectCount, unplacedCount, projectedLoad, remainingHeadroom };
}
