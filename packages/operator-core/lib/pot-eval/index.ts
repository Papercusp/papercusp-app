/**
 * `hive-eval/` — the Hive-run-evaluation battery (hive-run-evaluation-2026-06-13, HE-03).
 *
 * A sibling slice of the apiary IQ-battery (D-006/D-009): seeded scenarios with an objective
 * optimum (P-020), the run harness that drives a whole throwaway Hive on a scenario to
 * completion/timeout (P-021), and the determinism + repeat-distribution controls (P-022).
 * JUDGE-FREE — it records raw runs + distributions; HE-04/05 compute metrics over the
 * recorded observations and HE-06 layers the judge/composite/un-gameable gate.
 */
export {
  type HiveScenario,
  type ScenarioShape,
  type ScenarioWorkItem,
  type ScenarioSandbox,
  type AcceptanceTest,
  type ParallelismStructure,
  type ScenarioProblem,
  computeParallelismStructure,
  validateScenario,
} from './scenario';

export { HIVE_EVAL_SCENARIOS, SEED_APP_DIR, getScenario } from './scenarios';

export { hiveEvalRunIdentity, type HiveEvalRunKey, type HiveEvalRunIdentity } from './run-identity';

export {
  runHiveScenarioOnce,
  hiveScenarioSubject,
  makeFakeHivePorts,
  HIVE_RUN_DEFAULT_OPTS,
  type HiveRunPorts,
  type HiveRunOpts,
  type HiveScenarioCell,
  type HiveBootResult,
  type DriveResult,
  type HiveRunHandle,
  type HiveRunSignals,
  type HiveScenarioRunRecord,
  type FakeHiveBehavior,
  type FakeHivePorts,
} from './run-harness';

export {
  runHiveScenarioBattery,
  type HiveScenarioBatteryConfig,
  type HiveScenarioBatteryDeps,
  type HiveScenarioBatteryResult,
  type HiveScenarioRunOutcome,
  type HiveScenarioDistribution,
  type HiveRunOutcomeStatus,
} from './battery';

export {
  createInMemoryHiveEvalStore,
  type HiveEvalStore,
  type InMemoryHiveEvalStore,
  type HiveEvalScenarioRow,
  type HiveEvalRunRow,
  type HiveEvalRunFinish,
  type HiveRunObservations,
  type HiveRunTerminalState,
  type InstanceManifest,
} from './store';

export { createPgHiveEvalStore } from './store-pg';

export {
  computeOutcomeMetrics,
  detectFabrication,
  liveAcceptancePorts,
  type OutcomeMetrics,
  type OutcomeMetricsDeps,
  type AcceptancePorts,
  type RunGroundTruth,
  type WorkItemTruth,
  type FabricationResult,
  type TestResult,
} from './outcome-metrics';

export {
  buildGroundTruth,
  collectGroundTruth,
  commitBacksWorkItem,
  deriveActuals,
  gitLogCommits,
  liveGroundTruthPorts,
  parseTapResults,
  runBaselineSuite,
  type GroundTruthRaw,
  type GroundTruthCtx,
  type GroundTruthPorts,
  type LiveGroundTruthDeps,
  type WorkItemClaim,
  type WorkItemActual,
  type ObservedCommit,
} from './ground-truth';

export {
  makeLiveGroundTruthDeps,
  liveGroundTruthPortsFromSql,
  DEFAULT_DONE_STATUSES,
  DEFAULT_WORKED_STATUSES,
  type LiveGroundTruthConfig,
} from './ground-truth-live';

export { computeSpeedMetrics, type SpeedMetrics, type RunTimings } from './speed-metrics';

export {
  computeEfficiencyMetrics,
  type EfficiencyMetrics,
  type RunBehavior,
  type MetricPairing,
} from './efficiency-metrics';

// P-064/P-065 (D-021) — the adversarial SUPERVISION battery: seed a misbehaving bee, MEASURE the
// supervision layer's detection rate / latency / false-positive (don't assume it).
export {
  SUPERVISION_CASES,
  casesForFamily,
  type SupervisionCase,
  type SupervisionFamily,
  type LivenessSeed,
  type ChannelBehavior,
  type BehavioralSeed,
} from './supervision-scenarios';

export {
  measureLivenessDetection,
  measureBehavioralDetection,
  measureSupervision,
  ekgDriftDetector,
  scopeViolationDetector,
  convergenceChurnDetector,
  compositeDetector,
  fullBehavioralDetector,
  EXPECTED_RECOVERY_LATENCY_MS,
  WATCHDOG_SWEEP_MS,
  DETECTION_HORIZON_MS,
  EKG_WINDOW_MS,
  COLLECTOR_DETECTION_LATENCY_MS,
  type BehavioralDetector,
  type SupervisionDetectionReport,
  type DetectionOutcome,
  type DetectionVerdict,
} from './supervision-metrics';

export {
  computeHiveScore,
  hiveScoreRubricHash,
  hiveScoreToRow,
  DEFAULT_HIVE_SCORE_RUBRIC_V1,
  type HiveScore,
  type HiveScoreRubric,
  type HiveAxisScore,
  type ScoreComponent,
  type DeterministicFloor,
  type AxisWeights,
  type EfficiencyWeights,
  type SpeedWeights,
  type HiveScoreThresholds,
} from './scoring';

export { type HiveEvalScoreRow } from './store';

// HE-07 — the scored generation runner (battery → HE-06 score → persist), the cadence's invocation
// target + the full-battery integration subject (P-050/P-061).
export {
  runHiveEvalGeneration,
  type HiveEvalGenerationDeps,
  type HiveEvalGenerationResult,
  type HiveEvalScoreExtractor,
  type HiveRunScoreInputs,
  type ScoredRun,
  type ScoredScenarioDistribution,
} from './generation-runner';

// P-063 / D-011 — the LIVE whole-Hive ports + the capture→replay score extractor (the binding that
// makes the benchmark runnable; the real run is owner-gated P-051).
export {
  makeLiveHivePorts,
  seedRepoMaterializeCommands,
  seedRepoCloneCommands,
  scenarioSeedPlan,
  isHiveDrained,
  type LiveHiveOps,
  type LiveHivePortsOpts,
  type LiveRunStats,
} from './live-ports';
export {
  liveHiveOps,
  captureRunData,
  type LiveHiveOpsDeps,
  type CaptureRunDataInput,
} from './live-ops';
export {
  makeReplayExtractor,
  packLiveRunCapture,
  readLiveRunCapture,
  behaviorFromSpawnRows,
  timingsFromSpawnRows,
  beesBusySamplesFromIntervals,
  collisionsFromSpawnRows,
  replayAcceptancePorts,
  LIVE_CAPTURE_KEY,
  type LiveRunCapture,
  type SpawnRunRow,
  type BehaviorEkgFields,
  type ReplayExtractorOpts,
} from './live-capture';

// HE-07 — the cadence orchestration (P-050; the `pot-eval:gen` blueprint op wraps this).
export { runHiveEvalGen, type HiveEvalGenDeps } from './gen-loop';
export {
  runHiveEvalCadenceTick,
  ownerBudgetUsd,
  type HiveEvalCadenceOutcome,
  type HiveEvalRunRequest,
  type HiveEvalRunFn,
} from './cadence-tick';

// HE-07 — the Benchmark-tab "Hive orchestration" trend read (P-050).
export { readHiveEvalInstanceSummaries, type HiveEvalGenerationSummary } from './trend-read';
