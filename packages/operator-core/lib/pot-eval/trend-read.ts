/**
 * trend-read.ts — the read behind the Learning tab Benchmark view's "Hive orchestration" trend
 * (hive-run-evaluation-2026-06-13 HE-07, P-050). The SIBLING of iq-battery/benchmark-read.ts.
 *
 * The Hive-eval battery runs the seeded scenario corpus through a whole throwaway Hive each code
 * generation and scores the run on outcome quality / efficiency / speed (the un-gameable gate) —
 * the YARDSTICK that says whether queen-execution / wave-dispatch / autonomy actually made the Hive
 * better over time (D-007). This reader rolls the hive_eval tables (instances → runs → scores,
 * migrations 264/268) into one summary row PER INSTANCE (= one generation), newest-first, so the UI
 * can show the trend. Its OWN tables — NEVER the apiary beekeeper trend (D-011), so Hive-run scores
 * never contaminate the instance-evolution ranking.
 *
 * Scoped to ONE rubric hash (default: the current DEFAULT_HIVE_SCORE_RUBRIC_V1) so a threshold
 * change never silently mixes incomparable scores into the trend (D-011). A run with no score under
 * that rubric contributes to totalRuns but not the means (LEFT JOIN). Pure SQL over an injected
 * `Sql`; the scope is workspace_id (the runner stamps it on every instance).
 */
import type { Sql } from 'postgres';
import { hiveScoreRubricHash, DEFAULT_HIVE_SCORE_RUBRIC_V1 } from './scoring';

export interface HiveEvalGenerationSummary {
  instanceId: string;
  /** Git commit of the code under test — the generation identity (the trend x-axis label). */
  codeSha: string;
  /** ISO timestamp of the instance (the trend x-axis). */
  createdAt: string;
  /** Runs recorded for this generation (whole-Hive scenario runs). */
  totalRuns: number;
  /** Runs scored under the requested rubric (≤ totalRuns). */
  scoredRuns: number;
  /** Mean composite (0–10) — the headline benchmark metric; null if unscored. */
  meanComposite: number | null;
  /** Mean efficiency sub-score (0–10) over scored runs. */
  meanEfficiency: number | null;
  /** Mean speed sub-score (0–10) over scored runs. */
  meanSpeed: number | null;
  /** Mean critical-path ratio (≥1; the computed, un-gameable speed signal). */
  meanCriticalPathRatio: number | null;
  /** 0..1 — fraction of scored runs that passed the D-002 outcome gate. */
  outcomeGatePassRate: number | null;
  /** 0..1 — fraction of scored runs where a fabricated DONE was detected (D-005). */
  fabricationRate: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

/**
 * Per-generation Hive-eval summaries, newest instance first (capped). Each row is one code
 * generation; the score aggregates run over that instance's runs scored under `rubricHash`
 * (defaulting to the current rubric). A run with no score under that rubric contributes to
 * totalRuns but not the means (LEFT JOIN), so a partially-scored generation still reports honestly.
 */
export async function readHiveEvalInstanceSummaries(
  sql: Sql,
  q: { workspaceId: string; limit?: number; rubricHash?: string },
): Promise<HiveEvalGenerationSummary[]> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const rubricHash = q.rubricHash ?? hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1);
  const rows = (await sql`
    SELECT
      i.instance_id,
      i.code_sha,
      i.created_at,
      count(DISTINCT r.run_id)::int                                       AS total_runs,
      count(s.run_id)::int                                                AS scored_runs,
      avg(s.composite)                                                    AS mean_composite,
      avg(s.efficiency_score)                                             AS mean_efficiency,
      avg(s.speed_score)                                                  AS mean_speed,
      avg(s.critical_path_ratio)                                          AS mean_critical_path_ratio,
      -- ::int (not CASE-WHEN) so an UNSCORED run (NULL LEFT JOIN) stays NULL and avg ignores it —
      -- a CASE WHEN NULL would score 0 and wrongly drag the rate down over unscored runs.
      avg(s.outcome_gate_passed::int)                                     AS gate_pass_rate,
      avg(s.fabrication_detected::int)                                    AS fabrication_rate
    FROM harness_shared.pot_eval_instances i
    JOIN harness_shared.pot_eval_runs r       ON r.instance_id = i.instance_id
    LEFT JOIN harness_shared.pot_eval_scores s ON s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}
    WHERE i.workspace_id = ${q.workspaceId}
    GROUP BY i.instance_id, i.code_sha, i.created_at
    ORDER BY i.created_at DESC
    LIMIT ${limit}`) as Record<string, unknown>[];

  return rows.map((r) => ({
    instanceId: String(r.instance_id),
    codeSha: String(r.code_sha ?? ''),
    createdAt: isoOf(r.created_at),
    totalRuns: Number(r.total_runs ?? 0),
    scoredRuns: Number(r.scored_runs ?? 0),
    meanComposite: num(r.mean_composite),
    meanEfficiency: num(r.mean_efficiency),
    meanSpeed: num(r.mean_speed),
    meanCriticalPathRatio: num(r.mean_critical_path_ratio),
    outcomeGatePassRate: num(r.gate_pass_rate),
    fabricationRate: num(r.fabrication_rate),
  }));
}
