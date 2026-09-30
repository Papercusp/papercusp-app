/**
 * Operational bench-run store (benchmark-evaluation-ui-2026-06-16 P-002 / D-001).
 *
 * The durable, MUTABLE, lifecycle-driven source the Evaluation UI reads + writes
 * — distinct from the reproducibility cards (reproducibility/fleet.ts → the
 * immutable, firewall-gated benchmark_fleet_run / benchmark_run_result). This
 * module owns the bench_runs / bench_run_tasks / bench_run_events tables
 * (migration 296):
 *
 *   - WRITE (live): a UI/CLI-launched run upserts its run row, per-task rows as
 *     bees collect, and the coordination trace INCREMENTALLY so the in-flight run
 *     is visible (P-007). Each write fires notifySyncInvalidate so the desktop
 *     SSE stream refetches.
 *   - WRITE (import): readPreservedRun (the file-dir, ~/.papercusp/bench-results)
 *     → upsert, ONE-WAY (dir → store), so preserved/CLI runs appear alongside
 *     live ones. The file-dir stays the legacy source; the store is the live one.
 *   - READ: list + detail, reconstructed into the SAME PreservedArmRun /
 *     PreservedRunDetail shapes the existing eval-viz already renders (summary via
 *     the one canonical summarizePreservedRun) so the UI migration off REST is
 *     near-drop-in.
 *
 * The camelCase↔snake_case + DB-scope seam mirrors reproducibility/db.ts so the
 * same fresh-DB injection pattern drives the integration test.
 */
import type { CoordEvent } from '@papercusp/bench-metrics';
import { substrateSignalRates } from '@papercusp/bench-metrics';
import { notifySyncInvalidate } from '../sync-sse';
import { resolveDb, type DbScope } from './reproducibility/db';
import {
  defaultBenchResultsDir,
  listPreservedRuns,
  readPreservedRun,
  summarizePreservedRun,
  type PreservedArmRun,
  type PreservedRunSummary,
  type ResolvedPerTask,
} from './preserved-runs';
import type { FleetTaskResult } from './hive-backlog';

const jb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

export type BenchRunStatus = 'pending' | 'running' | 'grading' | 'done' | 'error' | 'cancelled';
export type BenchTaskStatus = 'todo' | 'in_progress' | 'collected' | 'graded' | 'error';
export type BenchRunSource = 'ui' | 'cli' | 'import';

/** The identity + launch config of a run (the create/upsert input). */
export interface BenchRunInit {
  id: string;
  arm: string;
  taskSetId: string;
  model: string;
  suite?: string;
  source?: BenchRunSource;
  status?: BenchRunStatus;
  config?: Record<string, unknown> | null;
  potSlug?: string | null;
  taskCount?: number | null;
  recovered?: boolean;
}

/** One per-task row (lenient — a live `todo` row carries only instanceId). */
export interface BenchTaskRow {
  instanceId: string;
  taskStatus?: BenchTaskStatus;
  resolved?: boolean | null;
  cupId?: string | null;
  disposition?: string | null;
  stopReason?: string | null;
  generationError?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  turns?: number | null;
  wallClockMs?: number | null;
  diffBytes?: number | null;
  armMeta?: Record<string, unknown> | null;
}

