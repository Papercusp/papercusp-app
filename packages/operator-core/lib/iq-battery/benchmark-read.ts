/**
 * benchmark-read.ts — the read behind the Learning tab's "Benchmark" sub-view
 * (operator-learning-tab-2026-06-09 P-007).
 *
 * The apiary / IQ-battery runs a fixed task corpus against the bee fleet and judges
 * each run (composite + d1/d2/d3) — the YARDSTICK that says whether the improvements
 * loop + the gym actually make the agents better over time (D-004). This reader rolls
 * the canonical cup_keeper tables (instances → runs → scores, migration 555 renamed from 180/201) into
 * one summary row PER INSTANCE (= one benchmark generation), newest-first, so the UI
 * can show the trend. The legacy `iq_battery_metrics` table is NOT used — cup_keeper_scores
 * is the source of truth.
 *
 * Pure SQL over an injected `Sql` (mirrors the gym control-plane readers); the scope is
 * workspace_id (the runner stamps it on every instance).
 */
import type { Sql } from 'postgres';

export interface ApiaryInstanceSummary {
  instanceId: string;
  /** Git commit of the solver under test — the generation identity. */
  codeSha: string;
  /** ISO timestamp of the instance (the trend x-axis). */
  createdAt: string;
  totalRuns: number;
  successfulRuns: number;
  /** 0..1 — successful runs / total runs. */
  successRate: number;
  /** Mean judge composite (the headline benchmark metric); null if unscored. */
  meanComposite: number | null;
  /** Mean wall-clock seconds task-start → green, over successful runs. */
  meanTimeToGreenSecs: number | null;
  /** Mean tokens per solved task. */
  meanTokens: number | null;
  /** 0..1 — fraction of runs that escalated to a human. */
  escalationRate: number | null;
  /** 0..1 — fraction solved on the first attempt. */
  firstAttemptRate: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

/**
 * Per-instance benchmark summaries, newest instance first (capped). Each row is one
 * sealed apiary generation; aggregates run over that instance's scored runs. A run with
 * no score row contributes to totalRuns but not the score means (LEFT JOIN), so a
 * partially-judged instance still reports an honest success/total.
 */
export async function readApiaryInstanceSummaries(
  sql: Sql,
  q: { workspaceId: string; limit?: number },
): Promise<ApiaryInstanceSummary[]> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const rows = (await sql`
    SELECT
      i.instance_id,
      i.code_sha,
      i.created_at,
      count(DISTINCT r.run_id)::int                                      AS total_runs,
      count(*) FILTER (WHERE s.success)::int                             AS successful_runs,
      avg(s.composite)                                                   AS mean_composite,
      avg(s.time_to_green_secs) FILTER (WHERE s.success)                 AS mean_time_to_green,
      avg(s.tokens_per_task) FILTER (WHERE s.success)                    AS mean_tokens,
      avg(CASE WHEN s.escalation THEN 1.0 ELSE 0.0 END)                  AS escalation_rate,
      avg(CASE WHEN s.first_attempt_pass THEN 1.0 ELSE 0.0 END)         AS first_attempt_rate
    FROM harness_shared.cup_keeper_instances i
    JOIN harness_shared.cup_keeper_runs r   ON r.instance_id = i.instance_id
    LEFT JOIN harness_shared.cup_keeper_scores s ON s.run_id = r.run_id
    WHERE i.workspace_id = ${q.workspaceId}
    GROUP BY i.instance_id, i.code_sha, i.created_at
    ORDER BY i.created_at DESC
    LIMIT ${limit}`) as Record<string, unknown>[];

  return rows.map((r) => {
    const total = Number(r.total_runs ?? 0);
    const success = Number(r.successful_runs ?? 0);
    return {
      instanceId: String(r.instance_id),
      codeSha: String(r.code_sha ?? ''),
      createdAt: isoOf(r.created_at),
      totalRuns: total,
      successfulRuns: success,
      successRate: total ? success / total : 0,
      meanComposite: num(r.mean_composite),
      meanTimeToGreenSecs: num(r.mean_time_to_green),
      meanTokens: num(r.mean_tokens),
      escalationRate: num(r.escalation_rate),
      firstAttemptRate: num(r.first_attempt_rate),
    };
  });
}
