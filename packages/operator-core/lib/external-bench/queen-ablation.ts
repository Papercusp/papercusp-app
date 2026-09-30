/**
 * `planFifoPlacement` (P-023 / BRIEF 4, su-136a4) — the QUEEN-ABLATION placement planner for the
 * impartial benchmark suite's fleet layer (`impartial-benchmark-suite-2026-06-15`, Phase 5 / D-010).
 *
 * THE NEW HEADLINE BASELINE. It is the deliberate naive-scheduler ABLATION of the Queen's real
 * placement planner ({@link planBatchPlacement} in ../fleet/batch-placement.ts): a drop-in with the
 * IDENTICAL input/output shape ({@link BatchPlacementInput} → {@link BatchPlacementPlan}) and the
 * identical queue mechanics (free-slot headroom, per-bee load threshold + inject cap, the
 * spawn / warm-inject / unplaced disposition vocab) — so the fleet driver (P-022, su-1226c) swaps ONE
 * function and nothing else. The hive arm runs `planBatchPlacement`; the queen-ablated arm runs this.
 *
 * What the Queen does that THIS deliberately does NOT (the ablated intelligence — the delta IS the
 * Queen's value, the D-002→D-010 headline):
 *   - IMPORTANCE RANKING — the Queen consumes the frontier in importance order; FIFO consumes tasks
 *     in the order given (the driver feeds the queen-ablated arm the BACKLOG/arrival order, un-ranked).
 *   - AFFINITY ROUTING — the Queen warm-injects onto the BEST-AFFINITY bee (explicit-intent >
 *     file-overlap > recency > queue-similarity); FIFO picks the LEAST-LOADED live bee, round-robin,
 *     with NO affinity scoring (`affinity`/`rank`-by-fit are never set).
 *   - SITUATIONAL BRIEFS — the Queen attaches a per-lane brief; FIFO attaches none.
 *   - EVICTION / RE-PLACEMENT / ADAPTATION — out of scope for both planners (a Queen judgment call),
 *     so neither plans it; the ablation's lack of it is inherent to having no Queen agent at all.
 *
 * Everything else is held IDENTICAL to the hive arm (same bee fleet, same per-task `external-bench`
 * unit the bees run, same fleet size, same iso-budget, same backlog, same grader) so the hive−ablation
 * delta is attributable to the Queen's coordination intelligence and nothing else (D-004 fairness).
 *
 * Anti-strawman (METR — applies to baselines too): this is NOT a crippled scheduler. It keeps the
 * fleet busy with the SAME queue depth the Queen gets (it fills the pool with fresh spawns, then
 * round-robins onto under-capacity bees up to the same caps) — it just lacks the Queen's judgment
 * about WHICH task goes WHERE and in WHAT ORDER. A standard FIFO work-pool, no more, no less.
 *
 * PURE + deterministic (ties broken by ownerId; no wall clock, no affinity, no `now`) — unit-testable
 * standalone, exactly like `planBatchPlacement`.
 */
import {
  type BatchPlacementInput,
  type BatchPlacementPlan,
  type PlacementDecision,
} from '../fleet/batch-placement';

const DEFAULT_INJECT_LOAD_THRESHOLD = 3;
const DEFAULT_MAX_INJECT_PER_BEE = 2;

/**
 * Plan a batch of placements with a NAIVE FIFO / round-robin policy — the Queen-ablation.
 *
 * Walks `input.tasks` in the order given (FIFO — the caller supplies backlog/arrival order, NOT
 * importance order). For each task picks the cheapest rung, matching the Queen's queue mechanics but
 * with zero placement intelligence:
 *   1. fresh SPAWN while free-slot headroom remains (fill the pool to the fleet size first);
 *   2. else round-robin WARM-INJECT onto the LEAST-LOADED live, under-capacity bee (NO affinity);
 *   3. else UNPLACED — queued back to the backlog for the next wake (a bee frees → re-planned).
 *
 * Deterministic for fixed inputs. Mirror of {@link planBatchPlacement} — diff the two to confirm the
 * ONLY change is the decision policy (importance+affinity → FIFO+round-robin).
 */