export interface BenchRunListEntry {
  id: string;
  arm: string;
  taskSetId: string;
  suite: string;
  model: string;
  status: BenchRunStatus;
  source: string;
  taskCount: number | null;
  gradedCount: number | null;
  resolvedCount: number | null;
  /** External/transient/infra rows EXCLUDED from the resolved% denominator (the fairness count). */
  infraExcluded: number | null;
  /** resolvedCount / gradedCount (0–1) where gradedCount = SCORED tasks (infra excluded); null when none scored. */
  resolvedPct: number | null;
  nonEmptyDiffs: number | null;
  costUsd: number | null;
  wallMs: number | null;
  recovered: boolean;
  runError: string | null;
  potSlug: string | null;
  fleetRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BenchRunDetail extends BenchRunListEntry {
  config: Record<string, unknown> | null;
  /** The headline rollup (re-derived via the canonical summarizer). */
  summary: PreservedRunSummary;
  /** The file-dir-equivalent shape the existing eval-viz consumes. */
  run: PreservedArmRun;
  perTask: ResolvedPerTask[];
  /** Objective substrate-signal rates over the coordEvents trace (feeds MastBreakdown). */
  coordRates: ReturnType<typeof substrateSignalRates>;
}

// ───────────────────────── writes ──────────────────────────

/** Create or refresh a run's identity row. On re-create (same id) the identity +
 *  config + status are refreshed; metrics are left to the dedicated updaters. */
export async function upsertBenchRun(init: BenchRunInit, opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const status = init.status ?? 'running';
  const source = init.source ?? 'ui';
  const suite = init.suite ?? 'swe-bench-pro';
  await sql`
    INSERT INTO harness_shared.bench_runs
      (id, workspace_id, arm, task_set_id, suite, model, status, source, config,
       pot_slug, task_count, recovered, started_at, created_at, updated_at)
    VALUES
      (${init.id}, ${ws}, ${init.arm}, ${init.taskSetId}, ${suite}, ${init.model}, ${status}, ${source},
       ${jb(init.config ?? null)}::text::jsonb, ${init.potSlug ?? null}, ${init.taskCount ?? null},
       ${init.recovered ?? false},
       ${status === 'running' ? sql`now()` : sql`null`}, now(), now())
    ON CONFLICT (id) DO UPDATE SET
      arm = EXCLUDED.arm, task_set_id = EXCLUDED.task_set_id, suite = EXCLUDED.suite,
      model = EXCLUDED.model, status = EXCLUDED.status, source = EXCLUDED.source,
      config = EXCLUDED.config, pot_slug = EXCLUDED.pot_slug, task_count = EXCLUDED.task_count,
      recovered = EXCLUDED.recovered, updated_at = now()
  `;
  await invalidate(init.id);
}

/** Record the spawned hive home slug (onHiveCreated) — for teardown + monitoring joins. */
export async function setBenchRunHive(runId: string, potSlug: string, opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`
    UPDATE harness_shared.bench_runs SET pot_slug = ${potSlug}, updated_at = now()
     WHERE id = ${runId} AND workspace_id = ${ws}
  `;
  await invalidate(runId);
}

/** Upsert one per-task row (live progress or a collected result). */
export async function upsertBenchRunTask(runId: string, task: BenchTaskRow, opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`
    INSERT INTO harness_shared.bench_run_tasks
      (run_id, workspace_id, instance_id, task_status, resolved, bee_id, disposition,
       stop_reason, generation_error, tokens_in, tokens_out, cost_usd, turns,
       wall_clock_ms, diff_bytes, arm_meta, created_at, updated_at)
    VALUES
      (${runId}, ${ws}, ${task.instanceId}, ${task.taskStatus ?? 'todo'}, ${task.resolved ?? null},
       ${task.cupId ?? null}, ${task.disposition ?? null}, ${task.stopReason ?? null},
       ${task.generationError ?? null}, ${task.tokensIn ?? null}, ${task.tokensOut ?? null},
       ${task.costUsd ?? null}, ${task.turns ?? null}, ${task.wallClockMs ?? null},
       ${task.diffBytes ?? null}, ${jb(task.armMeta ?? null)}::text::jsonb, now(), now())
    ON CONFLICT (run_id, instance_id) DO UPDATE SET
      task_status = EXCLUDED.task_status,
      resolved = COALESCE(EXCLUDED.resolved, harness_shared.bench_run_tasks.resolved),
      bee_id = COALESCE(EXCLUDED.bee_id, harness_shared.bench_run_tasks.bee_id),
      disposition = COALESCE(EXCLUDED.disposition, harness_shared.bench_run_tasks.disposition),
      stop_reason = COALESCE(EXCLUDED.stop_reason, harness_shared.bench_run_tasks.stop_reason),
      generation_error = EXCLUDED.generation_error,
      tokens_in = COALESCE(EXCLUDED.tokens_in, harness_shared.bench_run_tasks.tokens_in),
      tokens_out = COALESCE(EXCLUDED.tokens_out, harness_shared.bench_run_tasks.tokens_out),
      cost_usd = COALESCE(EXCLUDED.cost_usd, harness_shared.bench_run_tasks.cost_usd),
      turns = COALESCE(EXCLUDED.turns, harness_shared.bench_run_tasks.turns),
      wall_clock_ms = COALESCE(EXCLUDED.wall_clock_ms, harness_shared.bench_run_tasks.wall_clock_ms),
      diff_bytes = COALESCE(EXCLUDED.diff_bytes, harness_shared.bench_run_tasks.diff_bytes),
      arm_meta = COALESCE(EXCLUDED.arm_meta, harness_shared.bench_run_tasks.arm_meta),
      updated_at = now()
  `;
  await invalidate(runId);
}

/** Map a collected FleetTaskResult → a `collected` task row. */
export function taskRowFromFleetResult(tr: FleetTaskResult): BenchTaskRow {
  const a = tr.attempt;
  const diffBytes = a.diff ? Buffer.byteLength(a.diff, 'utf8') : 0;
  return {
    instanceId: a.instanceId,
    taskStatus: 'collected',
    cupId: tr.cupId,
    disposition: tr.disposition,
    stopReason: a.stopReason,
    generationError: a.generationError ?? null,
    tokensIn: a.tokensIn,
    tokensOut: a.tokensOut,
    costUsd: a.costUsd,
    turns: a.turns,
    wallClockMs: a.wallClockMs,
    diffBytes,
    armMeta: a.armMeta ?? null,
  };
}

/** Append coordination events to a run's trace (live streaming). Seq continues
 *  after the current max — use this OR setBenchRunEvents, not both for the same events. */
export async function appendBenchRunEvents(
  runId: string,
  events: readonly CoordEvent[],
  opts: DbScope = {},
): Promise<{ inserted: number }> {
  if (events.length === 0) return { inserted: 0 };
  const { sql, ws } = resolveDb(opts);
  const max = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM harness_shared.bench_run_events
     WHERE run_id = ${runId} AND workspace_id = ${ws}
  `;
  const start = Number(max[0]?.next ?? 0);
  await sql`INSERT INTO harness_shared.bench_run_events ${sql(
    events.map((e, i) => eventRow(runId, ws, start + i, e)),
    'run_id', 'workspace_id', 'seq', 'ts', 'kind', 'agent', 'task_id', 'payload',
  )}`;
  await invalidate(runId);
  return { inserted: events.length };
}

/** Replace a run's whole coordination trace idempotently (completion / import). */
export async function setBenchRunEvents(runId: string, events: readonly CoordEvent[], opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM harness_shared.bench_run_events WHERE run_id = ${runId} AND workspace_id = ${ws}`;
    if (events.length > 0) {
      await tx`INSERT INTO harness_shared.bench_run_events ${tx(
        events.map((e, i) => eventRow(runId, ws, i, e)),
        'run_id', 'workspace_id', 'seq', 'ts', 'kind', 'agent', 'task_id', 'payload',
      )}`;
    }
  });
  await invalidate(runId);
}

