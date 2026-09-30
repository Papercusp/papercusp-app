/**
 * Fleet-level (Hive-layer) metrics — P-025 / D-010. Where the per-task lib
 * (schema/aggregate) scores ONE task at a time (the L1 competence floor), this
 * module scores a whole BACKLOG handed to a fleet: L2 throughput (wall-clock
 * speedup vs serial, tasks/$, tasks/hr, drain time, autonomy), L3 value-capture
 * ($ captured under a fixed budget), and — via `./mast` — L4 coordination
 * quality. `buildHiveReport` is the importable surface the Evaluation UI's
 * Throughput / Value / Coordination subtabs (P-030) read.
 *
 * Treatment vs baseline: the `hive` arm (Queen + fleet) vs the `queen-ablated`
 * arm (same fleet, naive FIFO) — the delta IS the Queen's value (the NEW
 * HEADLINE, D-010). `native-serial` is the serial-throughput floor.
 */

import type { BenchSuite } from './schema';
import type { CoordEvent, MastReport, MastVerdict } from './mast';
import { scoreMast } from './mast';

/**
 * Fleet arm vocabulary — LOCKED with P-030 (the UI keys on these exact strings).
 * Open union so P-028's competitor orchestrators (`openhands-async`, `crewai`,
 * `langgraph`, …) slot in for the Coordination subtab without a type change.
 */
export type FleetArmId =
  | 'hive' //            treatment: Queen + bee fleet (intelligent placement/ranking/eviction)
  | 'queen-ablated' //   NEW HEADLINE baseline: same fleet, naive FIFO/round-robin (Queen OFF)
  | 'native-serial' //   serial floor: one native session draining the whole backlog
  | (string & {}); //    competitors (P-028): openhands-async | crewai | langgraph | …

export const MS_PER_HOUR = 3_600_000;

/**
 * One arm's run over a whole backlog — the input the fleet runners (P-022 hive,
 * P-023 queen-ablated, P-024 native-serial, P-028 competitors) emit, with the
 * fleet/coordination events captured by P-010's rollout layer.
 */
export interface FleetRunSummary {
  runId: string;
  suite: BenchSuite;
  arm: FleetArmId;
  /** Backlog size handed to the arm. */
  tasks: number;
  /** Tasks the external grader marked resolved. */
  resolved: number;
  /** Wall-clock to drain the whole backlog (ms). */
  wallClockMs: number;
  /** Total $ spent across the WHOLE fleet (coordination overhead counted). */
  costUsd: number;
  /** Total tokens across the whole fleet. */
  tokensTotal: number;
  /** Tasks completed with ZERO human gate (autonomy numerator). */
  tasksZeroHumanGate: number;
  /** Peak concurrent workers, for context (optional). */
  peakConcurrency?: number | null;
}

export interface ThroughputMetrics {
  arm: FleetArmId;
  tasks: number;
  resolved: number;
  /** Total $ spent draining the backlog (coordination overhead counted). */
  costUsd: number;
  /** Total tokens across the fleet. */
  tokensTotal: number;
  /** Backlog-drain wall-clock (ms). */
  backlogDrainMs: number;
  /** Tasks resolved per wall-clock hour. */
  resolvedPerHour: number;
  /** Tasks resolved per dollar (null if $0 spent). */
  resolvedPerDollar: number | null;
  /** Fraction of tasks completed with zero human gate. */
  autonomyRate: number;
  /** Wall-clock speedup vs the serial floor (serialMs / thisMs); null if no serial baseline. */
  speedupVsSerial: number | null;
}

/** Per-task $ value (UpBench / SWE-Lancer weighting) + whether the arm captured it. */
export interface TaskValue {
  taskId: string;
  /** $ value of the task. */
  dollarValue: number;
  resolved: boolean;
  /** $ spent attempting it. */
  costUsd: number;
}

export interface ValueMetrics {
  arm: FleetArmId;
  /** $ value of RESOLVED tasks — what the arm actually captured. */
  valueCaptured: number;
  /** $ value of the whole backlog. */
  valueAvailable: number;
  /** valueCaptured / valueAvailable. */
  captureRate: number;
  /** $ of work captured per $ of compute (null if $0 spent). */
  valuePerDollar: number | null;
  /** $ spent. */
  costUsd: number;
  /** The fixed budget the run was held to (null = unbudgeted). */
  budgetUsd: number | null;
  withinBudget: boolean;
}

export interface HiveArmReport {
  arm: FleetArmId;
  throughput: ThroughputMetrics;
  value: ValueMetrics | null;
  mast: MastReport | null;
}

/** hive − queen-ablated on the headline axes: the Queen's measured value. */
export interface HiveDelta {
  treatment: FleetArmId; // 'hive'
  baseline: FleetArmId; // 'queen-ablated'
  /** hive.resolvedPerHour / baseline.resolvedPerHour. */
  throughputRatio: number | null;
  /** hive.costUsd / baseline.costUsd. */
  costRatio: number | null;
  /** hive.valueCaptured − baseline.valueCaptured. */
  valueCapturedDelta: number | null;
  /** hive.failureRatePerTask − baseline.failureRatePerTask (NEGATIVE = hive coordinates better). */
  coordFailureRateDelta: number | null;
}

export interface HiveBacklogReport {
  runId: string;
  suite: BenchSuite;
  arms: HiveArmReport[];
  queenDelta: HiveDelta | null;
}

