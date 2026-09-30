/**
 * Separated Scout reward accounting (Blender redesign P-007).
 *
 * A routed proposal can be a fusion of several source ideas.  The old lens
 * outcome tally treated every provenance row as an independent win, so one
 * accepted fused artifact could multiply its success across every source.
 * This module first collapses rows by the routed artifact, then attributes the
 * artifact's mass once across its distinct source lenses.
 *
 * Reviewer preference is deliberately kept apart from measured effectiveness:
 * a grade is useful for prioritising what to inspect while an outcome is still
 * pending, but it never turns an immature outcome into a success.  Pending and
 * right-censored outcomes remain visible in the report and are excluded from
 * the matured-effectiveness denominator.
 */

import type { RoutedIdeaProvenance } from './outcome-feedback';

export const SCOUT_REWARD_DIMENSIONS = [
  'reviewerPreference',
  'artifactDelivery',
  'measuredEffectiveness',
  'regressions',
  'cost',
  'uncertainty',
] as const;

export type ScoutRewardDimension = (typeof SCOUT_REWARD_DIMENSIONS)[number];
export type ScoutArtifactDelivery = 'delivered' | 'missing' | 'pending';
export type ScoutEffectivenessStatus = 'pending' | 'matured' | 'right-censored';
export type ScoutRegressionStatus = 'pass' | 'fail' | 'not-measured';
export type ScoutUncertaintyStatus = 'known' | 'unknown';

export interface ScoutEffectiveness {
  status: ScoutEffectivenessStatus;
  /** A matured outcome's measured value. It is intentionally absent otherwise. */
  value?: number | null;
}

export interface ScoutRegressionEvidence {
  status: ScoutRegressionStatus;
  /** Optional count retained for diagnostics; status remains the decision input. */
  count?: number | null;
}

export interface ScoutUncertainty {
  status: ScoutUncertaintyStatus;
  /** Optional confidence, where 1 is known and 0 is wholly unknown. */
  confidence?: number | null;
}

/**
 * One source-idea observation. Only `routedRef` is required; the remaining
 * fields are optional so legacy routed-ledger rows can be measured without a
 * migration. `reviewerPreference` accepts a normalised 0..1 score, while the
 * `reviewerGrade`/`humanGrade` aliases accept the existing 1..5 grade.
 */
export interface ScoutRewardObservation {
  routedRef: string;
  ideaId?: string;
  sourceIdeaIds?: readonly string[];
  lens?: string;

  reviewerPreference?: number | null;
  reviewerGrade?: number | null;
  /** Existing routed-ledger spelling; kept as an input alias only. */
  humanGrade?: number | null;

  artifactDelivery?: ScoutArtifactDelivery | boolean | null;
  /** Convenience alias used by adapters that already have a delivery probe. */
  artifactDelivered?: boolean | null;

  measuredEffectiveness?: ScoutEffectiveness | number | null;
  /** Alias for callers whose contract calls the field simply `effectiveness`. */
  effectiveness?: ScoutEffectiveness | number | null;
  /** A feed-derived terminal can be mapped to a matured 1/0 outcome. */
  outcome?: 'won' | 'lost' | 'pending' | null;

  regressions?: ScoutRegressionEvidence | ScoutRegressionStatus | boolean | null;
  regressionStatus?: ScoutRegressionStatus | null;

  costUsd?: number | null;
  budgetUsd?: number | null;
  cost?: { usedUsd?: number | null; budgetUsd?: number | null } | number | null;

  uncertainty?: ScoutUncertainty | ScoutUncertaintyStatus | null;
  uncertaintyStatus?: ScoutUncertaintyStatus | null;
}

/** Accept a routed-ledger row plus the P-007 measurement fields. */
export type ScoutRewardInput = ScoutRewardObservation &
  Partial<Pick<RoutedIdeaProvenance, 'ideaId' | 'lens' | 'humanGrade'>>;

export interface ScoutArtifactReward {
  /** One reward record per routed artifact, regardless of source-row count. */
  routedRef: string;
  sourceIdeaIds: string[];
  sourceLenses: string[];
  sourceCount: number;
  fused: boolean;

  /** Normalised reviewer preference, independent of effectiveness. */
  reviewerPreference: number | null;
  artifactDelivery: ScoutArtifactDelivery;
  measuredEffectiveness: ScoutEffectiveness;
  regressions: ScoutRegressionEvidence;
  costUsd: number | null;
  budgetUsd: number | null;
  uncertainty: ScoutUncertainty;

  /** Grade-only prioritisation signal; never used as effectiveness. */
  prioritizationScore: number | null;
  /** Matured outcome value only; pending/right-censored always produce null. */
  effectivenessScore: number | null;
}

