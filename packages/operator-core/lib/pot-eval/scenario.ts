/**
 * Hive-run-evaluation — seeded scenarios with an OBJECTIVE optimum (P-020, D-004).
 *
 * A scenario is a TASK the whole Hive (Queen + bees) must complete, carrying four
 * things that make its run gradeable against ground truth — never the Hive's own
 * report of how it did:
 *
 *   (a) a known-good END STATE + an acceptance test (the objective outcome bar);
 *   (b) a PLANTED BUG (the un-gameable `plantedBugCaught` signal — HE-04);
 *   (c) a KNOWN PARALLELISM STRUCTURE: the work-items form a dependency DAG, so the
 *       ideal wall-clock (critical-path weight) and ideal bee-count (peak concurrency
 *       under the fastest schedule) are COMPUTABLE (this file's
 *       {@link computeParallelismStructure}); and
 *   (d) a FIXED SANDBOX (a throwaway hive over a pinned repo@commit, stood up with the
 *       gym hermetic runner).
 *
 * The corpus spans serial / wide-parallel / deep-dependency shapes so the battery
 * separates "slow because serialized/bottlenecked" (bad) from "slow because the work
 * is genuinely deep" (fine) — the critical-path ratio (HE-05) divides measured
 * wall-clock by the ideal this file computes.
 *
 * This module is PURE (no I/O): types + the parallelism math + validation. The run
 * harness (hive-subject.ts) and the battery (battery.ts) compose it.
 */
import type { PlantedBug } from '../gym/probe-generator';

/** The dependency shape a scenario exercises. Drives corpus coverage, not behavior. */
export type ScenarioShape = 'serial' | 'wide-parallel' | 'deep-dependency' | 'diamond';

/** One unit of work in a scenario's DAG. The Hive dispatches these to bees. */
export interface ScenarioWorkItem {
  /** Stable id within the scenario (e.g. `w1`). DAG node + dependency-edge target. */
  id: string;
  /** Human title — becomes the seeded work-item's title. */
  title: string;
  /** What the bee must do (becomes the seeded work-item's spec/summary). */
  spec: string;
  /** Ids of prerequisite work-items — the DAG edges (this item is ready once all done). */
  dependsOn: string[];
  /**
   * Estimated/relative work units for the STRUCTURAL ideal (default 1). The design-time
   * ideal wall-clock uses these; HE-05's live critical-path ratio re-runs the same math
   * with MEASURED per-item durations (computeParallelismStructure takes a cost accessor).
   */
  unitCost?: number;
}

/** The objective bar: a check of the scenario's known-good end state. Ground truth. */
export interface AcceptanceTest {
  /**
   * How the end state is asserted in the throwaway hive's repo:
   *  - `command`: a shell command run in the repo; exit 0 == known-good (with optional
   *    expected-substring `expect`).
   *  - `file-exists`: `path` must exist (cheap marker for fake/deterministic runs).
   *  - `predicate`: asserted in code by the metric layer (HE-04) from `observations`.
   */
  kind: 'command' | 'file-exists' | 'predicate';
  description: string;
  command?: string;
  /** For `command`: required substring of stdout. For `file-exists`: the path. */
  expect?: string;
  path?: string;
}

/** The seeded sandbox a throwaway hive clones (gym hermetic runner — git clone @ commit). */
export interface ScenarioSandbox {
  /** Repo source (local path or url) cloned into the throwaway scratch dir. */
  source: string;
  /** Pinned commit (a hex SHA, never a ref — reproducibility). */
  commit: string;
  /** Optional setup command run after clone, before the Hive starts (install/build). */
  setup?: string;
}

/** A seeded Hive-evaluation scenario with an objective optimum (D-004). */
export interface HiveScenario {
  /** Stable scenario id (the corpus key; deterministic run-identity derives from it). */
  id: string;
  title: string;
  /** The dependency shape this scenario exercises (corpus coverage). */
  shape: ScenarioShape;
  /** The fixed sandbox the throwaway hive runs over. */
  sandbox: ScenarioSandbox;
  /** The work-item DAG the Hive must drain. */
  workItems: ScenarioWorkItem[];
  /** The planted defect + which work-item's area carries it (un-gameable bug signal). */
  plantedBug: PlantedBug & { inWorkItem: string };
  /** The objective known-good end-state check. */
  acceptance: AcceptanceTest;
  /** Why this shape was chosen — design provenance, not behavior. */
  rationale: string;
}