/** Throughput for one arm. Pass the serial floor's wall-clock for the speedup. */
export function throughputMetrics(summary: FleetRunSummary, serialWallClockMs?: number | null): ThroughputMetrics {
  const hours = summary.wallClockMs / MS_PER_HOUR;
  return {
    arm: summary.arm,
    tasks: summary.tasks,
    resolved: summary.resolved,
    costUsd: summary.costUsd,
    tokensTotal: summary.tokensTotal,
    backlogDrainMs: summary.wallClockMs,
    resolvedPerHour: hours === 0 ? 0 : summary.resolved / hours,
    resolvedPerDollar: summary.costUsd > 0 ? summary.resolved / summary.costUsd : null,
    autonomyRate: summary.tasks === 0 ? 0 : summary.tasksZeroHumanGate / summary.tasks,
    speedupVsSerial:
      serialWallClockMs != null && serialWallClockMs > 0 && summary.wallClockMs > 0
        ? serialWallClockMs / summary.wallClockMs
        : null,
  };
}

/** Value captured by an arm under a fixed budget. */
export function valueMetrics(taskValues: readonly TaskValue[], arm: FleetArmId, budgetUsd?: number | null): ValueMetrics {
  let valueCaptured = 0;
  let valueAvailable = 0;
  let costUsd = 0;
  for (const t of taskValues) {
    valueAvailable += t.dollarValue;
    costUsd += t.costUsd;
    if (t.resolved) valueCaptured += t.dollarValue;
  }
  return {
    arm,
    valueCaptured,
    valueAvailable,
    captureRate: valueAvailable === 0 ? 0 : valueCaptured / valueAvailable,
    valuePerDollar: costUsd > 0 ? valueCaptured / costUsd : null,
    costUsd,
    budgetUsd: budgetUsd ?? null,
    withinBudget: budgetUsd == null || costUsd <= budgetUsd,
  };
}

/** One arm's bundle of inputs for the report. */
export interface HiveArmInput {
  summary: FleetRunSummary;
  /** L3 — per-task $ values (SWE-Lancer; UpBench is citation-only per D-011). Omit for non-value runs. */
  taskValues?: TaskValue[];
  /** L4 — the raw coordination trace (P-010 emits) for objective substrate-signal rates. */
  coordEvents?: CoordEvent[];
  /** L4 — our LLM-judge's 14-mode MAST verdicts (methodology-aligned per-category rates). */
  mastVerdicts?: MastVerdict[];
}

function deltaOrNull(a: number | null, b: number | null): number | null {
  return a != null && b != null ? a - b : null;
}

/** The headline coordination-failure rate for a MAST report: the judge's overall
 *  rate if available, else the summed objective substrate rates as a floor. */
export function mastHeadlineRate(report: MastReport | null): number | null {
  if (!report) return null;
  if (report.overallFailureRate != null) return report.overallFailureRate;
  if (report.substrate) {
    const s = report.substrate;
    return s.duplicationRate + s.coordinationBreakdownRate + s.misalignmentRate + s.redundantWorkRate;
  }
  return null;
}

export interface HiveReportOpts {
  /** Which arm is the serial floor for speedup. Default 'native-serial'. */
  serialArm?: FleetArmId;
  /** Fixed $ budget the value run was held to. */
  budgetUsd?: number | null;
}

const HIVE: FleetArmId = 'hive';
const QUEEN_ABLATED: FleetArmId = 'queen-ablated';

/**
 * Build the per-suite Hive-backlog report (throughput + value + MAST per arm,
 * plus the hive−queen-ablated delta). `arms` is one bundle per arm; the serial
 * floor's wall-clock drives every arm's speedup.
 */
export function buildHiveReport(arms: readonly HiveArmInput[], opts: HiveReportOpts = {}): HiveBacklogReport {
  if (arms.length === 0) throw new Error('buildHiveReport: no arms');
  const serialArm = opts.serialArm ?? 'native-serial';
  const serial = arms.find((a) => a.summary.arm === serialArm);
  const serialMs = serial ? serial.summary.wallClockMs : null;
  const runId = arms[0].summary.runId;
  const suite = arms[0].summary.suite;

  const reports: HiveArmReport[] = arms.map((a) => ({
    arm: a.summary.arm,
    throughput: throughputMetrics(a.summary, serialMs),
    value: a.taskValues ? valueMetrics(a.taskValues, a.summary.arm, opts.budgetUsd) : null,
    mast:
      a.coordEvents || a.mastVerdicts
        ? scoreMast({ arm: a.summary.arm, tasks: a.summary.tasks, verdicts: a.mastVerdicts, trace: a.coordEvents })
        : null,
  }));

  const byArm = new Map(reports.map((r) => [r.arm, r]));
  const hive = byArm.get(HIVE);
  const base = byArm.get(QUEEN_ABLATED);
  let queenDelta: HiveDelta | null = null;
  if (hive && base) {
    queenDelta = {
      treatment: HIVE,
      baseline: QUEEN_ABLATED,
      throughputRatio:
        base.throughput.resolvedPerHour > 0 ? hive.throughput.resolvedPerHour / base.throughput.resolvedPerHour : null,
      costRatio: base.throughput.costUsd > 0 ? hive.throughput.costUsd / base.throughput.costUsd : null,
      valueCapturedDelta: hive.value && base.value ? hive.value.valueCaptured - base.value.valueCaptured : null,
      coordFailureRateDelta: deltaOrNull(mastHeadlineRate(hive.mast), mastHeadlineRate(base.mast)),
    };
  }

  return { runId, suite, arms: reports, queenDelta };
}
