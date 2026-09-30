/**
 * drift.ts — the Fleet EKG's distribution-shift detector + change-ledger
 * attribution (self-learning-frontier-2026-06-12 P-030 / FB-10). PURE — no
 * PG, no LLM; scan.ts wires the IO.
 *
 * Model: compare a WINDOW cohort of session vectors (features.ts) against a
 * BASELINE cohort (the preceding days). Three finding kinds:
 *
 *   - numeric  — one per NUMERIC_FEATURES key, scored by PSI (population
 *     stability index) over baseline-quantile bins. PSI is the standard
 *     drift metric: ≥0.10 = moderate shift, ≥0.25 = major (industry rule of
 *     thumb, tunable via DriftOptions).
 *   - mix      — the cohort-aggregated tool-category distribution, scored by
 *     Jensen-Shannon divergence (base 2, 0..1).
 *   - bigram   — same, over category bigrams (the call RHYTHM, not just the
 *     call mix).
 *
 * Attribution (D-003): a finding is ATTRIBUTED when the behavior-change
 * ledger (lib/change-ledger) has ≥1 mutation row inside the lookback window
 * before the shift window's end — those rows ride along as ranked candidate
 * causes. A shift with NO ledgered mutation in range is UNATTRIBUTABLE — the
 * alarm case (someone changed behavior without a ledger row, or the world
 * changed under us).
 *
 * Cohort floors: drift over tiny cohorts is noise. Below the floors the
 * detector returns the 'insufficient' status instead of findings.
 */

import type { SessionVector } from './features';
import { NUMERIC_FEATURE_KEYS } from './features';
import type { BehaviorChangeRow } from '../change-ledger/change-ledger';

export interface DriftOptions {
  /** PSI thresholds for numeric features. */
  psiModerate?: number;
  psiMajor?: number;
  /** JSD thresholds for mix/bigram distributions. */
  jsdModerate?: number;
  jsdMajor?: number;
  /** Cohort floors — below either, no detection. */
  minWindowSessions?: number;
  minBaselineSessions?: number;
  /** Quantile bins for PSI. */
  bins?: number;
}

export const DRIFT_DEFAULTS: Required<DriftOptions> = {
  psiModerate: 0.1,
  psiMajor: 0.25,
  jsdModerate: 0.15,
  jsdMajor: 0.3,
  minWindowSessions: 8,
  minBaselineSessions: 30,
  bins: 5,
};

export type DriftSeverity = 'moderate' | 'major';
export type DriftKind = 'numeric' | 'mix' | 'bigram';

export interface DriftFinding {
  /** NUMERIC_FEATURES key, or 'toolMix' / 'toolBigrams'. */
  feature: string;
  kind: DriftKind;
  score: number;
  severity: DriftSeverity;
  /** numeric only: cohort medians + which way the window moved. */
  baselineSummary: number | null;
  windowSummary: number | null;
  direction: 'up' | 'down' | null;
}

export interface DriftResult {
  status: 'ok' | 'insufficient-window' | 'insufficient-baseline';
  windowSessions: number;
  baselineSessions: number;
  findings: DriftFinding[];
}

const EPS = 1e-4;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Population stability index of `window` against `baseline`, over bins cut at
 * baseline quantiles. Degenerate baselines (constant value) compare by the
 * out-of-range mass only.
 */
export function psi(baseline: number[], window: number[], bins = DRIFT_DEFAULTS.bins): number {
  if (baseline.length === 0 || window.length === 0) return 0;
  const sorted = [...baseline].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) {
    const pos = (sorted.length - 1) * (i / bins);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    edges.push(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
  }
  const bucket = (v: number): number => {
    let b = 0;
    while (b < edges.length && v > edges[b]) b += 1;
    return b;
  };
  const count = (values: number[]): number[] => {
    const c = new Array<number>(bins).fill(0);
    for (const v of values) c[bucket(v)] += 1;
    return c;
  };
  const bCounts = count(baseline);
  const wCounts = count(window);
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const b = Math.max(bCounts[i] / baseline.length, EPS);
    const w = Math.max(wCounts[i] / window.length, EPS);
    total += (w - b) * Math.log(w / b);
  }
  return total;
}

/** Jensen-Shannon divergence (base 2 → 0..1) between two count maps. */
export function jsd(p: Record<string, number>, q: Record<string, number>): number {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  if (keys.size === 0) return 0;
  const pTotal = Object.values(p).reduce((a, b) => a + b, 0);
  const qTotal = Object.values(q).reduce((a, b) => a + b, 0);
  if (pTotal === 0 || qTotal === 0) return 0;
  let div = 0;
  for (const k of keys) {
    const pi = Math.max((p[k] ?? 0) / pTotal, EPS);
    const qi = Math.max((q[k] ?? 0) / qTotal, EPS);
    const mi = (pi + qi) / 2;
    div += (pi * Math.log2(pi / mi) + qi * Math.log2(qi / mi)) / 2;
  }
  return div;
}

