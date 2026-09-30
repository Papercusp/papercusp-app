/**
 * swarmbench-backlog.ts — the SwarmBench fleet-arm driver + report (plan benchmark-suite-swarmbench-2026-06-17
 * P-006). Like `metr-hcast-backlog.ts`, it rides the generic `makePoolBacklogDriver` shell: ONE scenario =
 * one `perTask` → the canonical `HiveBacklogResult`, with the deterministic sim score carried on
 * `attempt.armMeta`. The pool runs scenarios/seeds concurrently; the coordination happens INSIDE one scenario
 * (the swarm controller, selected by the arm/mode). So SwarmBench flows through the same `runHiveBacklog`
 * contract as every other suite, and `swarmbenchTaskResultsFromFleet` + `buildSwarmBenchReport` give the
 * suite headline: per-(task,arm) mean score ± SE + the decentralized-vs-centralized topology delta.
 *
 * SwarmBench scores are CONTINUOUS (Pursuit +1/round cornered, etc.), not boolean-resolved — so the headline
 * is the mean SCORE per (task,arm) and the arm delta, NOT a pass-rate. `resolved` is left null.
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import { meanStderr } from '@papercusp/bench-metrics';
import type { HiveBacklogDriver, FleetTaskResult } from './hive-backlog';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import type { BenchTask, GenerationStopReason } from './types';
import { scenarioId, type RunSwarmSim, type SwarmMode, type SwarmScenario } from './swarmbench-live';
import { resolveBenchWorkspace } from './bench-workspace';

/** The two SwarmBench fleet-arm versions (reuse the cross-suite vocab for apples-to-apples comparison). */
export const SWARMBENCH_SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';
export const SWARMBENCH_HIVE_ARM: FleetArmId = 'hive-realqueen';

/** Map a fleet arm → the swarm-control mode the python runner uses. */
export function swarmModeForFleetArm(arm: FleetArmId): SwarmMode {
  if (arm === SWARMBENCH_HIVE_ARM || arm === 'hive') return 'mug';
  if (arm === 'random') return 'random';
  return 'openai'; // su-independent (the native decentralized arm)
}

/** Pack a scenario into a BenchTask (the scenario config rides graderMeta — never arm-facing). */
export function swarmScenarioToBenchTask(s: SwarmScenario): BenchTask {
  return {
    benchmark: 'swarmbench',
    instanceId: scenarioId(s),
    problemStatement: `SwarmBench ${s.task} (${s.numAgents} agents, ${s.width}x${s.height}, view ${s.viewSize}, ${s.maxRound} rounds, seed ${s.seed})`,
    graderMeta: {
      task: s.task,
      numAgents: s.numAgents,
      width: s.width,
      height: s.height,
      seed: s.seed,
      viewSize: s.viewSize,
      maxRound: s.maxRound,
    },
  } satisfies BenchTask;
}

/** The five foundational SwarmBench MAS tasks (deterministic sim scores). */
export const SWARMBENCH_TASKS = ['Pursuit', 'Synchronization', 'Foraging', 'Flocking', 'Transport'] as const;

/** SwarmBench task-set ids. `swarmbench-pilot` is small/cheap; `swarmbench` is the EXPENSIVE full sweep (D-004). */
export const SWARMBENCH_TASK_SET_IDS = ['swarmbench-pilot', 'swarmbench', 'swarmbench-custom'] as const;

