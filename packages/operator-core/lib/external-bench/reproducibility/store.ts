/**
 * Read side (BRIEF 8 / P-010) — the snake_case(PG) → camelCase(TS) seam. Returns
 * P-011's canonical `TaskRunResult` directly so buildSuiteReport() and the P-020
 * Evaluation UI consume one type with no per-caller mapping. Also reads the
 * rollout cards + prereg rows (P-010-owned artifacts).
 */
import type { TaskRunResult, TestOutcome } from '@papercusp/bench-metrics';
import type { PreregRecord, RolloutRecord } from './schema';
import { resolveDb, type DbScope } from './db';

/** bigint/numeric columns arrive as strings from postgres.js — coerce to number. */
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * jsonb columns come back as STRINGS under the production-faithful client
 * (prepare:false; see libs/papercusp/libs/db/src/connection.ts) — parse them.
 * Tolerates an already-parsed object too, so it's correct under any client.
 */
function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToTaskRunResult(r: any): TaskRunResult {
  return {
    runId: r.run_id,
    suite: r.suite,
    modality: r.modality,
    taskId: r.task_id,
    arm: r.arm,
    seed: Number(r.seed),
    resolved: r.resolved === null || r.resolved === undefined ? null : Boolean(r.resolved),
    score: numOrNull(r.score),
    graderStatus: r.grader_status,
    graderFamily: r.grader_family,
    graderVersion: r.grader_version,
    failToPass: asJson<TestOutcome[]>(r.fail_to_pass),
    passToPass: asJson<TestOutcome[]>(r.pass_to_pass),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    tokensTotal: num(r.tokens_total),
    tokensCacheRead: numOrNull(r.tokens_cache_read),
    tokensCacheWrite: numOrNull(r.tokens_cache_write),
    costUsd: num(r.cost_usd),
    priceTableVersion: r.price_table_version,
    wallClockMs: num(r.wall_clock_ms),
    turns: num(r.turns),
    budgetTokens: numOrNull(r.budget_tokens),
    capped: Boolean(r.capped),
    generationStatus: r.generation_status,
    generationError: r.generation_error ?? null,
    armMeta: asJson<Record<string, unknown>>(r.arm_meta),
    modelId: r.model_id,
    harnessVersion: r.harness_version,
    preregHash: r.prereg_hash,
    rolloutId: r.rollout_id,
    rawGraderOutputRef: r.raw_grader_output_ref ?? null,
    submissionRef: r.submission_ref ?? null,
    createdAt: toIso(r.created_at),
  };
}

function rowToRollout(r: any): RolloutRecord {
  return {
    rolloutId: r.rollout_id,
    runId: r.run_id,
    preregHash: r.prereg_hash,
    suite: r.suite,
    taskId: r.task_id,
    arm: r.arm,
    seed: Number(r.seed),
    configSnapshot: asJson<Record<string, unknown>>(r.config_snapshot),
    modelId: r.model_id,
    modelVersion: r.model_version ?? null,
    harnessVersion: r.harness_version,
    harnessGitSha: r.harness_git_sha ?? null,
    envFingerprint: asJson<Record<string, unknown>>(r.env_fingerprint),
    graderFamily: r.grader_family,
    graderVersion: r.grader_version,
    graderOutput: asJson(r.grader_output),
    rawGraderOutput: r.raw_grader_output ?? null,
    submission: r.submission ?? null,
    trajectoryRef: r.trajectory_ref ?? null,
    trajectoryKind: r.trajectory_kind ?? null,
    createdAt: toIso(r.created_at),
  };
}

function rowToPrereg(r: any): PreregRecord {
  return {
    preregHash: r.prereg_hash,
    runId: r.run_id,
    label: r.label ?? null,
    suites: asJson<PreregRecord['suites']>(r.suites) ?? [],
    config: asJson<Record<string, unknown>>(r.config) ?? {},
    filePath: r.file_path,
    gitCommitted: Boolean(r.git_committed),
    gitCommitSha: r.git_commit_sha ?? null,
    createdAt: toIso(r.created_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The per-(task × arm × seed) rows for a run (and optionally one suite), as TaskRunResult[]. */
export async function listRunResults(
  opts: { runId?: string; suite?: string } & DbScope = {},
): Promise<TaskRunResult[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_run_result
     WHERE workspace_id = ${ws}
       ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
       ${opts.suite ? sql`AND suite = ${opts.suite}` : sql``}
     ORDER BY suite, task_id, arm, seed
  `;
  return rows.map(rowToTaskRunResult);
}

export interface SuiteSummary {
  suite: string;
  runs: number;
  attempts: number;
  resolved: number;
  /** Attempts excluded from accuracy (resolved IS NULL — generation/grader infra). */
  infra: number;
  latestAt: string | null;
}

/** Suite scoreboard for the Evaluation UI's "External benchmarks" tab. */
export async function listSuites(opts: { runId?: string } & DbScope = {}): Promise<SuiteSummary[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<
    {
      suite: string;
      runs: number;
      attempts: number;
      resolved: number;
      infra: number;
      latest_at: Date | null;
    }[]
  >`
    SELECT suite,
           count(DISTINCT run_id)::int AS runs,
           count(*)::int AS attempts,
           count(*) FILTER (WHERE resolved IS TRUE)::int AS resolved,
           count(*) FILTER (WHERE resolved IS NULL)::int AS infra,
           max(created_at) AS latest_at
      FROM harness_shared.benchmark_run_result
     WHERE workspace_id = ${ws}
       ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
     GROUP BY suite
     ORDER BY suite
  `;
  return rows.map((r) => ({
    suite: r.suite,
    runs: r.runs,
    attempts: r.attempts,
    resolved: r.resolved,
    infra: r.infra,
    latestAt: r.latest_at ? toIso(r.latest_at) : null,
  }));
}

/** The full Rollout Card for one rollout (the published repro artifact). */
export async function getRollout(rolloutId: string, opts: DbScope = {}): Promise<RolloutRecord | null> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_rollout
     WHERE rollout_id = ${rolloutId} AND workspace_id = ${ws} LIMIT 1
  `;
  return rows.length ? rowToRollout(rows[0]) : null;
}

/** The pre-registration row, by hash or by run id. */
export async function getPrereg(
  by: { preregHash?: string; runId?: string },
  opts: DbScope = {},
): Promise<PreregRecord | null> {
  const { sql, ws } = resolveDb(opts);
  if (!by.preregHash && !by.runId) return null;
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_prereg
     WHERE workspace_id = ${ws}
       ${by.preregHash ? sql`AND prereg_hash = ${by.preregHash}` : sql``}
       ${by.runId ? sql`AND run_id = ${by.runId}` : sql``}
     LIMIT 1
  `;
  return rows.length ? rowToPrereg(rows[0]) : null;
}
