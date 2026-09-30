/**
 * capability-attribution.ts — per-capability attribution + cross-suite roll-up
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-011 / Phase 4 reporting).
 *
 * `buildSuiteReport` gives per-arm pass@1/pass^k + the cost/accuracy Pareto + pairwise
 * treatment-vs-baseline deltas. This module adds the attribution view P-011 needs:
 *
 *   1. A FIXED-CONTROL per-capability lift. The arms are `vanilla` (control) + the
 *      single-capability arms `+memory` / `+coord` / `+workqueue` + the `ours` bundle. We
 *      hold the control fixed and read each other arm's lift OVER it — value delta,
 *      cost-normalized (costPerResolved ratio + Pareto-dominance), CI-non-overlap
 *      significance, and per-task unlocked/regressed buckets (the "which capability, which
 *      task" narrative).
 *
 *   2. A CROSS-SUITE roll-up — the suite × capability headline matrix + a per-capability
 *      summary across suites.
 *
 * FAIRNESS (binding — /internal/docs/benchmarks/fairness-criteria.mdx, C1/C3/C6). A
 * cross-arm comparison is only fair on the SAME DENOMINATOR: every arm scored on the same
 * N, where a task an arm did not resolve — empty output, infra-failed, or absent — scores
 * `false`, NEVER silently excluded (excluding one arm's non-completions while the other
 * attempted all N is the single most common way to fake a win, C1). So this module's
 * DEFAULT headline (`sameDenominator: true`) scores each arm over the UNION of the
 * (control, capability) task sets, counting an infra/absent task as a 0 — and exposes
 * per-arm COVERAGE counts (attempted / produced / infra-failed, C6). The exclude-infra
 * view (each arm over only its own scored tasks — what `aggregateArm`/`buildSuiteReport`
 * compute, the METR "an infra error is not a capability fail" discipline) is the
 * clearly-labelled SECONDARY view (`sameDenominator: false`): correct for ONE arm's
 * capability headline, but it drops the tasks one arm could not attempt, which flatters the
 * weaker-coverage arm — never the cross-arm headline.
 *
 * BOOLEAN *and* CONTINUOUS suites (the `metric` option). Boolean-resolved suites attribute
 * on **pass@1**; continuous / partial-credit suites (SwarmBench sim score, AgentsNet,
 * rubric suites — `resolved=null` + a numeric `score`) attribute on **meanScore** (pass@1
 * would read every continuous row as a fail). Both produce the SAME
 * {@link CapabilityArmAttribution} shape, so a continuous suite's +coord lift sits in the
 * SAME cross-suite headline as a boolean suite's +memory lift.
 *
 * Domain-free: the control + capability arms are just arm ids, so it lives in
 * `@papercusp/bench-metrics` next to `buildSuiteReport`.
 */
import type { ArmId, BenchSuite, TaskRunResult } from './schema';
import type { Interval } from './intervals';
import { bootstrapMeanCI } from './intervals';
import { aggregateArm, type AggregateOpts } from './aggregate';
import { isScored } from './cost';

/** The default control arm every capability is attributed OVER (the empty / bare-model profile). */
export const DEFAULT_CONTROL_ARM: ArmId = 'vanilla';

/** Which metric the lift is read on. `passAt1` = boolean-resolved suites; `meanScore` = continuous/partial-credit. */
export type AttributionMetric = 'passAt1' | 'meanScore';

// Mirror aggregate.ts's bootstrap defaults so the CI here matches buildSuiteReport's pass@1 CI.
const DEFAULT_SEED = 0xbe0c;
const DEFAULT_ITERATIONS = 10_000;

/** Per-arm coverage over the comparison's task universe (the C6 audit counts). */
export interface ArmCoverage {
  /** Tasks in the comparison universe (control ∪ capability task ids). */
  tasks: number;
  /** Tasks with ≥1 scored row (the arm produced a gradeable result). */
  produced: number;
  /** Tasks with rows but ZERO scored (all infra-failed) — counted `false` under same-denominator. */
  infraOnly: number;
  /** Tasks in the universe with NO row for this arm — counted `false` under same-denominator. */
  absent: number;
  /** Seed-level: rows that passed generation+grader infra (gradeable). */
  scoredSeeds: number;
  /** Seed-level: rows excluded by infra (generation/grader error/timeout). */
  infraSeeds: number;
}

