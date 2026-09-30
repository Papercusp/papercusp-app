/**
 * maxturn-sweep — the SWEEP RIG for P-024 (deterministic-context-carry-2026-07-14,
 * Phase 8 — maxTurn behavior sweep).
 *
 * P-024: "using the per-session dynamic override (P-023), run a matrix over the maxTurn
 * cap input ∈ {2K, 4K, 8K, 15K, 25K, 50K, 100K} × session class (Ornith drone /
 * gateway-claude drone / interactive) × door-split variants, on a fixed benchmark task
 * set (drain-style, file-heavy writes, long-log analysis)."
 *
 * This module is the PURE, testable heart of that rig: the axis definitions, the cartesian
 * CELL expansion, and — the substantive part — the cell→config RESOLUTION that turns each
 * cell into the exact {@link DoorConstantsPatch} the P-023 surface would apply
 * (context-doors-config.ts → config:doors-set-session) PLUS the derived doors/thresholds
 * the cell imposes (context-doors.ts computeMaxTurn / computeTurnDoors /
 * computeCompactionThresholds). It also carries the fail-soft, DEFAULT-OFF live entry
 * point ({@link runMaxTurnSweep}); the actual actuation — driving real drone/interactive
 * sessions with the cell's override bound and capturing telemetry — is an injected
 * {@link CellDriver} seam that stays staged (armed:false) until the owner arms it, mirroring
 * the staged-arming discipline of the sibling cores (residual-carry-pass.ts / cold-boot-
 * drill.ts / carry-respawn.ts / maintenance-carry.ts).
 *
 * KEY RIG FINDING (grounded, not guessed): to realize a target maxTurn on an ARBITRARY
 * window you must pin BOTH the floor and the cap to the target — setting only the cap lets
 * the 8K floor override it on small windows (Ornith 204.8K → window/26 ≈ 7.9K, so cap=25K
 * still yields maxTurn=8K). And the P-023 config surface bounds the floor at 50K in BOTH
 * verbs (config:doors-set / -set-session), so the 100K sweep point is NOT reachable through
 * the override tools on any realistic window (window/26 ≥ 100K needs a 2.6M window). The rig
 * reports this per cell via {@link CellConfig.configReachable} + achievedMaxTurnTokens so the
 * live leg either skips or specially-provisions those cells rather than silently running a
 * mislabelled 50K cell as "100K".
 *
 * P-025 (blocked-by P-024) consumes the {@link CellResult}[] this rig produces and scores
 * the per-cell metrics ({@link CellRunMetrics}) into per-class constant recommendations —
 * a human ratifies any constant change, never auto-applied (D-001). P-024 defines the rig +
 * the result/metric shapes; P-025 adds the scorer.
 */
import {
  BAKED_DOOR_CONSTANTS,
  computeMaxTurn,
  computeTurnDoors,
  computeCompactionThresholds,
  type DoorConstants,
  type TurnDoors,
  type CompactionThresholds,
} from './context-doors';
import { resolveDoorConstants, type DoorConstantsPatch } from './context-doors-config';

// ─────────────────────────────────────────────────────────────────────────────
// Axes
// ─────────────────────────────────────────────────────────────────────────────

/** The maxTurn targets to sweep (tokens), the owner's 2K–100K range (plan P-024). */
export const DEFAULT_MAXTURN_TARGETS_TOKENS = [2_000, 4_000, 8_000, 15_000, 25_000, 50_000, 100_000] as const;

/** The session classes under test. The class is a real axis even where two share a window:
 *  the LIVE behavior differs (Ornith small-model drone hops vs gateway-claude drone hops vs
 *  interactive human-paced turns), so the driver runs all three. */
export type SweepSessionClass = 'ornith-drone' | 'gateway-claude-drone' | 'interactive';

export interface SessionClassSpec {
  sessionClass: SweepSessionClass;
  /** The effective window (tokens) this class's thresholds derive from — min(backend n_ctx,
   *  configured limit). What computeMaxTurn/thresholds run on for the cell. */
  effectiveWindowTokens: number;
}

