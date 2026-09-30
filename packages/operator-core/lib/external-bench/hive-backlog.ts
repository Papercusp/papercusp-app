/**
 * P-022 / redirect BRIEF 2 (su-1226c) — the HIVE-OVER-BACKLOG runner: the **'hive' treatment
 * arm** of the reframed suite (D-010). Hand the WHOLE benchmark task SET to a Hive (Queen + bee
 * fleet) as a backlog; the Queen places / ranks / warm-injects; each placed task → a bee runs the
 * per-task `external-bench` unit (`instantiateBenchHarness('external-bench',…)`, D-009) to DONE; we
 * collect the raw fleet generation trace. The headline of the reframe is `hive` vs `queen-ablated`
 * (P-023, same fleet + naive FIFO) — the delta IS the Queen's placement value.
 *
 * THIS FILE IS THE FLEET-LAYER CONVERGENCE POINT — the canonical over-backlog request + result every
 * fleet arm emits (P-022 hive, P-023 queen-ablated, P-024 native-serial su-9a191, P-028 competitors
 * su-8c30f) and the planner seam P-023 plugs into. Peers reconcile their local shapes to these.
 *
 * ── CONTRACT BOUNDARY (who owns what) ──────────────────────────────────────────────────────────
 * This runner EMITS the raw fleet GENERATION record ({@link HiveBacklogResult}); DERIVED metrics stay
 * single-owned downstream (same boundary as the L1 row in D-009):
 *   - per-task `resolved` ← BRIEF 3's `OfficialGrader` grading the {@link FleetTaskResult.attempt} diffs.
 *   - throughput / value / autonomy ← P-025 `@papercusp/bench-metrics` `buildHiveReport` over the
 *     {@link FleetRunSummary} this record projects to ({@link toFleetRunSummary}).
 *   - MAST coordination rates ← P-026 over the {@link HiveBacklogResult.coordEvents} trace
 *     (`CoordEvent`s, incl. every placement) that P-010's rollout layer persists.
 * Metrics shapes live in bench-metrics (locked, P-025/P-026); this owns the raw record + the runner
 * port + the planner seam. Arm ids are the LOCKED `FleetArmId` vocab ('hive' | 'queen-ablated' | …).
 *
 * ── THE PLANNER SEAM (hive ↔ queen-ablated — P-023, su-136a4) ──────────────────────────────────
 * The ONLY thing that differs between the treatment and its headline baseline is the placement
 * PLANNER — a pure `BatchPlacementInput → BatchPlacementPlan` function (the real fleet machinery,
 * `../fleet/batch-placement`). The hive arm runs `planBatchPlacement` (the Queen's importance+affinity
 * ranking); the queen-ablated arm runs su-136a4's `planFifoPlacement` (naive FIFO/round-robin, same
 * queue mechanics, zero placement intelligence). The shared runner (seed backlog / drive the loop /
 * await drain / collect the trace / teardown) is identical — "swap ONE function and nothing else"
 * (136a4). Same isolation discipline as `instantiateBenchHarness` ↔ `coding-solo` at L1.
 *
 * SCOPE NOTE (matches 136a4's): this isolates the Queen's PLACEMENT ALGORITHM (ranking + affinity).
 * The Queen's richer agentic behaviors — live eviction / re-placement / situational briefs / adaptive
 * wake-timing — are a PERSONA, not a pure planner, and are deliberately out of scope for BOTH arms of
 * this clean A/B. A full real-Queen-persona 'hive' variant (vs a real-fleet-no-Queen ablation) is a
 * richer, separate claim the pilot may ALSO run; flagged to the owner (10912), not baked in here.
 *
 * ── STAGING (D-009 discipline — live driver bound at the pilot) ────────────────────────────────
 * Spinning a real Hive over a backlog spends real fleet budget, so — like `instantiateBenchHarness`,
 * the grader, and the single-agent drive — the LIVE driver is bound at the P-032 pilot via
 * {@link setHiveBacklogDriver}. The live driver mirrors hive-eval's `makeLiveHivePorts` loop (create
 * transient hive → seed backlog work_items → drive `getFleetPlanner(arm)` over
 * gatherFrontier/gatherLiveBees/fleet:place_batch until `countHivePlacementsInFlight()==0` → collect
 * `spawned_agents`/work-item outcomes → teardown). The live function map is on {@link HiveBacklogDriver}.
 * UNBOUND, the port returns an infra-error result so the wave builds + tests against it today.
 */
import type { BenchSuite, CoordEvent, FleetArmId, FleetRunSummary } from '@papercusp/bench-metrics';
import type { BatchPlacementInput, BatchPlacementPlan } from '../fleet/batch-placement';
import { planBatchPlacement } from '../fleet/batch-placement';
import { planFifoPlacement } from './queen-ablation';
import type { ArmAttempt, BenchTask, GenerationBudget } from './types';

/** The treatment arm this runner spins by default — the real Queen's placement algorithm + bee fleet. */
export const HIVE_ARM: FleetArmId = 'hive';
/** The headline baseline arm (su-136a4's planFifoPlacement). */
export const QUEEN_ABLATED_ARM: FleetArmId = 'queen-ablated';