export function planFifoPlacement(input: BatchPlacementInput): BatchPlacementPlan {
  const injectLoadThreshold = input.injectLoadThreshold ?? DEFAULT_INJECT_LOAD_THRESHOLD;
  const maxInjectPerBee = input.maxInjectPerBee ?? DEFAULT_MAX_INJECT_PER_BEE;
  const max = input.max ?? input.tasks.length;

  // Projected per-bee load + per-bee injects accrued this batch (same bookkeeping as the Queen
  // planner), so round-robin spreads evenly and respects the caps.
  const projectedLoad: Record<string, number> = {};
  for (const b of input.bees) projectedLoad[b.ownerId] = b.load;
  const injectsOnBee = new Map<string, number>();

  let remainingHeadroom = Math.max(0, input.headroom);
  let placed = 0;
  const decisions: PlacementDecision[] = [];

  for (const task of input.tasks) {
    if (placed >= max) {
      decisions.push({ task, disposition: 'unplaced', reason: `batch cap reached (max ${max})` });
      continue;
    }

    // 1. Fill the pool first: a fresh spawn while slots remain (naive — reach the fleet size before
    //    reusing bees; no affinity choice involved).
    if (remainingHeadroom > 0) {
      decisions.push({ task, disposition: 'spawn', reason: 'FIFO: fresh spawn (filling the pool)' });
      remainingHeadroom--;
      placed++;
      continue;
    }

    // 2. Pool full → round-robin onto the LEAST-LOADED live, under-capacity bee. NO affinity scoring:
    //    the choice is purely "whichever free worker is next", ties broken by ownerId for determinism.
    const candidate = input.bees
      .filter((b) => b.alive)
      .filter((b) => (projectedLoad[b.ownerId] ?? 0) < injectLoadThreshold)
      .filter((b) => (injectsOnBee.get(b.ownerId) ?? 0) < maxInjectPerBee)
      .sort((a, b) => {
        const la = projectedLoad[a.ownerId] ?? 0;
        const lb = projectedLoad[b.ownerId] ?? 0;
        return la !== lb ? la - lb : a.ownerId.localeCompare(b.ownerId);
      })[0];

    if (candidate) {
      const priorInjects = injectsOnBee.get(candidate.ownerId) ?? 0;
      decisions.push({
        task,
        disposition: 'warm-inject',
        bee: candidate.ownerId,
        // FIFO append: this bee's Nth batch-inject lands at rank N (no head-of-line re-prioritization).
        rank: priorInjects,
        // NOTE: no `affinity` — the round-robin choice carries no fit score (that absence IS the ablation).
        reason: `FIFO: round-robin inject → ${candidate.ownerId} (no affinity)`,
      });
      projectedLoad[candidate.ownerId] = (projectedLoad[candidate.ownerId] ?? 0) + 1;
      injectsOnBee.set(candidate.ownerId, priorInjects + 1);
      placed++;
      continue;
    }

    // 3. Pool full + every bee at capacity → queue back to the backlog for the next wake.
    decisions.push({
      task,
      disposition: 'unplaced',
      reason: 'FIFO: pool full, all bees at capacity — queued back to the backlog',
    });
  }

  const spawnCount = decisions.filter((d) => d.disposition === 'spawn').length;
  const injectCount = decisions.filter((d) => d.disposition === 'warm-inject').length;
  const unplacedCount = decisions.filter((d) => d.disposition === 'unplaced').length;
  return { decisions, spawnCount, injectCount, unplacedCount, projectedLoad, remainingHeadroom };
}

/**
 * The placement-policy name recorded in `arm_meta.placement_policy` so a queen-ablated row's
 * scheduler is unambiguous on the row (paired with `arm='queen-ablated'`). The arm-id vocab itself
 * is owned by the fleet convergence point (`hive-backlog.ts#QUEEN_ABLATED_ARM` / bench-metrics
 * `FleetArmId`) — the planner does not declare its own arm id.
 */
export const FIFO_POLICY = 'fifo';
