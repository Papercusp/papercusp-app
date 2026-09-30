/**
 * UI-triggered bench run launcher + spend-safety teardown
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005, D-002).
 *
 * Launches a REAL bench-engine run from inside the operator host (NOT a /tmp CLI
 * launcher): persist a bench_runs row (status=running) + return a run_id
 * immediately, drive runHiveBacklog as a DETACHED promise, stream per-task +
 * coordination rows into the operational store as bees collect, and finalize on
 * completion.
 *
 * SPEND-SAFETY (closes impartial-benchmark-suite D-022 — the orphan-respin gap):
 *   1. Every spawned hive's slug is persisted on the bench_runs row
 *      (setBenchRunHive) the instant it is minted.
 *   2. The detached run ALWAYS tears down in a finally — dissolveBenchHive (which
 *      stops the Queen wake, cancels every bee subtree, and DELETES the
 *      gym_autoloop_config + scout routine + learning-governor registrants via
 *      teardownHiveLearningLoop) — so a completed/errored/cancelled run leaves no
 *      armed learning loop to re-spin opus.
 *   3. A boot-time reaper (reapStaleBenchRuns, wired into host boot) finds any run
 *      left status=running/grading/pending by a CRASHED host (SIGKILL bypasses the
 *      finally), dissolves its hive, and freezes its status — so a :3170 restart
 *      can NEVER re-arm an orphan hive. This is the durable closure; the finally
 *      is the fast path.
 *
 * The in-process `activeRuns` map holds only EPHEMERAL runtime handles (the cancel
 * flag + the live hive slugs for a run executing in THIS process). The durable
 * truth is bench_runs.status in PG — the reaper rebuilds safety from it on boot.
 * (Not a "module-scoped state Map" in the storage-policy sense: a live promise +
 * cancel flag cannot be serialized; PG is the source of truth.)
 */