/* -------------------------------------------------------------------------- */
/* The raw fleet run record (the canonical fleet-arm output)                   */
/* -------------------------------------------------------------------------- */

/** How the scheduler placed a task onto a bee (the placement vocabulary). */
export type PlacementDisposition = 'spawn' | 'warm-inject';

/** One backlog task's leaf result, with its fleet placement + timing provenance. */
export interface FleetTaskResult {
  /** The L1 leaf — the per-task `external-bench` generation (diff + cost + stopReason). Graded
   *  downstream by BRIEF 3's OfficialGrader → fills `resolved`. */
  attempt: ArmAttempt;
  /** The bee (spawn id) that ran it. */
  cupId: string;
  /** When the scheduler placed it (ms epoch). */
  placedAtMs: number;
  /** When the bee started / finished the task (ms epoch). */
  startedAtMs: number;
  finishedAtMs: number;
  /** How it was placed — fresh spawn vs warm-inject onto a busy bee. */
  disposition: PlacementDisposition;
}

/**
 * A live-concurrency timeline for a backlog run (su-vs-queen-expansion P-003, su-independent arm).
 *
 * `peakConcurrentBees` is a single scalar (the max ever observed); for the honest "how many agents
 * actually ran at once, on average" question we need the *shape* of concurrency over the run, not just
 * its peak. This records a `live` sample on a fixed cadence so the report can show the actual
 * utilization curve (a pool with cap=5 that only ever had 2 live tasks is very different from one that
 * pinned 5). Additive + optional — arms that don't populate it (hive-realqueen / fifo-noqueen) are
 * unaffected; the su-independent driver fills it from its pool-occupancy counter.
 */
export interface ConcurrencyTimeline {
  /** One sample per cadence tick: `tMs` = ms since the run started, `live` = concurrent agents then. */
  samples: { tMs: number; live: number }[];
  /** Mean of `samples[].live` (0 when no samples) — the average concurrency the run actually sustained. */
  avgConcurrent: number;
  /** Max of `samples[].live` (0 when no samples) — the sampled peak (≈ `peakConcurrentBees`). */
  peakConcurrent: number;
}

/** The whole backlog run handed to one fleet arm — the raw generation trace (the canonical shape). */
export interface HiveBacklogResult {
  /** LOCKED fleet vocab — 'hive' (this) | 'queen-ablated' (P-023) | 'native-serial' (P-024) | competitors. */
  arm: FleetArmId;
  suite: BenchSuite;
  /** P-010 pre-registered run id (groups every arm × seed of one pilot). */
  runId: string;
  /** The reproducibility seed/prefix this backlog pass ran under. */
  seed: number;
  /** Backlog-drain window (ms epoch) → wall-clock = finishedAtMs − startedAtMs (parallel, NOT Σ). */
  startedAtMs: number;
  finishedAtMs: number;
  /** Peak concurrent bees over the run (throughput context). */
  peakConcurrentBees: number;
  /** One per backlog task. */
  taskResults: FleetTaskResult[];
  /** The coordination trace (every placement/evict + substrate event) → P-026 MAST + P-010 rollout. */
  coordEvents: CoordEvent[];
  /**
   * The live-concurrency timeline (su-vs-queen-expansion P-003) — sampled occupancy over the run +
   * its avg/peak. Optional + additive: only arms that sample it populate it (the su-independent pool
   * driver does); existing arms (hive-realqueen / fifo-noqueen) leave it undefined.
   */
  concurrencyTimeline?: ConcurrencyTimeline;
  /** Generation-side infra failure for the WHOLE run (e.g. the live driver is unbound); null on a clean run. */
  runError?: string | null;
}

/**
 * Project the raw record → the LOCKED P-025 {@link FleetRunSummary} (the input `buildHiveReport`
 * consumes). `resolved` is NOT known at generation time (the grader fills it), so it is passed in
 * after BRIEF 3 grades the per-task diffs. Cost/tokens are SUMMED across every bee + turn
 * (coordination overhead counted — fairness #2); wall-clock is the PARALLEL drain window, not the
 * sum of per-task times. Autonomy numerator = tasks that reached DONE with no human gate.
 */
export function toFleetRunSummary(result: HiveBacklogResult, resolvedCount: number): FleetRunSummary {
  let costUsd = 0;
  let tokensTotal = 0;
  let tasksZeroHumanGate = 0;
  for (const t of result.taskResults) {
    costUsd += t.attempt.costUsd;
    tokensTotal += t.attempt.tokensIn + t.attempt.tokensOut;
    // A benchmark backlog runs with NO human gate; "zero human gate" = the bee reached DONE on its
    // own (not an ESCALATE that, in a gated run, would have waited on a human).
    if (t.attempt.stopReason === 'done') tasksZeroHumanGate += 1;
  }
  return {
    runId: result.runId,
    suite: result.suite,
    arm: result.arm,
    tasks: result.taskResults.length,
    resolved: resolvedCount,
    wallClockMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
    costUsd,
    tokensTotal,
    tasksZeroHumanGate,
    peakConcurrency: result.peakConcurrentBees,
  };
}

