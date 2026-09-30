/**
 * pb-backlog-driver.ts — PaperBench paper-replication fleet-arm backlog driver
 * (benchmark-suite-paperbench-2026-06-17 #18; the dual-arm unification — "run on BOTH the su-agent system
 * AND the hive via the SAME generic shared code").
 *
 * Wraps the SAME generic shell ({@link makePoolBacklogDriver}: bounded concurrency pool + live-occupancy
 * {@link ConcurrencyTimeline} + never-throw drain) the SWE-bench / METR HCAST / TheAgentCompany drivers use,
 * so PaperBench emits the canonical {@link HiveBacklogResult} and flows through the identical
 * {@link runHiveBacklog} dispatch + downstream fleet metrics. The ONLY suite-specific bit is the per-task
 * work: {@link drivePaperReplication} (drive the arm over ONE paper → produce a replication TREE in `outDir`),
 * with `req.arm` selecting the agent loop (su-independent solo vs the coordinating hive).
 *
 * EMPTY-START / TREE-OUTPUT (vs the SWE arm's clone-@-base → diff): the per-task input is the PAPER context +
 * an `outDir` the arm populates; the "submission" is the whole produced tree (Code-Dev: code + a root
 * `reproduce.sh`, NOT executed → no GPU). Grading is DECOUPLED + CONTINUOUS — the PaperBench judge scores the
 * tree against the paper's rubric (Replication Score) downstream; this driver is the GENERATION half and
 * carries the tree provenance (filesWritten / hasReproduceSh / submitted) on `attempt.armMeta`.
 *
 * GATING (D-003 build-now/host-later): the live arm drive ({@link realPaperReplicationOps} →
 * `paperbench-arm-binding.drivePaperViaArm`) currently throws {@link PaperBenchArmNotReadyError} until the
 * bench-harness-live DRIVE binding lands (#18 / su-1226c070). Because {@link drivePaperReplication} CATCHES
 * that, each task cleanly settles as a non-ok result (submitted=false, stopReason 'infra-failed',
 * generationError = the gate message) rather than throwing — so the dual-arm PATH is wired + exercised
 * today, and lights up unchanged the instant the live binding arrives.
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { HiveBacklogDriver, HiveBacklogResult, FleetTaskResult } from './hive-backlog';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import {
  drivePaperReplication,
  realPaperReplicationOps,
  type PaperReplicationOps,
  type PaperReplicationRequest,
  type PaperReplicationResult,
} from './_pb_hive_solve';
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationStopReason } from './types';

/** The PaperBench blueprint id stamped on the attempt row (the empty-start paper-replication suite). */
export const PAPERBENCH_BLUEPRINT_ID = 'paperbench';

/** The two PaperBench fleet-arm versions (reuse the SWE-bench/METR vocab → apples-to-apples cross-suite). */
export const PAPERBENCH_SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';
export const PAPERBENCH_HIVE_ARM: FleetArmId = 'hive-realqueen';

export interface PaperBenchBacklogOpts {
  now?: () => number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). */
  concurrencyCap: () => number | Promise<number>;
  /**
   * Build the full {@link PaperReplicationRequest} for one task+arm — the caller owns the empty-start
   * specifics (the per-paper `outDir`, the read paper context, `codeOnly`, `runId`, `workspaceId`), which
   * the generic shell can't know. The arm + budget are threaded from the fleet run request.
   */
  buildRequest: (input: { task: BenchTask; arm: FleetArmId; seed: string; budget: GenerationBudget }) => PaperReplicationRequest;
  /** The arm drive seam (default {@link realPaperReplicationOps} — gated until the live DRIVE binding lands). */
  ops?: PaperReplicationOps;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Fired the instant each paper settles → durability (a partial/killed run still banks its rows). */
  onTaskCollected?: (r: PaperReplicationResult) => void | Promise<void>;
}

/**
 * Map one settled {@link PaperReplicationResult} → the canonical {@link FleetTaskResult}. PaperBench has no
 * diff; the attempt carries the arm cost + the produced-tree provenance (filesWritten / hasReproduceSh /
 * submitted) on `armMeta`, so the PaperBench judge + the partial-credit rollup read it from the fleet output.
 * A non-ok result (empty tree / gated arm) → stopReason 'infra-failed' + generationError, excluded from grading.
 */
