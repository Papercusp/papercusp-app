/**
 * Matched optimizer comparison for Blender (P-010).
 *
 * This is the decision seam for comparing the existing Gym optimizer, the small
 * trace-reflection baseline, and GEPA.  It deliberately consumes recorded run
 * summaries instead of starting an optimizer or an LLM call: the owner-pause
 * remains in force and a caller can bind each method to the existing
 * `experiment:run`/Gym adapters later.
 *
 * Every method is evaluated over the same task splits, model/evaluator pins,
 * exposure, repeats, and budget cap.  Selection uses the sealed acceptance
 * split, keeps regression and missing evidence as hard states, and compares a
 * quality lower confidence endpoint.  Cost is retained as an explicit
 * dimension and breaks ties (or can be bounded by `maxCostRatio`).
 */

import type { ReproducibleBattery } from './battery';

export const OPTIMIZER_METHODS = ['gym', 'trace-reflection', 'gepa'] as const;
export type OptimizerMethod = (typeof OPTIMIZER_METHODS)[number];

export const GYM_OPTIMIZER = 'gym' as const;
export const TRACE_REFLECTION_BASELINE = 'trace-reflection' as const;
export const GEPA_OPTIMIZER = 'gepa' as const;

export const OPTIMIZER_TASK_SPLITS = ['development', 'sealed-acceptance', 'fresh-monitoring'] as const;
export type OptimizerTaskSplit = (typeof OPTIMIZER_TASK_SPLITS)[number];

export type RegressionStatus = 'pass' | 'fail' | 'not-measured';

export interface OptimizerTaskSplits {
  development: readonly string[];
  'sealed-acceptance': readonly string[];
  'fresh-monitoring': readonly string[];
}

/** Reuse the P-009 battery's frozen cohorts as the comparison split. */
export function optimizerTaskSplitsFromBattery(battery: Pick<ReproducibleBattery, 'cohorts'>): OptimizerTaskSplits {
  return {
    development: battery.cohorts.development.map((testCase) => testCase.caseId),
    'sealed-acceptance': battery.cohorts['sealed-acceptance'].map((testCase) => testCase.caseId),
    'fresh-monitoring': battery.cohorts['fresh-monitoring'].map((testCase) => testCase.caseId),
  };
}

export interface MatchedOptimizerPins {
  taskHash: string;
  modelHash: string;
  promptHash: string;
  rubricHash: string;
  codeHash: string;
  evaluatorHash: string;
  randomizationSeed: string;
  repeats: number;
  /** Equal spend cap assigned to each optimizer run. Actual spend is reported per run. */
  budgetUsd: number;
  exposure: { population: string; percentage: number };
}

/** One task's aggregate over the configured repeats.  Uncertainty is the half-width
 * of the method's predeclared confidence interval; null means not measured. */
export interface OptimizerTaskScore {
  taskId: string;
  split: OptimizerTaskSplit;
  quality: number;
  uncertainty: number | null;
  /** pass = measured no-regression; fail = a regression; not-measured = no signal. */
  regression: RegressionStatus;
  costUsd: number;
}

/** A method's recorded run.  The metadata is repeated on every run so a comparison
 * can reject an accidentally un-matched arm before ranking it. */
export interface OptimizerRun {
  method: OptimizerMethod;
  taskHash: string;
  modelHash: string;
  promptHash: string;
  rubricHash: string;
  codeHash: string;
  evaluatorHash: string;
  randomizationSeed: string;
  repeats: number;
  budgetUsd: number;
  exposure: { population: string; percentage: number };
  totalCostUsd: number;
  scores: readonly OptimizerTaskScore[];
}

export interface OptimizerComparisonThresholds {
  /** Required lower-bound quality lift over the Gym lower/upper-bound gap. Default 0. */
  minQualityImprovement?: number;
  /** Optional cap on candidate actual cost / Gym actual cost. Defaults to the Gym gate's 3× ceiling. */
  maxCostRatio?: number;
}

export interface OptimizerValidation {
  ok: boolean;
  errors: string[];
}

