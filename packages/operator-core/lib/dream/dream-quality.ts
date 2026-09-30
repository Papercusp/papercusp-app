/** Calibrated Dream diagnostics. No acceptance quota, provider call, or spend switch. */
import type { Sql } from 'postgres';
import { capabilityHash } from './capability-contracts';
import { CAPABILITY_REVIEW_VERSION, type CapabilityReviewResult } from './capability-review';
import { DEFAULT_DREAM_CYCLE_CONFIG } from './dream-config';
import { dreamReviewerConfusion, type DreamBenchmarkJudgment, type DreamBenchmarkLabel } from './dream-evaluation';
import { computeDreamMetrics, type DreamMetrics, type DreamMetricsScope } from './dream-metrics';
import { dreamCapabilityRun, dreamRunAssessments } from './dream-run-provenance';
import { listDreamRuns, type DreamRun } from './dream-run-store';

export const DREAM_QUALITY_POLICY = {
  version: 'dream-quality-v1',
  familyMinimum: 5,
  largestFamilyShare: 0.6,
  rejectedSampleSize: 6,
  scanLimit: 500,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

export interface DreamQualityBenchmark {
  labels: readonly DreamBenchmarkLabel[];
  judgments: readonly DreamBenchmarkJudgment[];
  expectedSourceHash: string;
  observedSourceHash: string;
}
export interface DreamQualityFault {
  code: string;
  severity: 'minor' | 'major';
  runIds: string[];
  evidence: string[];
}

/** Round-robin over rejection reasons; hash order is repeatable, independent of input order. */
export function sampleRejectedDreams(runs: readonly DreamRun[], limit: number = DREAM_QUALITY_POLICY.rejectedSampleSize) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new RangeError('Invalid rejection sample limit');
  const groups = new Map<string, DreamRun[]>();
  for (const run of runs) {
    if (run.status === 'running' || run.review?.verdict !== 'reject') continue;
    const reason = String(run.review.reason ?? 'unspecified');
    const group = groups.get(reason) ?? [];
    if (!group.some(r => r.runId === run.runId)) group.push(run);
    groups.set(reason, group);
  }
  const rank = (r: DreamRun) => capabilityHash(`dream-rejected-v1:${r.workspaceId}:${r.potSlug}:${r.runId}`);
  for (const group of groups.values()) group.sort((a, b) => rank(a).localeCompare(rank(b)) || a.runId.localeCompare(b.runId));
  const strata = [...groups.keys()].sort();
  const sample: Array<{ runId: string; reason: string; candidateHash: unknown; evidenceHash: unknown }> = [];
  for (let round = 0; sample.length < limit; round++) {
    let added = false;
    for (const reason of strata) {
      const run = groups.get(reason)![round];
      if (!run) continue;
      sample.push({ runId: run.runId, reason, candidateHash: run.review!.candidateHash, evidenceHash: run.review!.evidenceHash });
      added = true;
      if (sample.length === limit) break;
    }
    if (!added) break;
  }
  return { population: [...groups.values()].reduce((n, rows) => n + rows.length, 0), strata: strata.length, sample };
}

