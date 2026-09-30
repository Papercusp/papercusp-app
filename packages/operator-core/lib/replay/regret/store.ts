/**
 * store.ts — regret mining's PG glue (self-learning-frontier-2026-06-12
 * P-021 / FB-07): selection reads over the spawn/usage/transcript tables and
 * the regret_findings persistence (migration 248).
 *
 * Selection joins (recon vs the LIVE schema, 2026-06-12):
 *   - spawned_agents.run_id ⋈ harness_run_output.run_id — 230/299 spawns in
 *     the 30d window have a persisted transcript (PG is canonical;
 *     invoke.ts §11.5).
 *   - spawned_agents.run_id ⋈ agent_usage_samples.run_id — 177/299 carry
 *     run-attributed usage (cost_usd/output_tokens). NOTE
 *     agent_runs_consolidated does NOT join spawned_agents.run_id (different
 *     id namespaces — 0/299); usage samples are the per-spawn source.
 *   - spawned_agents.feature_id ⋈ harness_features_consolidated.feature_id —
 *     `attempts` ≥ 2 = validator bounces.
 *
 * Findings persistence carries forward what is already paid for (the FB-04
 * rule): report_improvement_id NEVER reverts, and a 'replayed' row's scores
 * survive a re-mine upsert (detection columns refresh; replay results don't
 * regress to pending).
 *
 * All timestamps cross the wire as ISO strings — getOrgPg's live client
 * rejects JS Date params (insight: db-org-client-rejects-js-date-params).
 */

import type { Sql } from 'postgres';
import type { SelectionInputRow } from './selection-core';
import type { CandidateChange, CandidateReplayScore } from './counterfactual-core';
import type { RegretTickDeps } from './mine';
import { captureImprovement } from '../../harness/improvements/capture-core';

export type ReplayStatus = 'pending' | 'replayed' | 'skipped';

export interface RegretFindingRecord {
  workspaceId: string;
  runId: string;
  harnessSlug: string;
  role: string | null;
  badnessScore: number;
  badnessReasons: string[];
  divergenceTurn: number | null;
  divergenceKind: string | null;
  divergenceEvidence: Record<string, unknown> | null;
  candidateChanges: CandidateChange[];
  replayStatus: ReplayStatus;
  replayScores: CandidateReplayScore[] | null;
  reportImprovementId: string | null;
  minedAt: string;
}

/** Row-fetch ceiling — terminal spawns in a window, not all history. */
const READ_LIMIT = 2000;

/** Terminal spawns in the window with usage, transcript-presence, and bounce joins. */
export async function readSelectionRows(sql: Sql, workspaceId: string, windowDays: number): Promise<SelectionInputRow[]> {
  const scopes = [...new Set([workspaceId, '*'])];
  const rows = await sql<
    {
      run_id: string;
      harness_slug: string;
      role: string | null;
      status: string;
      exit_code: number | null;
      duration_ms: string | number | null;
      started_at: string | Date;
      cost_usd: string | number | null;
      output_tokens: string | number | null;
      transcript_bytes: string | number | null;
      feature_attempts: number | null;
    }[]
  >`
    SELECT sa.run_id,
           sa.harness_slug,
           sa.child_role AS role,
           sa.status,
           sa.exit_code,
           sa.duration_ms,
           sa.started_at,
           us.cost_usd,
           us.output_tokens,
           ro.transcript_bytes,
           f.attempts AS feature_attempts
      FROM harness_shared.spawned_agents sa
      LEFT JOIN LATERAL (
            SELECT sum(u.cost_usd) AS cost_usd, sum(u.output_tokens) AS output_tokens
              FROM harness_shared.agent_usage_samples u
             WHERE u.run_id = sa.run_id
           ) us ON true
      LEFT JOIN LATERAL (
            SELECT length(r.jsonl_body) AS transcript_bytes
              FROM harness_shared.harness_run_output r
             WHERE r.run_id = sa.run_id
             LIMIT 1
           ) ro ON true
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON f.feature_id = sa.feature_id AND f.harness_slug = sa.harness_slug
     WHERE sa.started_at > now() - make_interval(days => ${windowDays})
       AND sa.run_id IS NOT NULL
       AND sa.status IN ('done', 'failed', 'cancelled')
       AND sa.workspace_id = ANY(${scopes}::text[])
     ORDER BY sa.started_at DESC
     LIMIT ${READ_LIMIT}`;
  return rows.map((r) => ({
    runId: r.run_id,
    harnessSlug: r.harness_slug,
    role: r.role,
    status: r.status,
    exitCode: r.exit_code,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    transcriptBytes: r.transcript_bytes === null ? null : Number(r.transcript_bytes),
    featureAttempts: r.feature_attempts === null ? null : Number(r.feature_attempts),
  }));
}