function eventRow(runId: string, ws: string, seq: number, e: CoordEvent) {
  return {
    run_id: runId,
    workspace_id: ws,
    seq,
    ts: e.ts ?? null,
    kind: e.kind,
    agent: e.agent ?? null,
    task_id: e.taskId ?? null,
    payload: e.detail != null ? JSON.stringify({ detail: e.detail }) : null,
  };
}

/** Transition status (+ optional run_error / finished_at stamp). */
export async function setBenchRunStatus(
  runId: string,
  status: BenchRunStatus,
  patch: { runError?: string | null; finished?: boolean } = {},
  opts: DbScope = {},
): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const finished = patch.finished ?? (status === 'done' || status === 'error' || status === 'cancelled');
  await sql`
    UPDATE harness_shared.bench_runs SET
      status = ${status},
      run_error = ${patch.runError ?? null},
      finished_at = ${finished ? sql`now()` : sql`finished_at`},
      updated_at = now()
     WHERE id = ${runId} AND workspace_id = ${ws}
  `;
  await invalidate(runId);
}

/**
 * Roll up + persist run-level metrics from the per-task rows (call on completion).
 *
 * FAIRNESS (benchmark-fairness-fix): a per-task row whose generation/grading was an EXTERNAL or TRANSIENT
 * failure (stop_reason ∈ {error, timeout, infra-failed} or a non-null generation_error) is EXCLUDED from
 * the resolved% denominator — it is treated as resolved=null (never a capability fail) and counted
 * SEPARATELY in `infra_excluded`. So `graded_count` = scored rows the grader actually verdicted, and
 * resolved% = resolved_count / graded_count is resolved / SCORED-tasks, NOT resolved / all-graded. This is
 * the live mirror of `@papercusp/bench-metrics` `isScored` (the same stop-reason → generationStatus bridge
 * `generationStatusForStopReason` encodes; `NON_SCORED_STOP_REASONS` is the locked set, kept in sync here).
 */
