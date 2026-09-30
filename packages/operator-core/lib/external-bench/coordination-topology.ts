/**
 * coordination-topology — the SHARED contract for the coordination-TOPOLOGY benchmark study
 * (benchmark-coordination-topologies). Every topology is a BLUEPRINT (schema: spine.claimModel +
 * coordination section); this module is the runtime bridge + the two pluggable seams that make the
 * topologies REUSABLE across benchmarks:
 *
 *   - {@link CloneGradeSeam} — pluggable per-BENCHMARK clone/grade (fairness C5: identical across arms,
 *     differs across benchmarks). SWE-bench-Pro = `diff` (clone worktree → git-diff → external eval);
 *     FrontierSWE / TheAgentCompany = `in-container` (docker build/run → the task's OWN scorer → a
 *     continuous score∈[0,1]). A benchmark supplies ONE seam; every topology arm uses it identically.
 *   - {@link CoordinationSpec} — the topology's coordination config, RESOLVED from its blueprint
 *     (the declarative spine.claimModel + coordination layer). One spec per arm; the runtime honors it.
 *
 * Consumers (coordinated 2026-06-18): su-a2b66's capability-injection P-003 SWE-Pro arms and su-7e0d2's
 * FrontierSWE arms BOTH wire onto this — they supply a task-set + a CloneGradeSeam and get every
 * topology for free. Results are emitted as `@papercusp/bench-metrics` {@link TaskRunResult} rows (the
 * one contract every consumer imports) → buildCapabilityAttribution + buildFairnessAudit report them
 * identically under one fair denominator. No SWE-Pro-specifics live here.
 */
import type { TaskRunResult, GraderModality, GraderStatus } from '@papercusp/bench-metrics';
import type { BenchTask } from './types';

/**
 * The pluggable clone/grade seam — per-BENCHMARK, identical across topology arms (C5). `H` is the
 * opaque environment handle (a worktree dir for `diff`, a live container ref for `in-container`).
 */
export interface CloneGradeSeam<H = unknown> {
  /** Stamped onto every emitted TaskRunResult.modality. */
  readonly modality: GraderModality;
  /** Prepare the task's working environment. `diff`: clone repo → worktree. `in-container`: docker
   *  build/run the task image → a container handle (agent runs as an unprivileged user inside). */
  clone(task: BenchTask): Promise<H>;
  /** Grade the agent's END STATE — never gameable by the arm. `resolved` = headline pass/fail
   *  (null = ungraded/infra → bench-metrics reconciles to false in the C1 same-denominator headline,
   *  never silently dropped). `score` = continuous [0,1] for in-container/own-scorer + rubric suites
   *  (FrontierSWE), null for boolean suites. The benchmark's OWN scorer runs here — we author none. */
  grade(task: BenchTask, handle: H): Promise<{
    resolved: boolean | null;
    score?: number | null;
    /** MUST be a CANONICAL status — `passed`/`failed`/`error`/`timeout`. A genuine capability-fail (empty
     *  or wrong output) is `'failed'` + `resolved:false` (scored, counts in every denominator), NOT a
     *  bespoke string: a non-canonical status coerces to infra (`'error'`) and SILENTLY drops the row from
     *  the valid denominator — flattering the arm (the C1 denominator-shrink one layer down; D-023). Keep
     *  the nuance (e.g. "empty-diff") in `detail`, never in the status. */
    graderStatus: GraderStatus;
    detail?: unknown;
  }>;
  /** Tear down the handle (rm worktree | docker rm). ALWAYS called — success, capability-fail, AND
   *  infra-fail paths — so a run never leaks containers/worktrees (the never-throw teardown contract). */
  teardown(handle: H): Promise<void>;
}

/** The coordination CONFIG for one arm, resolved from its topology blueprint. The runtime honors it. */
export interface CoordinationSpec {
  /** Topology id (= blueprint id) → the ArmId on every TaskRunResult row. */
  arm: string;
  /** How agents acquire work: central decider-dispatch vs flat self-claim (the distributed pole). */
  claimModel: 'decider-dispatch' | 'self-claim-fifo' | 'self-claim-priority';
  /** Peer findings-broadcast channel. */
  broadcast: 'none' | 'topic';
  /** Peer-review gate before a result is finalized. */
  review: 'none' | 'peer';
  /** Coordination medium (blackboard = stigmergic, no direct messaging). */
  sharedState: 'messages' | 'blackboard' | 'both';
  /** Coordination grouping granularity (huddle / pair / ensemble). */
  team: 'per-backlog' | 'per-repo' | 'per-task';
  /** Post-hoc aggregation across a per-task team's INDEPENDENT attempts. 'judge-best' = ensemble
   *  (N agents solve a task with no coordination during → a judge role picks/merges the best). Only
   *  meaningful with team:'per-task'; 'none' = no after-the-fact aggregation (pair, all distributed
   *  arms). The runtime fans N solvers + runs the judge when this is 'judge-best'. */
  aggregate: 'none' | 'judge-best';
  /** Intra-team coordinator (hierarchical pole). 'none' = flat (no lead); 'elected-lead' = a lead agent
   *  runs a coordination pass over the team backlog (charged to the iso-budget), then workers execute
   *  under it. A peer WITHIN the team, NOT the system Queen (`central`). */
  coordinator: 'none' | 'elected-lead';
  /** coord/* tools an agent in this topology may NOT use (e.g. ['coord:send'] enforces blackboard-only). */
  disciplineForbid: string[];
  /** Central orchestrator present (a `kind:'hive'` Queen blueprint) vs distributed/none. */
  central: boolean;
}

