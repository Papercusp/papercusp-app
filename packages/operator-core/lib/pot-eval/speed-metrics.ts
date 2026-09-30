/**
 * Hive-evaluation SPEED metrics (HE-05, P-032) — "did the Hive do it FAST?", measured against
 * the scenario's computable optimum (D-004), never self-reported.
 *
 * The centerpiece is the **critical-path ratio**: measured wall-clock ÷ the ideal wall-clock,
 * where the ideal is the critical-path weight computed from the scenario's KNOWN dependency DAG
 * using the run's MEASURED per-item durations. Because the structure is known, this separates
 * "slow because serialized/bottlenecked" (ratio >> 1 — bad: the Hive failed to parallelize
 * independent work) from "slow because the work is genuinely deep" (ratio ≈ 1 — fine: a long
 * critical path bounds it). It reuses the SAME `computeParallelismStructure` HE-03 ships, just
 * fed measured durations instead of the design-time unit costs.
 *
 * Pure — over an injected {@link RunTimings} the live run's collectRunData extracts from spawn
 * rows (owner-gated, P-051). HE-06 composes these UNDER the outcome gate (D-002): speed credit
 * is zero unless the run did a good job.
 */
import { computeParallelismStructure, type HiveScenario } from './scenario';

export interface RunTimings {
  /** Measured wall-clock to drain / timeout (ms) — from the run's observations. */
  wallClockMs: number;
  /** Measured per-work-item execution duration (ms), keyed by scenario work-item id. */
  perItemDurationMs: Record<string, number>;
  /** ms from run start to the first bee placement (time-to-first-placement). */
  timeToFirstPlacementMs: number;
  /** Longest interval a work-item was READY (deps satisfied) but unplaced — stuck duration. */
  maxStuckMs: number;
}

export interface SpeedMetrics {
  wallClockMs: number;
  /** Critical-path weight using MEASURED per-item durations + the scenario's KNOWN DAG — the
   *  minimum achievable wall-clock given how long each item actually took. */
  idealWallClockMs: number;
  /** wall-clock ÷ ideal (≥1 when the Hive can't beat the critical path). ≈1 = optimally
   *  parallel; >>1 = serialized/bottlenecked. The serialized-vs-deep discriminator (D-004). */
  criticalPathRatio: number;
  /** The work-items on the measured critical path (which items bound the makespan). */
  criticalPath: string[];
  /** Mean per-item execution duration (ms) — MTTC. */
  mttcMs: number;
  timeToFirstPlacementMs: number;
  maxStuckMs: number;
}

/** Compute the speed metrics for one run against its scenario. Pure + deterministic. */
export function computeSpeedMetrics(scenario: HiveScenario, timings: RunTimings): SpeedMetrics {
  // The live ideal: same DAG, MEASURED durations as the cost. With unbounded bees, the makespan
  // is the longest dependency chain's measured weight — that's the best the Hive could do.
  const ideal = computeParallelismStructure(scenario.workItems, (w) => timings.perItemDurationMs[w.id] ?? 0);
  const durations = Object.values(timings.perItemDurationMs);
  const mttcMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const criticalPathRatio = ideal.idealWallClockUnits > 0 ? timings.wallClockMs / ideal.idealWallClockUnits : 0;
  return {
    wallClockMs: timings.wallClockMs,
    idealWallClockMs: ideal.idealWallClockUnits,
    criticalPathRatio,
    criticalPath: ideal.criticalPath,
    mttcMs,
    timeToFirstPlacementMs: timings.timeToFirstPlacementMs,
    maxStuckMs: timings.maxStuckMs,
  };
}
