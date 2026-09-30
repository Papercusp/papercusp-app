/**
 * The Hive-evaluation battery (P-022): run the seeded scenario corpus against ONE code
 * generation, N repeats per scenario, and record each run so a scenario's result is a
 * DISTRIBUTION over the raw deterministic observations — not a single point (the run is
 * stochastic). Determinism controls: a fixed base `seed` (per-repeat seed = seed + repeat,
 * reproducible + distinct), a per-run `budgetUsdCap` + `beeCap`, and a wall-clock bound.
 *
 * Sequential by design — bounded spend + a shared LLM rate limit (the eval-battery engine
 * discipline). JUDGE-FREE (D-009): it records raw runs + the distribution; HE-06 layers the
 * judge/composite/gate over the recorded runs. The per-scenario aggregation reuses the gym's
 * `variance.ts` (meanStdDev) so the distribution shape matches the rest of the eval stack.
 */
import { meanStdDev, type Stats } from '../gym/variance';
import { computeParallelismStructure, type HiveScenario } from './scenario';
import { hiveEvalRunIdentity } from './run-identity';
import {
  runHiveScenarioOnce,
  type HiveRunPorts,
  type HiveRunOpts,
  type HiveScenarioCell,
  type HiveScenarioRunRecord,
} from './run-harness';
import type { HiveEvalStore, HiveRunObservations, HiveRunTerminalState, InstanceManifest } from './store';

export interface HiveScenarioBatteryConfig {
  /** The code generation under test (its manifest — deterministic instanceId). */
  instance: InstanceManifest;
  /** The seeded corpus to run. */
  scenarios: readonly HiveScenario[];
  /** N repeats per scenario for variance (P-022). */
  repeats: number;
  /** Base seed — per-repeat seed = seed + repeat (reproducible + distinct). */
  seed: number;
  /** Per-run spend cap (determinism / budget control). */
  budgetUsdCap: number;
  /** Per-run bee cap. */
  beeCap: number;
  /** Per-run wall-clock bound (ms); defaults to the harness default. */
  timeoutMs?: number;
  /** Distilled-trace cap. */
  maxDistillChars?: number;
}

export interface HiveScenarioBatteryDeps {
  store: HiveEvalStore;
  ports: HiveRunPorts;
}

/** The disposition of one run cell. `completed` = the Hive ran (drained/timeout/failed);
 *  `errored` = an infra failure (boot/seed/collect threw) — recorded, excluded from the
 *  distribution, never aborts the battery. */
export type HiveRunOutcomeStatus = 'completed' | 'errored';

export interface HiveScenarioRunOutcome {
  runId: string;
  scenarioId: string;
  repeat: number;
  status: HiveRunOutcomeStatus;
  terminalState?: HiveRunTerminalState;
  record?: HiveScenarioRunRecord;
  error?: string;
}

/** A scenario's result as a DISTRIBUTION over the raw deterministic observations (P-022).
 *  HE-06 adds composite-score Stats over the same recorded runs. */
export interface HiveScenarioDistribution {
  scenarioId: string;
  shape: HiveScenario['shape'];
  /** The computable objective optimum (D-004) — carried so trends/HE-05 don't recompute. */
  idealWallClockUnits: number;
  idealBeeCount: number;
  totalUnits: number;
  /** Total cells run vs cells that produced a run record (non-errored). */
  runs: number;
  completedRuns: number;
  /** Fraction of completed runs that drained the whole frontier (objective completion). */
  frontierDrainedRate: number;
  /** Per-run completed/total, as a distribution. */
  completionRate: Stats;
  /** Measured wall-clock (ms), as a distribution. */
  wallClockMs: Stats;
  /** Real spend (USD), as a distribution. */
  costUsd: Stats;
}

export interface HiveScenarioBatteryResult {
  instanceId: string;
  outcomes: HiveScenarioRunOutcome[];
  distributions: HiveScenarioDistribution[];
  totalRuns: number;
  completedRuns: number;
}