/** Sum count maps across a cohort. */
export function aggregateCounts(cohort: SessionVector[], pick: (s: SessionVector) => Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of cohort) {
    for (const [k, v] of Object.entries(pick(s))) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** Detect distribution shifts of `window` against `baseline`. */
export function detectDrift(
  baseline: SessionVector[],
  window: SessionVector[],
  opts: DriftOptions = {},
): DriftResult {
  const o = { ...DRIFT_DEFAULTS, ...opts };
  const base = { windowSessions: window.length, baselineSessions: baseline.length };
  if (window.length < o.minWindowSessions) return { ...base, status: 'insufficient-window', findings: [] };
  if (baseline.length < o.minBaselineSessions) return { ...base, status: 'insufficient-baseline', findings: [] };

  const findings: DriftFinding[] = [];

  for (const key of NUMERIC_FEATURE_KEYS) {
    const bVals = baseline.map((s) => s.features[key] ?? 0);
    const wVals = window.map((s) => s.features[key] ?? 0);
    const score = psi(bVals, wVals, o.bins);
    if (score < o.psiModerate) continue;
    const bMed = median(bVals);
    const wMed = median(wVals);
    findings.push({
      feature: key,
      kind: 'numeric',
      score,
      severity: score >= o.psiMajor ? 'major' : 'moderate',
      baselineSummary: bMed,
      windowSummary: wMed,
      direction: wMed === bMed ? null : wMed > bMed ? 'up' : 'down',
    });
  }

  const mixScore = jsd(aggregateCounts(baseline, (s) => s.toolMix), aggregateCounts(window, (s) => s.toolMix));
  if (mixScore >= o.jsdModerate) {
    findings.push({
      feature: 'toolMix',
      kind: 'mix',
      score: mixScore,
      severity: mixScore >= o.jsdMajor ? 'major' : 'moderate',
      baselineSummary: null,
      windowSummary: null,
      direction: null,
    });
  }

  const bigramScore = jsd(aggregateCounts(baseline, (s) => s.bigrams), aggregateCounts(window, (s) => s.bigrams));
  if (bigramScore >= o.jsdModerate) {
    findings.push({
      feature: 'toolBigrams',
      kind: 'bigram',
      score: bigramScore,
      severity: bigramScore >= o.jsdMajor ? 'major' : 'moderate',
      baselineSummary: null,
      windowSummary: null,
      direction: null,
    });
  }

  findings.sort((a, b) => b.score - a.score);
  return { ...base, status: 'ok', findings };
}

// ---------------------------------------------------------------------------
// Change-ledger attribution (D-003)
// ---------------------------------------------------------------------------

/** A candidate cause carried on a shift row (subset of the ledger row). */
export interface LedgerCandidate {
  id: string;
  source: string;
  mutationClass: string;
  target: string;
  recordedAt: string;
  summary: string | null;
}

export interface AttributedFinding extends DriftFinding {
  attributed: boolean;
  ledgerCandidates: LedgerCandidate[];
}

/** How far before the window's END a ledgered mutation can claim a shift. */
export const ATTRIBUTION_LOOKBACK_MS = 72 * 3600_000;
const MAX_CANDIDATES = 5;

/**
 * Attach candidate causes: ledger rows recorded in
 * [windowEnd − lookback, windowEnd], newest first. Behavioral shifts lag the
 * mutation that caused them (sessions started before the change finish after
 * it), so the lookback deliberately reaches BEFORE the window.
 */
export function attributeFindings(
  findings: DriftFinding[],
  ledger: BehaviorChangeRow[],
  windowEndMs: number,
  lookbackMs = ATTRIBUTION_LOOKBACK_MS,
): AttributedFinding[] {
  const inRange = ledger
    .filter((r) => {
      const t = Date.parse(r.recordedAt);
      return Number.isFinite(t) && t <= windowEndMs && t >= windowEndMs - lookbackMs;
    })
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const candidates: LedgerCandidate[] = inRange.slice(0, MAX_CANDIDATES).map((r) => ({
    id: r.id,
    source: r.source,
    mutationClass: r.mutationClass,
    target: r.target,
    recordedAt: r.recordedAt,
    summary: r.summary,
  }));
  return findings.map((f) => ({ ...f, attributed: candidates.length > 0, ledgerCandidates: candidates }));
}