/* -------------------------------------------------------------------------- */
/* The planner seam — the hive ↔ queen-ablated placement-policy toggle         */
/* -------------------------------------------------------------------------- */

/**
 * A fleet placement planner — the pure `BatchPlacementInput → BatchPlacementPlan` function the
 * shared runner swaps per arm. `planBatchPlacement` (the Queen) and `planFifoPlacement` (the
 * ablation) are both exactly this shape, so the runner changes ONE binding and nothing else.
 */
export type PlacementPlanner = (input: BatchPlacementInput) => BatchPlacementPlan;

const _planners = new Map<FleetArmId, PlacementPlanner>([
  [HIVE_ARM, planBatchPlacement], //         the Queen's importance + affinity placement (the treatment)
  [QUEEN_ABLATED_ARM, planFifoPlacement], // naive FIFO / round-robin, zero placement intelligence
]);

/** Register/override a fleet arm's placement planner (e.g. an experimental Queen variant). */
export function registerFleetPlanner(arm: FleetArmId, planner: PlacementPlanner): void {
  _planners.set(arm, planner);
}

/** The placement planner for an arm (the live driver dispatches on the run's arm). `undefined` for
 *  arms that are NOT our-fleet placement runs — e.g. P-028's external competitor orchestrators, which
 *  drive their own placement and emit {@link HiveBacklogResult} directly. */
export function getFleetPlanner(arm: FleetArmId): PlacementPlanner | undefined {
  return _planners.get(arm);
}

/* -------------------------------------------------------------------------- */
/* The runner port — live driver bound at the P-032 pilot                      */
/* -------------------------------------------------------------------------- */

/** One backlog run's config (the firing payload). */
export interface HiveBacklogRunRequest {
  arm: FleetArmId;
  suite: BenchSuite;
  runId: string;
  seed: number;
  /** The whole benchmark backlog handed to the fleet. */
  backlog: BenchTask[];
  /** Per-task iso-budget + an optional fleet-level $/time cap (BRIEF 7). */
  budget: GenerationBudget;
}

/**
 * The LIVE hive-backlog driver — bound at the P-032 pilot. Mirrors hive-eval's `makeLiveHivePorts`:
 *   CREATE   — a transient hive home (`createHiveHarness`, `agent-tools/hive/_create.ts`).
 *   SEED     — insert the backlog as `feature` work_items into the member harness
 *              (`harness_features_consolidated`), status 'todo', unassigned — the Queen's frontier.
 *   DRIVE    — loop `getFleetPlanner(req.arm)` over the live fleet (`surveyHive`/`gatherFrontier`/
 *              `gatherLiveBees` → planner(input) → `fleet:place_batch`/`executeBatch`) until
 *              `countHivePlacementsInFlight()==0`. Feed the hive arm the IMPORTANCE-ordered frontier;
 *              feed queen-ablated the BACKLOG/arrival order (FIFO — 136a4). Each placed task → a bee
 *              running `instantiateBenchHarness('external-bench', task, …)` (the L1 leaf, D-009).
 *   COLLECT  — read `spawned_agents` (timing/cost) + work-item outcomes → `FleetTaskResult[]`, the
 *              placement/coord `CoordEvent[]` (incl. a `kind:'placement'` per decision), the drain window.
 *   TEARDOWN — dissolve the transient hive.
 */
export interface HiveBacklogDriver {
  run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult>;
}

/** The default driver — unbound until the pilot wires the live one (the hive-eval precedent). */
const UNBOUND_DRIVER: HiveBacklogDriver = {
  async run() {
    throw new Error(
      'live hive-backlog driver not bound — setHiveBacklogDriver() is wired at the pilot (P-032 / impartial-benchmark-suite-2026-06-15)',
    );
  },
};

let _driver: HiveBacklogDriver | null = null;

/** Bind the live hive-backlog driver (the pilot) — or a fake (tests). `null` restores the unbound default. */
export function setHiveBacklogDriver(driver: HiveBacklogDriver | null): void {
  _driver = driver;
}

/**
 * Run one backlog through a fleet arm. Delegates to the bound {@link HiveBacklogDriver}; an
 * unbound/failed driver yields an empty result carrying `runError` (never throws — the
 * generation-failure contract the metrics layer relies on, mirroring `instantiateBenchHarness`).
 */
export async function runHiveBacklog(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
  const driver = _driver ?? UNBOUND_DRIVER;
  try {
    return await driver.run(req);
  } catch (e) {
    const runError = e instanceof Error ? e.message : String(e);
    return {
      arm: req.arm,
      suite: req.suite,
      runId: req.runId,
      seed: req.seed,
      startedAtMs: 0,
      finishedAtMs: 0,
      peakConcurrentBees: 0,
      taskResults: [],
      coordEvents: [],
      runError,
    };
  }
}