/** Representative windows: Ornith ≈ 200K (204800, floor binds → baseline maxTurn 8K); the
 *  opus[1m] drone + interactive classes ≈ 1M (cap binds → baseline maxTurn 15K). Overridable
 *  by passing a custom `axes`. */
export const DEFAULT_SESSION_CLASSES: readonly SessionClassSpec[] = Object.freeze([
  { sessionClass: 'ornith-drone', effectiveWindowTokens: 204_800 },
  { sessionClass: 'gateway-claude-drone', effectiveWindowTokens: 1_000_000 },
  { sessionClass: 'interactive', effectiveWindowTokens: 1_000_000 },
]);

/** A named door-split variant — the proportions of maxTurn given to output / each tool
 *  result / injections. Must sum to 1 (output + resultSlots×resultEach + injections). */
export interface DoorSplitVariant {
  id: string;
  split: DoorConstants['doorSplit'];
}

/** The default split (baked) plus two task-shaped alternatives: result-heavy (widen the tool
 *  door for file-heavy / long-log paging) and output-heavy (widen output for write-heavy
 *  generation). All sum to exactly 1 with 2 result slots. */
export const DEFAULT_DOOR_SPLIT_VARIANTS: readonly DoorSplitVariant[] = Object.freeze([
  { id: 'baked', split: BAKED_DOOR_CONSTANTS.doorSplit },
  { id: 'result-heavy', split: { output: 0.375, resultEach: 0.25, resultSlots: 2, injections: 0.125 } },
  { id: 'output-heavy', split: { output: 0.625, resultEach: 0.125, resultSlots: 2, injections: 0.125 } },
]);

/** The fixed benchmark workloads (plan P-024). */
export type BenchmarkTaskKind = 'drain-style' | 'file-heavy-writes' | 'long-log-analysis';

export interface BenchmarkTask {
  id: string;
  kind: BenchmarkTaskKind;
  /** One line on what the task exercises — the driver maps this to a concrete scenario. */
  summary: string;
}

export const DEFAULT_BENCHMARK_TASKS: readonly BenchmarkTask[] = Object.freeze([
  { id: 'drain', kind: 'drain-style', summary: 'Drain a backlog of small work-items — many short hops, tests the compaction cadence.' },
  { id: 'file-writes', kind: 'file-heavy-writes', summary: 'Author/edit many files — large model output per hop, tests the output door.' },
  { id: 'log-analysis', kind: 'long-log-analysis', summary: 'Analyze a long log/artifact — large tool results, tests the result door + spill-chase.' },
]);

export interface SweepAxes {
  maxTurnTargetsTokens: readonly number[];
  sessionClasses: readonly SessionClassSpec[];
  doorSplitVariants: readonly DoorSplitVariant[];
  tasks: readonly BenchmarkTask[];
}

export const DEFAULT_SWEEP_AXES: SweepAxes = Object.freeze({
  maxTurnTargetsTokens: DEFAULT_MAXTURN_TARGETS_TOKENS,
  sessionClasses: DEFAULT_SESSION_CLASSES,
  doorSplitVariants: DEFAULT_DOOR_SPLIT_VARIANTS,
  tasks: DEFAULT_BENCHMARK_TASKS,
});

// ─────────────────────────────────────────────────────────────────────────────
// P-023 config-surface bounds (mirrored from the config:doors-set[-session] zod schemas)
// ─────────────────────────────────────────────────────────────────────────────

/** The floor override's schema minimum in BOTH config verbs. */
export const SESSION_DOOR_FLOOR_MIN = 1_000;
/** The floor override's schema MAXIMUM in BOTH config verbs. Raised 50K→100K
 *  (D-012's named live-leg prerequisite): the owner's sweep range is 2K–100K and
 *  pinning maxTurn=100K requires floor=100K — with the old 50K bound the 100K
 *  cell was structurally unreachable. Now aligned with SESSION_DOOR_CAP_MAX. */
