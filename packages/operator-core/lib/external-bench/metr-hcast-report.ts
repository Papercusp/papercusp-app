/**
 * METR HCAST REPORT (plan benchmark-suite-metr-hcast-2026-06-17 Phase 3, P-006/P-007).
 *
 * Folds the per-arm {@link MetrHcastTaskResult}[] from the runner into the suite's HEADLINE: a per-arm
 * 50%/80%-time-horizon fit (+ bootstrap CIs) and the hive-vs-single-opus horizon LIFT. This is the
 * `suite='metr-hcast'` report — per-task pass/fail rides the normal run-result fields, but the headline is
 * this derived run-level metric (the horizon), computed by @papercusp/bench-metrics' faithful METR port.
 *
 * THE HONEST FRAMING IS LOAD-BEARING (D-002 / D-003) and is encoded here, not left to the reader:
 *  - The ABSOLUTE horizon on the ~31-task open subset (only ~18 carry a human-time baseline, spanning
 *    ~2–95 min vs METR's full seconds→8 h) is NOISY/biased with wide CIs and is NOT leaderboard-comparable.
 *    {@link MetrHcastReport.caveats} states this; callers MUST surface it (never quote the absolute number
 *    as a METR-comparable horizon).
 *  - The LIFT (treatment=hive `papercusp` vs baseline=single-opus `baseline-a-ablation`, SAME tasks) cancels
 *    much of the subset bias and is the DEFENSIBLE signal. {@link MetrHcastReport.lifts} is the headline.
 *  - The metric is single-agent by construction; the hive arm is OUR framing, labelled as such (D-003).
 */
import {
  fitHorizon,
  horizonLift,
  type HorizonCIOpts,
  type HorizonFit,
  type HorizonLift,
  type HorizonPoint,
  type HorizonTask,
  type HorizonWeighting,
} from '@papercusp/bench-metrics';
import type { MetrHcastTaskResult } from './metr-hcast-runner';

/** The treatment (hive) + baseline (single-opus) arm ids the lift is computed between. */
export const METR_HCAST_TREATMENT_ARM = 'papercusp';
export const METR_HCAST_BASELINE_ARM = 'baseline-a-ablation';

/** One arm's horizon fit over the human-time-baselined tasks it was scored on. */
export interface MetrHcastArmHorizon {
  arm: string;
  /** Tasks that contributed to the fit (≥1 scored attempt AND a human-time baseline). */
  horizonTasks: number;
  /** Distinct human-time-baselined tasks attempted (incl. those dropped for being all-infra). */
  baselinedTasksSeen: number;
  /** Mean per-task success rate over the fit tasks (weighted by the scheme). */
  meanSuccess: number;
  fit: HorizonFit;
  /** p50/p80 horizons (minutes) with bootstrap CIs. */
  points: HorizonPoint[];
}

/** The full METR HCAST report — the headline derived metric for `suite='metr-hcast'`. */
export interface MetrHcastReport {
  suite: 'metr-hcast';
  runId?: string;
  weighting: HorizonWeighting;
  quantiles: number[];
  arms: MetrHcastArmHorizon[];
  /** The headline: hive-vs-single-opus horizon lift at each quantile (empty if an arm is missing). */
  lifts: HorizonLift[];
  /** Human-time baseline span (minutes) over the fit tasks — context for the "noisy small subset" caveat. */
  humanTimeRangeMin: [number, number] | null;
  /** MANDATORY honest-framing lines — callers MUST surface these (D-002/D-003). */
  caveats: string[];
}

export interface MetrHcastReportOpts {
  runId?: string;
  /** Task weighting (default 'invsqrt' — METR's headline scheme). */
  weighting?: HorizonWeighting;
  /** Quantiles to read off (default [0.5, 0.8]). */
  quantiles?: number[];
  /** Bootstrap iterations for CIs (default 1000). */
  bootstrap?: number;
  /** Confidence level (default 0.95). */
  ci?: number;
  /** PRNG seed (deterministic). */
  seed?: number;
}