export function reportDreamQuality(
  runs: readonly DreamRun[],
  scope: DreamMetricsScope,
  options: { complete?: boolean; benchmark?: DreamQualityBenchmark } = {},
) {
  // Reuse the metrics window contract, including its tenant and maximum-window validation.
  computeDreamMetrics([], scope);
  const since = Date.parse(scope.since), until = Date.parse(scope.until);
  const faults = new Map<string, DreamQualityFault>();
  const fault = (code: string, severity: DreamQualityFault['severity'], evidence: string, runId?: string) => {
    const entry = faults.get(code) ?? { code, severity, runIds: [], evidence: [] };
    if (severity === 'major') entry.severity = severity;
    if (runId && !entry.runIds.includes(runId)) entry.runIds.push(runId);
    const boundedEvidence = evidence.slice(0, 1000);
    if (!entry.evidence.includes(boundedEvidence) && entry.evidence.length < 8) entry.evidence.push(boundedEvidence);
    faults.set(code, entry);
  };
  const unique = new Map<string, DreamRun>();
  for (const run of runs) {
    if (run.workspaceId !== scope.workspaceId || run.potSlug !== scope.potSlug)
      throw new Error('Dream quality row crosses workspace or pot');
    const previous = unique.get(run.runId);
    if (!previous || run.updatedAt >= previous.updatedAt) unique.set(run.runId, run);
  }
  const valid: DreamRun[] = [];
  const observed: DreamRun[] = [];
  let inspected = 0;
  for (const run of unique.values()) {
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started)) { observed.push(run); fault('invalid-provenance', 'major', 'Invalid start timestamp', run.runId); continue; }
    if (started < since || started >= until || run.status === 'running') continue;
    observed.push(run);
    inspected++;
    try {
      const provenance = dreamCapabilityRun(run);
      if (!provenance) fault('missing-evidence', 'minor', 'Legacy attempt lacks capability provenance', run.runId);
      if (!Number.isFinite(run.costUsd) || run.costUsd < 0) throw new Error('Invalid recorded cost');
      if (run.outcome?.verdict === 'insight' && !run.review)
        fault('unresolved-review', 'minor', 'Completed proposal has no review result', run.runId);
      if (run.review?.verdict === 'unverified')
        fault('unresolved-review', 'minor', String(run.review.reason ?? 'Unverified review'), run.runId);
      if (run.review && provenance) {
        const review = run.review as unknown as CapabilityReviewResult;
        if (review.schemaVersion !== CAPABILITY_REVIEW_VERSION || !Array.isArray(review.coverage?.unknown))
          throw new Error('Missing capability review coverage');
        if (review.coverage.unknown.length)
          fault('missing-or-stale-evidence', review.verdict === 'accept' ? 'major' : 'minor', review.coverage.unknown.join('; '), run.runId);
        if (review.reason === 'source-unavailable' || review.reason === 'source-changed-during-review')
          fault('missing-or-stale-evidence', 'minor', review.reason, run.runId);
      }
      for (const assessment of dreamRunAssessments(run)) {
        if (assessment.candidateHash !== run.review?.candidateHash || assessment.evidenceHash !== run.review?.evidenceHash)
          throw new Error('Assessment is stale against its frozen review');
      }
      // A broken row is diagnosed without hiding the remaining rows in this window.
      computeDreamMetrics([{ run, routed: null, experiments: [] }], scope);
      valid.push(run);
    } catch (error) {
      fault('invalid-provenance', 'major', error instanceof Error ? error.message : String(error), run.runId);
    }
  }
  let metrics: DreamMetrics | null = null;
  try { metrics = computeDreamMetrics(valid.map(run => ({ run, routed: null, experiments: [] })), scope); }
  catch (error) { fault('invalid-provenance', 'major', error instanceof Error ? error.message : String(error)); }
  if (metrics) {
    for (const error of metrics.cost.reconciliationErrors) fault('accounting-mismatch', 'major', error);
    if (metrics.cost.unknownUsageCount || metrics.cost.unknownPacketUses)
      fault('unknown-accounting', 'minor', `${metrics.cost.unknownUsageCount} unknown calls; ${metrics.cost.unknownPacketUses} packet uses with unknown cost`);
    const family = metrics.novelty.largestFamilyShare;
    if (family.denominator >= DREAM_QUALITY_POLICY.familyMinimum && family.value !== null && family.value >= DREAM_QUALITY_POLICY.largestFamilyShare)
      fault('family-concentration', 'minor', `${family.numerator}/${family.denominator} identified proposals share one assessed family; inspect diversity`);
    if (metrics.reviewerDisagreement.numerator)
      fault('assessment-disagreement', 'minor', `${metrics.reviewerDisagreement.numerator}/${metrics.reviewerDisagreement.denominator} multiply-assessed proposals disagree`);
  }
  const cycles = new Map<string, number>();
  for (const run of valid) cycles.set(run.cycleId, (cycles.get(run.cycleId) ?? 0) + run.costUsd);
  for (const [cycle, cost] of cycles) if (cost > DEFAULT_DREAM_CYCLE_CONFIG.maxCostUsd + 1e-8)
    fault('budget-breach', 'major', `Cycle ${cycle} records USD ${cost} above its hard cap`);
  const windowCost = valid.reduce((n, r) => n + r.costUsd, 0);
  if (until - since <= DREAM_QUALITY_POLICY.windowMs && windowCost > DEFAULT_DREAM_CYCLE_CONFIG.rolling24hCostUsd + 1e-8)
    fault('budget-breach', 'major', `At most 24h records USD ${windowCost} above the rolling-day hard cap`);

  let calibration: { calibration: ReturnType<typeof dreamReviewerConfusion>; heldOut: ReturnType<typeof dreamReviewerConfusion> } | null = null;
  if (options.benchmark) {
    const b = options.benchmark;
    if (!/^[a-f0-9]{64}$/.test(b.expectedSourceHash) || b.expectedSourceHash !== b.observedSourceHash)
      fault('stale-calibration', 'major', 'Benchmark source differs from the independently reviewed snapshot');
    else try {
      calibration = { calibration: dreamReviewerConfusion(b.labels, b.judgments, 'calibration'), heldOut: dreamReviewerConfusion(b.labels, b.judgments, 'held-out') };
      for (const result of Object.values(calibration)) {
        if (result.falseAccept.numerator) fault('calibration-false-accept', 'major', `${result.split}: ${result.falseAccept.numerator}/${result.falseAccept.denominator} known negatives accepted`);
        if (result.falseReject.numerator) fault('calibration-false-reject', 'major', `${result.split}: ${result.falseReject.numerator}/${result.falseReject.denominator} known positives rejected`);
        if (result.cases.some(c => c.observed === 'missing' || (c.observed === 'unverified' && c.expected !== 'unverified')))
          fault('unresolved-calibration', 'minor', `${result.split}: missing or unresolved judgments remain in the denominators`);
      }
    } catch (error) { fault('invalid-calibration', 'major', error instanceof Error ? error.message : String(error)); }
  }
  return {
    policy: DREAM_QUALITY_POLICY, scope, coverage: { complete: options.complete ?? true, inspected, valid: valid.length },
    faults: [...faults.values()].map(f => ({ ...f, identifiedRunCount: f.runIds.length, runIds: f.runIds.slice(0, 12) })), calibration,
    reviewPassRate: metrics?.funnel.reviewPassRate ?? null,
    rejectedReview: sampleRejectedDreams(valid),
    // The evidence time is stable across ticks; a later clock tick is not new evidence.
    latestEvidenceAt: observed.filter(r => Number.isFinite(Date.parse(r.updatedAt)))
      .reduce<string | null>((latest, r) => latest === null || r.updatedAt > latest ? r.updatedAt : latest, null),
  };
}