/** One capability arm's lift over the control, with cost-normalization + per-task attribution. */
export interface CapabilityArmAttribution {
  /** The capability arm (e.g. `+memory`, `+coord`, `ours`). */
  capability: ArmId;
  /** The control arm it is attributed over (e.g. `vanilla`). */
  control: ArmId;
  /** Which metric `value`/`valueDelta` are in (`passAt1` boolean suites | `meanScore` continuous suites). */
  metric: AttributionMetric;
  /** TRUE = the C1 fair headline (union-N, infra/absent = false); FALSE = the exclude-infra secondary view. */
  sameDenominator: boolean;
  /** value(capability) − value(control). Positive ⇒ the capability lifts the metric. */
  valueDelta: number;
  /** The control arm's headline value (pass@1 or meanScore) under the active denominator policy. */
  controlValue: number;
  /** The capability arm's headline value under the active denominator policy. */
  capabilityValue: number;
  /** Bootstrap-over-tasks CIs for both arms' values. */
  controlValueCi: Interval;
  capabilityValueCi: Interval;
  /** TRUE when the two value CIs do NOT overlap — a conservative "this lift is real" flag. */
  significant: boolean;
  /** costPerResolved(capability) / costPerResolved(control). <1 ⇒ cheaper per resolved task (D-008/C3).
   *  null when either arm resolved nothing — incl. pure-continuous suites (no boolean resolved). */
  costRatio: number | null;
  /** capability mean-$/attempt as a fraction of the control's ("at Z% of the cost"). null if control free. */
  costFraction: number | null;
  /** Is the capability STRICTLY Pareto-better than the control (≥ value AND ≤ cost, > on one axis)? (D-008/C3) */
  paretoDominates: boolean;
  /** Tasks the capability UNLOCKED: capability value strictly > control's (over the active denominator). */
  unlockedTasks: string[];
  /** Tasks the capability REGRESSED: capability value strictly < control's. */
  regressedTasks: string[];
  /** Tasks where both arms score the same value (no attribution signal). */
  neutralTasks: string[];
  /** Count of tasks compared = |control ∪ capability| under same-denominator; |intersection of scored| otherwise. */
  tasksCompared: number;
  /** Per-arm coverage over the comparison universe (C6) — the audit table's attempted/produced/infra counts. */
  controlCoverage: ArmCoverage;
  capabilityCoverage: ArmCoverage;
}

/** The per-suite attribution report: every non-control arm's lift over the control. */
export interface CapabilityAttributionReport {
  suite: BenchSuite;
  runId: string;
  control: ArmId;
  metric: AttributionMetric;
  sameDenominator: boolean;
  /** One row per capability arm (single-capability arms + the bundle), in input arm order. */
  capabilities: CapabilityArmAttribution[];
  /** MANDATORY honest-framing lines (D-008/D-011 + fairness C1/C3/C6) — a renderer must surface these. */
  caveats: string[];
}

export interface CapabilityAttributionOpts extends AggregateOpts {
  /** The control arm (default {@link DEFAULT_CONTROL_ARM} = `vanilla`). */
  control?: ArmId;
  /** Restrict attribution to these capability arms (default: every non-control arm, first-seen order). */
  capabilityArms?: ArmId[];
  /** Boolean-resolved (`passAt1`, default) vs continuous/partial-credit (`meanScore`) suites. */
  metric?: AttributionMetric;
  /** C1 fair headline (default TRUE): score both arms on the union-N, infra/absent = false. Set FALSE for
   *  the exclude-infra secondary view (each arm over only its own scored tasks). */
  sameDenominator?: boolean;
}