/** The persisted stream body for one run; null when no transcript landed in PG. */
export async function readTranscriptBody(sql: Sql, runId: string): Promise<string | null> {
  const rows = await sql<{ jsonl_body: string }[]>`
    SELECT jsonl_body FROM harness_shared.harness_run_output WHERE run_id = ${runId} LIMIT 1`;
  return rows[0]?.jsonl_body ?? null;
}

/** Already-mined run ids for the workspace (the skip-known set). */
export async function listKnownRunIds(sql: Sql, workspaceId: string): Promise<Set<string>> {
  const rows = await sql<{ run_id: string }[]>`
    SELECT run_id FROM harness_shared.regret_findings WHERE workspace_id = ${workspaceId}`;
  return new Set(rows.map((r) => r.run_id));
}

/**
 * Upsert a finding. Detection columns refresh; replay results and the filed
 * report id CARRY FORWARD (paid-for work never regresses on a re-mine).
 */
export async function upsertFinding(sql: Sql, finding: RegretFindingRecord): Promise<void> {
  await sql`
    INSERT INTO harness_shared.regret_findings
      (workspace_id, run_id, harness_slug, role, badness_score, badness_reasons,
       divergence_turn, divergence_kind, divergence_evidence, candidate_changes,
       replay_status, replay_scores, report_improvement_id, mined_at, updated_at)
    VALUES (${finding.workspaceId}, ${finding.runId}, ${finding.harnessSlug}, ${finding.role},
            ${finding.badnessScore}, ${JSON.stringify(finding.badnessReasons)}::text::jsonb,
            ${finding.divergenceTurn}, ${finding.divergenceKind},
            ${finding.divergenceEvidence === null ? null : JSON.stringify(finding.divergenceEvidence)}::text::jsonb,
            ${JSON.stringify(finding.candidateChanges)}::text::jsonb,
            ${finding.replayStatus},
            ${finding.replayScores === null ? null : JSON.stringify(finding.replayScores)}::text::jsonb,
            ${finding.reportImprovementId}, ${finding.minedAt}, now())
    ON CONFLICT (workspace_id, run_id) DO UPDATE SET
      harness_slug = EXCLUDED.harness_slug,
      role = EXCLUDED.role,
      badness_score = EXCLUDED.badness_score,
      badness_reasons = EXCLUDED.badness_reasons,
      divergence_turn = EXCLUDED.divergence_turn,
      divergence_kind = EXCLUDED.divergence_kind,
      divergence_evidence = EXCLUDED.divergence_evidence,
      candidate_changes = EXCLUDED.candidate_changes,
      -- replay results never regress: a replayed row keeps its status+scores
      replay_status = CASE
        WHEN harness_shared.regret_findings.replay_status = 'replayed' THEN 'replayed'
        ELSE EXCLUDED.replay_status END,
      replay_scores = COALESCE(harness_shared.regret_findings.replay_scores, EXCLUDED.replay_scores),
      report_improvement_id = COALESCE(harness_shared.regret_findings.report_improvement_id, EXCLUDED.report_improvement_id),
      updated_at = now()`;
}

