/**
 * selection-core.ts — pure bad-session scoring for regret mining
 * (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * Input rows come from store.ts (`readSelectionRows`: spawned_agents ⋈
 * agent_usage_samples ⋈ harness_run_output ⋈ harness_features_consolidated).
 * This module ranks them by "badness" — how much the session looks like one
 * regret mining can learn from:
 *
 *   token-burn percentile — within the ROLE cohort, on the best available
 *     burn metric per row: summed cost_usd (agent_usage_samples), else
 *     output tokens, else transcript bytes (length(jsonl_body) — always
 *     present when a transcript is). Percentiles compare like with like:
 *     the cohort is (role, metric kind), and small cohorts (< 4) yield no
 *     percentile rather than a misleading one.
 *   terminal status — failed / cancelled spawns; rc=124 timeouts.
 *   validator bounces — harness_features_consolidated.attempts ≥ 2 on the
 *     spawn's feature (each attempt past the first is a bounce).
 *
 * Reasons are stable strings (they land in regret_findings.badness_reasons
 * and the filed report), not enums — additive evolution without migrations.
 */

export interface SelectionInputRow {
  runId: string;
  harnessSlug: string;
  role: string | null;
  /** spawned_agents.status — done | failed | cancelled (terminal only). */
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  /** Summed agent_usage_samples.cost_usd for the run; null when unsampled. */
  costUsd: number | null;
  /** Summed agent_usage_samples.output_tokens; null when unsampled. */
  outputTokens: number | null;
  /** length(harness_run_output.jsonl_body); null when no transcript persisted. */
  transcriptBytes: number | null;
  /** harness_features_consolidated.attempts on the spawn's feature; null when feature-less. */
  featureAttempts: number | null;
}

export interface BadSessionCandidate extends SelectionInputRow {
  /** 0..1 — how worth-mining the session looks. */
  badnessScore: number;
  /** Stable reason strings, e.g. 'burn-p93', 'status-failed', 'validator-bounces:2'. */
  reasons: string[];
  /** Burn percentile within the (role, metric) cohort; null for tiny cohorts / no metric. */
  burnPercentile: number | null;
}

export interface SelectionOptions {
  /** Minimum badness to keep. Default 0.35. */
  minScore?: number;
  /** Max candidates returned per tick. Default 10. */
  maxSessions?: number;
}

export const DEFAULT_MIN_SCORE = 0.35;
export const DEFAULT_MAX_SESSIONS = 10;
const MIN_COHORT = 4;

type BurnMetric = { kind: 'cost' | 'tokens' | 'bytes'; value: number };

function burnMetricOf(row: SelectionInputRow): BurnMetric | null {
  if (row.costUsd !== null && row.costUsd > 0) return { kind: 'cost', value: row.costUsd };
  if (row.outputTokens !== null && row.outputTokens > 0) return { kind: 'tokens', value: row.outputTokens };
  if (row.transcriptBytes !== null && row.transcriptBytes > 0) return { kind: 'bytes', value: row.transcriptBytes };
  return null;
}

/** Fraction of cohort values strictly below `value` (0..1). */
function percentileWithin(cohort: number[], value: number): number {
  let below = 0;
  for (const v of cohort) if (v < value) below += 1;
  return below / cohort.length;
}

/** Score + rank the window's sessions; returns candidates above bar, worst first. */
export function scoreBadSessions(
  rows: readonly SelectionInputRow[],
  options: SelectionOptions = {},
): BadSessionCandidate[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // Cohorts: (role, burn-metric kind) → values.
  const cohorts = new Map<string, number[]>();
  const metrics = new Map<string, BurnMetric | null>();
  for (const row of rows) {
    const metric = burnMetricOf(row);
    metrics.set(row.runId, metric);
    if (!metric) continue;
    const key = `${row.role ?? '?'} ${metric.kind}`;
    const cohort = cohorts.get(key) ?? [];
    cohort.push(metric.value);
    cohorts.set(key, cohort);
  }

  const candidates: BadSessionCandidate[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    let score = 0;

    const metric = metrics.get(row.runId) ?? null;
    let burnPercentile: number | null = null;
    if (metric) {
      const cohort = cohorts.get(`${row.role ?? '?'} ${metric.kind}`) ?? [];
      if (cohort.length >= MIN_COHORT) {
        burnPercentile = percentileWithin(cohort, metric.value);
        if (burnPercentile >= 0.9) {
          score += 0.3;
          reasons.push(`burn-p${Math.round(burnPercentile * 100)}`);
        } else if (burnPercentile >= 0.75) {
          score += 0.15;
          reasons.push(`burn-p${Math.round(burnPercentile * 100)}`);
        }
      }
    }

    if (row.status === 'failed') {
      score += 0.3;
      reasons.push('status-failed');
    } else if (row.status === 'cancelled') {
      score += 0.2;
      reasons.push('status-cancelled');
    }

    if (row.exitCode === 124) {
      score += 0.15;
      reasons.push('timeout-rc124');
    }

    if (row.featureAttempts !== null && row.featureAttempts >= 2) {
      score += 0.25;
      reasons.push(`validator-bounces:${row.featureAttempts - 1}`);
    }

    const badnessScore = Math.min(1, score);
    if (badnessScore >= minScore) {
      candidates.push({ ...row, badnessScore, reasons, burnPercentile });
    }
  }

  candidates.sort((a, b) => b.badnessScore - a.badnessScore || (a.startedAt < b.startedAt ? 1 : -1));
  return candidates.slice(0, maxSessions);
}