/** Per-(task) accumulated stats for ONE arm, over ALL its rows (infra rows included). */
interface TaskStats {
  /** Seeds that passed generation+grader infra. */
  scoredSeeds: number;
  /** Seeds excluded by infra. */
  infraSeeds: number;
  /** Resolved seeds (resolved===true) among scored. */
  resolvedSeeds: number;
  /** Sum of numeric `score` over scored seeds (meanScore numerator). */
  scoreSum: number;
  /** Scored seeds carrying a numeric `score` (meanScore exclude-infra denominator). */
  scoreCountScored: number;
}

/** Accumulate per-task stats for one arm's rows. */
function armTaskStats(rows: readonly TaskRunResult[]): Map<string, TaskStats> {
  const m = new Map<string, TaskStats>();
  for (const r of rows) {
    const s = m.get(r.taskId) ?? { scoredSeeds: 0, infraSeeds: 0, resolvedSeeds: 0, scoreSum: 0, scoreCountScored: 0 };
    if (isScored(r)) {
      s.scoredSeeds += 1;
      if (r.resolved === true) s.resolvedSeeds += 1;
      if (typeof r.score === 'number') {
        s.scoreSum += r.score;
        s.scoreCountScored += 1;
      }
    } else {
      s.infraSeeds += 1;
    }
    m.set(r.taskId, s);
  }
  return m;
}

/**
 * One task's value in [0,1] for an arm under a denominator policy + metric.
 *  - sameDenominator (C1): infra seeds count in the denominator (as 0); an absent task (no stats) = 0.
 *    passAt1 = resolvedSeeds/(scored+infra); meanScore = scoreSum/(scored+infra).
 *  - exclude-infra: only scored seeds; passAt1 = resolved/scored; meanScore = scoreSum/scoreCountScored.
 *    Returns null when the arm has no scored seeds for the task (it is not in this arm's scored set).
 */
function taskValue(stats: TaskStats | undefined, metric: AttributionMetric, sameDenominator: boolean): number | null {
  if (sameDenominator) {
    const denom = (stats?.scoredSeeds ?? 0) + (stats?.infraSeeds ?? 0);
    if (denom === 0) return 0; // absent task → false under same-denominator.
    return metric === 'meanScore' ? (stats!.scoreSum) / denom : stats!.resolvedSeeds / denom;
  }
  if (!stats || stats.scoredSeeds === 0) return null; // exclude-infra: not in this arm's scored set.
  return metric === 'meanScore'
    ? (stats.scoreCountScored === 0 ? 0 : stats.scoreSum / stats.scoreCountScored)
    : stats.resolvedSeeds / stats.scoredSeeds;
}

/** An arm's headline value (mean over tasks of per-task value) + bootstrap-over-tasks CI. */
function armValue(values: number[], opts: CapabilityAttributionOpts): { value: number; ci: Interval } {
  const value = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  const ci = bootstrapMeanCI(values, {
    ci: opts.ci ?? 0.95,
    seed: opts.bootstrapSeed ?? DEFAULT_SEED,
    iterations: opts.bootstrapIterations ?? DEFAULT_ITERATIONS,
  });
  return { value, ci };
}

/** Coverage counts for an arm over the comparison universe. */
function coverageFor(stats: Map<string, TaskStats>, universe: Set<string>): ArmCoverage {
  let produced = 0;
  let infraOnly = 0;
  let absent = 0;
  let scoredSeeds = 0;
  let infraSeeds = 0;
  for (const taskId of universe) {
    const s = stats.get(taskId);
    if (!s) {
      absent += 1;
      continue;
    }
    scoredSeeds += s.scoredSeeds;
    infraSeeds += s.infraSeeds;
    if (s.scoredSeeds > 0) produced += 1;
    else infraOnly += 1;
  }
  return { tasks: universe.size, produced, infraOnly, absent, scoredSeeds, infraSeeds };
}

/** Two CIs are non-overlapping (a conservative significance test) when one's upper < the other's lower. */
function ciDisjoint(a: Interval, b: Interval): boolean {
  return a.upper < b.lower || b.upper < a.lower;
}

