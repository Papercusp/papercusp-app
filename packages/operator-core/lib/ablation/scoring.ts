/**
 * Behavioral-delta scoring for prompt sedimentology (self-learning-frontier
 * P-023 / FB-09) — pure aggregation over per-scenario baseline-vs-ablated arm
 * outcomes, plus the cross-week DEAD-WEIGHT report.
 *
 * Verdict semantics (D-003 discipline: the cycle MEASURES, it never asserts —
 * and it certainly never edits a prompt):
 *
 *   - 'load-bearing'  — removing the rule degraded behavior (pass-rate fell
 *                       past the threshold). The rule earns its tokens.
 *   - 'no-delta'      — no measurable behavioral change. ONE no-delta cycle is
 *                       weak evidence (LLM noise); dead-weight status needs
 *                       repeated no-delta cycles on the SAME wording.
 *   - 'improved'      — behavior got BETTER without the rule. Surfaced loudly:
 *                       either the rule actively confuses the model or the
 *                       suite is mis-measuring; both want owner eyes.
 *   - 'inconclusive'  — too few scenarios produced measurable arm pairs
 *                       (budget cap, arm errors) to say anything.
 *
 * Dead-weight aggregation: evidence for a rule accumulates only while its
 * contentHash holds (a reworded rule starts over) and only from uncapped-or-
 * capped-but-measurable cycles. A rule reaches 'dead-weight-candidate' after
 * `minRuns` cycles with zero load-bearing verdicts. The report is owner-facing
 * review material — any actual removal is a normal reviewed edit riding the
 * behavior-change ledger + release gate.
 */

export type AblationVerdict = 'load-bearing' | 'no-delta' | 'improved' | 'inconclusive';

/** One arm's extracted metrics for one scenario (undefined = arm errored). */
export interface ArmMetrics {
  /** Fraction of matrix runs that passed (0..1). */
  passRate?: number;
  /** Mean total cost per run (USD). */
  meanCostUsd?: number;
  /** Mean judge score per rubric axis across the matrix runs. */
  judgeAxes?: Record<string, number>;
  /** Present when the arm failed to run at all. */
  error?: string;
}

export interface ScenarioArmOutcome {
  scenarioId: string;
  baseline: ArmMetrics;
  ablated: ArmMetrics;
}

export interface AblationThresholds {
  /** passRateDelta (ablated − baseline) at/below this ⇒ 'load-bearing'. */
  loadBearingDelta: number;
  /** passRateDelta at/above this ⇒ 'improved'. */
  improvedDelta: number;
  /** Fewer measurable scenario pairs than this ⇒ 'inconclusive'. */
  minMeasurableScenarios: number;
}

export const DEFAULT_ABLATION_THRESHOLDS: AblationThresholds = {
  loadBearingDelta: -0.1,
  improvedDelta: 0.1,
  minMeasurableScenarios: 4,
};