export const SESSION_DOOR_FLOOR_MAX = 100_000;
/** The cap override's schema maximum in BOTH config verbs. */
export const SESSION_DOOR_CAP_MAX = 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// Cells
// ─────────────────────────────────────────────────────────────────────────────

/** `2000 → "2k"`, `100000 → "100k"`, non-round → the raw number. */
function fmtTok(n: number): string {
  return n % 1000 === 0 ? `${n / 1000}k` : `${n}`;
}

/** One point in the sweep matrix. */
export interface SweepCell {
  cellId: string;
  maxTurnTargetTokens: number;
  sessionClass: SweepSessionClass;
  effectiveWindowTokens: number;
  doorSplitVariantId: string;
  taskId: string;
  taskKind: BenchmarkTaskKind;
}

/** Stable, human-readable cell id — order-independent of the axes iteration. */
export function cellId(sessionClass: SweepSessionClass, targetTokens: number, splitVariantId: string, taskId: string): string {
  return `${sessionClass}__mt${fmtTok(targetTokens)}__${splitVariantId}__${taskId}`;
}

/** Expand the axes into the full cartesian product of cells. Pure. */
export function expandSweepCells(axes: SweepAxes = DEFAULT_SWEEP_AXES): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const cls of axes.sessionClasses) {
    for (const target of axes.maxTurnTargetsTokens) {
      for (const variant of axes.doorSplitVariants) {
        for (const task of axes.tasks) {
          cells.push({
            cellId: cellId(cls.sessionClass, target, variant.id, task.id),
            maxTurnTargetTokens: target,
            sessionClass: cls.sessionClass,
            effectiveWindowTokens: cls.effectiveWindowTokens,
            doorSplitVariantId: variant.id,
            taskId: task.id,
            taskKind: task.kind,
          });
        }
      }
    }
  }
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell → config resolution (the substantive pure core)
// ─────────────────────────────────────────────────────────────────────────────

export interface CellConfig {
  /** The DoorConstantsPatch config:doors-set-session would apply to realize this cell —
   *  pins floor=cap=target (clamped to the surface's floor bound) + the split variant. */
  patch: DoorConstantsPatch;
  /** BAKED merged with the patch through the REAL resolution (resolveDoorConstants), so the
   *  rig's expectation matches what the live door sites would actually enforce. */
  effectiveConstants: DoorConstants;
  /** The per-door caps this cell imposes on its window. */
  turnDoors: TurnDoors;
  /** The soft/hard compaction thresholds this cell imposes on its window. */
  thresholds: CompactionThresholds;
  /** The maxTurn the config surface can actually realize for this cell's window (== target
   *  when reachable; caps at the floor bound otherwise). */
  achievedMaxTurnTokens: number;
  /** True ⇒ the override tools can realize the target exactly. False ⇒ the target exceeds the
   *  50K floor bound and no realistic window pushes maxTurn there (the 100K point) — the live
   *  leg must special-provision or skip it. */
  configReachable: boolean;
  /** Set when !configReachable — why, and what the live leg must do. */
  clampNote?: string;
}

/**
 * Resolve one cell into the P-023 patch that realizes it + the doors/thresholds it imposes.
 * PURE. Pins floor=cap=target (the only way to realize a target maxTurn on an arbitrary
 * window), clamped to the config surface's bounds, and reports honestly when the target is
 * unreachable (the 100K point).
 */