/**
 * The computable optimum derived purely from a scenario's DAG (D-004). `idealWallClock`
 * and `criticalPath` use the supplied cost accessor; with the design-time `unitCost`
 * they are the structural ideal, with measured per-item durations (HE-05) they are the
 * live ideal the critical-path ratio divides into.
 */
export interface ParallelismStructure {
  /** Sum of every item's cost — total work (the fully-serial wall-clock). */
  totalUnits: number;
  /** The longest dependency chain's weight — the makespan with unbounded bees. */
  idealWallClockUnits: number;
  /** Peak simultaneous work under the fastest (ASAP) schedule — the ideal bee count. */
  idealBeeCount: number;
  /** The work-item ids on a longest (critical) path — which items bound the makespan. */
  criticalPath: string[];
  /** Max speed-up vs fully-serial (totalUnits / idealWallClockUnits) — the parallelism. */
  maxSpeedup: number;
}

/** Default cost accessor: each item is 1 unit unless it declares a `unitCost`. */
const unitCostOf = (w: ScenarioWorkItem): number => (w.unitCost == null ? 1 : w.unitCost);

/**
 * Compute the scenario's objective parallelism optimum from its DAG (D-004) — pure,
 * deterministic. Throws on a malformed DAG (unknown dep / cycle) so a bad scenario can
 * never silently yield a meaningless ideal.
 *
 * @param workItems the DAG nodes.
 * @param costOf    per-item cost; defaults to `unitCost ?? 1`. HE-05 passes measured
 *                  per-item durations (ms) to get the live ideal wall-clock.
 */
export function computeParallelismStructure(
  workItems: readonly ScenarioWorkItem[],
  costOf: (w: ScenarioWorkItem) => number = unitCostOf,
): ParallelismStructure {
  if (workItems.length === 0) {
    return { totalUnits: 0, idealWallClockUnits: 0, idealBeeCount: 0, criticalPath: [], maxSpeedup: 0 };
  }
  const byId = new Map<string, ScenarioWorkItem>();
  for (const w of workItems) {
    if (byId.has(w.id)) throw new Error(`duplicate work-item id: ${w.id}`);
    byId.set(w.id, w);
  }
  for (const w of workItems) {
    for (const d of w.dependsOn) {
      if (!byId.has(d)) throw new Error(`work-item ${w.id} depends on unknown id: ${d}`);
    }
  }

  // Longest-path (critical path) by cost, memoized over the DAG. earliestStart(i) =
  // max over deps of finish(dep); finish(i) = earliestStart(i) + cost(i). A re-entrant
  // visit means a cycle. `predOnPath` records which dep extends the longest chain so we
  // can reconstruct one critical path.
  const finish = new Map<string, number>();
  const start = new Map<string, number>();
  const predOnPath = new Map<string, string | null>();
  const visiting = new Set<string>();

  const resolve = (id: string): number => {
    const cached = finish.get(id);
    if (cached != null) return cached;
    if (visiting.has(id)) throw new Error(`dependency cycle through work-item: ${id}`);
    visiting.add(id);
    const w = byId.get(id)!;
    let earliest = 0;
    let pred: string | null = null;
    for (const d of w.dependsOn) {
      const depFinish = resolve(d);
      if (depFinish > earliest) {
        earliest = depFinish;
        pred = d;
      }
    }
    visiting.delete(id);
    const cost = costOf(w);
    if (!(cost >= 0)) throw new Error(`work-item ${id} has a negative/NaN cost: ${cost}`);
    start.set(id, earliest);
    predOnPath.set(id, pred);
    const f = earliest + cost;
    finish.set(id, f);
    return f;
  };

  let totalUnits = 0;
  let idealWallClockUnits = 0;
  let sink: string | null = null;
  for (const w of workItems) {
    totalUnits += costOf(w);
    const f = resolve(w.id);
    if (f > idealWallClockUnits) {
      idealWallClockUnits = f;
      sink = w.id;
    }
  }

  // Reconstruct one critical path (sink → source via predOnPath), then reverse.
  const path: string[] = [];
  for (let cur: string | null = sink; cur != null; cur = predOnPath.get(cur) ?? null) {
    path.push(cur);
  }
  path.reverse();

  // Peak concurrency under the ASAP schedule = max overlap of [start, finish) intervals.
  // A sweep over start/end events; ties resolved end-before-start so a zero-cost item
  // doesn't inflate the peak. This is the ideal bee count — more bees buy no speed-up.
  const events: { t: number; delta: number }[] = [];
  for (const w of workItems) {
    const s = start.get(w.id)!;
    const f = finish.get(w.id)!;
    if (f === s) continue; // zero-cost node occupies no bee-time
    events.push({ t: s, delta: +1 });
    events.push({ t: f, delta: -1 });
  }
  events.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t - b.t));
  let cur = 0;
  let idealBeeCount = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > idealBeeCount) idealBeeCount = cur;
  }
  // A DAG of only zero-cost items still needs at least one bee if it has work.
  if (idealBeeCount === 0 && workItems.length > 0) idealBeeCount = 1;

  const maxSpeedup = idealWallClockUnits > 0 ? totalUnits / idealWallClockUnits : 0;
  return { totalUnits, idealWallClockUnits, idealBeeCount, criticalPath: path, maxSpeedup };
}