/** Aggregate one arm's per-(task×seed) results → per-task {@link HorizonTask} (mean success over scored seeds). */
export function toHorizonTasks(results: readonly MetrHcastTaskResult[]): {
  tasks: HorizonTask[];
  baselinedTasksSeen: number;
} {
  // Group by instanceId.
  const byTask = new Map<string, { scores: number[]; humanMinutes: number | null; family: string }>();
  for (const r of results) {
    const id = r.attempt.instanceId;
    const fam = (typeof r.attempt.armMeta?.['family'] === 'string' ? (r.attempt.armMeta['family'] as string) : id.split('__')[0]);
    const g = byTask.get(id) ?? { scores: [], humanMinutes: r.humanMinutes, family: fam };
    // Only SCORED rows (resolved !== null) count; infra-null rows are excluded (METR discipline). Use the
    // task's CONTINUOUS score in [0,1] (METR's logistic fits fractional success) — for binary tasks this
    // equals resolved, but for partial-credit tasks (e.g. symbolic_regression) it preserves partial credit
    // instead of binarizing at 1.0 and throwing the signal away.
    if (r.grade.resolved !== null) {
      const s = r.grade.score != null ? Math.min(1, Math.max(0, r.grade.score)) : r.grade.resolved ? 1 : 0;
      g.scores.push(s);
    }
    if (r.humanMinutes != null) g.humanMinutes = r.humanMinutes;
    byTask.set(id, g);
  }

  let baselinedTasksSeen = 0;
  const tasks: HorizonTask[] = [];
  for (const [taskId, g] of byTask) {
    if (g.humanMinutes == null) continue; // no human-time baseline → can't contribute to the horizon fit
    baselinedTasksSeen += 1;
    if (g.scores.length === 0) continue; // all attempts infra-failed → no scored signal, drop from the fit
    const successRate = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
    tasks.push({ taskId, humanMinutes: g.humanMinutes, successRate, family: g.family });
  }
  return { tasks, baselinedTasksSeen };
}

function armHorizon(arm: string, results: readonly MetrHcastTaskResult[], opts: HorizonCIOpts): MetrHcastArmHorizon {
  const { tasks, baselinedTasksSeen } = toHorizonTasks(results);
  const { fit, points } = fitHorizon(tasks, opts);
  const weights = tasks.length;
  const meanSuccess = weights > 0 ? tasks.reduce((a, t) => a + t.successRate, 0) / weights : 0;
  return { arm, horizonTasks: tasks.length, baselinedTasksSeen, meanSuccess, fit, points };
}

/**
 * Build the METR HCAST report from per-arm runner results. `resultsByArm` keys are arm ids (at least the
 * treatment `papercusp` and baseline `baseline-a-ablation` for a lift). Returns per-arm horizons + the lift +
 * the mandatory honest-framing caveats.
 */
