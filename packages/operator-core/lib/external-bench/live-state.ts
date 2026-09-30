/**
 * Live bench-run fleet state (benchmark-evaluation-ui-2026-06-16 P-007 / P-009).
 *
 * The "manual PG checks made visual": for a run still in flight, read the live
 * fleet — the Queen's survival (status/age/reclaims), bee status counts, the
 * model-leak check (opus-only), cumulative spend, wall-clock — from
 * spawned_agents / agent_usage_samples scoped to the run's spawned hive
 * (pot_slug), plus the per-task progress from bench_run_tasks. This replaces the
 * hand-run SELECTs that drove the benchmark.
 *
 * The AGGREGATION is a pure function (aggregateBenchRunLiveState) so it is unit-
 * tested in isolation; the fetcher just supplies rows. For a completed/imported
 * run (no hive, fleet gone) the live signals come back null → the validity badges
 * show "unknown" honestly rather than a fabricated pass.
 */
import { resolveDb, type DbScope } from './reproducibility/db';

/** A spawned-agent row (the subset we read). */
export interface LiveSpawnRow {
  childRole: string;
  status: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  restartCount: number | null;
}
/** A usage-sample row (the subset we read). */
export interface LiveSampleRow {
  model: string | null;
  modelClass: string | null;
  costUsd: number | null;
}

export interface BenchRunLiveState {
  runId: string;
  status: string;
  potSlug: string | null;
  /** A genuinely in-flight run with a live fleet (vs a completed/imported run). */
  isLive: boolean;
  queen: {
    alive: boolean | null;
    ageSec: number | null;
    reclaims: number | null;
    status: string | null;
  };
  bees: {
    total: number;
    placed: number;
    working: number;
    done: number;
    evicted: number;
    failed: number;
    byStatus: Record<string, number>;
  };
  models: {
    opusOnly: boolean | null;
    nonOpusSamples: number | null;
    totalSamples: number | null;
    distinctModels: string[];
  };
  spendUsd: number | null;
  wallSec: number | null;
  taskProgress: { todo: number; in_progress: number; collected: number; graded: number; error: number; total: number };
}

const QUEEN_ROLE = 'mug';
const DEAD_STATUSES = new Set(['done', 'completed', 'failed', 'error', 'cancelled', 'canceled', 'evicted', 'exited', 'dead', 'killed']);
const WORKING_STATUSES = new Set(['running', 'working', 'active', 'spawning', 'in_progress', 'placed', 'started']);
const EVICTED_STATUSES = new Set(['evicted', 'cancelled', 'canceled']);
const FAILED_STATUSES = new Set(['failed', 'error']);
const DONE_STATUSES = new Set(['done', 'completed', 'exited']);

function isOpusModel(model: string | null, modelClass: string | null): boolean {
  const m = (model ?? modelClass ?? '').toLowerCase();
  return m.includes('opus');
}