export async function rollupBenchRunMetrics(runId: string, opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`
    UPDATE harness_shared.bench_runs r SET
      task_count = agg.task_count,
      graded_count = agg.graded_count,
      resolved_count = agg.resolved_count,
      infra_excluded = agg.infra_excluded,
      non_empty_diffs = agg.non_empty_diffs,
      cost_usd = agg.cost_usd,
      tokens_in = agg.tokens_in,
      tokens_out = agg.tokens_out,
      updated_at = now()
    FROM (
      SELECT
        count(*)::int AS task_count,
        -- A row is NON-SCORED (excluded — external/transient/infra) when its stop_reason is one of the
        -- locked non-scored reasons OR it carries a generation_error. These never count as a fail.
        count(*) FILTER (
          WHERE (stop_reason IS NULL OR stop_reason NOT IN ('error', 'timeout', 'infra-failed'))
            AND generation_error IS NULL
            AND resolved IS NOT NULL
        )::int AS graded_count,
        count(*) FILTER (
          WHERE (stop_reason IS NULL OR stop_reason NOT IN ('error', 'timeout', 'infra-failed'))
            AND generation_error IS NULL
            AND resolved IS TRUE
        )::int AS resolved_count,
        count(*) FILTER (
          WHERE stop_reason IN ('error', 'timeout', 'infra-failed') OR generation_error IS NOT NULL
        )::int AS infra_excluded,
        count(*) FILTER (WHERE diff_bytes > 0)::int AS non_empty_diffs,
        COALESCE(sum(cost_usd), 0) AS cost_usd,
        COALESCE(sum(tokens_in), 0)::bigint AS tokens_in,
        COALESCE(sum(tokens_out), 0)::bigint AS tokens_out
      FROM harness_shared.bench_run_tasks
      WHERE run_id = ${runId} AND workspace_id = ${ws}
    ) agg
    WHERE r.id = ${runId} AND r.workspace_id = ${ws}
  `;
  await invalidate(runId);
}

/** Apply an official grader verdict map (instance_id → resolved) to the task rows
 *  + re-roll the run's graded/resolved counts. Used by the grade trigger (P-010)
 *  and the file-dir import. */
export async function applyGradeMap(
  runId: string,
  gradeMap: Record<string, boolean>,
  opts: DbScope = {},
): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const entries = Object.entries(gradeMap);
  if (entries.length > 0) {
    await sql.begin(async (tx) => {
      for (const [instanceId, resolved] of entries) {
        await tx`
          UPDATE harness_shared.bench_run_tasks
             SET resolved = ${resolved}, task_status = 'graded', updated_at = now()
           WHERE run_id = ${runId} AND workspace_id = ${ws} AND instance_id = ${instanceId}
        `;
      }
    });
  }
  await rollupBenchRunMetrics(runId, opts);
}

/** On-completion write: stamp the run-level wall/peak/window + status, then
 *  roll up metrics from the per-task rows. Per-task rows + events are expected to
 *  already be persisted incrementally (durability hooks) — this finalizes. */
