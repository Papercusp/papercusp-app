/**
 * The A/B eval-matrix as a runtime DAG (harness-blueprint-orchestration-2026-06-03
 * P-013 / D-014). THE genuinely-new piece of the gym blueprint port.
 *
 * `ab-runner.ts`'s `runAbEvaluation` runs the matrix as a sequential triple-loop
 * (variant → task → repeat) with the analysis folded inline. Under the blueprint
 * port the matrix becomes a **Level-2 runtime DAG**: each (variant × task × repeat)
 * is an INDEPENDENT cell node (no dependencies → all parallelizable, the planner's
 * wave 0) and a single AGGREGATE node depends on every cell (wave 1). That maps
 * 1:1 onto the coding planner's wave + blocked_by model (`harness/waves.ts`): the
 * cells are un-blocked wave-0 work items; the aggregate is a wave-1 step blocked_by
 * all of them. So the gym's eval matrix rides the SAME runtime DAG every harness
 * uses — it is not bespoke scheduling.
 *
 * This module owns two pure halves, both unit-testable with zero I/O:
 *   1. `expandAbMatrix` — the matrix → DAG expansion (the structure to schedule).
 *   2. `aggregateAbMatrix` / `compareVariantsFromOutcomes` — the comparison /
 *      aggregation primitive the AGGREGATE node runs once the cells have results
 *      (variance + cost + the A-vs-B comparison), extracted out of the sequential
 *      runner so it works over in-memory cell outcomes with no PG read.
 *
 * Bounded by construction (D-019): `size = variants × tasks × repeats`, sized by
 * the caller; nothing here fans out on its own.
 */
import { aggregateRepeats, deriveThresholds, type DeriveOpts } from './variance';
import { meanRunCostUsd, type RunCost } from './cost';
import type { PerTaskVariance } from './ab-runner';
import type { VariantComparisonRow } from './store';

// ───────────────────────────── matrix → DAG ─────────────────────────────

export interface AbMatrixConfig {
  /** Variant ids under test (variant[0] = A/baseline, variant[1] = B/candidate). */
  variantIds: string[];
  /** Eval task ids. */
  taskIds: string[];
  /** Repeats per (variant × task) — the variance sample (D-013). */
  repeats: number;
}

/** One (variant × task × repeat) eval run — an independent DAG node (wave 0). */
export interface AbCellNode {
  id: string;
  kind: 'cell';
  variantId: string;
  taskId: string;
  repeat: number;
  /** Cells are independent → no dependencies → all run in parallel (wave 0). */
  dependsOn: readonly string[];
}

/** The single fold node — runs the comparison/aggregation once every cell is done (wave 1). */
export interface AbAggregateNode {
  id: string;
  kind: 'aggregate';
  dependsOn: readonly string[];
}

export interface AbMatrixDag {
  cells: AbCellNode[];
  aggregate: AbAggregateNode;
  /** variants × tasks × repeats — the bounded cell count (D-019). */
  size: number;
  /** The DAG bucketed into dependency waves: [cells, [aggregate]]. */
  waves: string[][];
}

/** Deterministic cell id — matches the live runner's `newRunId` (`v::t::rN`). */
export function abCellId(variantId: string, taskId: string, repeat: number): string {
  return `${variantId}::${taskId}::r${repeat}`;
}

/**
 * Expand a matrix config into its runtime DAG: a cell node per (variant × task ×
 * repeat) with no dependencies, plus one aggregate node depending on every cell.
 * Pure + deterministic (stable ordering), so it is safe to schedule, resume, and
 * snapshot. The cells form wave 0 (fully parallel); the aggregate is wave 1.
 */
export function expandAbMatrix(config: AbMatrixConfig): AbMatrixDag {
  if (config.repeats < 1) throw new Error(`abMatrix: repeats must be ≥ 1 (got ${config.repeats})`);
  const cells: AbCellNode[] = [];
  for (const variantId of config.variantIds) {
    for (const taskId of config.taskIds) {
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        cells.push({ id: abCellId(variantId, taskId, repeat), kind: 'cell', variantId, taskId, repeat, dependsOn: [] });
      }
    }
  }
  const aggregate: AbAggregateNode = { id: 'aggregate', kind: 'aggregate', dependsOn: cells.map((c) => c.id) };
  return {
    cells,
    aggregate,
    size: cells.length,
    waves: cells.length ? [cells.map((c) => c.id), [aggregate.id]] : [[aggregate.id]],
  };
}

// ──────────────────────── comparison / aggregation ────────────────────────

/**
 * The minimal per-cell result the aggregation reads — a structural subset of
 * `ab-runner`'s `AbRunOutcome`, so the live runner's outcomes feed straight in
 * while keeping this module decoupled from the runner's effectful graph.
 */
export interface AbCellOutcome {
  variantId: string;
  taskId: string;
  repeat: number;
  composite: number;
  pipelineUsd: number;
  judgeUsd: number;
  /** Non-`scored` cells (rate-limited / errored) are EXCLUDED from variance + comparison (RB-006). */
  status?: 'scored' | 'rate_limited' | 'errored';
}

