/**
 * Compare/select runner + Scorer modes (test-gym-apiary-framework-2026-06-09
 * P-002 + P-003).
 *
 * An eval = a registered scenario + a variant knob + THIS: run the scenario
 * for the baseline (no variant) and each candidate variant, extract named
 * metrics from each arm's RunReport via pluggable {@link Scorer}s, diff every
 * candidate against the baseline, rank, and select a winner only when it
 * strictly improves the primary metric (D-003: an eval MEASURES + COMPARES —
 * it never asserts).
 *
 * Two scorer modes (D-002): `deterministic` counts what is countable straight
 * off the runs (pass rate, cost, latency, tool-call signals); `judge` reads
 * the LLM-judge axis scores the runner already produced. An LLM never judges
 * a number you can count.
 *
 * Arms run SEQUENTIALLY (bounded spend + a shared LLM rate limit — the same
 * discipline as eval-battery's runBattery), and a failed arm is RECORDED and
 * excluded from ranking, never aborting the remaining arms.
 */

import { runScenario, type RunnerOpts, type RunReport } from './runner';
import type { RunnerDeps } from './deps';
import type { Scenario, ScenarioVariant } from './types';

// =============================================================================
// Scorer — P-003
// =============================================================================

/** Which way a metric improves. */
export type ScorerDirection = 'higher-better' | 'lower-better';

/**
 * One named metric extracted from an arm's {@link RunReport}.
 * Returns `undefined` when the metric is unavailable for that arm (e.g. a
 * judge axis the rubric doesn't carry) — an undefined metric never ranks.
 */
export interface Scorer {
  id: string;
  direction: ScorerDirection;
  /** 'deterministic' = counted from the runs; 'judge' = LLM-judge axis read. */
  mode: 'deterministic' | 'judge';
  score(report: RunReport): number | undefined;
}

/** Factory for custom deterministic collectors (lock/usage signals, etc.). */
export function deterministicScorer(
  id: string,
  direction: ScorerDirection,
  score: (report: RunReport) => number | undefined,
): Scorer {
  return { id, direction, mode: 'deterministic', score };
}

/** Fraction of matrix runs that passed (asserts + judge), 0..1. */
export const passRateScorer: Scorer = deterministicScorer('pass-rate', 'higher-better', (report) => {
  if (report.runs.length === 0) return undefined;
  return report.runs.filter((r) => r.status === 'passed').length / report.runs.length;
});

/** Mean total cost (USD) per run. */
export const meanCostScorer: Scorer = deterministicScorer('mean-cost-usd', 'lower-better', (report) => {
  if (report.runs.length === 0) return undefined;
  const total = report.runs.reduce((s, r) => s + r.summary.totalCostUsd, 0);
  return total / report.runs.length;
});

/** Mean per-turn latency (ms) across all turns of all runs. */
export const meanLatencyScorer: Scorer = deterministicScorer('mean-turn-latency-ms', 'lower-better', (report) => {
  const turns = report.runs.flatMap((r) => r.summary.turns);
  if (turns.length === 0) return undefined;
  return turns.reduce((s, t) => s + t.latencyMs, 0) / turns.length;
});

/** Mean tool invocations per run (optionally one named tool). */
export function toolCallRateScorer(toolName?: string): Scorer {
  const id = toolName ? `tool-calls:${toolName}` : 'tool-calls';
  return deterministicScorer(id, 'lower-better', (report) => {
    if (report.runs.length === 0) return undefined;
    const count = report.runs.reduce((s, r) => {
      const calls = r.summary.toolInvocations.filter((t) => !toolName || t.toolName === toolName);
      return s + calls.length;
    }, 0);
    return count / report.runs.length;
  });
}

/** Judge mode: mean of one judge axis (0..5) across the matrix runs. */
export function judgeAxisScorer(axisId: string): Scorer {
  return {
    id: `judge:${axisId}`,
    direction: 'higher-better',
    mode: 'judge',
    score(report) {
      const scores = report.runs
        .map((r) => r.judge.scores[axisId])
        .filter((v): v is number => typeof v === 'number');
      if (scores.length === 0) return undefined;
      return scores.reduce((s, v) => s + v, 0) / scores.length;
    },
  };
}