/** Mean $/attempt for an arm (the cost axis; mirrors `buildSuiteReport`'s Pareto points). */
function costPerAttempt(costUsd: number, attempts: number): number {
  return attempts === 0 ? 0 : costUsd / attempts;
}

/**
 * Build the per-suite capability-attribution report: hold `control` fixed and read every other arm's lift
 * over it. The DEFAULT is the C1 fair headline (same-denominator: every arm over the union-N, infra/absent =
 * false); pass `sameDenominator: false` for the exclude-infra secondary view. Cost from {@link aggregateArm}
 * (numbers identical to {@link buildSuiteReport}); the value/CI/per-task buckets honor the denominator policy.
 *
 * Throws when `rows` is empty or the control arm has no rows.
 */
export function buildCapabilityAttribution(
  rows: readonly TaskRunResult[],
  opts: CapabilityAttributionOpts = {},
): CapabilityAttributionReport {
  if (rows.length === 0) throw new Error('buildCapabilityAttribution: no rows');
  const control = opts.control ?? DEFAULT_CONTROL_ARM;
  const metric = opts.metric ?? 'passAt1';
  const sameDenominator = opts.sameDenominator ?? true;
  const suite = rows[0].suite;
  const runId = rows[0].runId;

  const controlRows = rows.filter((r) => r.arm === control);
  if (controlRows.length === 0) {
    throw new Error(`buildCapabilityAttribution: control arm "${control}" has no rows (arms present: ${[...new Set(rows.map((r) => r.arm))].join(', ')})`);
  }

  const armOrder = [...new Set(rows.map((r) => r.arm))];
  const capabilityArms = (opts.capabilityArms ?? armOrder).filter((a) => a !== control);

  const controlAgg = aggregateArm(controlRows, suite, control, opts);
  const controlStats = armTaskStats(controlRows);
  const controlCostPerAttempt = costPerAttempt(controlAgg.cost.costUsd, controlAgg.attempts);

  const capabilities: CapabilityArmAttribution[] = [];
  for (const arm of capabilityArms) {
    const armRows = rows.filter((r) => r.arm === arm);
    if (armRows.length === 0) continue;
    const armAgg = aggregateArm(armRows, suite, arm, opts);
    const armStats = armTaskStats(armRows);

    // The comparison universe = control ∪ capability task ids. Under same-denominator every task in the
    // universe is scored for BOTH arms (infra/absent = 0); under exclude-infra only tasks scored in both count.
    const universe = new Set<string>([...controlStats.keys(), ...armStats.keys()]);

    const controlVals: number[] = [];
    const armVals: number[] = [];
    const unlockedTasks: string[] = [];
    const regressedTasks: string[] = [];
    const neutralTasks: string[] = [];
    for (const taskId of universe) {
      const cv = taskValue(controlStats.get(taskId), metric, sameDenominator);
      const av = taskValue(armStats.get(taskId), metric, sameDenominator);
      // exclude-infra: only compare tasks scored in BOTH arms (cv/av non-null); same-denom: always non-null.
      if (cv === null || av === null) continue;
      controlVals.push(cv);
      armVals.push(av);
      if (av > cv) unlockedTasks.push(taskId);
      else if (av < cv) regressedTasks.push(taskId);
      else neutralTasks.push(taskId);
    }

    const controlV = armValue(controlVals, opts);
    const armV = armValue(armVals, opts);

    const armCostPerAttempt = costPerAttempt(armAgg.cost.costUsd, armAgg.attempts);
    const cpr = armAgg.cost.costPerResolved;
    const ctrlCpr = controlAgg.cost.costPerResolved;
    const costRatio = cpr !== null && ctrlCpr !== null && ctrlCpr !== 0 ? cpr / ctrlCpr : null;
    const costFraction = controlCostPerAttempt === 0 ? null : armCostPerAttempt / controlCostPerAttempt;
    const paretoDominates =
      armV.value >= controlV.value &&
      armCostPerAttempt <= controlCostPerAttempt &&
      (armV.value > controlV.value || armCostPerAttempt < controlCostPerAttempt);

    capabilities.push({
      capability: arm,
      control,
      metric,
      sameDenominator,
      valueDelta: armV.value - controlV.value,
      controlValue: controlV.value,
      capabilityValue: armV.value,
      controlValueCi: controlV.ci,
      capabilityValueCi: armV.ci,
      significant: ciDisjoint(controlV.ci, armV.ci),
      costRatio,
      costFraction,
      paretoDominates,
      unlockedTasks: unlockedTasks.sort(),
      regressedTasks: regressedTasks.sort(),
      neutralTasks: neutralTasks.sort(),
      tasksCompared: unlockedTasks.length + regressedTasks.length + neutralTasks.length,
      controlCoverage: coverageFor(controlStats, universe),
      capabilityCoverage: coverageFor(armStats, universe),
    });
  }

  return { suite, runId, control, metric, sameDenominator, capabilities, caveats: ATTRIBUTION_CAVEATS };
}