export interface ScoutLensRewardStat {
  lens: string;
  /** Fractional artifact mass; the sum across lenses is at most artifact count. */
  artifactMass: number;
  reviewerPreferenceMean: number | null;
  artifactDeliveryRate: number | null;
  measuredEffectivenessMean: number | null;
  regressionRate: number | null;
  costUsd: number;
  uncertaintyRate: number | null;
  pendingArtifacts: number;
  rightCensoredArtifacts: number;
  maturedArtifacts: number;
  /** Same as the mean preference, named explicitly for ranking consumers. */
  prioritizationScore: number | null;
  /** Same as the matured-only effectiveness mean. */
  effectivenessScore: number | null;
}

export interface ScoutRewardReport {
  /** The six dimensions are named so consumers cannot silently fuse them. */
  dimensions: readonly ScoutRewardDimension[];
  artifacts: ScoutArtifactReward[];
  totalArtifacts: number;
  fusedArtifacts: number;
  /** Number of source rows collapsed beyond one row per artifact. */
  collapsedSourceRows: number;
  maturedArtifacts: number;
  pendingArtifacts: number;
  rightCensoredArtifacts: number;
  byLens: Record<string, ScoutLensRewardStat>;
}

interface GroupedObservation {
  row: ScoutRewardInput;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Convert the existing 1..5 reviewer grade to a 0..1 preference score. */
export function normalizeReviewerPreference(value: number | null | undefined): number | null {
  if (!finite(value)) return null;
  if (Number.isInteger(value) && value >= 1 && value <= 5) return (value - 1) / 4;
  return null;
}

/** Normalise an already-scored 0..1 preference field. */
function normalizePreferenceScore(value: number | null | undefined): number | null {
  return finite(value) && value >= 0 && value <= 1 ? value : null;
}

function preferenceOf(row: ScoutRewardInput): number | null {
  // Prefer the explicit normalised field. The aliases preserve compatibility
  // with routed-ledger's humanGrade without changing its 1..5 semantics.
  const explicit = normalizePreferenceScore(row.reviewerPreference);
  if (explicit != null) return explicit;
  return normalizeReviewerPreference(row.reviewerGrade ?? row.humanGrade);
}

function deliveryOf(row: ScoutRewardInput): ScoutArtifactDelivery {
  if (typeof row.artifactDelivered === 'boolean') return row.artifactDelivered ? 'delivered' : 'missing';
  if (typeof row.artifactDelivery === 'boolean') return row.artifactDelivery ? 'delivered' : 'missing';
  if (row.artifactDelivery === 'delivered' || row.artifactDelivery === 'missing' || row.artifactDelivery === 'pending') {
    return row.artifactDelivery;
  }
  // A terminal feed outcome proves the artifact exists, even when no explicit
  // delivery probe was recorded. It does not say anything about effectiveness.
  if (row.outcome === 'won' || row.outcome === 'lost') return 'delivered';
  return 'pending';
}

function effectivenessOf(row: ScoutRewardInput): ScoutEffectiveness {
  const raw = row.measuredEffectiveness ?? row.effectiveness;
  if (typeof raw === 'number') return finite(raw) ? { status: 'matured', value: raw } : { status: 'pending' };
  if (raw && typeof raw === 'object') {
    const status = raw.status;
    if (status === 'matured') return { status, value: finite(raw.value) ? raw.value : null };
    if (status === 'right-censored') return { status };
    return { status: 'pending' };
  }
  if (row.outcome === 'won') return { status: 'matured', value: 1 };
  if (row.outcome === 'lost') return { status: 'matured', value: 0 };
  return { status: 'pending' };
}

function regressionOf(row: ScoutRewardInput): ScoutRegressionEvidence {
  const raw = row.regressions ?? row.regressionStatus;
  if (typeof raw === 'boolean') return { status: raw ? 'fail' : 'pass' };
  if (typeof raw === 'string' && (raw === 'pass' || raw === 'fail' || raw === 'not-measured')) return { status: raw };
  if (raw && typeof raw === 'object') {
    const status = raw.status;
    if (status === 'pass' || status === 'fail' || status === 'not-measured') {
      return { status, count: finite(raw.count) ? raw.count : null };
    }
  }
  return { status: 'not-measured' };
}

function costOf(row: ScoutRewardInput): { usedUsd: number | null; budgetUsd: number | null } {
  let used = row.costUsd;
  let budget = row.budgetUsd;
  if (typeof row.cost === 'number') used = row.cost;
  else if (row.cost && typeof row.cost === 'object') {
    used = row.cost.usedUsd ?? used;
    budget = row.cost.budgetUsd ?? budget;
  }
  return {
    usedUsd: finite(used) && used >= 0 ? used : null,
    budgetUsd: finite(budget) && budget >= 0 ? budget : null,
  };
}

function uncertaintyOf(row: ScoutRewardInput, effectiveness: ScoutEffectiveness): ScoutUncertainty {
  const raw = row.uncertainty ?? row.uncertaintyStatus;
  if (typeof raw === 'string' && (raw === 'known' || raw === 'unknown')) return { status: raw, confidence: raw === 'known' ? 1 : 0 };
  if (raw && typeof raw === 'object') {
    const status = raw.status;
    if (status === 'known' || status === 'unknown') {
      const confidence = finite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : status === 'known' ? 1 : 0;
      return { status, confidence };
    }
  }
  // Immature outcomes are uncertainty, not a zero effectiveness score.
  return effectiveness.status === 'matured' ? { status: 'known', confidence: 1 } : { status: 'unknown', confidence: 0 };
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => typeof v === 'string' && v.trim().length > 0))];
}

