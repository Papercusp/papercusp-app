/**
 * The Hive-evaluation GENERATION runner (HE-07) — the layer that turns the judge-free battery
 * (HE-03) into a SCORED generation: run the seeded corpus against one code generation, then score
 * each recorded run with the HE-06 composite + un-gameable gate and persist it to `hive_eval_scores`.
 *
 * This is the single orchestration shared by:
 *   - the CADENCE (the `pot-eval-battery` routine, which targets `system:blueprint-run`; P-050) —
 *     invoked monthly per new code SHA so the
 *     Hive's good/efficient/fast scores become a TREND; and
 *   - the FULL-BATTERY integration (P-061) — the scenarios run end-to-end and produce a scored
 *     distribution per scenario.
 *
 * The seam that keeps this testable without real LLM spend is {@link HiveEvalScoreExtractor}: given
 * a recorded run + its scenario, it yields the three metric bundles (outcome · efficiency · speed).
 * Its LIVE implementation (run the acceptance command, extract ground truth, read the EKG/throughput
 * behavior + timings — `collectRunData`) is owner-gated P-051, exactly the boundary HE-03/04/05/06
 * drew; a fake extractor exercises the whole battery → score → persist path deterministically.
 *
 * Pure orchestration over injected ports — no IO of its own beyond the store + the injected ports.
 */
import { meanStdDev, type Stats } from '../gym/variance';
import { runHiveScenarioBattery, type HiveScenarioBatteryConfig, type HiveScenarioBatteryResult } from './battery';
import type { HiveRunPorts, HiveScenarioRunRecord } from './run-harness';
import type { HiveScenario, ScenarioShape } from './scenario';
import type { OutcomeMetrics } from './outcome-metrics';
import type { EfficiencyMetrics } from './efficiency-metrics';
import type { SpeedMetrics } from './speed-metrics';
import {
  computeHiveScore,
  hiveScoreToRow,
  hiveScoreRubricHash,
  DEFAULT_HIVE_SCORE_RUBRIC_V1,
  type HiveScore,
  type HiveScoreRubric,
} from './scoring';
import type { HiveEvalStore } from './store';

/** The three metric bundles a scored run needs — what the extractor yields per recorded run. */
export interface HiveRunScoreInputs {
  outcome: OutcomeMetrics;
  efficiency: EfficiencyMetrics;
  speed: SpeedMetrics;
}

/**
 * Yield the metric bundles for one recorded run. The LIVE impl runs the scenario's acceptance
 * command, extracts ground truth (`collectGroundTruth` → `computeOutcomeMetrics`), and reads the
 * run's behavior + timings (EKG / `computeHiveThroughput` / spawn rows) — all owner-gated P-051.
 * A fake impl makes the whole generation deterministic for tests (P-061).
 */
export interface HiveEvalScoreExtractor {
  extract(input: { record: HiveScenarioRunRecord; scenario: HiveScenario }): Promise<HiveRunScoreInputs>;
}

export interface HiveEvalGenerationDeps {
  store: HiveEvalStore;
  ports: HiveRunPorts;
  extractor: HiveEvalScoreExtractor;
  /** The frozen scoring rubric; defaults to v1 (the cache key keys the score row). */
  rubric?: HiveScoreRubric;
}

/** One scored run — the run id, its scenario, and the full HiveScore (persisted to hive_eval_scores). */
export interface ScoredRun {
  runId: string;
  scenarioId: string;
  score: HiveScore;
}

/** A scenario's SCORED distribution — the composite + axis Stats HE-07's trend surfaces over time. */
export interface ScoredScenarioDistribution {
  scenarioId: string;
  shape: ScenarioShape;
  scoredRuns: number;
  /** Fraction of scored runs that passed the D-002 outcome gate. */
  outcomeGatePassRate: number;
  composite: Stats;
  efficiency: Stats;
  speed: Stats;
  criticalPathRatio: Stats;
}

export interface HiveEvalGenerationResult {
  instanceId: string;
  rubricHash: string;
  battery: HiveScenarioBatteryResult;
  scores: ScoredRun[];
  scoreDistributions: ScoredScenarioDistribution[];
}

/**
 * Run + SCORE one whole generation: the judge-free battery records the runs (HE-03), then each
 * completed run is scored (HE-06) and persisted. Errored runs (infra failures) carry no record and
 * are skipped from scoring — they already show in `battery.outcomes` as errored. Returns the scored
 * runs + the per-scenario SCORED distribution (the trend's row source).
 */
export async function runHiveEvalGeneration(
  config: HiveScenarioBatteryConfig,
  deps: HiveEvalGenerationDeps,
): Promise<HiveEvalGenerationResult> {
  const rubric = deps.rubric ?? DEFAULT_HIVE_SCORE_RUBRIC_V1;
  const battery = await runHiveScenarioBattery(config, { store: deps.store, ports: deps.ports });

  const scenarioById = new Map(config.scenarios.map((s) => [s.id, s]));
  const scores: ScoredRun[] = [];
  const byScenario = new Map<string, HiveScore[]>();

  for (const outcome of battery.outcomes) {
    if (outcome.status !== 'completed' || !outcome.record) continue;
    const scenario = scenarioById.get(outcome.scenarioId);
    if (!scenario) continue;

    const inputs = await deps.extractor.extract({ record: outcome.record, scenario });
    const score = computeHiveScore(inputs.outcome, inputs.efficiency, inputs.speed, rubric);
    await deps.store.upsertScore(hiveScoreToRow(outcome.record.runId, score));

    scores.push({ runId: outcome.record.runId, scenarioId: scenario.id, score });
    const bucket = byScenario.get(scenario.id);
    if (bucket) bucket.push(score);
    else byScenario.set(scenario.id, [score]);
  }

  const scoreDistributions: ScoredScenarioDistribution[] = [];
  for (const [scenarioId, ss] of byScenario) {
    scoreDistributions.push({
      scenarioId,
      shape: scenarioById.get(scenarioId)!.shape,
      scoredRuns: ss.length,
      outcomeGatePassRate: ss.filter((s) => s.outcomeGatePassed).length / ss.length,
      composite: meanStdDev(ss.map((s) => s.composite)),
      efficiency: meanStdDev(ss.map((s) => s.efficiency.score)),
      speed: meanStdDev(ss.map((s) => s.speed.score)),
      criticalPathRatio: meanStdDev(ss.map((s) => s.floor.criticalPathRatio)),
    });
  }

  return {
    instanceId: battery.instanceId,
    rubricHash: hiveScoreRubricHash(rubric),
    battery,
    scores,
    scoreDistributions,
  };
}

export type { HiveScenarioBatteryConfig };
