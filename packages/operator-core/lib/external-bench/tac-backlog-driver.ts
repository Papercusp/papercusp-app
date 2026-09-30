/**
 * tac-backlog-driver.ts — TheAgentCompany fleet-arm backlog driver
 * (benchmark-suite-theagentcompany-2026-06-17; the dual-arm unification — the owner's
 * "run the suites on BOTH the su-agent system AND the hive via the SAME generic shared code").
 *
 * The M2 (in-container, live-workspace) counterpart of the SWE-bench-Pro M1 drivers
 * ({@link ./su-independent-backlog.ts} + {@link ./hive-backlog-realqueen.ts}) and a sibling of the METR
 * HCAST driver ({@link ./metr-hcast-backlog.ts}). It wraps the SAME generic shell
 * ({@link makePoolBacklogDriver}: bounded concurrency pool + live-occupancy {@link ConcurrencyTimeline} +
 * the never-throw drain) so TheAgentCompany flows through the identical {@link runHiveBacklog} dispatch +
 * downstream fleet metrics (`toFleetRunSummary` → `@papercusp/bench-metrics buildHiveReport`) as every other
 * suite. The ONLY suite-specific bit is the per-task work — {@link runOneTacTask} (pull image → init.sh →
 * driveArm against the live RocketChat/GitLab/Plane/ownCloud workspace → leave the env mutated for eval.py).
 *
 * THE TWO VERSIONS (the owner's "both versions"), reusing the locked SWE-bench/METR arm vocab so the
 * cross-suite comparison stays apples-to-apples:
 *   - 'su-independent'  → a pool of INDEPENDENT in-container agents (one task each).
 *   - 'hive-realqueen'  → the coordinating in-container agent (lead + delegate sub-agents).
 * Both run through THIS one driver + the shared pool; only the injected `driveArm` differs (D-002 causal
 * isolation — identical container/services/budget, only the orchestration changes). `req.arm` is threaded to
 * `runOneTacTask`'s `arm` so the live ops' `driveArm` selects the agent loop (host-gated; D-003 build-now/
 * host-later — the binding lands with the service stack, P-017).
 *
 * GRADING IS DECOUPLED (like the SWE-bench diff arms, unlike METR HCAST's in-process score): this driver is
 * the GENERATION half. It carries the in-container provenance (image + the submission's `envRef` + whether a
 * gradable submission was produced) on `attempt.armMeta`, so the official grader (eval.py against `envRef`)
 * fills the CONTINUOUS partial-credit `score`/`resolved` downstream off the canonical fleet output.
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { HiveBacklogDriver, HiveBacklogResult, FleetTaskResult } from './hive-backlog';
import { runOneTacTask, type TacRunnerOps, type TacRunResult } from './the-agent-company-runner';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import type { BenchTask, GenerationBudget } from './types';

/** The two TheAgentCompany fleet-arm versions (reuse the SWE-bench/METR vocab → apples-to-apples cross-suite). */
export const TAC_SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';
export const TAC_HIVE_ARM: FleetArmId = 'hive-realqueen';

export interface TacBacklogOpts {
  workspaceId?: string;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Fired the instant each task settles → durability (a partial/killed run still banks its rows). */
  onTaskCollected?: (r: TacRunResult) => void | Promise<void>;
}

/**
 * Map one settled {@link TacRunResult} → the canonical {@link FleetTaskResult}. The runner already stamps the
 * in-container provenance (`inContainer`/`image`/`envRef`) onto `attempt.armMeta`; we add `suite` + the
 * `submitted` flag (was a gradable env produced — a non-scored/infra terminal yields no submission) so the
 * eval.py grader + the partial-credit rollup read everything from the canonical fleet output.
 */