function sourceIdsOf(rows: readonly GroupedObservation[]): string[] {
  const ids: string[] = [];
  for (const { row } of rows) {
    if (row.sourceIdeaIds) ids.push(...row.sourceIdeaIds);
    if (row.ideaId) ids.push(row.ideaId);
  }
  return uniqueStrings(ids);
}

function mergeArtifact(routedRef: string, rows: readonly GroupedObservation[]): ScoutArtifactReward {
  const sourceIdeaIds = sourceIdsOf(rows);
  const sourceLenses = uniqueStrings(rows.map(({ row }) => row.lens));
  const preferences = rows.map(({ row }) => preferenceOf(row)).filter((v): v is number => v != null);
  const reviewerPreference = preferences.length ? preferences.reduce((a, b) => a + b, 0) / preferences.length : null;
  const deliveries = rows.map(({ row }) => deliveryOf(row));
  const artifactDelivery = deliveries.includes('missing') ? 'missing' : deliveries.includes('pending') ? 'pending' : 'delivered';

  const effects = rows.map(({ row }) => effectivenessOf(row));
  const matured = effects.filter((e) => e.status === 'matured' && finite(e.value));
  const measuredEffectiveness: ScoutEffectiveness = matured.length
    ? { status: 'matured', value: matured.reduce((sum, e) => sum + Number(e.value), 0) / matured.length }
    : effects.some((e) => e.status === 'right-censored')
      ? { status: 'right-censored' }
      : { status: 'pending' };

  const regressions = rows.map(({ row }) => regressionOf(row));
  const regressionsStatus: ScoutRegressionStatus = regressions.some((r) => r.status === 'fail')
    ? 'fail'
    : regressions.length > 0 && regressions.every((r) => r.status === 'pass')
      ? 'pass'
      : 'not-measured';
  const regressionCount = regressions.reduce((sum, r) => sum + (finite(r.count) ? Number(r.count) : 0), 0);
  const firstCost = rows.map(({ row }) => costOf(row)).find((c) => c.usedUsd != null || c.budgetUsd != null) ?? { usedUsd: null, budgetUsd: null };
  const uncertaintyRows = rows.map(({ row }) => uncertaintyOf(row, effectivenessOf(row)));
  const uncertainty = uncertaintyRows.some((u) => u.status === 'unknown')
    ? { status: 'unknown' as const, confidence: Math.min(...uncertaintyRows.map((u) => u.confidence ?? 0)) }
    : { status: 'known' as const, confidence: Math.min(...uncertaintyRows.map((u) => u.confidence ?? 1)) };

  const sourceCount = Math.max(1, sourceIdeaIds.length || rows.length);
  return {
    routedRef,
    sourceIdeaIds,
    sourceLenses,
    sourceCount,
    fused: sourceCount > 1 || rows.length > 1,
    reviewerPreference,
    artifactDelivery,
    measuredEffectiveness,
    regressions: { status: regressionsStatus, count: regressionCount || null },
    costUsd: firstCost.usedUsd,
    budgetUsd: firstCost.budgetUsd,
    uncertainty,
    prioritizationScore: reviewerPreference,
    effectivenessScore: measuredEffectiveness.status === 'matured' && finite(measuredEffectiveness.value)
      ? measuredEffectiveness.value
      : null,
  };
}

function emptyLens(lens: string): ScoutLensRewardStat {
  return {
    lens,
    artifactMass: 0,
    reviewerPreferenceMean: null,
    artifactDeliveryRate: null,
    measuredEffectivenessMean: null,
    regressionRate: null,
    costUsd: 0,
    uncertaintyRate: null,
    pendingArtifacts: 0,
    rightCensoredArtifacts: 0,
    maturedArtifacts: 0,
    prioritizationScore: null,
    effectivenessScore: null,
  };
}

/**
 * Collapse observations by routed artifact and compute independent reward
 * dimensions. Each artifact contributes one unit of mass across its distinct
 * source lenses, so a fused artifact cannot earn one full success per source.
 */