/** The mandatory honest-framing lines that ride every attribution report (D-008/D-011 + fairness C1/C3/C6). */
export const ATTRIBUTION_CAVEATS: string[] = [
  'SAME DENOMINATOR (fairness C1/C6, the default): both arms are scored on the SAME union-N — a task an arm did not resolve (empty output, infra-failed, or absent) scores `false`, never excluded. The exclude-infra view (sameDenominator:false) is a labelled SECONDARY only — it drops tasks one arm could not attempt, which flatters the weaker-coverage arm. Read controlCoverage/capabilityCoverage (attempted/produced/infra) for the audit (C6).',
  'PRIMARY = single-capability arms (D-011): the story is the per-capability lift (+memory / +coord / +workqueue), each over the same vanilla control; the `ours` bundle is confirmatory, not the headline.',
  'COST-NORMALIZED (D-008/C3): a capability "wins" only if it lifts the metric at equal-or-better cost — read `paretoDominates` + `costRatio` (costPerResolved capability/control; <1 = cheaper per resolved task), never the raw value delta alone. Report $/task + calls/task.',
  'SIGNIFICANCE is CI-non-overlap on the headline value (bootstrap over tasks) — a CONSERVATIVE flag: it under-reports real lifts rather than over-claiming. A non-significant positive delta is suggestive, not established; ≥2 seeds per arm for a real claim (C8).',
  'PER-TASK buckets (unlocked / regressed) are DESCRIPTIVE and seed-noisy. METRIC: boolean-resolved suites attribute on pass@1; continuous / partial-credit suites attribute on meanScore — the value delta is in that suite\'s metric, never mixed across metrics.',
];

/* ----------------------------- cross-suite roll-up ----------------------------- */

/** One cell of the headline matrix: a capability's attribution on one suite (compact). */
export interface CrossSuiteCell {
  suite: BenchSuite;
  capability: ArmId;
  metric: AttributionMetric;
  sameDenominator: boolean;
  valueDelta: number;
  significant: boolean;
  costRatio: number | null;
  paretoDominates: boolean;
  unlockedCount: number;
  regressedCount: number;
}

/** A capability's summary ACROSS suites (the "+memory lifts on N/M suites" line). */
export interface CapabilityRollup {
  capability: ArmId;
  /** Suites this capability ran on (had a row). */
  suites: number;
  /** Mean value delta over those suites (simple mean — each suite weighted equally).
   *  NB this mixes pass@1 + meanScore deltas across suites of different metrics; read it as a coarse
   *  "net direction" indicator and rely on the per-suite cells for the honest per-metric number. */
  meanValueDelta: number;
  /** Suites where the lift was significant (CI-disjoint). */
  suitesSignificant: number;
  /** Suites where the capability was strictly Pareto-better than the control. */
  suitesParetoBetter: number;
  /** Total tasks unlocked across suites. */
  totalUnlocked: number;
  /** Total tasks regressed across suites (the honest counter-evidence). */
  totalRegressed: number;
}

