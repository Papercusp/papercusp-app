/**
 * Persistence + aggregation for worker-chunk-loop OUTCOMES — the monitoring metrics
 * surface for the operator-hosted `worker:chunk-loop` rollout
 * (worker-chunk-loop-operator-hosted-2026-06-14 P-020).
 *
 * ONE row per `runWorkerChunkLoop()` call (a feature attempt) into
 * `harness_shared.worker_chunk_loop_outcomes` (migration 394). The record carries the
 * ChunkLoopOutcome KIND and the execution PATH (subprocess vs the operator-hosted op) —
 * neither of which is captured anywhere else (the feature status collapses to
 * 'validating' | 'failing'). This is what the dark-launch parity diff and the ramp gate
 * read: feature completion RATE + outcome DISTRIBUTION, split by path.
 *
 * The write is BEST-EFFORT at the call site: a metrics-persist hiccup must NEVER fail a
 * real feature run (mirrors the bakeoff-delta persist). `recordWorkerChunkOutcome`
 * therefore never throws.
 */
import { type OrchestratorPg } from './invoke.js';
import type { ChunkLoopOutcome } from './worker-chunk-loop.js';

export type WorkerExecutionPath = 'subprocess' | 'op';

/** The persisted/derived shape of a single worker-chunk-loop outcome record. */
export interface ChunkLoopOutcomeRecord {
  executionPath: WorkerExecutionPath;
  outcomeKind: ChunkLoopOutcome['kind'];
  chunksCommitted: number | null;
  replanStrikes: number | null;
  escalatedChunkId: string | null;
  detail: string | null;
  /** P-020 crash-resume: true iff this run resumed a persisted, not-all-done plan. */
  resumed: boolean | null;
  /** P-020 file-lock contention: set ('lock_contention') only on aborted runs that hit the
   * chunk file-claim timeout; also distinguishes scratch-setup / replan failures. */
  abortReason: string | null;
  /** P-020 replan frequency: replans spent across the WHOLE run, not just on the chunk
   * that ultimately escalated (replanStrikes resets per-chunk and is escalated-only). */
  totalReplans: number | null;
  /** P-020 per-chunk durability numerator: chunks committed by the time the run ended,
   * for ANY outcome kind. */
  chunksCommittedSoFar: number | null;
  /** P-020 per-chunk durability denominator: size of the chunk plan this run drove. */
  totalChunksPlanned: number | null;
}

