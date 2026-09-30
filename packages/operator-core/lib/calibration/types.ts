/**
 * Calibration markets (self-learning-frontier-2026-06-12 P-041 / FB-13) —
 * vocabulary + shapes for cheap recorded claims ("bets") captured at natural
 * moments (improvement resolves, plan starts, flake filings), matured by the
 * resolution sweep, and Brier-scored per persona per domain. Per D-005 the
 * scores only ever land as a feature of the one queue ranker and as
 * Queen-weighting reads (calibration:summary) — never as their own ranker.
 *
 * Storage: harness_shared.calibration_predictions (migration 253). Domain and
 * subject_kind are plain text columns; this module owns the vocabulary.
 */
import type { SignalOrigin } from '../harness/improvements/provenance';

/** The v1 bet domains. */
export type PredictionDomain = 'fix-survival' | 'plan-ship' | 'flake-recurrence';
export const PREDICTION_DOMAINS: readonly PredictionDomain[] = [
  'fix-survival',
  'plan-ship',
  'flake-recurrence',
];

export type PredictionSubjectKind = 'improvement' | 'plan';

/**
 * Per-domain implicit prior + maturity horizon. The prior is what a seam
 * records when the actor states no probability (stated:false) — cheap volume
 * that bootstraps per-persona base rates; an explicit `confidence` upgrades
 * the bet to stated:true, where the Brier score actually differentiates.
 */
export const DOMAIN_DEFAULTS: Record<PredictionDomain, { prior: number; horizonDays: number }> = {
  // "this fix survives — no re-capture/reopen inside the horizon"
  'fix-survival': { prior: 0.8, horizonDays: 14 },
  // "this started plan reaches status shipped inside the horizon"
  'plan-ship': { prior: 0.7, horizonDays: 30 },
  // "this filed flake recurs (same watchdogKey re-captured) inside the horizon"
  'flake-recurrence': { prior: 0.6, horizonDays: 14 },
};

/**
 * Flake-shaped watchdog keys — the flake-recurrence capture seam's net
 * (capture-core checks it synchronously, so it lives in this pure module).
 */
export function isFlakeKey(key: string): boolean {
  return /flak|quarantin/i.test(key);
}

/** One bet row (camelCase mirror of the PG columns; timestamps epoch-ms). */
export interface PredictionRow {
  id: string;
  workspaceId: string;
  predictor: string;
  domain: string;
  subjectKind: string;
  subjectId: string;
  claim: string;
  probability: number;
  stated: boolean;
  origin: SignalOrigin;
  watchdogKey: string | null;
  horizonTs: number;
  createdAt: number;
  resolvedAt: number | null;
  /** true/false once scored; NULL after resolution = voided (unscorable). */
  outcome: boolean | null;
  resolutionNote: string | null;
  /** The pot the predictor worked under (P-002 pot-scope-all-learnings); null = pre-pot legacy or context-less. */
  potSlug: string | null;
}

/** Per-persona per-domain Brier aggregate over scored organic bets. */
export interface CalibrationScore {
  predictor: string;
  domain: string;
  /** Scored bets (outcome NOT NULL). */
  n: number;
  /** Mean (p − outcome)². 0 = perfect; 0.25 = constant-0.5 noise. */
  brier: number;
  /** Mean realized outcome — the predictor's base rate in this domain. */
  baseRate: number;
  /** Shrunk trust weight in [0,1] (scoring.ts): 0.5 = unknown/neutral. */
  weight: number;
}