/** A validation problem found in a scenario (id, dep, plantedBug, acceptance, cycle). */
export interface ScenarioProblem {
  scenarioId: string;
  field: string;
  message: string;
}

/**
 * Validate a scenario's internal consistency — pure, returns problems (empty == valid).
 * Catches the mistakes that would make the objective optimum or the seeded run
 * meaningless: empty/duplicate ids, dangling deps, a cycle (no computable ideal), a
 * planted bug not attached to a real item, and a `command`/`file-exists` acceptance
 * test missing its command/path.
 */
export function validateScenario(s: HiveScenario): ScenarioProblem[] {
  const problems: ScenarioProblem[] = [];
  const p = (field: string, message: string) => problems.push({ scenarioId: s.id, field, message });

  if (!s.id) p('id', 'scenario id is required');
  if (s.workItems.length === 0) p('workItems', 'a scenario needs at least one work-item');

  const ids = new Set<string>();
  for (const w of s.workItems) {
    if (!w.id) p('workItems', 'work-item id is required');
    if (ids.has(w.id)) p('workItems', `duplicate work-item id: ${w.id}`);
    ids.add(w.id);
    if (w.unitCost != null && !(w.unitCost >= 0)) {
      p('workItems', `work-item ${w.id} has a negative/NaN unitCost`);
    }
  }
  for (const w of s.workItems) {
    for (const d of w.dependsOn) {
      if (!ids.has(d)) p('workItems', `work-item ${w.id} depends on unknown id: ${d}`);
      if (d === w.id) p('workItems', `work-item ${w.id} depends on itself`);
    }
  }

  // Cycle / DAG check via the parallelism math (it throws on a cycle or dangling dep).
  // Only run when ids+deps are otherwise sound, so we don't double-report.
  if (problems.length === 0) {
    try {
      computeParallelismStructure(s.workItems);
    } catch (err) {
      p('workItems', `not a DAG: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!s.plantedBug?.inWorkItem) {
    p('plantedBug', 'plantedBug.inWorkItem is required (which item carries the defect)');
  } else if (!ids.has(s.plantedBug.inWorkItem)) {
    p('plantedBug', `plantedBug.inWorkItem references unknown work-item: ${s.plantedBug.inWorkItem}`);
  }
  if (!s.plantedBug?.location || !s.plantedBug?.detectionSignature) {
    p('plantedBug', 'plantedBug needs a location and a detectionSignature (un-gameable signal)');
  }

  if (s.acceptance.kind === 'command' && !s.acceptance.command) {
    p('acceptance', 'a command acceptance test needs a command');
  }
  if (s.acceptance.kind === 'file-exists' && !s.acceptance.path) {
    p('acceptance', 'a file-exists acceptance test needs a path');
  }

  return problems;
}