function toFleetTaskResult(
  r: PaperReplicationResult,
  arm: FleetArmId,
  seed: string,
  placedAtMs: number,
  startedAtMs: number,
  finishedAtMs: number,
): FleetTaskResult {
  const stopReason: GenerationStopReason = r.ok ? 'done' : 'infra-failed';
  const attempt: ArmAttempt = {
    arm: String(arm),
    blueprintId: PAPERBENCH_BLUEPRINT_ID,
    instanceId: r.paperId,
    seed,
    diff: '', // empty-start tree-output suite: there is no diff
    tokensIn: 0,
    tokensOut: 0,
    costUsd: r.costUsd,
    turns: 0,
    wallClockMs: Math.max(0, finishedAtMs - startedAtMs),
    trajectoryRef: r.agentId ?? '',
    stopReason,
    ...(r.error ? { generationError: r.error } : {}),
    armMeta: {
      suite: 'paperbench',
      submitted: r.ok,
      filesWritten: r.filesWritten,
      hasReproduceSh: r.hasReproduceSh,
    },
  };
  return {
    attempt,
    cupId: r.agentId ?? `pb-${r.paperId}-${seed}`,
    placedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/**
 * Build the PaperBench {@link HiveBacklogDriver} for ONE arm. The generic shell owns the sampler + pool +
 * canonical-output projection; PaperBench supplies ONLY its per-task work ({@link drivePaperReplication} over
 * one paper → tree → FleetTaskResult). Never throws — `drivePaperReplication` is itself never-throw (an empty
 * submission or a gated/erroring arm becomes a non-ok result, not an exception).
 */
export function paperBenchBacklogDriver(opts: PaperBenchBacklogOpts): HiveBacklogDriver {
  const now = opts.now ?? (() => Date.now());
  const ops = opts.ops ?? realPaperReplicationOps();
  return makePoolBacklogDriver({
    now,
    concurrencyCap: () => opts.concurrencyCap(),
    fleetTimeoutMs: opts.fleetTimeoutMs,
    sampleIntervalMs: opts.sampleIntervalMs,
    perTask: async ({ task, arm, seed, budget }): Promise<FleetTaskResult> => {
      const placedAtMs = now();
      const startedAt = now();
      const req = opts.buildRequest({ task, arm, seed, budget });
      const r = await drivePaperReplication(req, ops); // never-throws (gated arm → non-ok result)
      const finishedAt = now();
      await Promise.resolve(opts.onTaskCollected?.(r)).catch(() => {});
      return toFleetTaskResult(r, arm, seed, placedAtMs, startedAt, finishedAt);
    },
  });
}

/** One arm's outcome from {@link runPaperBenchSuiteViaFleet}: the canonical fleet record for that arm. */
export interface PaperBenchFleetArmResult {
  fleetArm: FleetArmId;
  result: HiveBacklogResult;
}

/** The full two-arm PaperBench run THROUGH the shared fleet contract — one canonical record per arm. */
export interface PaperBenchFleetRunResult {
  fleet: PaperBenchFleetArmResult[];
}

/**
 * Run the two-arm PaperBench suite THROUGH the canonical {@link HiveBacklogDriver} fleet contract — each
 * fleet arm ('su-independent' / 'hive-realqueen') runs its own {@link paperBenchBacklogDriver} over the SAME
 * paper backlog. Returns the canonical {@link HiveBacklogResult} per arm (the generation traces + produced
 * trees). Grading is DECOUPLED: the PaperBench judge scores each produced tree against the paper rubric
 * (continuous Replication Score) downstream, then `toFleetRunSummary` projects the metrics.
 */
export async function runPaperBenchSuiteViaFleet(input: {
  tasks: BenchTask[];
  /** Fleet arms to run (default both: su-independent + hive-realqueen). */
  arms?: FleetArmId[];
  now?: () => number;
  concurrencyCap: () => number | Promise<number>;
  buildRequest: (input: { task: BenchTask; arm: FleetArmId; seed: string; budget: GenerationBudget }) => PaperReplicationRequest;
  /** Per-arm drive seam (default {@link realPaperReplicationOps} for every arm). */
  opsFor?: (arm: FleetArmId) => PaperReplicationOps;
  runId?: string;
  seed?: number;
  budget?: GenerationBudget;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (fleetArm: FleetArmId, r: PaperReplicationResult) => void | Promise<void>;
  onArmDone?: (arm: PaperBenchFleetArmResult) => void | Promise<void>;
}): Promise<PaperBenchFleetRunResult> {
  const arms = input.arms ?? [PAPERBENCH_SU_INDEPENDENT_ARM, PAPERBENCH_HIVE_ARM];
  const runId = input.runId ?? 'paperbench-fleet';
  const seed = input.seed ?? 0;
  const budget = input.budget ?? {};

  const fleet: PaperBenchFleetArmResult[] = [];
  for (const arm of arms) {
    const driver = paperBenchBacklogDriver({
      now: input.now,
      concurrencyCap: input.concurrencyCap,
      buildRequest: input.buildRequest,
      ops: input.opsFor?.(arm),
      fleetTimeoutMs: input.fleetTimeoutMs,
      sampleIntervalMs: input.sampleIntervalMs,
      onTaskCollected: (r) => input.onTaskCollected?.(arm, r),
    });
    const result = await driver.run({ arm, suite: 'paperbench', runId, seed, backlog: input.tasks, budget });
    const armResult: PaperBenchFleetArmResult = { fleetArm: arm, result };
    fleet.push(armResult);
    await Promise.resolve(input.onArmDone?.(armResult)).catch(() => {});
  }
  return { fleet };
}
