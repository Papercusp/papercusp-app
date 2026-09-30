/**
 * swe-pro-arm.ts — the thin arm-wiring that plugs SWE-bench-Pro into the steward's shared topology RUN
 * DRIVER (`runTopology`, run-topology.ts). This is the P-003 REFERENCE the other capability/topology
 * suites copy (mirrors su-7e0d2's frontier-swe-arm.ts). SWE-Pro supplies only: (1) its task-set
 * (`loadBenchTaskSet`), (2) its `CloneGradeSeam` (`makeSweProCloneGradeSeam`, modality `diff`), and
 * (3) the SWE-Pro-stamped row metadata. The driver owns the topology enactment (teams / directives /
 * iso-budget / TaskRunResult emission); we do NOT re-roll it (D-007).
 *
 * `runAgent` (the actual fleet-spawn agent drive on the prepared worktree) is INJECTED — live, the
 * `makeSweProRunAgent` + the owner-gated live spawn binding; a fake in tests — so this wiring is
 * unit-testable with NO fleet / NO docker / NO spend. The LIVE run stays owner/compute-gated: the steward
 * (su-37e53) drives it, awaiting the owner's fleet-cap raise + gateway-AIMD decision before launching the
 * clean su-vs-hive run.
 *
 * `resolveSweProFrameworkSpec` is the P-012 framework-arm = blueprint-selection mechanism for SWE-Pro: a
 * caller names the arm by the PLAN's vocabulary (`vanilla` / `su` / `hive`, {@link SWE_PRO_FRAMEWORK_ARMS}),
 * and we resolve BOTH its topology → a {@link CoordinationSpec} AND its per-task SOLVER blueprint
 * (`external-bench` su spine vs `coding-solo` floor, P-013) via an injected blueprint-view lookup (live:
 * reads `blueprint:catalog`; a static map in tests). So the framework axis threads through the SAME shared
 * dispatch the coordination study uses — no parallel selection path.
 */
import {
  resolveCoordinationSpec,
  type CoordinationSpec,
  type IsoBudget,
  type TopologyBlueprintView,
} from './coordination-topology';
import type { AgentRunOutput, RunAgentInput, TopologyRowMeta, TopologyRunResult } from './run-topology';
import { runTopology } from './run-topology';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import { makeSweProCloneGradeSeam, SWE_PRO_FRAMEWORK_ARMS, type SweProFrameworkArm, type SweProGradeDiff } from './swe-pro-seam';
import { loadBenchTaskSet } from './task-sets';
import type { CloneTaskRepo, ExtractDiff, TaskCheckout } from './types';

const GRADER_FAMILY = 'swe-bench-pro';
const SUITE = 'swe-bench-pro';

/** The SWE-Pro-specific run-level row metadata (the rest comes from the caller for pre-registration). */
export interface SweProRowMetaInput {
  /** Grader version pin (the official Pro grader commit / image-set tag). */
  version: string;
  modelId: string;
  harnessVersion: string;
  preregHash: string;
  rolloutId: string;
  priceTableVersion?: string;
}

export function sweProRowMeta(m: SweProRowMetaInput): TopologyRowMeta {
  return {
    suite: SUITE,
    modelId: m.modelId,
    harnessVersion: m.harnessVersion,
    preregHash: m.preregHash,
    rolloutId: m.rolloutId,
    graderFamily: GRADER_FAMILY,
    graderVersion: m.version,
    priceTableVersion: m.priceTableVersion ?? 'price-table-v1',
  };
}

export interface SweProArmDeps {
  /** The topology arm's coordination spec (resolve it from a blueprint via {@link resolveSweProFrameworkSpec}
   *  or the steward's `resolveCoordinationSpec` directly). */
  spec: CoordinationSpec;
  /** The actual agent invocation — INJECTED. Live: a fleet-spawn-backed drive of an agent on the prepared
   *  worktree (via `makeSweProRunAgent` + the live spawn binding); a fake in tests. */
  runAgent: (input: RunAgentInput<TaskCheckout>) => Promise<AgentRunOutput>;
  /** The official Pro grader (docker-gated; injected — the seam runs it to decide `resolved`). */
  gradeDiff: SweProGradeDiff;
  /** The iso-budget cap applied UNIFORMLY across every arm (C3). */
  budget: IsoBudget;
  seed: number;
  runId: string;
  rowMeta: SweProRowMetaInput;
  /** Task-set id (default '11-task-pilot' — the on-disk Pro pilot; 'swe-bench-pro-full' is owner-gated). */
  taskSetId?: string;
  taskIds?: string[];
  cap?: number;
  ensembleSize?: number;
  now?: () => number;
  onResult?: (r: TaskRunResult) => void | Promise<void>;
  /** Scratch root the worktrees clone under. */
  workRoot?: string;
  /** Inject fake clone/extract seams in tests; live defaults to the real git-backed binding. */
  cloneTaskRepo?: CloneTaskRepo;
  extractDiff?: ExtractDiff;
}

/**
 * Run ONE SWE-bench-Pro topology arm × one seed over a task-set. Thin: loads the task-set, builds the
 * SWE-Pro {@link CloneGradeSeam} + rowMeta, calls {@link runTopology}. The driver enacts the topology
 * (the `spec`'s teams / directives / iso-budget) and emits one {@link TaskRunResult} per task.
 */
export async function runSweProArm(deps: SweProArmDeps): Promise<TopologyRunResult> {
  const backlog = await loadBenchTaskSet(deps.taskSetId ?? '11-task-pilot', deps.taskIds);
  const seam = makeSweProCloneGradeSeam({
    gradeDiff: deps.gradeDiff,
    cloneTaskRepo: deps.cloneTaskRepo,
    extractDiff: deps.extractDiff,
    workRoot: deps.workRoot,
  });
  return runTopology<TaskCheckout>({
    spec: deps.spec,
    backlog,
    seam,
    budget: deps.budget,
    rowMeta: sweProRowMeta(deps.rowMeta),
    runId: deps.runId,
    seed: deps.seed,
    now: deps.now ?? (() => Date.now()),
    runAgent: deps.runAgent,
    cap: deps.cap,
    ensembleSize: deps.ensembleSize,
    onResult: deps.onResult,
  });
}

/**
 * P-012 framework-arm = blueprint-selection mechanism (SWE-Pro), resolving BOTH axes of a framework arm
 * (`vanilla` / `su` / `hive`, {@link SWE_PRO_FRAMEWORK_ARMS}) per su-37e53's P-013 decision:
 *   - `spec` — the {@link CoordinationSpec} resolved from the arm's TOPOLOGY blueprint (via the injected
 *     `lookupBlueprint`: live `blueprint:catalog` → {@link TopologyBlueprintView}; a static map in tests).
 *   - `solverBlueprint` — the per-task SOLVER blueprint (`external-bench` su spine for the su system,
 *     `coding-solo` for the vanilla floor) the runAgent's spawn drives.
 *
 * Two axes, one selection path: holding `solverBlueprint` constant isolates coordination (su-vs-hive);
 * holding the topology constant isolates the su spine (vanilla-vs-su). Threads through the steward's shared
 * coordination dispatch — no parallel mechanism.
 */
export function resolveSweProFrameworkSpec(
  frameworkArm: SweProFrameworkArm,
  lookupBlueprint: (blueprintId: string) => TopologyBlueprintView,
): { spec: CoordinationSpec; solverBlueprint: string } {
  const { topology, solver } = SWE_PRO_FRAMEWORK_ARMS[frameworkArm];
  return { spec: resolveCoordinationSpec(lookupBlueprint(topology)), solverBlueprint: solver };
}