function recordFromRow(row: Record<string, unknown>): RegretFindingRecord {
  const minedAt = row.mined_at;
  return {
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    harnessSlug: String(row.harness_slug),
    role: (row.role as string | null) ?? null,
    badnessScore: Number(row.badness_score),
    badnessReasons: (row.badness_reasons as string[] | null) ?? [],
    divergenceTurn: row.divergence_turn === null ? null : Number(row.divergence_turn),
    divergenceKind: (row.divergence_kind as string | null) ?? null,
    divergenceEvidence: (row.divergence_evidence as Record<string, unknown> | null) ?? null,
    candidateChanges: (row.candidate_changes as CandidateChange[] | null) ?? [],
    replayStatus: row.replay_status as ReplayStatus,
    replayScores: (row.replay_scores as CandidateReplayScore[] | null) ?? null,
    reportImprovementId: (row.report_improvement_id as string | null) ?? null,
    minedAt: minedAt instanceof Date ? minedAt.toISOString() : String(minedAt),
  };
}

/** Findings awaiting the replay leg, oldest mined first (FIFO through the budget). */
export async function readPendingReplay(sql: Sql, workspaceId: string, limit: number): Promise<RegretFindingRecord[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM harness_shared.regret_findings
     WHERE workspace_id = ${workspaceId} AND replay_status = 'pending'
       AND divergence_turn IS NOT NULL
     ORDER BY mined_at ASC
     LIMIT ${limit}`;
  return rows.map(recordFromRow);
}

/** Record the replay leg's scores and flip the row to 'replayed'. */
export async function recordReplayScores(
  sql: Sql,
  workspaceId: string,
  runId: string,
  scores: CandidateReplayScore[],
): Promise<void> {
  await sql`
    UPDATE harness_shared.regret_findings
       SET replay_scores = ${JSON.stringify(scores)}::text::jsonb,
           replay_status = 'replayed',
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId}`;
}

/** Replayed-but-unfiled findings — the filing queue. */
export async function readUnfiledReplayed(sql: Sql, workspaceId: string, limit: number): Promise<RegretFindingRecord[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM harness_shared.regret_findings
     WHERE workspace_id = ${workspaceId} AND replay_status = 'replayed'
       AND report_improvement_id IS NULL
     ORDER BY mined_at ASC
     LIMIT ${limit}`;
  return rows.map(recordFromRow);
}

/** Stamp the filed report's improvement id onto its finding row. */
export async function markReportFiled(sql: Sql, workspaceId: string, runId: string, improvementId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.regret_findings
       SET report_improvement_id = ${improvementId}, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND run_id = ${runId}`;
}

/**
 * The live PG-backed deps (the routine action's default wiring). The replay
 * runner ships null — the FB-06 lib/replay adapter is wired here when
 * `frontier:replay-landed` fires; until then the replay leg is dormant and
 * findings accumulate as replay_status='pending'.
 */
export function defaultRegretDeps(sql: Sql): RegretTickDeps {
  return {
    readRows: (ws, windowDays) => readSelectionRows(sql, ws, windowDays),
    readTranscript: (runId) => readTranscriptBody(sql, runId),
    listKnownRunIds: (ws) => listKnownRunIds(sql, ws),
    upsertFinding: (finding) => upsertFinding(sql, finding),
    readPendingReplay: (ws, limit) => readPendingReplay(sql, ws, limit),
    recordReplayScores: (ws, runId, scores) => recordReplayScores(sql, ws, runId, scores),
    readUnfiledReplayed: (ws, limit) => readUnfiledReplayed(sql, ws, limit),
    capture: (input) => captureImprovement(input),
    markFiled: (ws, runId, id) => markReportFiled(sql, ws, runId, id),
    replayRunner: null,
    nowIso: () => new Date().toISOString(),
    log: (m) => console.log(m),
  };
}