export interface WorkerChunkOutcomeCtx {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

const DETAIL_LIMIT = 2000;
const clampDetail = (s: string | undefined | null): string | null =>
  s == null ? null : s.length <= DETAIL_LIMIT ? s : `${s.slice(0, DETAIL_LIMIT)}…`;

/**
 * Pure map ChunkLoopOutcome → the persisted record fields. Exhaustive over the union;
 * unit-tested without PG.
 */
export function outcomeToRecord(
  outcome: ChunkLoopOutcome,
  executionPath: WorkerExecutionPath,
): ChunkLoopOutcomeRecord {
  const base = {
    executionPath,
    outcomeKind: outcome.kind,
    chunksCommitted: null as number | null,
    replanStrikes: null as number | null,
    escalatedChunkId: null as string | null,
    detail: null as string | null,
    resumed: outcome.resumed ?? null,
    totalReplans: outcome.totalReplans ?? null,
    chunksCommittedSoFar: outcome.chunksCommittedSoFar ?? null,
    totalChunksPlanned: outcome.totalChunksPlanned ?? null,
    abortReason: outcome.kind === 'aborted' ? (outcome.abortReason ?? null) : null,
  };
  switch (outcome.kind) {
    case 'completed':
      return { ...base, chunksCommitted: outcome.chunksCommitted };
    case 'planning_failed':
      return { ...base, detail: clampDetail(outcome.error) };
    case 'escalated':
      return {
        ...base,
        replanStrikes: outcome.strikes,
        escalatedChunkId: outcome.chunk.id,
        detail: clampDetail(outcome.reason),
      };
    case 'aborted':
      return { ...base, detail: clampDetail(outcome.reason) };
  }
}

/**
 * Persist one outcome record. BEST-EFFORT — never throws (a metrics hiccup must not fail
 * the loop). Returns true on a successful insert, false on any error (logged via `log`).
 */
export async function recordWorkerChunkOutcome(
  ctx: WorkerChunkOutcomeCtx,
  args: {
    featureId: string;
    executionPath: WorkerExecutionPath;
    outcome: ChunkLoopOutcome;
    atMs?: number;
    log?: (msg: string) => void;
  },
): Promise<boolean> {
  try {
    const rec = outcomeToRecord(args.outcome, args.executionPath);
    const createdTs = args.atMs ?? Date.now();
    await ctx.pg`
      INSERT INTO harness_shared.worker_chunk_loop_outcomes
        (workspace_id, harness_slug, feature_id, execution_path, outcome_kind,
         chunks_committed, replan_strikes, escalated_chunk_id, detail, created_ts,
         resumed, abort_reason, total_replans, chunks_committed_so_far, total_chunks_planned)
      VALUES
        (${ctx.workspaceId}, ${ctx.harnessSlug}, ${args.featureId}, ${rec.executionPath},
         ${rec.outcomeKind}, ${rec.chunksCommitted}, ${rec.replanStrikes},
         ${rec.escalatedChunkId}, ${rec.detail}, ${createdTs},
         ${rec.resumed}, ${rec.abortReason}, ${rec.totalReplans}, ${rec.chunksCommittedSoFar},
         ${rec.totalChunksPlanned})
    `;
    return true;
  } catch (err) {
    args.log?.(
      `worker-chunk outcome persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Read recent outcome records for aggregation (operator/dev-tool side). Filters by
 * workspace (RLS + explicit) and an optional time window / harness.
 */
export async function readWorkerChunkOutcomes(
  ctx: { pg: OrchestratorPg; workspaceId: string },
  opts: { sinceMs?: number; harnessSlug?: string; limit?: number } = {},
): Promise<ChunkLoopOutcomeRecord[]> {
  const since = opts.sinceMs ?? 0;
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000));
  const harness = opts.harnessSlug ?? null;
  const rows = (await ctx.pg`
    SELECT execution_path, outcome_kind, chunks_committed, replan_strikes,
           escalated_chunk_id, detail, resumed, abort_reason, total_replans,
           chunks_committed_so_far, total_chunks_planned
    FROM harness_shared.worker_chunk_loop_outcomes
    WHERE workspace_id = ${ctx.workspaceId}
      AND created_ts >= ${since}
      AND (${harness}::text IS NULL OR harness_slug = ${harness})
    ORDER BY created_ts DESC
    LIMIT ${limit}
  `) as unknown as Array<{
    execution_path: string;
    outcome_kind: string;
    chunks_committed: number | null;
    replan_strikes: number | null;
    escalated_chunk_id: string | null;
    detail: string | null;
    resumed: boolean | null;
    abort_reason: string | null;
    total_replans: number | null;
    chunks_committed_so_far: number | null;
    total_chunks_planned: number | null;
  }>;
  return rows.map((r) => ({
    executionPath: r.execution_path as WorkerExecutionPath,
    outcomeKind: r.outcome_kind as ChunkLoopOutcome['kind'],
    chunksCommitted: r.chunks_committed,
    replanStrikes: r.replan_strikes,
    escalatedChunkId: r.escalated_chunk_id,
    detail: r.detail,
    resumed: r.resumed ?? null,
    abortReason: r.abort_reason ?? null,
    totalReplans: r.total_replans ?? null,
    chunksCommittedSoFar: r.chunks_committed_so_far ?? null,
    totalChunksPlanned: r.total_chunks_planned ?? null,
  }));
}

export interface WorkerChunkPathMetrics {
  path: WorkerExecutionPath;
  total: number;
  /** completed / total (0..1); null when total === 0. */
  completionRate: number | null;
  /** counts per outcome kind. */
  distribution: Record<ChunkLoopOutcome['kind'], number>;
  /** mean replan strikes across escalated runs; null when none escalated. */
  avgReplanStrikes: number | null;
  /** mean chunks committed across completed runs; null when none completed. */
  avgChunksCommitted: number | null;
  /** P-020 file-lock contention: aborted runs whose abortReason was 'lock_contention'
   * (a chunk's file claim couldn't be acquired within CHUNK_LOCK_TIMEOUT_MS), and that
   * count as a rate over all runs on this path. */
  lockContentionCount: number;
  lockContentionRate: number | null;
  /** P-020 replan frequency across ALL runs (not just escalated ones): mean total
   * replan-strikes spent per run, and the share of runs that needed >=1 replan. Null
   * when no rows on this path report totalReplans (pre-migration data). */
  avgTotalReplans: number | null;
  replanRate: number | null;
  /** P-020 crash-resume success: how many runs on this path resumed a persisted plan
   * after a crash/restart, and their completion rate (vs the path's overall rate). */
  resumedCount: number;
  resumedCompletionRate: number | null;
  /** P-020 per-chunk durability: sum(chunks actually committed) / sum(chunks planned)
   * across every run that reported a plan size — 1.0 means every planned chunk across
   * every run on this path ended up committed. Null when no run reports plan size. */
  perChunkDurability: number | null;
}

export interface WorkerChunkMetrics {
  byPath: Record<WorkerExecutionPath, WorkerChunkPathMetrics>;
  /** op-vs-subprocess completion-rate delta (op − subprocess); null if either path has 0 runs. */
  completionRateDelta: number | null;
}

const ZERO_DIST = (): Record<ChunkLoopOutcome['kind'], number> => ({
  completed: 0,
  planning_failed: 0,
  escalated: 0,
  aborted: 0,
});

function summarizePath(path: WorkerExecutionPath, rows: ChunkLoopOutcomeRecord[]): WorkerChunkPathMetrics {
  const dist = ZERO_DIST();
  let strikeSum = 0;
  let strikeN = 0;
  let chunkSum = 0;
  let chunkN = 0;
  let lockContentionCount = 0;
  let totalReplansSum = 0;
  let totalReplansN = 0;
  let replanRunsCount = 0;
  let resumedCount = 0;
  let resumedCompletedCount = 0;
  let committedSoFarSum = 0;
  let plannedSum = 0;
  for (const r of rows) {
    dist[r.outcomeKind] = (dist[r.outcomeKind] ?? 0) + 1;
    if (r.outcomeKind === 'escalated' && r.replanStrikes != null) {
      strikeSum += r.replanStrikes;
      strikeN += 1;
    }
    if (r.outcomeKind === 'completed' && r.chunksCommitted != null) {
      chunkSum += r.chunksCommitted;
      chunkN += 1;
    }
    if (r.outcomeKind === 'aborted' && r.abortReason === 'lock_contention') {
      lockContentionCount += 1;
    }
    if (r.totalReplans != null) {
      totalReplansSum += r.totalReplans;
      totalReplansN += 1;
      if (r.totalReplans > 0) replanRunsCount += 1;
    }
    if (r.resumed) {
      resumedCount += 1;
      if (r.outcomeKind === 'completed') resumedCompletedCount += 1;
    }
    if (r.chunksCommittedSoFar != null && r.totalChunksPlanned != null && r.totalChunksPlanned > 0) {
      committedSoFarSum += r.chunksCommittedSoFar;
      plannedSum += r.totalChunksPlanned;
    }
  }
  const total = rows.length;
  return {
    path,
    total,
    completionRate: total === 0 ? null : dist.completed / total,
    distribution: dist,
    avgReplanStrikes: strikeN === 0 ? null : strikeSum / strikeN,
    avgChunksCommitted: chunkN === 0 ? null : chunkSum / chunkN,
    lockContentionCount,
    lockContentionRate: total === 0 ? null : lockContentionCount / total,
    avgTotalReplans: totalReplansN === 0 ? null : totalReplansSum / totalReplansN,
    replanRate: totalReplansN === 0 ? null : replanRunsCount / totalReplansN,
    resumedCount,
    resumedCompletionRate: resumedCount === 0 ? null : resumedCompletedCount / resumedCount,
    perChunkDurability: plannedSum === 0 ? null : committedSoFarSum / plannedSum,
  };
}

/**
 * Pure aggregation: the P-020 metric — feature completion RATE + outcome DISTRIBUTION,
 * split by execution PATH (subprocess vs op), plus the op−subprocess completion-rate
 * delta the ramp gate compares against baseline. Unit-tested without PG.
 */
export function summarizeWorkerChunkOutcomes(rows: ChunkLoopOutcomeRecord[]): WorkerChunkMetrics {
  const sub = summarizePath('subprocess', rows.filter((r) => r.executionPath === 'subprocess'));
  const op = summarizePath('op', rows.filter((r) => r.executionPath === 'op'));
  const completionRateDelta =
    sub.completionRate == null || op.completionRate == null
      ? null
      : op.completionRate - sub.completionRate;
  return { byPath: { subprocess: sub, op }, completionRateDelta };
}