/** Aggregate one scenario's completed run records into its observation distribution. */
function aggregateScenario(scenario: HiveScenario, records: HiveScenarioRunRecord[], runs: number): HiveScenarioDistribution {
  const para = computeParallelismStructure(scenario.workItems);
  const obs = records.map((r) => r.observations);
  const drained = obs.filter((o) => o.frontierDrained).length;
  const completionRates = obs.map((o) => (o.workItemsTotal > 0 ? o.workItemsCompleted / o.workItemsTotal : 0));
  return {
    scenarioId: scenario.id,
    shape: scenario.shape,
    idealWallClockUnits: para.idealWallClockUnits,
    idealBeeCount: para.idealBeeCount,
    totalUnits: para.totalUnits,
    runs,
    completedRuns: records.length,
    frontierDrainedRate: records.length > 0 ? drained / records.length : 0,
    completionRate: meanStdDev(completionRates),
    wallClockMs: meanStdDev(obs.map((o) => o.wallClockMs)),
    costUsd: meanStdDev(obs.map((o) => o.costUsd)),
  };
}

/**
 * Run the whole battery. Records the instance + each scenario (with its computed ideal) +
 * every run; returns the per-cell outcomes and the per-scenario distributions.
 */
export async function runHiveScenarioBattery(
  config: HiveScenarioBatteryConfig,
  deps: HiveScenarioBatteryDeps,
): Promise<HiveScenarioBatteryResult> {
  const { store, ports } = deps;
  const opts: HiveRunOpts = {
    defaultTimeoutMs: config.timeoutMs ?? 30 * 60_000,
    maxDistillChars: config.maxDistillChars ?? 8000,
  };

  await store.upsertInstance(config.instance);

  const outcomes: HiveScenarioRunOutcome[] = [];
  const distributions: HiveScenarioDistribution[] = [];

  for (const scenario of config.scenarios) {
    const para = computeParallelismStructure(scenario.workItems);
    await store.upsertScenario({
      scenarioId: scenario.id,
      title: scenario.title,
      shape: scenario.shape,
      idealWallClockUnits: para.idealWallClockUnits,
      idealBeeCount: para.idealBeeCount,
      totalUnits: para.totalUnits,
      criticalPath: para.criticalPath,
      workItemCount: scenario.workItems.length,
      plantedBugLocation: scenario.plantedBug.location,
    });

    const scenarioRecords: HiveScenarioRunRecord[] = [];
    for (let repeat = 0; repeat < config.repeats; repeat++) {
      const runSeed = config.seed + repeat;
      const cell: HiveScenarioCell = {
        instanceId: config.instance.instanceId,
        scenario,
        repeat,
        seed: runSeed,
        budgetUsdCap: config.budgetUsdCap,
        beeCap: config.beeCap,
        timeoutMs: config.timeoutMs,
      };
      const identity = hiveEvalRunIdentity({ instanceId: config.instance.instanceId, scenarioId: scenario.id, repeat, seed: runSeed });

      await store.startRun({
        runId: identity.runId,
        instanceId: config.instance.instanceId,
        scenarioId: scenario.id,
        shape: scenario.shape,
        repeat,
        seed: runSeed,
        budgetUsdCap: config.budgetUsdCap,
        beeCap: config.beeCap,
        startedAt: new Date(ports.now()),
      });

      try {
        const record = await runHiveScenarioOnce(cell, ports, opts);
        await store.finishRun(record.runId, {
          finishedAt: record.finishedAt,
          observations: record.observations,
          traceRef: record.traceRef,
        });
        scenarioRecords.push(record);
        outcomes.push({
          runId: record.runId,
          scenarioId: scenario.id,
          repeat,
          status: 'completed',
          terminalState: record.observations.terminalState,
          record,
        });
      } catch (err) {
        const failed: HiveRunObservations = {
          terminalState: 'failed',
          wallClockMs: 0,
          frontierDrained: false,
          workItemsTotal: scenario.workItems.length,
          workItemsCompleted: 0,
          costUsd: 0,
        };
        await store.finishRun(identity.runId, { finishedAt: new Date(ports.now()), observations: failed });
        outcomes.push({
          runId: identity.runId,
          scenarioId: scenario.id,
          repeat,
          status: 'errored',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    distributions.push(aggregateScenario(scenario, scenarioRecords, config.repeats));
  }

  return {
    instanceId: config.instance.instanceId,
    outcomes,
    distributions,
    totalRuns: outcomes.length,
    completedRuns: outcomes.filter((o) => o.status === 'completed').length,
  };
}