export interface OptimizerDimensionSummary {
  qualityMean: number | null;
  qualityLowerBound: number | null;
  qualityUpperBound: number | null;
  qualityMeasured: number;
  qualityRequired: number;
  regression: RegressionStatus;
  regressionMeasured: number;
  regressionRequired: number;
  regressionRate: number | null;
  uncertaintyMean: number | null;
  uncertaintyMeasured: number;
  uncertaintyRequired: number;
  totalCostUsd: number;
  costPerMeasuredTask: number | null;
}

export interface OptimizerMethodSummary extends OptimizerDimensionSummary {
  method: OptimizerMethod;
  qualityDeltaVsGym: number | null;
  costDeltaVsGym: number | null;
  costRatioVsGym: number | null;
  eligible: boolean;
  exclusionReasons: string[];
}

export type OptimizerComparisonVerdict = 'selected' | 'baseline-holds' | 'inconclusive' | 'invalid';

export interface OptimizerComparisonResult {
  ok: boolean;
  errors: string[];
  matched: boolean;
  baselineMethod: typeof GYM_OPTIMIZER;
  selectionSplit: 'sealed-acceptance';
  summaries: OptimizerMethodSummary[];
  selected: OptimizerMethod | null;
  verdict: OptimizerComparisonVerdict;
  reason: string;
}

const EPSILON = 1e-9;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const equalNumber = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

function expectedTaskIds(splits: OptimizerTaskSplits): Set<string> {
  return new Set(OPTIMIZER_TASK_SPLITS.flatMap((split) => splits[split]));
}

function validateSplits(splits: OptimizerTaskSplits | undefined, errors: string[]): void {
  const seen = new Set<string>();
  for (const split of OPTIMIZER_TASK_SPLITS) {
    const ids = splits?.[split];
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push(`taskSplits.${split} must contain at least one task`);
      continue;
    }
    for (const [index, id] of ids.entries()) {
      if (!nonEmpty(id)) errors.push(`taskSplits.${split}[${index}] must be non-empty`);
      if (nonEmpty(id) && seen.has(id)) errors.push(`task id is reused across splits: ${id}`);
      if (nonEmpty(id)) seen.add(id);
    }
  }
}

function validatePins(pins: MatchedOptimizerPins | undefined, errors: string[]): void {
  for (const [value, field] of [
    [pins?.taskHash, 'pins.taskHash'],
    [pins?.modelHash, 'pins.modelHash'],
    [pins?.promptHash, 'pins.promptHash'],
    [pins?.rubricHash, 'pins.rubricHash'],
    [pins?.codeHash, 'pins.codeHash'],
    [pins?.evaluatorHash, 'pins.evaluatorHash'],
    [pins?.randomizationSeed, 'pins.randomizationSeed'],
    [pins?.exposure?.population, 'pins.exposure.population'],
  ] as const) {
    if (!nonEmpty(value)) errors.push(`${field} must be non-empty`);
  }
  if (!Number.isInteger(pins?.repeats) || (pins?.repeats ?? 0) < 1) errors.push('pins.repeats must be a positive integer');
  if (!finite(pins?.budgetUsd) || (pins?.budgetUsd ?? -1) < 0) errors.push('pins.budgetUsd must be finite and non-negative');
  if (!finite(pins?.exposure?.percentage) || (pins?.exposure?.percentage ?? 0) <= 0 || (pins?.exposure?.percentage ?? 0) > 100) {
    errors.push('pins.exposure.percentage must be in (0, 100]');
  }
}