export async function recordRunCompletion(
  runId: string,
  fin: {
    peakConcurrentBees?: number | null;
    wallMs?: number | null;
    startedAtIso?: string | null;
    runError?: string | null;
  },
  opts: DbScope = {},
): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const status: BenchRunStatus = fin.runError ? 'error' : 'done';
  await sql`
    UPDATE harness_shared.bench_runs SET
      peak_concurrent_bees = COALESCE(${fin.peakConcurrentBees ?? null}, peak_concurrent_bees),
      wall_ms = COALESCE(${fin.wallMs ?? null}, wall_ms),
      started_at = COALESCE(started_at, ${fin.startedAtIso ?? null}),
      status = ${status},
      run_error = ${fin.runError ?? null},
      finished_at = now(),
      updated_at = now()
     WHERE id = ${runId} AND workspace_id = ${ws}
  `;
  await rollupBenchRunMetrics(runId, opts);
  // Best-effort: emit a portable report-<runId>.html alongside the run (plan
  // benchmark-report-portable-trace-2026-06-17, P-001). Dynamic-imported + try/caught so it NEVER
  // blocks or fails run completion; a runId with no run_result rows just no-ops (returns null).
  try {
    const { emitReport } = await import('./report/report-builder-pg');
    // DbScope carries `workspaceId`, not `workspace` — the old `opts.workspace`
    // was always `undefined` (a type error), so the report builder silently fell
    // back to the ACTIVE workspace and emitted the wrong/empty report for any run
    // in a non-active workspace.
    await emitReport(runId, { workspace: opts.workspaceId });
  } catch {
    /* report emit is best-effort — a missing report never breaks a completed run */
  }
}

// ───────────────────────── reads ──────────────────────────

export async function listBenchRuns(opts: DbScope = {}): Promise<BenchRunListEntry[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<RunRow[]>`
    SELECT * FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws}
     ORDER BY created_at DESC
     LIMIT 500
  `;
  return rows.map(toListEntry);
}

export async function getBenchRunDetail(id: string, opts: DbScope = {}): Promise<BenchRunDetail | null> {
  const { sql, ws } = resolveDb(opts);
  const runRows = await sql<RunRow[]>`
    SELECT * FROM harness_shared.bench_runs WHERE id = ${id} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = runRows[0];
  if (!row) return null;

  const taskRows = await sql<TaskRow[]>`
    SELECT * FROM harness_shared.bench_run_tasks
     WHERE run_id = ${id} AND workspace_id = ${ws}
     ORDER BY instance_id ASC
  `;
  const eventRows = await sql<EventRow[]>`
    SELECT * FROM harness_shared.bench_run_events
     WHERE run_id = ${id} AND workspace_id = ${ws}
     ORDER BY seq ASC
  `;

  const perTask: ResolvedPerTask[] = taskRows.map((t) => ({
    instanceId: t.instance_id,
    cupId: t.bee_id ?? undefined,
    disposition: t.disposition ?? undefined,
    stopReason: t.stop_reason ?? undefined,
    generationError: t.generation_error,
    tokensIn: numOrUndef(t.tokens_in),
    tokensOut: numOrUndef(t.tokens_out),
    costUsd: numOrUndef(t.cost_usd),
    turns: numOrUndef(t.turns),
    wallClockMs: numOrUndef(t.wall_clock_ms),
    diffBytes: numOrUndef(t.diff_bytes),
    armMeta: parseJsonb<Record<string, unknown>>(t.arm_meta) ?? undefined,
    resolved: t.resolved,
  }));
  const coordEvents: CoordEvent[] = eventRows.map((e) => ({
    ts: e.ts == null ? undefined : Number(e.ts),
    kind: e.kind as CoordEvent['kind'],
    agent: e.agent ?? undefined,
    taskId: e.task_id ?? null,
    detail: parseJsonb<{ detail?: string }>(e.payload)?.detail,
  }));

  const totalCost = perTask.reduce((s, t) => s + (t.costUsd || 0), 0);
  const run: PreservedArmRun = {
    arm: row.arm,
    runId: row.id,
    runError: row.run_error,
    startedAt: row.started_at ?? undefined,
    wallMs: numOrUndef(row.wall_ms) ?? 0,
    peakConcurrentBees: row.peak_concurrent_bees ?? 0,
    taskCount: perTask.length,
    nonEmptyDiffs: perTask.filter((t) => (t.diffBytes ?? 0) > 0).length,
    totals: {
      costUsd: numOrUndef(row.cost_usd) ?? totalCost,
      tokensIn: numOrUndef(row.tokens_in) ?? perTask.reduce((s, t) => s + (t.tokensIn || 0), 0),
      tokensOut: numOrUndef(row.tokens_out) ?? perTask.reduce((s, t) => s + (t.tokensOut || 0), 0),
    },
    perTask,
    coordEvents,
    recovered: row.recovered,
  };

  const summary = summarizePreservedRun(run, perTask);
  const list = toListEntry(row);
  return {
    ...list,
    config: parseJsonb<Record<string, unknown>>(row.config),
    summary,
    run,
    perTask,
    coordRates: substrateSignalRates(coordEvents, perTask.length),
  };
}

/** Delete a run + its task/event rows (P-014 management). The file-dir snapshot
 *  is left on disk (re-importable). Returns whether a row was removed. */
export async function deleteBenchRun(runId: string, opts: DbScope = {}): Promise<{ deleted: boolean }> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.bench_runs WHERE id = ${runId} AND workspace_id = ${ws} RETURNING id
  `;
  if (rows.length > 0) {
    await notifySyncInvalidate('evals.benchRuns', {});
    await notifySyncInvalidate('evals.benchRun', { runId });
  }
  return { deleted: rows.length > 0 };
}