export function resolveCellConfig(cell: Pick<SweepCell, 'maxTurnTargetTokens' | 'effectiveWindowTokens' | 'doorSplitVariantId'>, axes: SweepAxes = DEFAULT_SWEEP_AXES): CellConfig {
  const target = cell.maxTurnTargetTokens;
  const variant = axes.doorSplitVariants.find((v) => v.id === cell.doorSplitVariantId);

  // Pin floor=cap=target, clamped to what the config verbs accept (floor ≤ 100K, cap ≤ 100K,
  // both ≥ 1K — floor max raised 50K→100K per D-012's live-leg prerequisite). An out-of-range
  // target yields the closest appliable patch; achieved reflects reality after the real resolver runs.
  const floorTarget = Math.min(Math.max(target, SESSION_DOOR_FLOOR_MIN), SESSION_DOOR_FLOOR_MAX);
  const capTarget = Math.min(Math.max(target, floorTarget), SESSION_DOOR_CAP_MAX);
  const patch: DoorConstantsPatch = {
    maxTurnFloorTokens: floorTarget,
    maxTurnCapTokens: capTarget,
    ...(variant ? { doorSplit: variant.split } : {}),
  };

  const effectiveConstants = resolveDoorConstants({ defaults: patch }, null);
  const achievedMaxTurnTokens = computeMaxTurn(cell.effectiveWindowTokens, effectiveConstants);
  const configReachable = achievedMaxTurnTokens === target;

  return {
    patch,
    effectiveConstants,
    turnDoors: computeTurnDoors(cell.effectiveWindowTokens, effectiveConstants),
    thresholds: computeCompactionThresholds(cell.effectiveWindowTokens, effectiveConstants),
    achievedMaxTurnTokens,
    configReachable,
    ...(configReachable
      ? {}
      : {
          clampNote:
            `target ${fmtTok(target)} exceeds the P-023 floor bound (${fmtTok(SESSION_DOOR_FLOOR_MAX)}); ` +
            `the override surface can only realize maxTurn=${fmtTok(achievedMaxTurnTokens)} on a ${fmtTok(cell.effectiveWindowTokens)}-token window. ` +
            `The live leg must special-provision this cell (raise the tool bound / direct override write) or skip it.`,
        }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-cell result + metric shapes (P-025 fills + scores these)
// ─────────────────────────────────────────────────────────────────────────────

/** The metrics captured per cell (plan P-025). All nullable: a cell that did not run, or a
 *  metric the driver could not capture, is null (never a fabricated 0). */
export interface CellRunMetrics {
  /** Fraction of hops that stopped with stopReason=length (hit the output door). */
  stopReasonLengthRate: number | null;
  /** Fraction of spilled pointers the agent actually read back (did spill-chase work?). */
  spillChaseSuccessRate: number | null;
  hopsPerTask: number | null;
  cacheReadInputTokens: number | null;
  freshInputTokens: number | null;
  compactionCount: number | null;
  wallClockMs: number | null;
  /** Fraction of task repeats that reached a successful terminal state. */
  taskSuccessRate: number | null;
}

/** Every metric null — the shape a staged / not-yet-run cell carries. */
export function emptyCellMetrics(): CellRunMetrics {
  return {
    stopReasonLengthRate: null,
    spillChaseSuccessRate: null,
    hopsPerTask: null,
    cacheReadInputTokens: null,
    freshInputTokens: null,
    compactionCount: null,
    wallClockMs: null,
    taskSuccessRate: null,
  };
}

export type CellRunStatus =
  | 'ok' // driven, metrics captured
  | 'staged' // not driven (sweep not armed, no driver, or cell config-unreachable + onlyReachable)
  | 'error'; // the driver threw — captured fail-soft, sweep continued

export interface CellResult {
  cellId: string;
  cell: SweepCell;
  config: CellConfig;
  repeats: number;
  status: CellRunStatus;
  metrics: CellRunMetrics;
  /** Set on status 'staged' (why it was skipped) or 'error' (the driver's failure). */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The DEFAULT-OFF live entry point (actuation is an injected, deferred seam)
// ─────────────────────────────────────────────────────────────────────────────

/** The LIVE actuation seam — binds the cell's override, runs its benchmark task on a real
 *  session of the cell's class, and returns the captured metrics. Deferred: absent an armed
 *  driver the sweep only ASSEMBLES + inspects the matrix (nothing spends, nothing drives). */
export type CellDriver = (
  cell: SweepCell,
  config: CellConfig,
  opts: { repeats: number; now: () => number },
) => Promise<CellRunMetrics>;

export interface RunSweepInput {
  axes?: SweepAxes;
  /** Repeats per cell (default 1, clamped ≥ 1). */
  repeats?: number;
  /** The live actuation seam. Absent ⇒ the sweep stays staged. */
  driver?: CellDriver;
  /** DEFAULT-OFF: must be true to drive any cell. A sweep that binds overrides on live
   *  drone/interactive sessions and spends is opt-in, never a default. */
  armed?: boolean;
  /** When armed, skip cells the config surface cannot realize (the 100K point). Default true. */
  onlyReachable?: boolean;
  /** Incremental per-DRIVEN-cell observer (fires after each ok/error cell resolves) — lets a
   *  multi-hour campaign persist completed cells as it goes instead of only at the end.
   *  Fail-soft: an observer throw never fails the sweep. Staged cells do not fire it. */
  onCell?: (result: CellResult) => void | Promise<void>;
  now?: () => number;
}

export interface SweepRunResult {
  cells: SweepCell[];
  results: CellResult[];
  armed: boolean;
  /** True iff at least one cell was actually driven. */
  ran: boolean;
  skippedReason?: 'not-armed' | 'no-driver';
  /** Cells whose target the config surface can realize exactly. */
  reachableCount: number;
  /** Cell ids the config surface cannot realize (the 100K point) — special-provision or skip. */
  unreachableCells: string[];
}

/**
 * Assemble + (optionally) drive the maxTurn sweep. PURE assembly always runs; the live
 * actuation is gated behind `armed` + an injected `driver` and is FAIL-SOFT — a driver that
 * throws on one cell is captured as that cell's status:'error' and never aborts the sweep.
 * Staged by default: with no armed driver every cell comes back status:'staged' with empty
 * metrics, so the whole matrix (cells + resolved configs + reachability) is inspectable
 * without spending or touching a live session.
 */
export async function runMaxTurnSweep(input: RunSweepInput = {}): Promise<SweepRunResult> {
  const axes = input.axes ?? DEFAULT_SWEEP_AXES;
  const repeats = Math.max(1, Math.floor(input.repeats ?? 1));
  const now = input.now ?? Date.now;
  const onlyReachable = input.onlyReachable ?? true;
  const armed = input.armed === true;

  const cells = expandSweepCells(axes);
  const configs = new Map<string, CellConfig>();
  for (const cell of cells) configs.set(cell.cellId, resolveCellConfig(cell, axes));

  const unreachableCells = cells.filter((c) => !configs.get(c.cellId)!.configReachable).map((c) => c.cellId);
  const reachableCount = cells.length - unreachableCells.length;

  const drivable = armed && typeof input.driver === 'function';
  const skippedReason: SweepRunResult['skippedReason'] = !armed ? 'not-armed' : !drivable ? 'no-driver' : undefined;

  const results: CellResult[] = [];
  let ran = false;

  for (const cell of cells) {
    const config = configs.get(cell.cellId)!;
    const base = { cellId: cell.cellId, cell, config, repeats };

    if (!drivable) {
      results.push({ ...base, status: 'staged', metrics: emptyCellMetrics(), note: skippedReason });
      continue;
    }
    if (onlyReachable && !config.configReachable) {
      results.push({ ...base, status: 'staged', metrics: emptyCellMetrics(), note: config.clampNote ?? 'config-unreachable' });
      continue;
    }
    try {
      const metrics = await input.driver!(cell, config, { repeats, now });
      ran = true;
      results.push({ ...base, status: 'ok', metrics });
    } catch (err) {
      ran = true; // an attempt was made; the sweep stays soft and moves on
      results.push({ ...base, status: 'error', metrics: emptyCellMetrics(), note: err instanceof Error ? err.message : String(err) });
    }
    if (input.onCell) {
      try {
        await input.onCell(results[results.length - 1]);
      } catch {
        // observer faults never fail the sweep
      }
    }
  }

  return {
    cells,
    results,
    armed,
    ran,
    ...(skippedReason ? { skippedReason } : {}),
    reachableCount,
    unreachableCells,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// P-025 — measure + report per cell; recommend per-class constants (advisory-only)
// ═════════════════════════════════════════════════════════════════════════════
//
// The SCORER over the CellResult[] runMaxTurnSweep produces. Aggregates the per-cell
// metrics into per-(class, maxTurn-target) points, then recommends a per-class maxTurn
// constant from the evidence. The recommendation is ADVISORY ONLY — a human ratifies any
// constant change, never auto-applied (plan D-001). Pure, mirroring cold-boot-drill's
// gradeColdBootDrills / residual-carry-pass's scoreResidualMissRate.
//
// The recommendation heuristic encodes the plan's stance ("context is rent — a bigger
// window is headroom for the SESSION, not licence for bigger hops", context-doors.ts):
// prefer the SMALLEST maxTurn that still clears the quality gates (task success high,
// length-stops low, spill-chase reliable). A bigger hop budget that only marginally
// reduces length-stops is not worth the per-hop token rent.

export interface SweepScoreParams {
  /** A point must average ≥ this task success rate to be recommendable (default 0.95). */
  minTaskSuccessRate: number;
  /** …and ≤ this length-stop rate (hops hitting the output door; default 0.05). */
  maxStopReasonLengthRate: number;
  /** …and ≥ this spill-chase success rate WHEN MEASURED (default 0.95). A point whose
   *  cells never exercised spill-chase (mean null — e.g. a drain-only canary) is NOT
   *  failed by this gate: null is "not exercised", not "failed" (WI-5003 — treating
   *  null as failing made the gate structurally unsatisfiable for raw-file workloads
   *  before the fixture-coverage metric existed, and would still veto narrowed runs). */
  minSpillChaseSuccessRate: number;
  /** Minimum ok cells behind a (class, target) point before it is trusted (default 1). */
  minCellsPerPoint: number;
}

export const DEFAULT_SWEEP_SCORE_PARAMS: SweepScoreParams = {
  minTaskSuccessRate: 0.95,
  maxStopReasonLengthRate: 0.05,
  minSpillChaseSuccessRate: 0.95,
  minCellsPerPoint: 1,
};

/** Mean of the non-null values, or null when there are none (never a fabricated 0). */
function meanOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

export interface PointAggregate {
  sessionClass: SweepSessionClass;
  maxTurnTargetTokens: number;
  /** Count of status:'ok' cells behind this point (staged/error cells are excluded). */
  okCells: number;
  meanStopReasonLengthRate: number | null;
  meanSpillChaseSuccessRate: number | null;
  meanHopsPerTask: number | null;
  meanCompactionCount: number | null;
  meanWallClockMs: number | null;
  meanTaskSuccessRate: number | null;
  meanCacheReadInputTokens: number | null;
  meanFreshInputTokens: number | null;
  /** True ⇒ meets every quality gate with ≥ minCellsPerPoint ok cells — a recommendable point. */
  qualityPassing: boolean;
}

export interface ClassRecommendation {
  sessionClass: SweepSessionClass;
  /** The smallest maxTurn target whose point cleared the gates; null when none did. */
  recommendedMaxTurnTokens: number | null;
  rationale: string;
  /** Every target whose point cleared the gates (ascending). */
  passingTargets: number[];
  /** Always true — a constant change requires human ratification (D-001), never auto-applied. */
  advisoryOnly: true;
}

export interface SweepScoreReport {
  points: PointAggregate[];
  recommendations: ClassRecommendation[];
  params: SweepScoreParams;
  advisoryOnly: true;
}

/**
 * Score a batch of cell results into per-(class,target) aggregates + a per-class advisory
 * recommendation. PURE. Only status:'ok' cells contribute; staged/error cells are excluded
 * (they carry no real metrics). A point is `qualityPassing` when it has ≥ minCellsPerPoint
 * ok cells and clears all three gates; the per-class recommendation is the SMALLEST passing
 * target (cheapest hop budget that still works), or null when no target passed.
 */
export function scoreMaxTurnSweep(results: CellResult[], params: SweepScoreParams = DEFAULT_SWEEP_SCORE_PARAMS): SweepScoreReport {
  // Bucket ok cells by (class, target).
  const buckets = new Map<string, { sessionClass: SweepSessionClass; target: number; cells: CellResult[] }>();
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const key = `${r.cell.sessionClass}__${r.cell.maxTurnTargetTokens}`;
    const b = buckets.get(key) ?? { sessionClass: r.cell.sessionClass, target: r.cell.maxTurnTargetTokens, cells: [] };
    b.cells.push(r);
    buckets.set(key, b);
  }

  const points: PointAggregate[] = [];
  for (const { sessionClass, target, cells } of buckets.values()) {
    const m = (pick: (x: CellRunMetrics) => number | null) => meanOrNull(cells.map((c) => pick(c.metrics)));
    const meanTaskSuccessRate = m((x) => x.taskSuccessRate);
    const meanStopReasonLengthRate = m((x) => x.stopReasonLengthRate);
    const meanSpillChaseSuccessRate = m((x) => x.spillChaseSuccessRate);
    const qualityPassing =
      cells.length >= params.minCellsPerPoint &&
      meanTaskSuccessRate !== null &&
      meanTaskSuccessRate >= params.minTaskSuccessRate &&
      meanStopReasonLengthRate !== null &&
      meanStopReasonLengthRate <= params.maxStopReasonLengthRate &&
      // Spill-chase gates only when MEASURED: null = no cell at this point
      // exercised it (not a failure — see minSpillChaseSuccessRate's doc).
      (meanSpillChaseSuccessRate === null || meanSpillChaseSuccessRate >= params.minSpillChaseSuccessRate);
    points.push({
      sessionClass,
      maxTurnTargetTokens: target,
      okCells: cells.length,
      meanStopReasonLengthRate,
      meanSpillChaseSuccessRate,
      meanHopsPerTask: m((x) => x.hopsPerTask),
      meanCompactionCount: m((x) => x.compactionCount),
      meanWallClockMs: m((x) => x.wallClockMs),
      meanTaskSuccessRate,
      meanCacheReadInputTokens: m((x) => x.cacheReadInputTokens),
      meanFreshInputTokens: m((x) => x.freshInputTokens),
      qualityPassing,
    });
  }
  points.sort((a, b) => a.sessionClass.localeCompare(b.sessionClass) || a.maxTurnTargetTokens - b.maxTurnTargetTokens);

  // Per-class recommendation: the smallest passing target (cheapest hop budget that works).
  const byClass = new Map<SweepSessionClass, PointAggregate[]>();
  for (const p of points) {
    const arr = byClass.get(p.sessionClass) ?? [];
    arr.push(p);
    byClass.set(p.sessionClass, arr);
  }
  const recommendations: ClassRecommendation[] = [];
  for (const [sessionClass, pts] of byClass) {
    const passing = pts.filter((p) => p.qualityPassing).map((p) => p.maxTurnTargetTokens).sort((a, b) => a - b);
    const recommendedMaxTurnTokens = passing.length ? passing[0] : null;
    const rationale =
      recommendedMaxTurnTokens !== null
        ? `smallest maxTurn clearing the gates (success ≥ ${params.minTaskSuccessRate}, length-stop ≤ ${params.maxStopReasonLengthRate}, spill-chase ≥ ${params.minSpillChaseSuccessRate}) — cheapest hop budget that still works; bigger buys little for the per-hop token rent (advisory, human-ratified per D-001)`
        : `no (class, target) point cleared the quality gates; needs more cells or relaxed gates before recommending a constant`;
    recommendations.push({ sessionClass, recommendedMaxTurnTokens, rationale, passingTargets: passing, advisoryOnly: true });
  }
  recommendations.sort((a, b) => a.sessionClass.localeCompare(b.sessionClass));

  return { points, recommendations, params, advisoryOnly: true };
}
