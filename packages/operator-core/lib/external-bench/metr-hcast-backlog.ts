/**
 * metr-hcast-backlog.ts — the METR HCAST fleet-arm backlog driver (benchmark-suite-metr-hcast-2026-06-17,
 * owner-directed extraction: "run the tests on BOTH versions — su-agents and hive — via generic shared code").
 *
 * This is the M2 (in-container) counterpart of the SWE-bench-Pro M1 drivers ({@link ./su-independent-backlog.ts}
 * + {@link ./hive-backlog-realqueen.ts}). It implements the SAME canonical {@link HiveBacklogDriver} contract
 * and emits the SAME {@link HiveBacklogResult} (FleetTaskResult[] + ConcurrencyTimeline + CoordEvent[]) — so
 * METR HCAST flows through the identical `runHiveBacklog()` dispatch + downstream fleet metrics
 * (`toFleetRunSummary` → `@papercusp/bench-metrics buildHiveReport`) as the SWE-bench arms, AND the
 * METR-specific horizon report (a small analysis on top — see {@link metrHcastTaskResultsFromFleet}).
 *
 * WORK-SURFACE DIFFERENCE (M1 vs M2): the SWE-bench drivers clone a host worktree → spawn a spine bee via
 * :3170 → extract a `git diff`. METR HCAST has no worktree/diff: each task is its OWN Docker container; the
 * agent runs INSIDE it; scoring is the task's own `score()` via taskhelper. So the per-task WORK is the
 * injected {@link MetrHcastRunnerOps} (prepare container → driveArm → score → teardown), and the ARM selects
 * the in-container agent loop ({@link makeMetrHcastLiveOps}: single-opus solo vs the lead+delegate hive). The
 * ORCHESTRATION (the bounded concurrency pool + the live-occupancy {@link ConcurrencyTimeline}) is the SHARED
 * {@link runConcurrencyPool} + {@link makeConcurrencySampler} that the su-independent driver also uses.
 *
 * THE TWO VERSIONS (the owner's "both versions"):
 *   - 'su-independent'  → a pool of INDEPENDENT in-container agents (one task each), arm `baseline-a-ablation`.
 *   - 'hive-realqueen'  → the coordinating in-container agent (lead + delegate sub-agents), arm `papercusp`.
 * Both run through THIS one driver + the shared pool; only the injected `driveArm` differs (D-002 causal
 * isolation — identical container/scoring/budget, only the orchestration changes). NB the real Queen-over-
 * backlog placement (worktree members) is NOT reachable for container tasks without a spine work-surface
 * change; this driver's 'hive' version is the in-container coordination arm, labelled as such.
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { HiveBacklogDriver, HiveBacklogResult, FleetTaskResult } from './hive-backlog';
import { toFleetRunSummary } from './hive-backlog';
import { runOneMetrHcastTask, type MetrHcastRunnerOps, type MetrHcastTaskResult } from './metr-hcast-runner';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import { buildMetrHcastReport, type MetrHcastReport, type MetrHcastReportOpts } from './metr-hcast-report';
import type { BenchTask, GenerationBudget } from './types';
import type { FleetRunSummary } from '@papercusp/bench-metrics';

/** The two METR HCAST fleet-arm versions (reuse the SWE-bench vocab so cross-suite comparison is apples-to-apples). */
export const METR_HCAST_SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';
export const METR_HCAST_HIVE_ARM: FleetArmId = 'hive-realqueen';

/** Map a fleet-arm id → the metr-hcast ArmId the runner/ops use (which selects the in-container agent loop). */
export function metrHcastArmIdForFleetArm(arm: FleetArmId): 'baseline-a-ablation' | 'papercusp' {
  return arm === METR_HCAST_HIVE_ARM || arm === 'hive' || arm === 'papercusp' ? 'papercusp' : 'baseline-a-ablation';
}

export interface MetrHcastBacklogOpts {
  workspaceId?: string;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Fired the instant each task settles → durability (a partial/killed run still banks its rows). */
  onTaskCollected?: (r: MetrHcastTaskResult) => void | Promise<void>;
}