export function buildMetrHcastReport(
  resultsByArm: Record<string, readonly MetrHcastTaskResult[]>,
  opts: MetrHcastReportOpts = {},
): MetrHcastReport {
  const weighting: HorizonWeighting = opts.weighting ?? 'invsqrt';
  const quantiles = opts.quantiles ?? [0.5, 0.8];
  const fitOpts: HorizonCIOpts = {
    weighting,
    quantiles,
    bootstrap: opts.bootstrap ?? 1000,
    ci: opts.ci ?? 0.95,
    seed: opts.seed ?? 12345,
    regularization: 1e-5,
  };

  const arms = Object.entries(resultsByArm).map(([arm, results]) => armHorizon(arm, results, fitOpts));

  // Lift: treatment (hive) vs baseline (single-opus) at each quantile, when both arms are present.
  const treatment = arms.find((a) => a.arm === METR_HCAST_TREATMENT_ARM);
  const baseline = arms.find((a) => a.arm === METR_HCAST_BASELINE_ARM);
  const lifts: HorizonLift[] = [];
  if (treatment && baseline) {
    for (const q of quantiles) {
      const tp = treatment.points.find((p) => p.quantile === q);
      const bp = baseline.points.find((p) => p.quantile === q);
      if (tp && bp) lifts.push(horizonLift(tp, bp));
    }
  }

  // Human-time span over the union of fit tasks (context for the noise caveat).
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arms) {
    for (const r of resultsByArm[a.arm] ?? []) {
      if (r.humanMinutes != null) {
        lo = Math.min(lo, r.humanMinutes);
        hi = Math.max(hi, r.humanMinutes);
      }
    }
  }
  const humanTimeRangeMin: [number, number] | null = Number.isFinite(lo) ? [lo, hi] : null;

  const nFit = Math.max(0, ...arms.map((a) => a.horizonTasks), 0);
  const caveats = [
    `ABSOLUTE HORIZON IS ILLUSTRATIVE-ONLY (D-002): fit on ${nFit} human-time-baselined open tasks` +
      `${humanTimeRangeMin ? ` spanning ~${humanTimeRangeMin[0].toFixed(0)}–${humanTimeRangeMin[1].toFixed(0)} min` : ''}` +
      ` — a small, short-skewed subset (METR's full suite spans seconds→8 h). Wide CIs; NOT leaderboard-comparable; do NOT quote as a METR-published horizon.`,
    `THE LIFT IS THE DEFENSIBLE SIGNAL (D-002): treatment (hive, '${METR_HCAST_TREATMENT_ARM}') vs baseline (single-opus, '${METR_HCAST_BASELINE_ARM}') on the SAME tasks cancels much of the subset bias. Report as "hive 50%-horizon X (CI …) vs single-opus Y (CI …) — a Z× lift", not "our system has an N-hour horizon".`,
    `THE METRIC IS SINGLE-AGENT BY CONSTRUCTION (D-003): METR's published horizons are single-agent; the hive-vs-single-opus lift is OUR framing — label it as such, not as a METR-published comparison.`,
  ];

  return {
    suite: 'metr-hcast',
    ...(opts.runId ? { runId: opts.runId } : {}),
    weighting,
    quantiles,
    arms,
    lifts,
    humanTimeRangeMin,
    caveats,
  };
}

/** A compact one-screen human summary of the report — the headline lift + per-arm horizons + caveats. */
export function formatMetrHcastReport(report: MetrHcastReport): string {
  const fmtMin = (m: number): string =>
    !Number.isFinite(m) ? (m === Infinity ? '>range' : 'n/a') : m >= 60 ? `${(m / 60).toFixed(2)} h` : `${m.toFixed(1)} min`;
  const lines: string[] = [];
  lines.push(`METR HCAST horizon report  (suite=metr-hcast, weighting=${report.weighting}${report.runId ? `, run=${report.runId}` : ''})`);
  lines.push('');
  for (const a of report.arms) {
    lines.push(`  arm ${a.arm}: fit on ${a.horizonTasks} baselined tasks, mean success ${(a.meanSuccess * 100).toFixed(0)}%${a.fit.degenerate ? `  [DEGENERATE: ${a.fit.degenerateReason}]` : ''}`);
    for (const p of a.points) {
      const ci = p.ci ? `  CI95 [${fmtMin(p.ci.lower)}, ${fmtMin(p.ci.upper)}]` : '';
      lines.push(`      p${Math.round(p.quantile * 100)} horizon = ${fmtMin(p.horizonMinutes)}${ci}`);
    }
  }
  if (report.lifts.length > 0) {
    lines.push('');
    lines.push('  HEADLINE — horizon LIFT (hive vs single-opus, same tasks):');
    for (const l of report.lifts) {
      const sep = l.ciSeparated === true ? '  (CIs separated)' : l.ciSeparated === false ? '  (CIs overlap)' : '';
      lines.push(
        `      p${Math.round(l.quantile * 100)}: hive ${fmtMin(l.treatmentMinutes)} vs single-opus ${fmtMin(l.baselineMinutes)} → ${Number.isFinite(l.liftRatio) ? l.liftRatio.toFixed(2) : '∞'}× lift${sep}`,
      );
    }
  }
  lines.push('');
  lines.push('  CAVEATS (must surface):');
  for (const c of report.caveats) lines.push(`    • ${c}`);
  return lines.join('\n');
}