export function computeScoutRewardReport(input: readonly ScoutRewardInput[]): ScoutRewardReport {
  const groups = new Map<string, GroupedObservation[]>();
  let validRows = 0;
  input.forEach((row) => {
    if (typeof row.routedRef !== 'string' || row.routedRef.trim().length === 0) return;
    validRows += 1;
    const rows = groups.get(row.routedRef) ?? [];
    rows.push({ row });
    groups.set(row.routedRef, rows);
  });

  const artifacts = [...groups.entries()].map(([ref, rows]) => mergeArtifact(ref, rows));
  type LensAccumulator = {
    stat: ScoutLensRewardStat;
    preferenceMass: number;
    preferenceWeighted: number;
    deliveryMass: number;
    deliveredMass: number;
    effectivenessMass: number;
    effectivenessWeighted: number;
    regressionMass: number;
    regressionFailures: number;
    uncertaintyMass: number;
    uncertaintyUnknownMass: number;
  };
  const accumulators = new Map<string, LensAccumulator>();
  const byLens: Record<string, ScoutLensRewardStat> = {};
  const add = (lens: string, artifact: ScoutArtifactReward, share: number) => {
    const acc = accumulators.get(lens) ?? {
      stat: emptyLens(lens),
      preferenceMass: 0,
      preferenceWeighted: 0,
      deliveryMass: 0,
      deliveredMass: 0,
      effectivenessMass: 0,
      effectivenessWeighted: 0,
      regressionMass: 0,
      regressionFailures: 0,
      uncertaintyMass: 0,
      uncertaintyUnknownMass: 0,
    };
    accumulators.set(lens, acc);
    const stat = acc.stat;
    stat.artifactMass += share;
    if (artifact.reviewerPreference != null) {
      acc.preferenceMass += share;
      acc.preferenceWeighted += artifact.reviewerPreference * share;
    }
    if (artifact.artifactDelivery !== 'pending') {
      acc.deliveryMass += share;
      if (artifact.artifactDelivery === 'delivered') acc.deliveredMass += share;
    }
    if (artifact.effectivenessScore != null) {
      acc.effectivenessMass += share;
      acc.effectivenessWeighted += artifact.effectivenessScore * share;
      stat.maturedArtifacts += share;
    } else if (artifact.measuredEffectiveness.status === 'right-censored') {
      stat.rightCensoredArtifacts += share;
    } else {
      stat.pendingArtifacts += share;
    }
    if (artifact.regressions.status !== 'not-measured') {
      acc.regressionMass += share;
      if (artifact.regressions.status === 'fail') acc.regressionFailures += share;
    }
    if (artifact.costUsd != null) stat.costUsd += artifact.costUsd * share;
    acc.uncertaintyMass += share;
    if (artifact.uncertainty.status === 'unknown') acc.uncertaintyUnknownMass += share;
  };
  for (const artifact of artifacts) {
    const lenses = artifact.sourceLenses;
    if (lenses.length === 0) continue;
    const share = 1 / lenses.length;
    for (const lens of lenses) add(lens, artifact, share);
  }
  for (const [lens, acc] of accumulators) {
    const stat = acc.stat;
    stat.reviewerPreferenceMean = acc.preferenceMass > 0 ? acc.preferenceWeighted / acc.preferenceMass : null;
    stat.artifactDeliveryRate = acc.deliveryMass > 0 ? acc.deliveredMass / acc.deliveryMass : null;
    stat.measuredEffectivenessMean = acc.effectivenessMass > 0 ? acc.effectivenessWeighted / acc.effectivenessMass : null;
    stat.regressionRate = acc.regressionMass > 0 ? acc.regressionFailures / acc.regressionMass : null;
    stat.uncertaintyRate = acc.uncertaintyMass > 0 ? acc.uncertaintyUnknownMass / acc.uncertaintyMass : null;
    stat.prioritizationScore = stat.reviewerPreferenceMean;
    stat.effectivenessScore = stat.measuredEffectivenessMean;
    byLens[lens] = stat;
  }

  return {
    dimensions: SCOUT_REWARD_DIMENSIONS,
    artifacts,
    totalArtifacts: artifacts.length,
    fusedArtifacts: artifacts.filter((a) => a.fused).length,
    collapsedSourceRows: Math.max(0, validRows - artifacts.length),
    maturedArtifacts: artifacts.filter((a) => a.measuredEffectiveness.status === 'matured').length,
    pendingArtifacts: artifacts.filter((a) => a.measuredEffectiveness.status === 'pending').length,
    rightCensoredArtifacts: artifacts.filter((a) => a.measuredEffectiveness.status === 'right-censored').length,
    byLens,
  };
}

/** Compatibility aliases for callers that describe this as a reward fold. */
export const computeScoutRewards = computeScoutRewardReport;
export const computeRoutedIdeaRewards = computeScoutRewardReport;