export interface CrossSuiteAttribution {
  /** suite × capability cells (every report's every capability), in report-then-arm order. */
  cells: CrossSuiteCell[];
  /** Per-capability summary across the suites it appeared on. */
  rollup: CapabilityRollup[];
  caveats: string[];
}

/**
 * Fold many per-suite {@link CapabilityAttributionReport}s into the headline cross-suite matrix + a
 * per-capability roll-up. Pure aggregation over the per-suite reports (no re-scoring). A capability is rolled
 * up over exactly the suites it appeared on; `meanValueDelta` weights each such suite equally.
 */
export function buildCrossSuiteAttribution(reports: readonly CapabilityAttributionReport[]): CrossSuiteAttribution {
  const cells: CrossSuiteCell[] = [];
  for (const rep of reports) {
    for (const cap of rep.capabilities) {
      cells.push({
        suite: rep.suite,
        capability: cap.capability,
        metric: cap.metric,
        sameDenominator: cap.sameDenominator,
        valueDelta: cap.valueDelta,
        significant: cap.significant,
        costRatio: cap.costRatio,
        paretoDominates: cap.paretoDominates,
        unlockedCount: cap.unlockedTasks.length,
        regressedCount: cap.regressedTasks.length,
      });
    }
  }

  const order: ArmId[] = [];
  const byCap = new Map<ArmId, CrossSuiteCell[]>();
  for (const c of cells) {
    if (!byCap.has(c.capability)) {
      byCap.set(c.capability, []);
      order.push(c.capability);
    }
    byCap.get(c.capability)!.push(c);
  }
  const rollup: CapabilityRollup[] = order.map((capability) => {
    const cs = byCap.get(capability)!;
    const suites = cs.length;
    return {
      capability,
      suites,
      meanValueDelta: suites === 0 ? 0 : cs.reduce((s, c) => s + c.valueDelta, 0) / suites,
      suitesSignificant: cs.filter((c) => c.significant).length,
      suitesParetoBetter: cs.filter((c) => c.paretoDominates).length,
      totalUnlocked: cs.reduce((s, c) => s + c.unlockedCount, 0),
      totalRegressed: cs.reduce((s, c) => s + c.regressedCount, 0),
    };
  });

  return { cells, rollup, caveats: ATTRIBUTION_CAVEATS };
}

/* ----------------------------- narrative formatting ----------------------------- */

/**
 * One human-readable line per capability for a suite report — the narrative the methodology doc / report
 * surface prints. Pure formatting over {@link buildCapabilityAttribution}'s output (no recompute). Marks a
 * significant + Pareto-better lift "✓", a positive-but-unconfirmed lift "~", a regression "✗".
 */
export function formatAttributionLines(report: CapabilityAttributionReport): string[] {
  return report.capabilities.map((c) => {
    const delta =
      c.metric === 'passAt1'
        ? (c.valueDelta >= 0 ? '+' : '') + (c.valueDelta * 100).toFixed(1) + 'pp pass@1'
        : (c.valueDelta >= 0 ? '+' : '') + c.valueDelta.toFixed(3) + ' meanScore';
    const mark = c.valueDelta > 0 && c.significant && c.paretoDominates ? '✓' : c.valueDelta > 0 ? '~' : c.valueDelta < 0 ? '✗' : '·';
    const cost = c.costRatio === null ? 'cost n/a' : `${c.costRatio.toFixed(2)}× $/resolved`;
    const sig = c.significant ? 'sig' : 'ns';
    const tasks = `${c.unlockedTasks.length}↑/${c.regressedTasks.length}↓ of ${c.tasksCompared}`;
    const infra = c.capabilityCoverage.infraOnly + c.capabilityCoverage.absent;
    const infraNote = infra > 0 ? `, ${infra} cap-noncompletion=false` : '';
    return `${mark} ${c.capability} vs ${c.control} on ${report.suite}: ${delta} (${sig}), ${cost}, tasks ${tasks}${infraNote}`;
  });
}