export function isSwarmBenchTaskSet(taskSetId: string): boolean {
  return (SWARMBENCH_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/**
 * Generate the programmatic scenarios for a task-set id (SwarmBench scenarios are NOT downloaded — they are
 * task × grid × num_agents × seed × view_size tuples). `swarmbench-pilot` = a small/cheap subset for the
 * topology A/B; `swarmbench` = the full 5-task sweep at the paper's defaults (10 agents × 100 rounds) — the
 * most expensive suite, gated behind this explicit id (D-004). Override seeds via PAPERCUSP_SWARMBENCH_SEEDS.
 */
export function swarmbenchScenarios(taskSetId: string): SwarmScenario[] {
  const seeds = (process.env.PAPERCUSP_SWARMBENCH_SEEDS ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (taskSetId === 'swarmbench-pilot') {
    const tasks = ['Pursuit', 'Synchronization'];
    const useSeeds = seeds.length ? seeds : [42, 7, 123];
    return tasks.flatMap((task) => useSeeds.map((seed) => ({ task, numAgents: 4, width: 8, height: 8, seed, viewSize: 5, maxRound: 15 })));
  }
  // 'swarmbench' (+ 'swarmbench-custom' falls through to full defaults) — EXPENSIVE: 5 tasks × 100 rounds × 10 agents.
  const useSeeds = seeds.length ? seeds : [27, 42, 123];
  return SWARMBENCH_TASKS.flatMap((task) => useSeeds.map((seed) => ({ task, numAgents: 10, width: 10, height: 10, seed, viewSize: 5, maxRound: 100 })));
}

/** Read a SwarmScenario back out of a BenchTask's graderMeta. */
export function scenarioFromBenchTask(task: BenchTask): SwarmScenario {
  const g = task.graderMeta ?? {};
  return {
    task: String(g['task'] ?? ''),
    numAgents: Number(g['numAgents'] ?? 0),
    width: Number(g['width'] ?? 0),
    height: Number(g['height'] ?? 0),
    seed: Number(g['seed'] ?? 0),
    viewSize: Number(g['viewSize'] ?? 0),
    maxRound: Number(g['maxRound'] ?? 0),
  };
}

export interface SwarmbenchBacklogOpts {
  workspaceId?: string;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (r: FleetTaskResult) => void | Promise<void>;
}

/**
 * Build the SwarmBench {@link HiveBacklogDriver} for ONE arm's `RunSwarmSim`. `perTask` runs one scenario
 * under the arm's swarm-control mode → a `FleetTaskResult` carrying the sim score on `armMeta`. Never throws
 * (a sim/infra failure → stopReason 'infra-failed', score null, excluded — the generation-failure contract).
 */
export function swarmbenchBacklogDriver(runSim: RunSwarmSim, opts: SwarmbenchBacklogOpts = {}): HiveBacklogDriver {
  // Isolated benchmark workspace — never production (guarded; the owner-flagged pollution fix,
  // plan benchmark-workspace-isolation-2026-06-18). 'swarmbench' is a per-suite sub-workspace.
  const ws = resolveBenchWorkspace(opts.workspaceId ?? 'swarmbench');
  return makePoolBacklogDriver({
    now: () => Date.now(),
    // SwarmBench scenarios are heavy (N agents × rounds); run a small pool. Override via opts if needed.
    concurrencyCap: () => 2,
    fleetTimeoutMs: opts.fleetTimeoutMs,
    sampleIntervalMs: opts.sampleIntervalMs,
    perTask: async ({ task, arm, seed }): Promise<FleetTaskResult> => {
      const scenario = scenarioFromBenchTask(task);
      const mode = swarmModeForFleetArm(arm);
      const startedAtMs = Date.now();
      const res = await runSim({ scenario, mode, workspaceId: ws });
      const finishedAtMs = Date.now();
      const infra = res.error !== undefined || res.score === null;
      const stopReason: GenerationStopReason = infra ? 'infra-failed' : 'done';
      return {
        attempt: {
          arm,
          blueprintId: 'swarmbench',
          instanceId: task.instanceId,
          seed,
          diff: '',
          tokensIn: 0,
          tokensOut: res.agentTokens, // LLM-call-count proxy (coordination overhead counted)
          costUsd: 0,
          turns: res.rounds,
          wallClockMs: finishedAtMs - startedAtMs,
          trajectoryRef: '',
          stopReason,
          ...(res.error ? { generationError: res.error } : {}),
          armMeta: {
            suite: 'swarmbench',
            task: scenario.task,
            score: res.score,
            rounds: res.rounds,
            agentTokens: res.agentTokens,
            numAgents: scenario.numAgents,
            viewSize: scenario.viewSize,
            mode,
            done: res.done,
            ...(res.error ? { error: res.error } : {}),
          },
        },
        cupId: `swarm-${task.instanceId}-${seed}`,
        placedAtMs: startedAtMs,
        startedAtMs,
        finishedAtMs,
        disposition: 'spawn',
      };
    },
  });
}

/* ----------------------------------- report ----------------------------------- */

/** One settled SwarmBench scenario result reconstructed from the fleet output (for the report). */
export interface SwarmScenarioResult {
  instanceId: string;
  task: string;
  arm: FleetArmId;
  /** The sim score; null = infra-failed (excluded). */
  score: number | null;
}

/** Pull per-scenario scores back out of a HiveBacklogResult's FleetTaskResults (the score rides armMeta). */
export function swarmbenchResultsFromFleet(taskResults: readonly FleetTaskResult[], arm: FleetArmId): SwarmScenarioResult[] {
  return taskResults.map((t) => {
    const m = t.attempt.armMeta ?? {};
    return {
      instanceId: t.attempt.instanceId,
      task: typeof m['task'] === 'string' ? (m['task'] as string) : t.attempt.instanceId.split('__')[0],
      arm,
      score: typeof m['score'] === 'number' ? (m['score'] as number) : null,
    };
  });
}

export interface SwarmTaskArmStat {
  task: string;
  arm: FleetArmId;
  /** Mean sim score over scored (non-infra) scenarios for this (task,arm). */
  meanScore: number;
  /** Standard error of the mean. */
  se: number;
  /** Scenarios scored / scenarios attempted (infra-excluded = attempted − scored). */
  scored: number;
  attempted: number;
}

export interface SwarmTaskDelta {
  task: string;
  /** Mean score for su-independent (decentralized) — null if that arm wasn't run. */
  suMean: number | null;
  /** Mean score for hive-realqueen (centralized) — null if that arm wasn't run. */
  hiveMean: number | null;
  /** hive − su (positive ⇒ centralizing the aggregated-local info helped on this task). */
  delta: number | null;
}

export interface SwarmBenchReport {
  suite: 'swarmbench';
  /** Per-(task,arm) mean score ± SE. */
  stats: SwarmTaskArmStat[];
  /** The headline: per-task decentralized-vs-centralized delta (hive − su). */
  deltas: SwarmTaskDelta[];
  /** MANDATORY honest-framing lines (D-001/D-005). */
  caveats: string[];
}

/**
 * Build the SwarmBench report from per-arm scenario results. Per (task,arm): mean score ± SE over scored
 * scenarios (infra-failed excluded). The headline `deltas` are per-task hive − su (the decentralized-vs-
 * centralized topology comparison). Carries the mandatory caveats (D-001 fair-queen / D-005 not-prod-hive).
 */
export function buildSwarmBenchReport(resultsByArm: Record<string, readonly SwarmScenarioResult[]>): SwarmBenchReport {
  const stats: SwarmTaskArmStat[] = [];
  // group by (arm, task)
  for (const [arm, rows] of Object.entries(resultsByArm)) {
    const byTask = new Map<string, number[]>();
    const attempts = new Map<string, number>();
    for (const r of rows) {
      attempts.set(r.task, (attempts.get(r.task) ?? 0) + 1);
      if (r.score !== null) {
        const arr = byTask.get(r.task) ?? [];
        arr.push(r.score);
        byTask.set(r.task, arr);
      }
    }
    for (const [task, scores] of byTask) {
      const ms = meanStderr(scores);
      stats.push({ task, arm: arm as FleetArmId, meanScore: ms.mean, se: ms.stderr, scored: scores.length, attempted: attempts.get(task) ?? scores.length });
    }
    // tasks that were all-infra (no scored scenarios) still surface with 0 scored
    for (const [task, n] of attempts) {
      if (!byTask.has(task)) stats.push({ task, arm: arm as FleetArmId, meanScore: 0, se: 0, scored: 0, attempted: n });
    }
  }

  const meanFor = (arm: FleetArmId, task: string): number | null => {
    const s = stats.find((x) => x.arm === arm && x.task === task && x.scored > 0);
    return s ? s.meanScore : null;
  };
  const tasks = [...new Set(stats.map((s) => s.task))].sort();
  const deltas: SwarmTaskDelta[] = tasks.map((task) => {
    const suMean = meanFor(SWARMBENCH_SU_INDEPENDENT_ARM, task);
    const hiveMean = meanFor(SWARMBENCH_HIVE_ARM, task);
    return { task, suMean, hiveMean, delta: suMean !== null && hiveMean !== null ? hiveMean - suMean : null };
  });

  return {
    suite: 'swarmbench',
    stats,
    deltas,
    caveats: [
      'FAIRNESS (D-001): the centralized (hive) arm sees only the AGGREGATED LOCAL views/messages the agents already have — NOT the global grid. A global-view queen would violate SwarmBench\'s local-only premise (cheating). The delta measures whether centralizing decentralized-local info beats peer self-organization.',
      'NOT THE PRODUCTION HIVE (D-005): the hive arm is a SwarmBench-specific aggregated-local coordinator, not the production Queen-over-backlog (which places bees on work_items across a task backlog). Frame this as a coordination-topology A/B on opus-4.8, not "our production Queen ran SwarmBench".',
      'Scores are CONTINUOUS per-task sim metrics (not pass-rates); the sim is seed-stochastic, so report mean±SE over multiple seeds. Infra-failed scenarios are excluded, not scored 0.',
    ],
  };
}