/** Bounded read of the existing ledger; no synthetic labels or provider calls enter the live collector. */
export async function collectDreamQualitySignals(
  sql: Sql,
  workspaceId: string,
  now = Date.now(),
  readRuns = listDreamRuns,
) {
  if (!workspaceId.trim() || !Number.isFinite(now)) throw new Error('Dream quality collection needs workspace and clock');
  const since = new Date(now - DREAM_QUALITY_POLICY.windowMs).toISOString(), until = new Date(now).toISOString();
  const runs = await readRuns(sql, { workspaceId, limit: DREAM_QUALITY_POLICY.scanLimit });
  const complete = runs.length < DREAM_QUALITY_POLICY.scanLimit || runs.some(r => Date.parse(r.startedAt) < Date.parse(since));
  const groups = new Map<string, DreamRun[]>();
  for (const run of runs) {
    if (run.workspaceId !== workspaceId) throw new Error('Dream reader crossed workspace');
    const group = groups.get(run.potSlug) ?? [];
    group.push(run); groups.set(run.potSlug, group);
  }
  const reports = [...groups].map(([potSlug, rows]) => reportDreamQuality(rows, { workspaceId, potSlug, since, until }, { complete }));
  const rejectionSamples = reports.flatMap(r => r.rejectedReview.sample.map(s => ({ pot: r.scope.potSlug, ...s })));
  return {
    signals: reports.flatMap(report => report.faults.map(f => ({
      source: 'dream-quality' as const, key: `${report.scope.potSlug}:${f.code}`,
      title: `Dream quality: ${f.code}`,
      body: `${JSON.stringify({ window: report.scope, coverage: report.coverage, fault: f, reviewPassRate: report.reviewPassRate, rejectedReview: report.rejectedReview })}. Acceptance rate is diagnostic; review the cited evidence.`,
      severity: f.severity, kind: f.code === 'family-concentration' ? 'change' as const : 'bug' as const,
      scope: `harness:${report.scope.potSlug}`, latestAt: report.latestEvidenceAt ?? undefined,
      paths: ['packages/operator-core/lib/dream/dream-quality.ts'],
    }))),
    note: JSON.stringify({ window: { since, until }, fetched: runs.length, complete, rejectedSample: rejectionSamples.slice(0, 12), omittedSamples: Math.max(0, rejectionSamples.length - 12) }),
  };
}