const isScored = (o: AbCellOutcome): boolean => (o.status ?? 'scored') === 'scored';

/** Mean composite per (variant, task) over the SCORED cells. */
function meanCompositeByVariantTask(outcomes: readonly AbCellOutcome[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const o of outcomes) {
    if (!isScored(o)) continue;
    const k = `${o.variantId}\u0000${o.taskId}`;
    const cur = sums.get(k) ?? { sum: 0, n: 0 };
    cur.sum += o.composite;
    cur.n += 1;
    sums.set(k, cur);
  }
  const means = new Map<string, number>();
  for (const [k, { sum, n }] of sums) means.set(k, sum / n);
  return means;
}

/**
 * The pure A-vs-B comparison primitive: per task, variant A's and variant B's MEAN
 * judge-composite (over repeats) + the signed delta (B − A). Tasks evaluated by
 * either variant appear; a side with no scored cell for a task is null.
 *
 * Differs from the PG `compareVariants` (store.ts) deliberately: that uses
 * MAX(composite) per (task, variant) — fine for single-repeat v1; this uses the
 * MEAN, which is the right summary once `repeats > 1` (it matches the variance
 * sample). The matrix DAG always carries every repeat, so the mean is well-defined.
 */
export function compareVariantsFromOutcomes(
  outcomes: readonly AbCellOutcome[],
  variantA: string,
  variantB: string,
): VariantComparisonRow[] {
  const means = meanCompositeByVariantTask(outcomes);
  const taskIds = [...new Set(outcomes.filter(isScored).map((o) => o.taskId))].sort();
  return taskIds.map((taskId) => {
    const a = means.get(`${variantA}\u0000${taskId}`) ?? null;
    const b = means.get(`${variantB}\u0000${taskId}`) ?? null;
    return { taskId, aComposite: a, bComposite: b, delta: a !== null && b !== null ? b - a : null };
  });
}

export interface AbMatrixResult {
  /** Per-(variant,task) judge-composite variance + the derived ε/δ/min-repeats (D-013). */
  perTaskVariance: PerTaskVariance[];
  cost: { totalUsd: number; meanRunUsd: number; perVariant: Record<string, number> };
  /** A-vs-B per-task mean composite + signed delta (variant[0] = A, variant[1] = B). */
  comparison: VariantComparisonRow[];
  /** Cells that contributed a real score. */
  scoredCells: number;
  /** Cells excluded from variance/comparison (rate-limited / errored). */
  excludedCells: number;
}

export interface AggregateOpts {
  deriveOpts: DeriveOpts;
  /** A/baseline + B/candidate ids; default to the first two distinct variant ids seen. */
  variantA?: string;
  variantB?: string;
}

/**
 * The AGGREGATE node's body: fold every cell outcome into per-(variant,task)
 * variance, cost totals, and the A-vs-B comparison. Pure — the same analysis
 * `runAbEvaluation` does inline, but over the DAG's collected cell outcomes (so the
 * cells can have run in parallel) and with NO PG read for the comparison.
 */
export function aggregateAbMatrix(outcomes: readonly AbCellOutcome[], opts: AggregateOpts): AbMatrixResult {
  const scored = outcomes.filter(isScored);

  // 1. Per-(variant,task) variance over scored cells → ε/δ/min-repeats.
  const perTaskVariance: PerTaskVariance[] = [];
  const seen = new Set<string>();
  for (const o of scored) {
    const k = `${o.variantId}\u0000${o.taskId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const composites = scored.filter((x) => x.variantId === o.variantId && x.taskId === o.taskId).map((x) => x.composite);
    const stats = aggregateRepeats(composites);
    const thr = deriveThresholds(stats.sd, opts.deriveOpts);
    perTaskVariance.push({ variantId: o.variantId, taskId: o.taskId, mean: stats.mean, sd: stats.sd, n: stats.n, ...thr });
  }
  perTaskVariance.sort((p, q) => p.variantId.localeCompare(q.variantId) || p.taskId.localeCompare(q.taskId));

  // 2. Cost — over ALL cells (a failed run can still have cost the pipeline incurred).
  const runCosts: RunCost[] = outcomes.map((o) => ({ pipelineUsd: o.pipelineUsd, judgeUsd: o.judgeUsd }));
  const totalUsd = runCosts.reduce((s, c) => s + c.pipelineUsd + c.judgeUsd, 0);
  const perVariant: Record<string, number> = {};
  for (const o of outcomes) perVariant[o.variantId] = (perVariant[o.variantId] ?? 0) + o.pipelineUsd + o.judgeUsd;

  // 3. A-vs-B comparison from the scored cells (mean-based).
  const distinctVariants = [...new Set(outcomes.map((o) => o.variantId))];
  const a = opts.variantA ?? distinctVariants[0];
  const b = opts.variantB ?? distinctVariants[1] ?? a;
  const comparison = a != null ? compareVariantsFromOutcomes(outcomes, a, b) : [];

  return {
    perTaskVariance,
    cost: { totalUsd, meanRunUsd: meanRunCostUsd(runCosts), perVariant },
    comparison,
    scoredCells: scored.length,
    excludedCells: outcomes.length - scored.length,
  };
}