/** Pure aggregation of the live fleet rows → the monitor state. nowMs is injected. */
export function aggregateBenchRunLiveState(args: {
  runId: string;
  status: string;
  potSlug: string | null;
  startedAtMs: number | null;
  nowMs: number;
  agents: LiveSpawnRow[];
  samples: LiveSampleRow[];
  taskCounts: Record<string, number>;
}): BenchRunLiveState {
  const { runId, status, potSlug, startedAtMs, nowMs, agents, samples, taskCounts } = args;

  // ── Queen ──
  const queenRows = agents.filter((a) => a.childRole === QUEEN_ROLE);
  const newest = queenRows.reduce<LiveSpawnRow | null>((best, r) => {
    if (!best) return r;
    return (r.startedAtMs ?? 0) > (best.startedAtMs ?? 0) ? r : best;
  }, null);
  const queen = newest
    ? {
        status: newest.status,
        alive: !DEAD_STATUSES.has(newest.status.toLowerCase()) && newest.finishedAtMs == null,
        ageSec: newest.startedAtMs != null ? Math.max(0, Math.round((nowMs - newest.startedAtMs) / 1000)) : null,
        // A reclaim = a queen respawn: extra queen rows + any per-queen restarts.
        reclaims: Math.max(0, queenRows.length - 1) + queenRows.reduce((s, r) => s + (r.restartCount ?? 0), 0),
      }
    : { status: null, alive: null, ageSec: null, reclaims: null };

  // ── Bees ──
  const beeRows = agents.filter((a) => a.childRole !== QUEEN_ROLE);
  const byStatus: Record<string, number> = {};
  let placed = 0, working = 0, done = 0, evicted = 0, failed = 0;
  for (const b of beeRows) {
    const s = b.status.toLowerCase();
    byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    if (DONE_STATUSES.has(s)) done += 1;
    else if (EVICTED_STATUSES.has(s)) evicted += 1;
    else if (FAILED_STATUSES.has(s)) failed += 1;
    else if (WORKING_STATUSES.has(s)) working += 1;
    else placed += 1;
  }

  // ── Models (opus-only leak check) ──
  const samplesWithModel = samples.filter((s) => (s.model ?? s.modelClass) != null);
  const nonOpus = samplesWithModel.filter((s) => !isOpusModel(s.model, s.modelClass)).length;
  const distinctModels = [...new Set(samplesWithModel.map((s) => (s.model ?? s.modelClass) as string))].sort();
  const models = {
    totalSamples: samplesWithModel.length,
    nonOpusSamples: samplesWithModel.length > 0 ? nonOpus : null,
    opusOnly: samplesWithModel.length > 0 ? nonOpus === 0 : null,
    distinctModels,
  };

  const spendUsd = samples.length > 0 ? samples.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null;
  const wallSec = startedAtMs != null ? Math.max(0, Math.round((nowMs - startedAtMs) / 1000)) : null;

  const taskProgress = {
    todo: taskCounts['todo'] ?? 0,
    in_progress: taskCounts['in_progress'] ?? 0,
    collected: taskCounts['collected'] ?? 0,
    graded: taskCounts['graded'] ?? 0,
    error: taskCounts['error'] ?? 0,
    total: Object.values(taskCounts).reduce((s, n) => s + n, 0),
  };

  const activeStatus = status === 'running' || status === 'grading' || status === 'pending';
  const isLive = potSlug != null && activeStatus && agents.length > 0;

  return { runId, status, potSlug, isLive, queen, bees: { total: beeRows.length, placed, working, done, evicted, failed, byStatus }, models, spendUsd, wallSec, taskProgress };
}

/** Fetch the live fleet state for a run (reads spawned_agents / agent_usage_samples
 *  scoped to its hive + bench_run_tasks). Returns null if the run is unknown. */
export async function getBenchRunLiveState(runId: string, opts: DbScope = {}): Promise<BenchRunLiveState | null> {
  const { sql, ws } = resolveDb(opts);
  const runRows = await sql<{ status: string; pot_slug: string | null; started_at: string | null }[]>`
    SELECT status, pot_slug, started_at FROM harness_shared.bench_runs
     WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const run = runRows[0];
  if (!run) return null;

  const taskRows = await sql<{ task_status: string; n: number }[]>`
    SELECT task_status, count(*)::int AS n FROM harness_shared.bench_run_tasks
     WHERE run_id = ${runId} AND workspace_id = ${ws} GROUP BY task_status
  `;
  const taskCounts: Record<string, number> = {};
  for (const r of taskRows) taskCounts[r.task_status] = Number(r.n);

  let agents: LiveSpawnRow[] = [];
  let samples: LiveSampleRow[] = [];
  if (run.pot_slug) {
    const agentRows = await sql<{ child_role: string; status: string; started_at: string | null; finished_at: string | null; restart_count: number | null }[]>`
      SELECT child_role, status, started_at, finished_at, restart_count
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${ws} AND harness_slug = ${run.pot_slug}
    `;
    agents = agentRows.map((a) => ({
      childRole: a.child_role,
      status: a.status,
      startedAtMs: a.started_at ? Date.parse(a.started_at) : null,
      finishedAtMs: a.finished_at ? Date.parse(a.finished_at) : null,
      restartCount: a.restart_count,
    }));
    const sampleRows = await sql<{ model: string | null; model_class: string | null; cost_usd: number | null }[]>`
      SELECT model, model_class, cost_usd FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${ws} AND harness_slug = ${run.pot_slug}
    `;
    samples = sampleRows.map((s) => ({ model: s.model, modelClass: s.model_class, costUsd: s.cost_usd == null ? null : Number(s.cost_usd) }));
  }

  return aggregateBenchRunLiveState({
    runId,
    status: run.status,
    potSlug: run.pot_slug,
    startedAtMs: run.started_at ? Date.parse(run.started_at) : null,
    nowMs: Date.now(),
    agents,
    samples,
    taskCounts,
  });
}