// =============================================================================
// The pure compare/select core
// =============================================================================

/** Reserved arm id for the no-variant run (ScenarioVariant doc contract). */
export const BASELINE_ID = 'baseline';

/** One executed arm: the baseline or one candidate. */
export interface CompareArm {
  variantId: string;
  /** scorer id → extracted value (undefined = unavailable). */
  metrics: Record<string, number | undefined>;
  /** Present when the arm executed (absent on an errored arm). */
  report?: RunReport;
  /** The arm failed to run; it is recorded but never ranked. */
  error?: string;
}

/** One metric's baseline-vs-candidate diff. */
export interface MetricDiff {
  scorerId: string;
  direction: ScorerDirection;
  baseline?: number;
  candidate?: number;
  /** candidate − baseline (sign as-is; read with `direction`). */
  delta?: number;
  /** Direction-aware: true iff the candidate strictly improves this metric. */
  improved?: boolean;
}

export interface RankedCandidate {
  variantId: string;
  diffs: MetricDiff[];
  /**
   * Direction-normalized primary improvement (positive = better than
   * baseline), undefined when the arm errored or the metric is unavailable.
   */
  primaryImprovement?: number;
  /** 1-based; errored / unmeasurable arms rank after all measurable ones. */
  rank: number;
  errored: boolean;
}

export interface CompareSelectResult {
  scenarioId: string;
  primaryScorer: string;
  baseline: CompareArm;
  /** Best-first. */
  candidates: RankedCandidate[];
  /** Winning variantId — only set on a strict primary-metric improvement ≥ minDelta. */
  selected?: string;
  selectionReason: string;
}

function diffMetric(
  scorer: Pick<Scorer, 'id' | 'direction'>,
  baseline: number | undefined,
  candidate: number | undefined,
): MetricDiff {
  const diff: MetricDiff = { scorerId: scorer.id, direction: scorer.direction };
  if (baseline !== undefined) diff.baseline = baseline;
  if (candidate !== undefined) diff.candidate = candidate;
  if (baseline !== undefined && candidate !== undefined) {
    const delta = candidate - baseline;
    diff.delta = delta;
    diff.improved = scorer.direction === 'higher-better' ? delta > 0 : delta < 0;
  }
  return diff;
}

export interface CompareArmsOpts {
  baseline: CompareArm;
  candidates: CompareArm[];
  scorers: Array<Pick<Scorer, 'id' | 'direction'>>;
  /** Scorer id that ranks + selects. Must be one of `scorers`. */
  primary: string;
  /** Required direction-normalized primary improvement to select (default 0 = any strict improvement). */
  minDelta?: number;
}

/**
 * Pure diff/rank/select over already-extracted arm metrics. Exposed separately
 * so a non-scenario substrate (e.g. an eval-battery caller mapping
 * BatteryCellResults to arms) can reuse the comparison semantics verbatim.
 */