import type { BenchTask } from './types';
import type { FleetTaskResult, HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import { runHiveBacklog } from './hive-backlog';
import { bindRealQueenBacklogDriver, dissolveBenchHive } from './hive-backlog-realqueen';
import { bindSuIndependentBacklogDriver, SU_INDEPENDENT_ARM } from './su-independent-backlog';
import { assertExternalBenchEnabled } from './gate';
import { resolveDb, type DbScope } from './reproducibility/db';
import {
  upsertBenchRun,
  setBenchRunHive,
  upsertBenchRunTask,
  taskRowFromFleetResult,
  setBenchRunEvents,
  setBenchRunStatus,
  recordRunCompletion,
  type BenchRunStatus,
} from './run-store';
import { loadBenchTaskSet } from './task-sets';

/** A run actively executing in THIS host process (ephemeral; PG is durable truth). */
interface ActiveRun {
  runId: string;
  workspaceId: string;
  arm: string;
  taskSetId: string;
  taskIds?: string[];
  startedAtMs: number;
  potSlugs: Set<string>;
  cancelled: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

export interface LaunchBenchRunInput {
  /** Single arm per run (a multi-arm compare launches one run per arm). */
  arm: string;
  /** '11-task-pilot' | 'swe-bench-pro-full' | 'custom'. */
  taskSetId: string;
  /** When taskSetId='custom', the explicit instance ids. */
  taskIds?: string[];
  suite?: string;
  /** opus — fail-closed (never silently downgraded). */
  model?: string;
  /** Fleet concurrency cap (maxSimultaneousAgents). */
  cap?: number;
  /** Per-task spend cap (USD). */
  maxUsdPerTask?: number;
  /** Per-task token cap. */
  maxTokensPerTask?: number;
  /** Per-run spend ceiling (USD) — advisory, recorded in config. */
  maxUsdPerRun?: number;
}

/**
 * The persister-hook surface BOTH backlog driver binds (real-Queen + su-independent) accept — the
 * normalized seam `launchBenchRun` wires its bench_runs persistence through. Each bind reads only the
 * common fields it needs; `onHiveCreated` is meaningful for the hive arms and a harmless no-op for the
 * hive-less su-independent arm (it never fires). The enrolled/task shapes are narrowed to the fields the
 * launcher reads (`enrolled.task.instanceId`, the FleetTaskResult), so both concrete binds — which take
 * their own richer enrolled type — are assignable here (callback param contravariance).
 */
export type BenchDriverBinder = (opts: {
  workspaceId: string;
  onHiveCreated?: (hiveHome: string) => void | Promise<void>;
  onEnrolled?: (enrolled: { task: BenchTask }) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
}) => void;

/** Test/host injection seam — defaults wire the real engine. */
export interface LaunchDeps {
  scope?: DbScope;
  /** Run the backlog (default runHiveBacklog). */
  run?: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>;
  /** Bind the backlog driver with the persister hooks (per-arm default: real-Queen / su-independent). */
  bindDriver?: BenchDriverBinder;
  /** Dissolve a spawned hive (default dissolveBenchHive). */
  dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
  /** Load the task set → BenchTask[] (default loadBenchTaskSet). */
  loadBacklog?: (taskSetId: string, taskIds?: string[]) => Promise<BenchTask[]>;
  /** Gate check (default assertExternalBenchEnabled). */
  assertEnabled?: () => Promise<void>;
  /** Deterministic run id (tests). Default embeds a timestamp. */
  runId?: string;
}

const ACTIVE_STATES: BenchRunStatus[] = ['pending', 'running', 'grading'];

/** Throw if a run is already in flight (single-active-run — the spend-safety + D-005 gate). */
export async function assertNoActiveRun(opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws} AND status = ANY(${ACTIVE_STATES as unknown as string[]})
     LIMIT 1
  `;
  if (rows.length > 0) {
    throw new Error(`conflicting_run_active: run ${rows[0].id} is still in flight — cancel it before launching another`);
  }
}

/**
 * Launch a bench run. Persists status=running, kicks the engine DETACHED, and
 * returns the run_id immediately. The caller (the launch route) does NOT await
 * the run — it streams live via @papercusp/sync.
 */
export async function launchBenchRun(
  input: LaunchBenchRunInput,
  deps: LaunchDeps = {},
): Promise<{ runId: string; done: Promise<void> }> {
  const assertEnabled = deps.assertEnabled ?? (() => assertExternalBenchEnabled('system'));
  await assertEnabled();

  const scope = deps.scope ?? {};
  const { ws } = resolveDb(scope);
  await assertNoActiveRun(scope);

  const model = input.model ?? 'opus';
  const suite = input.suite ?? 'swe-bench-pro';
  const runId = deps.runId ?? `ui-${input.arm}-${Date.now()}`;
  const loadBacklog = deps.loadBacklog ?? loadBenchTaskSet;
  const run = deps.run ?? runHiveBacklog;
  // Per-arm driver selection (same mechanism the engine already uses: ONE bound HiveBacklogDriver per
  // run, picked by arm). 'su-independent' → the independent-su-agents pool driver (NO queen/hive); every
  // other arm → the real-Queen driver, which itself branches on 'hive-realqueen' vs 'fifo-noqueen'. A
  // test/host may override with deps.bindDriver. Both binds share the {workspaceId, onEnrolled,
  // onTaskCollected} persister surface; onHiveCreated is a no-op for the hive-less su-independent arm.
  const bindDriver = deps.bindDriver ?? (input.arm === SU_INDEPENDENT_ARM ? bindSuIndependentBacklogDriver : bindRealQueenBacklogDriver);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const backlog = await loadBacklog(input.taskSetId, input.taskIds);

  await upsertBenchRun(
    {
      id: runId,
      arm: input.arm,
      taskSetId: input.taskSetId,
      suite,
      model,
      source: 'ui',
      status: 'running',
      taskCount: backlog.length,
      config: {
        arm: input.arm,
        taskSetId: input.taskSetId,
        taskIds: input.taskIds ?? null,
        model,
        cap: input.cap ?? null,
        maxUsdPerTask: input.maxUsdPerTask ?? null,
        maxTokensPerTask: input.maxTokensPerTask ?? null,
        maxUsdPerRun: input.maxUsdPerRun ?? null,
      },
    },
    scope,
  );

  // Seed per-task rows as todo so the live monitor shows the full task set up-front.
  for (const t of backlog) {
    await upsertBenchRunTask(runId, { instanceId: t.instanceId, taskStatus: 'todo' }, scope);
  }

  const active: ActiveRun = {
    runId,
    workspaceId: ws,
    arm: input.arm,
    taskSetId: input.taskSetId,
    taskIds: input.taskIds,
    startedAtMs: Date.now(),
    potSlugs: new Set(),
    cancelled: false,
  };
  activeRuns.set(runId, active);

  // Wire the persister durability hooks onto the real-Queen driver.
  bindDriver({
    workspaceId: ws,
    onHiveCreated: (hiveHome: string) => {
      active.potSlugs.add(hiveHome);
      void setBenchRunHive(runId, hiveHome, scope).catch(() => {});
    },
    onEnrolled: (e) => {
      void upsertBenchRunTask(runId, { instanceId: e.task.instanceId, taskStatus: 'in_progress' }, scope).catch(() => {});
    },
    onTaskCollected: (tr) => {
      void upsertBenchRunTask(runId, taskRowFromFleetResult(tr), scope).catch(() => {});
    },
  });

  const req: HiveBacklogRunRequest = {
    arm: input.arm as HiveBacklogRunRequest['arm'],
    suite: suite as HiveBacklogRunRequest['suite'],
    runId,
    seed: 1,
    backlog,
    budget: { maxUsd: input.maxUsdPerTask ?? 10, maxTokens: input.maxTokensPerTask ?? 4_000_000 },
  };

  // DETACHED — the route does NOT await `done`. Always tears down in the finally
  // (the fast path; the boot reaper is the SIGKILL-resilient backstop). `done` is
  // returned so tests / advanced callers can await completion.
  const done = executeDetached(active, req, run, dissolve, scope);

  return { runId, done };
}

/** Heartbeat interval (ms) the live run bumps bench_runs.updated_at on, so the
 *  boot reaper can tell a crashed host (stale heartbeat) from a run legitimately
 *  in flight in ANOTHER live host (fresh heartbeat). */
const HEARTBEAT_MS = 60_000;

/** Bump a run's updated_at — the liveness heartbeat. */
async function touchBenchRun(runId: string, opts: DbScope): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`UPDATE harness_shared.bench_runs SET updated_at = now() WHERE id = ${runId} AND workspace_id = ${ws}`;
}

async function executeDetached(
  active: ActiveRun,
  req: HiveBacklogRunRequest,
  run: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>,
  dissolve: (potSlug: string, workspaceId: string) => Promise<void>,
  scope: DbScope,
): Promise<void> {
  const { runId } = active;
  // Liveness heartbeat — unref'd so it never keeps the process alive on its own.
  const heartbeat = setInterval(() => void touchBenchRun(runId, scope).catch(() => {}), HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try {
    const result = await run(req);
    if (active.cancelled) return; // cancelBenchRun already froze the status
    // Write the on-disk snapshot (PreservedArmRun + diffs + sample) so the run is
    // gradeable (P-010) + exportable (P-013), exactly like a CLI run. Best-effort.
    if (result.taskResults.length > 0) {
      try {
        const { writeRunSnapshot } = await import('./run-snapshot');
        writeRunSnapshot({
          runId,
          arm: active.arm,
          result,
          startedAtMs: active.startedAtMs,
          taskSetId: active.taskSetId,
          taskIds: active.taskIds,
        });
      } catch {
        /* snapshot is best-effort — the PG store already has the live truth */
      }
    }
    await setBenchRunEvents(runId, result.coordEvents ?? [], scope);
    await recordRunCompletion(
      runId,
      {
        peakConcurrentBees: result.peakConcurrentBees,
        wallMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
        runError: result.runError ?? null,
      },
      scope,
    );
  } catch (e) {
    if (!active.cancelled) {
      await setBenchRunStatus(runId, 'error', { runError: e instanceof Error ? e.message : String(e) }, scope).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    // ALWAYS dissolve every hive this run minted — no orphan learning loop survives.
    for (const slug of active.potSlugs) {
      await dissolve(slug, active.workspaceId).catch(() => {});
    }
    activeRuns.delete(runId);
  }
}

/** Cancel an in-flight run: freeze status, dissolve its hive (stops spend). */
export async function cancelBenchRun(
  runId: string,
  deps: { scope?: DbScope; dissolve?: (potSlug: string, workspaceId: string) => Promise<void> } = {},
): Promise<{ cancelled: boolean }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const rows = await sql<{ status: string; pot_slug: string | null }[]>`
    SELECT status, pot_slug FROM harness_shared.bench_runs
     WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { cancelled: false };

  const active = activeRuns.get(runId);
  if (active) active.cancelled = true;

  // Freeze status FIRST so the detached completion handler won't overwrite it.
  await setBenchRunStatus(runId, 'cancelled', { runError: 'cancelled by operator' }, scope);

  // Dissolve every known hive (the in-flight set + the persisted slug).
  const slugs = new Set<string>(active?.potSlugs ?? []);
  if (row.pot_slug) slugs.add(row.pot_slug);
  for (const slug of slugs) await dissolve(slug, ws).catch(() => {});

  return { cancelled: true };
}

/**
 * Boot-time reaper (P-005, the D-022 durable closure). Any run left in an active
 * state by a crashed host (the finally never ran) is orphaned — its hive may
 * still carry an armed learning loop that re-spins opus on restart. Dissolve each
 * orphan's hive (deactivating its learning loops) and freeze its status to a
 * terminal state.
 *
 * HEARTBEAT-GATED: only runs whose liveness heartbeat (updated_at) is older than
 * `staleAfterSec` are reaped — so a run legitimately in flight in ANOTHER live
 * host (fresh heartbeat) is NOT killed by this host's boot sweep. Pass
 * staleAfterSec=0 to reap every active run regardless (tests / a forced sweep).
 * Idempotent; call once at host boot. Returns the runs reaped.
 */
export async function reapStaleBenchRuns(
  deps: {
    scope?: DbScope;
    dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
    staleAfterSec?: number;
  } = {},
): Promise<{ reaped: string[] }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;
  const staleAfterSec = deps.staleAfterSec ?? 180;

  const rows = await sql<{ id: string; pot_slug: string | null }[]>`
    SELECT id, pot_slug FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws}
       AND status = ANY(${ACTIVE_STATES as unknown as string[]})
       AND updated_at < now() - make_interval(secs => ${staleAfterSec})
  `;
  const reaped: string[] = [];
  for (const r of rows) {
    if (r.pot_slug) {
      await dissolve(r.pot_slug, ws).catch(() => {});
    }
    await setBenchRunStatus(
      r.id,
      'error',
      { runError: 'reaped: operator restarted while this run was in flight (spend-safety teardown)' },
      scope,
    ).catch(() => {});
    reaped.push(r.id);
  }
  return { reaped };
}

/** Test-only — clear the in-process active-run registry between tests. */
export function _resetActiveRunsForTests(): void {
  activeRuns.clear();
}