/** The structural slice of a resolved blueprint that {@link resolveCoordinationSpec} reads. (Typed
 *  structurally to avoid a cross-package orchestrator import; matches BlueprintSchema's fields.) */
export interface TopologyBlueprintView {
  id: string;
  kind?: 'pot' | 'hive' | 'harness';
  spine: { claimModel?: 'decider-dispatch' | 'self-claim-fifo' | 'self-claim-priority' };
  coordination?: {
    broadcast?: 'none' | 'topic';
    review?: 'none' | 'peer';
    sharedState?: 'messages' | 'blackboard' | 'both';
    team?: 'per-backlog' | 'per-repo' | 'per-task';
    aggregate?: 'none' | 'judge-best';
    coordinator?: 'none' | 'elected-lead';
    discipline?: { allow?: string[]; forbid?: string[] };
  };
}

/** PURE: resolve a topology blueprint → its {@link CoordinationSpec}. The declarative→runtime bridge.
 *  Defaults mirror the schema (decider-dispatch + no coordination = today's central pipeline). */
export function resolveCoordinationSpec(bp: TopologyBlueprintView): CoordinationSpec {
  const c = bp.coordination;
  return {
    arm: bp.id,
    claimModel: bp.spine.claimModel ?? 'decider-dispatch',
    broadcast: c?.broadcast ?? 'none',
    review: c?.review ?? 'none',
    sharedState: c?.sharedState ?? 'both',
    team: c?.team ?? 'per-backlog',
    aggregate: c?.aggregate ?? 'none',
    coordinator: c?.coordinator ?? 'none',
    disciplineForbid: c?.discipline?.forbid ?? [],
    central: bp.kind === 'hive' || bp.kind === 'pot',
  };
}

/** The iso-budget cap applied UNIFORMLY across every arm (fairness C3). All dimensions reported per
 *  arm on the TaskRunResult; `maxModelCalls` is the cleanest cross-topology unit, but a long-horizon
 *  benchmark (FrontierSWE: hours→tens-of-hours) MUST also bound `maxWallMs`. A cap-terminated run sets
 *  TaskRunResult.capped=true (a capped run ≠ a genuine fail). */
export interface IsoBudget {
  maxModelCalls?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  maxWallMs?: number;
}

/**
 * The runtime hooks a topology drives, keyed by its {@link CoordinationSpec}. The shared pool driver
 * calls these; each is a thin map from the spec to fleet/coord behavior (claim_next vs decider
 * dispatch; broadcast→topic vs write→blackboard; peer-review gate; team grouping). Implementations
 * land in the runtime phase; this interface is the contract consumers build against.
 */
export interface CoordinationStrategy {
  readonly spec: CoordinationSpec;
  /** Acquire the next task for an idle agent. self-claim-* pulls work_items:claim_next from the shared
   *  backlog (no decider); decider-dispatch is assigned centrally. null = backlog drained. */
  claimNext(ctx: CoordinationContext): Promise<BenchTask | null>;
  /** Publish a progress note/finding per `broadcast`/`sharedState` (topic broadcast | blackboard write
   *  | nothing). Respects `disciplineForbid` (a blackboard arm with coord:send forbidden writes state). */
  onProgress(ctx: CoordinationContext, note: string): Promise<void>;
  /** Peer-review gate per `review`: 'peer' nominates a peer to critique the result before finalize;
   *  'none' passes through. Returns whether to submit + optional revision guidance. */
  beforeSubmit(ctx: CoordinationContext, result: { taskId: string; output: unknown }): Promise<{
    approved: boolean;
    revision?: string;
  }>;
}

/** Per-agent runtime context the strategy hooks operate over (fleet/coord handles supplied by the
 *  driver). Kept opaque here; the runtime phase fills it. */
export interface CoordinationContext {
  arm: string;
  agentId: string;
  /** The slice of the backlog this agent's team owns (per-backlog = all; per-repo = its repo's tasks;
   *  per-task = the one task its team collaborates on). */
  teamBacklog: BenchTask[];
  workspaceId: string;
}

/** Re-export the row contract so consumers import the topology + the row shape from one module. */
export type { TaskRunResult };