export function compareArms(opts: CompareArmsOpts): Omit<CompareSelectResult, 'scenarioId'> {
  const { baseline, candidates, scorers, primary, minDelta = 0 } = opts;
  const primaryScorer = scorers.find((s) => s.id === primary);
  if (!primaryScorer) {
    throw new Error(`compareArms: primary scorer '${primary}' is not among the scorers (${scorers.map((s) => s.id).join(', ')})`);
  }

  const ranked: Array<Omit<RankedCandidate, 'rank'>> = candidates.map((arm) => {
    const diffs = scorers.map((s) => diffMetric(s, baseline.metrics[s.id], arm.metrics[s.id]));
    const primaryDiff = diffs.find((d) => d.scorerId === primary);
    const entry: Omit<RankedCandidate, 'rank'> = {
      variantId: arm.variantId,
      diffs,
      errored: arm.error !== undefined,
    };
    if (!entry.errored && primaryDiff?.delta !== undefined) {
      entry.primaryImprovement = primaryScorer.direction === 'higher-better' ? primaryDiff.delta : -primaryDiff.delta;
    }
    return entry;
  });

  ranked.sort((a, b) => {
    const ai = a.primaryImprovement;
    const bi = b.primaryImprovement;
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1; // unmeasurable sinks
    if (bi === undefined) return -1;
    return bi - ai;
  });

  const withRank: RankedCandidate[] = ranked.map((c, i) => ({ ...c, rank: i + 1 }));

  let selected: string | undefined;
  let selectionReason: string;
  if (baseline.error !== undefined) {
    selectionReason = 'baseline_errored: no diff basis, baseline holds by default';
  } else {
    const top = withRank[0];
    if (!top || top.primaryImprovement === undefined) {
      selectionReason = 'no_measurable_candidate: baseline holds';
    } else if (top.primaryImprovement > minDelta) {
      selected = top.variantId;
      selectionReason = `selected '${top.variantId}': primary '${primary}' improved by ${top.primaryImprovement} (> minDelta ${minDelta})`;
    } else {
      selectionReason = `baseline_holds: best candidate '${top.variantId}' primary improvement ${top.primaryImprovement} ≤ minDelta ${minDelta}`;
    }
  }

  return {
    primaryScorer: primary,
    baseline,
    candidates: withRank,
    ...(selected !== undefined && { selected }),
    selectionReason,
  };
}

// =============================================================================
// The scenario adapter — P-002
// =============================================================================

export interface CompareSelectOpts {
  scenario: Scenario;
  /** Candidate variants. The baseline (no variant) always runs first. */
  variants: ScenarioVariant[];
  scorers: Scorer[];
  /** Scorer id that ranks + selects. */
  primary: string;
  /** Required primary improvement to select a candidate (default 0). */
  minDelta?: number;
  /** Shared runner opts (models, seed, repeat). `variant` is per-arm — rejected here. */
  runnerOpts?: RunnerOpts;
  /** Injectable scenario runner (tests / alternative substrates). */
  runScenarioFn?: typeof runScenario;
}

/**
 * Run baseline + every candidate variant of one parameterized scenario,
 * sequentially, and compare/select. The runner's own variant gating applies
 * per-arm (a target without `supportsVariants` fails the candidate arm loudly
 * — that arm records as errored, the baseline still stands).
 */
export async function runCompareSelect(opts: CompareSelectOpts, deps: RunnerDeps): Promise<CompareSelectResult> {
  const { scenario, variants, scorers, primary, minDelta, runnerOpts = {}, runScenarioFn = runScenario } = opts;

  if (variants.length === 0) {
    throw new Error('runCompareSelect: no candidate variants — nothing to compare');
  }
  if (runnerOpts.variant !== undefined) {
    throw new Error('runCompareSelect: pass variants via `variants`, not runnerOpts.variant — the runner sets the per-arm variant itself');
  }
  const seen = new Set<string>();
  for (const v of variants) {
    if (v.id === BASELINE_ID) throw new Error(`runCompareSelect: variant id '${BASELINE_ID}' is reserved for the no-variant arm`);
    if (seen.has(v.id)) throw new Error(`runCompareSelect: duplicate variant id '${v.id}'`);
    seen.add(v.id);
  }

  const runArm = async (variant?: ScenarioVariant): Promise<CompareArm> => {
    const variantId = variant?.id ?? BASELINE_ID;
    try {
      const report = await runScenarioFn(
        scenario,
        { ...runnerOpts, ...(variant !== undefined && { variant }) },
        deps,
      );
      const metrics: Record<string, number | undefined> = {};
      for (const s of scorers) metrics[s.id] = s.score(report);
      return { variantId, metrics, report };
    } catch (err) {
      return { variantId, metrics: {}, error: (err as Error).message };
    }
  };

  const baseline = await runArm();
  const candidateArms: CompareArm[] = [];
  for (const variant of variants) {
    candidateArms.push(await runArm(variant));
  }

  const compared = compareArms({
    baseline,
    candidates: candidateArms,
    scorers,
    primary,
    ...(minDelta !== undefined && { minDelta }),
  });
  return { scenarioId: scenario.id, ...compared };
}