/** Validate matching metadata and complete task-split coverage before selection. */
export function validateMatchedOptimizerComparison(input: {
  pins: MatchedOptimizerPins;
  taskSplits: OptimizerTaskSplits;
  runs: readonly OptimizerRun[];
}): OptimizerValidation {
  const errors: string[] = [];
  validatePins(input?.pins, errors);
  validateSplits(input?.taskSplits, errors);

  const runs = input?.runs ?? [];
  const methods = runs.map((run) => run?.method);
  if (runs.length !== OPTIMIZER_METHODS.length) errors.push(`exactly ${OPTIMIZER_METHODS.length} optimizer runs are required`);
  for (const method of OPTIMIZER_METHODS) if (!methods.includes(method)) errors.push(`missing optimizer run: ${method}`);
  if (new Set(methods).size !== methods.length) errors.push('optimizer methods must be unique');

  const taskIds = expectedTaskIds(input?.taskSplits);
  for (const [index, run] of runs.entries()) {
    if (!OPTIMIZER_METHODS.includes(run?.method)) errors.push(`runs[${index}].method is invalid`);
    for (const [value, field] of [
      [run?.taskHash, 'taskHash'],
      [run?.modelHash, 'modelHash'],
      [run?.promptHash, 'promptHash'],
      [run?.rubricHash, 'rubricHash'],
      [run?.codeHash, 'codeHash'],
      [run?.evaluatorHash, 'evaluatorHash'],
      [run?.randomizationSeed, 'randomizationSeed'],
    ] as const) {
      if (value !== input?.pins?.[field]) errors.push(`runs[${index}].${field} does not match pins.${field}`);
    }
    if (run?.repeats !== input?.pins?.repeats) errors.push(`runs[${index}].repeats does not match pins.repeats`);
    if (!equalNumber(run?.budgetUsd ?? NaN, input?.pins?.budgetUsd ?? NaN)) errors.push(`runs[${index}].budgetUsd does not match pins.budgetUsd`);
    if (run?.exposure?.population !== input?.pins?.exposure?.population || !equalNumber(run?.exposure?.percentage ?? NaN, input?.pins?.exposure?.percentage ?? NaN)) {
      errors.push(`runs[${index}].exposure does not match pins.exposure`);
    }
    if (!finite(run?.totalCostUsd) || (run?.totalCostUsd ?? -1) < 0) errors.push(`runs[${index}].totalCostUsd must be finite and non-negative`);
    if (finite(run?.totalCostUsd) && finite(run?.budgetUsd) && run.totalCostUsd > run.budgetUsd + EPSILON) errors.push(`runs[${index}].totalCostUsd cannot exceed budgetUsd`);
    const scores = run?.scores ?? [];
    const seen = new Set<string>();
    let scoreCost = 0;
    for (const [scoreIndex, score] of scores.entries()) {
      if (!OPTIMIZER_TASK_SPLITS.includes(score?.split)) errors.push(`runs[${index}].scores[${scoreIndex}].split is invalid`);
      if (!nonEmpty(score?.taskId) || !taskIds.has(score.taskId)) errors.push(`runs[${index}].scores[${scoreIndex}].taskId is not in taskSplits`);
      const cell = `${score?.split ?? ''}|${score?.taskId ?? ''}`;
      if (seen.has(cell)) errors.push(`runs[${index}] duplicates task score: ${cell}`);
      seen.add(cell);
      if (!finite(score?.quality)) errors.push(`runs[${index}].scores[${scoreIndex}].quality must be finite`);
      if (score?.uncertainty !== null && score?.uncertainty !== undefined && (!finite(score.uncertainty) || score.uncertainty < 0)) {
        errors.push(`runs[${index}].scores[${scoreIndex}].uncertainty must be null or finite and non-negative`);
      }
      if (!['pass', 'fail', 'not-measured'].includes(score?.regression)) errors.push(`runs[${index}].scores[${scoreIndex}].regression is invalid`);
      if (!finite(score?.costUsd) || (score?.costUsd ?? -1) < 0) errors.push(`runs[${index}].scores[${scoreIndex}].costUsd must be finite and non-negative`);
      if (finite(score?.costUsd)) scoreCost += score.costUsd;
    }
    if (finite(run?.totalCostUsd) && Math.abs(scoreCost - run.totalCostUsd) > EPSILON) {
      errors.push(`runs[${index}].totalCostUsd must equal the sum of score costUsd values`);
    }
    for (const split of OPTIMIZER_TASK_SPLITS) {
      for (const taskId of input?.taskSplits?.[split] ?? []) {
        if (!seen.has(`${split}|${taskId}`)) errors.push(`runs[${index}] is missing ${split} task ${taskId}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function summarizeRun(run: OptimizerRun, splits: OptimizerTaskSplits, gymCostUsd: number | null, thresholds: OptimizerComparisonThresholds): OptimizerMethodSummary {
  const scores = run.scores.filter((score) => score.split === 'sealed-acceptance');
  const required = splits['sealed-acceptance'].length;
  const qualityMeasured = scores.filter((score) => finite(score.quality)).length;
  const qualityMean = qualityMeasured === required && required > 0 ? scores.reduce((sum, score) => sum + score.quality, 0) / required : null;
  const uncertaintyScores = scores.filter((score) => finite(score.uncertainty));
  const uncertaintyMeasured = uncertaintyScores.length;
  const uncertaintyMean = uncertaintyMeasured === required && required > 0
    ? uncertaintyScores.reduce((sum, score) => sum + (score.uncertainty as number), 0) / required
    : null;
  const qualityLowerBound = qualityMean === null || uncertaintyMean === null ? null : qualityMean - uncertaintyMean;
  const qualityUpperBound = qualityMean === null || uncertaintyMean === null ? null : qualityMean + uncertaintyMean;
  const regressionMeasured = scores.filter((score) => score.regression !== 'not-measured').length;
  const regressionFailures = scores.filter((score) => score.regression === 'fail').length;
  const regression: RegressionStatus = regressionFailures > 0 ? 'fail' : regressionMeasured === required && required > 0 ? 'pass' : 'not-measured';
  const regressionRate = regressionMeasured > 0 ? regressionFailures / regressionMeasured : null;
  const costPerMeasuredTask = qualityMeasured > 0 ? run.totalCostUsd / qualityMeasured : null;
  const exclusionReasons: string[] = [];
  if (regression === 'fail') exclusionReasons.push('sealed-acceptance regression measured');
  else if (regression === 'not-measured') exclusionReasons.push('sealed-acceptance regression is not measured');
  if (qualityMean === null) exclusionReasons.push('sealed-acceptance quality is incomplete');
  if (uncertaintyMean === null) exclusionReasons.push('sealed-acceptance uncertainty is not measured');
  if (run.totalCostUsd > run.budgetUsd + EPSILON) exclusionReasons.push('run exceeded its matched spend cap');
  const costRatioVsGym = gymCostUsd === null ? null : gymCostUsd > EPSILON ? run.totalCostUsd / gymCostUsd : run.totalCostUsd > EPSILON ? Infinity : 1;
  const maxCostRatio = thresholds.maxCostRatio ?? 3;
  if (costRatioVsGym !== null && costRatioVsGym > maxCostRatio + EPSILON) {
    exclusionReasons.push(`cost ratio ${Number.isFinite(costRatioVsGym) ? costRatioVsGym.toFixed(3) : 'infinite'} exceeds max ${maxCostRatio}`);
  }
  return {
    method: run.method,
    qualityMean,
    qualityLowerBound,
    qualityUpperBound,
    qualityMeasured,
    qualityRequired: required,
    regression,
    regressionMeasured,
    regressionRequired: required,
    regressionRate,
    uncertaintyMean,
    uncertaintyMeasured,
    uncertaintyRequired: required,
    totalCostUsd: run.totalCostUsd,
    costPerMeasuredTask,
    qualityDeltaVsGym: null,
    costDeltaVsGym: gymCostUsd === null ? null : run.totalCostUsd - gymCostUsd,
    costRatioVsGym,
    eligible: exclusionReasons.length === 0,
    exclusionReasons,
  };
}

/** Compare the three methods.  Invalid/mismatched inputs never produce a winner. */
export function compareOptimizers(input: {
  pins: MatchedOptimizerPins;
  taskSplits: OptimizerTaskSplits;
  runs: readonly OptimizerRun[];
  thresholds?: OptimizerComparisonThresholds;
}): OptimizerComparisonResult {
  const validation = validateMatchedOptimizerComparison(input);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      matched: false,
      baselineMethod: GYM_OPTIMIZER,
      selectionSplit: 'sealed-acceptance',
      summaries: [],
      selected: null,
      verdict: 'invalid',
      reason: 'comparison inputs are not matched; no optimizer was selected',
    };
  }
  const thresholds = input.thresholds ?? {};
  const gym = input.runs.find((run) => run.method === GYM_OPTIMIZER)!;
  const gymSummary = summarizeRun(gym, input.taskSplits, gym.totalCostUsd, thresholds);
  const summaries = input.runs.map((run) => summarizeRun(run, input.taskSplits, gym.totalCostUsd, thresholds));
  const baseline = summaries.find((summary) => summary.method === GYM_OPTIMIZER)!;
  const minImprovement = thresholds.minQualityImprovement ?? 0;
  const baselineUsable = baseline.qualityLowerBound !== null && baseline.qualityUpperBound !== null && baseline.regression === 'pass';
  for (const summary of summaries) {
    summary.qualityDeltaVsGym = summary.qualityMean === null || gymSummary.qualityMean === null ? null : summary.qualityMean - gymSummary.qualityMean;
    if (summary.method === GYM_OPTIMIZER) {
      summary.eligible = baselineUsable;
      if (!baselineUsable && summary.exclusionReasons.length === 0) summary.exclusionReasons.push('Gym baseline has incomplete quality, uncertainty, or regression evidence');
      continue;
    }
    if (!baselineUsable) {
      summary.eligible = false;
      summary.exclusionReasons.push('Gym baseline is not usable for a matched comparison');
      continue;
    }
    if (summary.qualityLowerBound === null || summary.qualityUpperBound === null || summary.regression !== 'pass') summary.eligible = false;
    if (summary.eligible && summary.qualityLowerBound! - baseline.qualityUpperBound! <= minImprovement + EPSILON) {
      summary.eligible = false;
      summary.exclusionReasons.push(`quality lower bound does not clear Gym upper bound by ${minImprovement}`);
    }
  }
  const candidates = summaries
    .filter((summary) => summary.method !== GYM_OPTIMIZER && summary.eligible)
    .sort((a, b) => {
      const qualityDelta = (b.qualityLowerBound ?? -Infinity) - (a.qualityLowerBound ?? -Infinity);
      if (Math.abs(qualityDelta) > EPSILON) return qualityDelta;
      return (a.totalCostUsd - b.totalCostUsd) || OPTIMIZER_METHODS.indexOf(a.method) - OPTIMIZER_METHODS.indexOf(b.method);
    });
  if (!baselineUsable) {
    return { ok: true, errors: [], matched: true, baselineMethod: GYM_OPTIMIZER, selectionSplit: 'sealed-acceptance', summaries, selected: null, verdict: 'inconclusive', reason: 'Gym baseline lacks complete regression, quality, or uncertainty evidence' };
  }
  if (candidates.length === 0) {
    const challengerSummaries = summaries.filter((summary) => summary.method !== GYM_OPTIMIZER);
    const anyMeasuredCandidate = challengerSummaries.some((summary) => summary.qualityMean !== null);
    const hasEvidenceGap = challengerSummaries.some((summary) => summary.exclusionReasons.some((reason) => /not measured|incomplete|gap/i.test(reason)));
    return {
      ok: true,
      errors: [],
      matched: true,
      baselineMethod: GYM_OPTIMIZER,
      selectionSplit: 'sealed-acceptance',
      summaries,
      selected: null,
      verdict: hasEvidenceGap ? 'inconclusive' : anyMeasuredCandidate ? 'baseline-holds' : 'inconclusive',
      reason: hasEvidenceGap ? 'comparison has an evidence gap; no challenger can be selected' : anyMeasuredCandidate ? 'no challenger clears the quality, regression, uncertainty, and cost gates' : 'no challenger has measured sealed-acceptance evidence',
    };
  }
  const selected = candidates[0]!.method;
  return { ok: true, errors: [], matched: true, baselineMethod: GYM_OPTIMIZER, selectionSplit: 'sealed-acceptance', summaries, selected, verdict: 'selected', reason: `selected ${selected} on sealed-acceptance quality lower bound; cost ${candidates[0]!.totalCostUsd} USD` };
}

/** Compatibility aliases for callers that call the seam a method bake-off. */
export const validateOptimizerComparison = validateMatchedOptimizerComparison;
export const compareOptimizerMethods = compareOptimizers;