export interface AblationCycleScore {
  verdict: AblationVerdict;
  scenarioCount: number;
  /** Scenario pairs where BOTH arms produced a pass rate. */
  measurableCount: number;
  baselinePassRate: number | null;
  ablatedPassRate: number | null;
  /** ablated − baseline (negative = the rule was load-bearing). */
  passRateDelta: number | null;
  /** Scenarios that pass at baseline and fail ablated — the rule's footprint. */
  regressions: string[];
  /** Scenarios that fail at baseline and pass ablated — surfaced, not celebrated. */
  improvements: string[];
  /** Mean judge-axis delta (ablated − baseline) across scenarios carrying the axis. */
  judgeAxisDeltas: Record<string, number>;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

export function scoreAblationCycle(
  outcomes: readonly ScenarioArmOutcome[],
  thresholds: AblationThresholds = DEFAULT_ABLATION_THRESHOLDS,
): AblationCycleScore {
  const measurable = outcomes.filter(
    (o) => o.baseline.passRate !== undefined && o.ablated.passRate !== undefined,
  );
  const baselinePassRate = mean(measurable.map((o) => o.baseline.passRate!));
  const ablatedPassRate = mean(measurable.map((o) => o.ablated.passRate!));
  const passRateDelta =
    baselinePassRate !== null && ablatedPassRate !== null ? ablatedPassRate - baselinePassRate : null;

  const regressions = measurable
    .filter((o) => o.baseline.passRate! >= 0.5 && o.ablated.passRate! < 0.5)
    .map((o) => o.scenarioId);
  const improvements = measurable
    .filter((o) => o.baseline.passRate! < 0.5 && o.ablated.passRate! >= 0.5)
    .map((o) => o.scenarioId);

  const axisDeltas = new Map<string, number[]>();
  for (const o of measurable) {
    for (const [axis, b] of Object.entries(o.baseline.judgeAxes ?? {})) {
      const a = o.ablated.judgeAxes?.[axis];
      if (typeof a === 'number') {
        const arr = axisDeltas.get(axis) ?? [];
        arr.push(a - b);
        axisDeltas.set(axis, arr);
      }
    }
  }
  const judgeAxisDeltas: Record<string, number> = {};
  for (const [axis, deltas] of axisDeltas) judgeAxisDeltas[axis] = mean(deltas)!;

  let verdict: AblationVerdict;
  if (measurable.length < thresholds.minMeasurableScenarios || passRateDelta === null) {
    verdict = 'inconclusive';
  } else if (passRateDelta <= thresholds.loadBearingDelta) {
    verdict = 'load-bearing';
  } else if (passRateDelta >= thresholds.improvedDelta) {
    verdict = 'improved';
  } else {
    verdict = 'no-delta';
  }

  return {
    verdict,
    scenarioCount: outcomes.length,
    measurableCount: measurable.length,
    baselinePassRate,
    ablatedPassRate,
    passRateDelta,
    regressions,
    improvements,
    judgeAxisDeltas,
  };
}

// ---------------------------------------------------------------------------
// The dead-weight report (cross-week aggregation over stored run rows)
// ---------------------------------------------------------------------------

/** The slice of a stored run row the report needs (store.ts rows satisfy it). */
export interface AblationRunSummary {
  ruleKey: string;
  ruleHash: string;
  ruleExcerpt: string;
  verdict: AblationVerdict | string;
  passRateDelta: number | null;
  finishedAt: string;
  capped: boolean;
}

export type DeadWeightStatus = 'dead-weight-candidate' | 'load-bearing' | 'insufficient-evidence';

export interface DeadWeightEntry {
  ruleKey: string;
  ruleExcerpt: string;
  /** The wording the evidence applies to (the most recent run's hash). */
  ruleHash: string;
  status: DeadWeightStatus;
  /** Conclusive cycles on the current wording (inconclusive runs don't count). */
  evidenceRuns: number;
  noDeltaRuns: number;
  improvedRuns: number;
  loadBearingRuns: number;
  lastVerdict: string;
  lastFinishedAt: string;
  meanPassRateDelta: number | null;
}

export interface DeadWeightReportOptions {
  /** Conclusive cycles on one wording required before 'dead-weight-candidate'. */
  minRuns?: number;
}

/**
 * Aggregate stored cycles into per-rule dead-weight standings. Rows must be
 * one rule-rotation's history (any order); evidence counts only runs whose
 * ruleHash matches the rule's MOST RECENT hash.
 */
export function buildDeadWeightReport(
  rows: readonly AblationRunSummary[],
  opts: DeadWeightReportOptions = {},
): DeadWeightEntry[] {
  const minRuns = opts.minRuns ?? 2;
  const byRule = new Map<string, AblationRunSummary[]>();
  for (const row of rows) {
    const arr = byRule.get(row.ruleKey) ?? [];
    arr.push(row);
    byRule.set(row.ruleKey, arr);
  }

  const entries: DeadWeightEntry[] = [];
  for (const [ruleKey, all] of byRule) {
    const sorted = [...all].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
    const latest = sorted[0]!;
    const current = sorted.filter((r) => r.ruleHash === latest.ruleHash);
    const conclusive = current.filter((r) => r.verdict !== 'inconclusive');
    const loadBearing = conclusive.filter((r) => r.verdict === 'load-bearing').length;
    const noDelta = conclusive.filter((r) => r.verdict === 'no-delta').length;
    const improved = conclusive.filter((r) => r.verdict === 'improved').length;

    let status: DeadWeightStatus;
    if (loadBearing > 0) status = 'load-bearing';
    else if (conclusive.length >= minRuns) status = 'dead-weight-candidate';
    else status = 'insufficient-evidence';

    entries.push({
      ruleKey,
      ruleExcerpt: latest.ruleExcerpt,
      ruleHash: latest.ruleHash,
      status,
      evidenceRuns: conclusive.length,
      noDeltaRuns: noDelta,
      improvedRuns: improved,
      loadBearingRuns: loadBearing,
      lastVerdict: latest.verdict,
      lastFinishedAt: latest.finishedAt,
      meanPassRateDelta: mean(
        conclusive.map((r) => r.passRateDelta).filter((v): v is number => typeof v === 'number'),
      ),
    });
  }

  // Candidates first (the owner's review queue), then by evidence depth.
  const rank: Record<DeadWeightStatus, number> = {
    'dead-weight-candidate': 0,
    'insufficient-evidence': 1,
    'load-bearing': 2,
  };
  return entries.sort(
    (a, b) => rank[a.status] - rank[b.status] || b.evidenceRuns - a.evidenceRuns || a.ruleKey.localeCompare(b.ruleKey),
  );
}