/** Map one settled {@link MetrHcastTaskResult} → the canonical {@link FleetTaskResult}, carrying the M2
 *  score/resolved/humanMinutes in `attempt.armMeta` so BOTH the fleet metrics and the horizon fit can read it. */
function toFleetTaskResult(r: MetrHcastTaskResult, placedAtMs: number, startedAtMs: number, finishedAtMs: number): FleetTaskResult {
  return {
    attempt: {
      ...r.attempt,
      armMeta: {
        ...(r.attempt.armMeta ?? {}),
        suite: 'metr-hcast',
        score: r.grade.score,
        resolved: r.grade.resolved,
        humanMinutes: r.humanMinutes,
        graderError: r.grade.graderError ?? null,
      },
    },
    cupId: r.attempt.trajectoryRef || `metr-${r.attempt.instanceId}-${r.attempt.seed}`,
    placedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/**
 * Build the METR HCAST {@link HiveBacklogDriver} for ONE arm's ops. The same pool orchestration the
 * su-independent driver uses; the per-task work is the injected metr-hcast ops (prepare/drive/score/teardown),
 * and `req.arm` is stamped onto the canonical {@link HiveBacklogResult}. Never throws (the generation-failure
 * contract — a failed task lands a resolved=null row, surfaced not scored).
 */
export function metrHcastBacklogDriver(ops: MetrHcastRunnerOps, opts: MetrHcastBacklogOpts = {}): HiveBacklogDriver {
  const ws = opts.workspaceId ?? 'metr-hcast';
  // The generic shell ({@link makePoolBacklogDriver}) owns the sampler + pool + canonical-output projection;
  // metr-hcast supplies ONLY its per-task work (prepare container → driveArm → score → FleetTaskResult).
  return makePoolBacklogDriver({
    now: ops.now,
    concurrencyCap: () => ops.concurrencyCap(),
    fleetTimeoutMs: opts.fleetTimeoutMs,
    sampleIntervalMs: opts.sampleIntervalMs,
    perTask: async ({ task, arm, seed, budget }): Promise<FleetTaskResult> => {
      const placedAtMs = ops.now();
      const startedAt = ops.now();
      // runOneMetrHcastTask is itself never-throw (prepare/drive/score/teardown, infra → resolved=null).
      const r = await runOneMetrHcastTask(ops, { task, arm: metrHcastArmIdForFleetArm(arm), budget, seed, workspaceId: ws });
      const finishedAt = ops.now();
      await Promise.resolve(opts.onTaskCollected?.(r)).catch(() => {});
      return toFleetTaskResult(r, placedAtMs, startedAt, finishedAt);
    },
  });
}

/** One arm's outcome from {@link runMetrHcastSuiteViaFleet}: the canonical fleet record + its fleet summary. */
export interface MetrHcastFleetArmResult {
  fleetArm: FleetArmId;
  result: HiveBacklogResult;
  /** The standard fleet rollup (tasks / resolved / cost / tokens / wall-clock / peak concurrency). */
  summary: FleetRunSummary;
}

/** The full two-arm METR HCAST run THROUGH the shared fleet contract — both metric families from one run. */
export interface MetrHcastFleetRunResult {
  /** Per fleet-arm: the canonical HiveBacklogResult + fleet summary (the unified output every suite emits). */
  fleet: MetrHcastFleetArmResult[];
  /** Per-arm MetrHcastTaskResult[] reconstructed from the fleet output (for the horizon fit). */
  resultsByArm: Record<string, MetrHcastTaskResult[]>;
  /** The METR-specific horizon report (per-arm horizon + the hive-vs-single-opus lift + caveats). */
  report: MetrHcastReport;
}

/**
 * Run the two-arm METR HCAST suite THROUGH the canonical {@link HiveBacklogDriver} fleet contract (the shared
 * code), so ONE run yields BOTH the standard fleet metrics ({@link toFleetRunSummary}) AND the METR horizon
 * report. Each fleet arm ('su-independent' / 'hive-realqueen') runs its own {@link metrHcastBacklogDriver}
 * over the same backlog; `opsFor(arm)` binds the arm's in-container agent loop. This is the live unification:
 * metr-hcast now flows through the identical orchestration the SWE-bench arms use.
 */
export async function runMetrHcastSuiteViaFleet(input: {
  tasks: BenchTask[];
  /** Fleet arms to run (default both: su-independent + hive-realqueen). */
  arms?: FleetArmId[];
  /** Build the runner ops for one fleet arm (binds its in-container agent loop). */
  opsFor: (arm: FleetArmId) => MetrHcastRunnerOps;
  runId?: string;
  seed?: number;
  budget?: GenerationBudget;
  report?: MetrHcastReportOpts;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (fleetArm: FleetArmId, r: MetrHcastTaskResult) => void | Promise<void>;
  onArmDone?: (arm: MetrHcastFleetArmResult) => void | Promise<void>;
}): Promise<MetrHcastFleetRunResult> {
  const arms = input.arms ?? [METR_HCAST_SU_INDEPENDENT_ARM, METR_HCAST_HIVE_ARM];
  const runId = input.runId ?? 'metr-hcast-fleet';
  const seed = input.seed ?? 0;
  const budget = input.budget ?? {};

  const fleet: MetrHcastFleetArmResult[] = [];
  const resultsByArm: Record<string, MetrHcastTaskResult[]> = {};
  for (const arm of arms) {
    const driver = metrHcastBacklogDriver(input.opsFor(arm), {
      fleetTimeoutMs: input.fleetTimeoutMs,
      sampleIntervalMs: input.sampleIntervalMs,
      onTaskCollected: (r) => input.onTaskCollected?.(arm, r),
    });
    const result = await driver.run({ arm, suite: 'metr-hcast', runId, seed, backlog: input.tasks, budget });
    const taskResults = metrHcastTaskResultsFromFleet(result);
    resultsByArm[metrHcastArmIdForFleetArm(arm)] = taskResults;
    const resolvedCount = taskResults.filter((t) => t.grade.resolved === true).length;
    const armResult: MetrHcastFleetArmResult = { fleetArm: arm, result, summary: toFleetRunSummary(result, resolvedCount) };
    fleet.push(armResult);
    await Promise.resolve(input.onArmDone?.(armResult)).catch(() => {});
  }

  const report = buildMetrHcastReport(resultsByArm, input.report);
  return { fleet, resultsByArm, report };
}

/**
 * Reconstruct {@link MetrHcastTaskResult}[] from a canonical {@link HiveBacklogResult} (the M2 score/resolved/
 * humanMinutes ride `attempt.armMeta`) so the horizon report (`buildMetrHcastReport`) can run off the same
 * fleet output the standard metrics consume — one run, both metric families.
 */
export function metrHcastTaskResultsFromFleet(result: HiveBacklogResult): MetrHcastTaskResult[] {
  return result.taskResults.map((t): MetrHcastTaskResult => {
    const meta = t.attempt.armMeta ?? {};
    const score = typeof meta['score'] === 'number' ? (meta['score'] as number) : null;
    const resolved = typeof meta['resolved'] === 'boolean' ? (meta['resolved'] as boolean) : null;
    const humanMinutes = typeof meta['humanMinutes'] === 'number' ? (meta['humanMinutes'] as number) : null;
    return {
      attempt: t.attempt,
      grade: {
        instanceId: t.attempt.instanceId,
        prefix: t.attempt.seed,
        resolved,
        score,
        graderFamily: 'metr-hcast',
        graderVersion: typeof meta['version'] === 'string' ? (meta['version'] as string) : 'task-standard',
        rawGraderOutput: null,
        ...(typeof meta['graderError'] === 'string' ? { graderError: meta['graderError'] as string } : {}),
      },
      humanMinutes,
    };
  });
}