function toFleetTaskResult(r: TacRunResult, placedAtMs: number, startedAtMs: number, finishedAtMs: number): FleetTaskResult {
  return {
    attempt: {
      ...r.attempt,
      armMeta: {
        ...(r.attempt.armMeta ?? {}),
        suite: 'the-agent-company',
        submitted: r.submission !== null,
        // The TAC submission is always the M2 in-container shape; narrow before reading envRef.
        ...(r.submission?.modality === 'in-container' ? { envRef: r.submission.envRef } : {}),
      },
    },
    cupId: r.attempt.trajectoryRef || `tac-${r.attempt.instanceId}-${r.attempt.seed}`,
    placedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/**
 * Build the TheAgentCompany {@link HiveBacklogDriver} for ONE arm's ops. The generic shell
 * ({@link makePoolBacklogDriver}) owns the sampler + pool + canonical-output projection; TheAgentCompany
 * supplies ONLY its per-task work (prepare container → driveArm → eval-able submission → FleetTaskResult).
 * Never throws (the generation-failure contract — {@link runOneTacTask} returns an error attempt with no
 * submission, which the grader excludes, rather than throwing).
 */
export function theAgentCompanyBacklogDriver(ops: TacRunnerOps, opts: TacBacklogOpts = {}): HiveBacklogDriver {
  const ws = opts.workspaceId ?? 'the-agent-company';
  return makePoolBacklogDriver({
    now: ops.now,
    concurrencyCap: () => ops.concurrencyCap(),
    fleetTimeoutMs: opts.fleetTimeoutMs,
    sampleIntervalMs: opts.sampleIntervalMs,
    perTask: async ({ task, arm, seed, budget }): Promise<FleetTaskResult> => {
      const placedAtMs = ops.now();
      const startedAt = ops.now();
      // runOneTacTask is itself never-throw (prepare/drive/teardown; infra → error attempt, no submission).
      const r = await runOneTacTask(ops, { task, arm: String(arm), budget, seed, workspaceId: ws });
      const finishedAt = ops.now();
      await Promise.resolve(opts.onTaskCollected?.(r)).catch(() => {});
      return toFleetTaskResult(r, placedAtMs, startedAt, finishedAt);
    },
  });
}

/** One arm's outcome from {@link runTheAgentCompanySuiteViaFleet}: the canonical fleet record for that arm. */
export interface TacFleetArmResult {
  fleetArm: FleetArmId;
  result: HiveBacklogResult;
}

/** The full two-arm TheAgentCompany run THROUGH the shared fleet contract — one canonical record per arm. */
export interface TacFleetRunResult {
  fleet: TacFleetArmResult[];
}

/**
 * Run the two-arm TheAgentCompany suite THROUGH the canonical {@link HiveBacklogDriver} fleet contract — each
 * fleet arm ('su-independent' / 'hive-realqueen') runs its own {@link theAgentCompanyBacklogDriver} over the
 * SAME backlog; `opsFor(arm)` binds that arm's in-container agent loop. Returns the canonical
 * {@link HiveBacklogResult} per arm (the generation traces + submissions). Grading is DECOUPLED: the official
 * grader runs eval.py against each result's submissions to fill the partial-credit score/resolved, then
 * `toFleetRunSummary` projects the metrics — exactly the staged pipeline the SWE-bench diff arms use.
 */
export async function runTheAgentCompanySuiteViaFleet(input: {
  tasks: BenchTask[];
  /** Fleet arms to run (default both: su-independent + hive-realqueen). */
  arms?: FleetArmId[];
  /** Build the runner ops for one fleet arm (binds its in-container agent loop). */
  opsFor: (arm: FleetArmId) => TacRunnerOps;
  runId?: string;
  seed?: number;
  budget?: GenerationBudget;
  workspaceId?: string;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (fleetArm: FleetArmId, r: TacRunResult) => void | Promise<void>;
  onArmDone?: (arm: TacFleetArmResult) => void | Promise<void>;
}): Promise<TacFleetRunResult> {
  const arms = input.arms ?? [TAC_SU_INDEPENDENT_ARM, TAC_HIVE_ARM];
  const runId = input.runId ?? 'the-agent-company-fleet';
  const seed = input.seed ?? 0;
  const budget = input.budget ?? {};

  const fleet: TacFleetArmResult[] = [];
  for (const arm of arms) {
    const driver = theAgentCompanyBacklogDriver(input.opsFor(arm), {
      workspaceId: input.workspaceId,
      fleetTimeoutMs: input.fleetTimeoutMs,
      sampleIntervalMs: input.sampleIntervalMs,
      onTaskCollected: (r) => input.onTaskCollected?.(arm, r),
    });
    const result = await driver.run({ arm, suite: 'the-agent-company', runId, seed, backlog: input.tasks, budget });
    const armResult: TacFleetArmResult = { fleetArm: arm, result };
    fleet.push(armResult);
    await Promise.resolve(input.onArmDone?.(armResult)).catch(() => {});
  }
  return { fleet };
}