// ───────────────────── file-dir import (one-way dir → store) ─────────────────────

/** Import one preserved file-dir run into the store (source='import'). Idempotent. */
export async function importPreservedRunToStore(
  id: string,
  opts: DbScope & { baseDir?: string } = {},
): Promise<{ runId: string; imported: boolean }> {
  const baseDir = opts.baseDir ?? defaultBenchResultsDir();
  const detail = readPreservedRun(id, baseDir);
  if (!detail) return { runId: id, imported: false };
  const { run, perTask, summary } = detail;

  await upsertBenchRun(
    {
      id,
      // `arm` is a NOT-NULL identity column; a preserved run whose metadata JSON
      // omitted it would pass `undefined` to postgres-js (UNDEFINED_VALUE) and
      // throw. Fall back to a placeholder so a near-complete run still imports.
      arm: run.arm ?? 'unknown',
      taskSetId: inferTaskSetId(perTask.length),
      model: 'opus',
      source: 'import',
      status: 'done',
      recovered: Boolean(run.recovered),
      taskCount: perTask.length,
      config: { imported: true, runId: run.runId ?? null },
    },
    opts,
  );

  // Per-task rows (with grader verdict already merged by readPreservedRun).
  for (const t of perTask) {
    // instance_id is half the (run_id, instance_id) PK / ON CONFLICT target — a
    // task missing it can't be keyed (undefined → postgres-js UNDEFINED_VALUE);
    // skip it rather than abort the whole run's import.
    if (t.instanceId == null) continue;
    await upsertBenchRunTask(
      id,
      {
        instanceId: t.instanceId,
        taskStatus: t.resolved == null ? 'collected' : 'graded',
        resolved: t.resolved,
        cupId: t.cupId ?? null,
        disposition: t.disposition ?? null,
        stopReason: t.stopReason ?? null,
        generationError: t.generationError ?? null,
        tokensIn: t.tokensIn ?? null,
        tokensOut: t.tokensOut ?? null,
        costUsd: t.costUsd ?? null,
        turns: t.turns ?? null,
        wallClockMs: t.wallClockMs ?? null,
        diffBytes: t.diffBytes ?? null,
        armMeta: t.armMeta ?? null,
      },
      opts,
    );
  }
  await setBenchRunEvents(id, run.coordEvents ?? [], opts);

  // Stamp the rolled-up headline straight from the preserved summary, then finalize.
  await finalizeImportedRun(id, run, summary, opts);
  return { runId: id, imported: true };
}

async function finalizeImportedRun(
  id: string,
  run: PreservedArmRun,
  summary: PreservedRunSummary,
  opts: DbScope = {},
): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`
    UPDATE harness_shared.bench_runs SET
      status = 'done',
      task_count = ${summary.taskCount},
      graded_count = ${summary.gradedCount},
      resolved_count = ${summary.resolvedCount},
      infra_excluded = ${summary.infraExcluded},
      non_empty_diffs = ${summary.nonEmptyDiffs},
      cost_usd = ${summary.costUsd},
      tokens_in = ${summary.tokensIn},
      tokens_out = ${summary.tokensOut},
      wall_ms = ${summary.wallMs},
      peak_concurrent_bees = ${summary.peakConcurrentBees},
      summary = ${jb(summary)}::text::jsonb,
      started_at = COALESCE(${run.startedAt ?? null}, started_at),
      finished_at = now(),
      updated_at = now()
     WHERE id = ${id} AND workspace_id = ${ws}
  `;
  await invalidate(id);
}

/** Backfill every preserved file-dir run into the store (idempotent). */
export async function importAllPreservedRuns(
  opts: DbScope & { baseDir?: string } = {},
): Promise<{ imported: string[]; skipped: string[] }> {
  const baseDir = opts.baseDir ?? defaultBenchResultsDir();
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const entry of listPreservedRuns(baseDir)) {
    // Per-entry isolation: ONE malformed preserved run (e.g. a metadata JSON
    // missing `arm` → postgres-js `UNDEFINED_VALUE`) must not abort the whole
    // boot-time backfill and leave the Evaluation Compare view empty. Skip the
    // bad run with a warning and import the rest.
    try {
      const res = await importPreservedRunToStore(entry.id, opts);
      (res.imported ? imported : skipped).push(entry.id);
    } catch (e) {
      skipped.push(entry.id);
       
      console.warn(
        `[bench-import] skipped malformed preserved run ${entry.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { imported, skipped };
}

// ───────────────────────── helpers ──────────────────────────

async function invalidate(runId: string): Promise<void> {
  await notifySyncInvalidate('evals.benchRuns', {});
  await notifySyncInvalidate('evals.benchRun', { runId });
  await notifySyncInvalidate('evals.benchRunLive', { runId });
}

function inferTaskSetId(taskCount: number): string {
  if (taskCount === 11) return '11-task-pilot';
  return `custom:${taskCount}-task`;
}

const numOrUndef = (v: unknown): number | undefined =>
  v == null ? undefined : typeof v === 'number' ? v : Number(v);

/** Read a jsonb column defensively — the production org client parses jsonb to an
 *  object, but a bare postgres-js client (tests) returns the raw text; handle both. */
function parseJsonb<T>(v: unknown): T | null {
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

function toListEntry(r: RunRow): BenchRunListEntry {
  const resolvedCount = r.resolved_count == null ? null : Number(r.resolved_count);
  const gradedCount = r.graded_count == null ? null : Number(r.graded_count);
  // resolved% = resolved / SCORED-tasks (gradedCount already excludes infra/transient rows — fairness fix).
  const resolvedPct = resolvedCount != null && gradedCount != null && gradedCount > 0 ? resolvedCount / gradedCount : null;
  return {
    id: r.id,
    arm: r.arm,
    taskSetId: r.task_set_id,
    suite: r.suite,
    model: r.model,
    status: r.status as BenchRunStatus,
    source: r.source,
    taskCount: r.task_count == null ? null : Number(r.task_count),
    gradedCount,
    resolvedCount,
    infraExcluded: r.infra_excluded == null ? null : Number(r.infra_excluded),
    resolvedPct,
    nonEmptyDiffs: r.non_empty_diffs == null ? null : Number(r.non_empty_diffs),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    wallMs: r.wall_ms == null ? null : Number(r.wall_ms),
    recovered: Boolean(r.recovered),
    runError: r.run_error,
    potSlug: r.pot_slug,
    fleetRunId: r.fleet_run_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Raw row shapes (snake_case as returned by postgres-js).
interface RunRow {
  id: string;
  workspace_id: string;
  arm: string;
  task_set_id: string;
  suite: string;
  model: string;
  status: string;
  source: string;
  summary: unknown;
  task_count: number | null;
  graded_count: number | null;
  resolved_count: number | null;
  infra_excluded: number | null;
  non_empty_diffs: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  wall_ms: number | null;
  peak_concurrent_bees: number | null;
  recovered: boolean;
  run_error: string | null;
  config: unknown;
  fleet_run_id: string | null;
  pot_slug: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}
interface TaskRow {
  instance_id: string;
  task_status: string;
  resolved: boolean | null;
  bee_id: string | null;
  disposition: string | null;
  stop_reason: string | null;
  generation_error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  turns: number | null;
  wall_clock_ms: number | null;
  diff_bytes: number | null;
  arm_meta: unknown;
}
interface EventRow {
  seq: number;
  ts: number | null;
  kind: string;
  agent: string | null;
  task_id: string | null;
  payload: unknown;
}
