/**
 * `@papercusp/bench-metrics` — benchmark scoring + cost/Pareto metrics for the
 * impartial benchmark suite (BRIEF 7 / P-011). Owns the canonical run-result
 * schema (co-defined with P-010), the published price table, per-arm token/$
 * accounting with coordination overhead counted, iso-budget verification, the
 * cost/accuracy Pareto, and pass@1-over-seeds + CIs + a uniform pass@k/pass^k
 * protocol.
 *
 *   import { buildSuiteReport, type TaskRunResult } from '@papercusp/bench-metrics';
 *   const report = buildSuiteReport(rows);  // → SuiteReport (arms, frontier, deltas)
 *
 * The pure statistics cores (pass-k, intervals, pareto) are domain-free and
 * usable on their own; schema/pricing/cost/aggregate compose them into the
 * benchmark layer.
 */

// The canonical schema (input + output contracts) — the one type every consumer imports.
export * from './schema';

// Pure domain-free statistics cores.
export { passAtK, passHatK, meanPassAtK } from './pass-k';
// Continuous-score aggregation for FrontierSWE-style suites (mean@k / best@k / AVG-RANK / dominance) —
// plan benchmark-suite-frontier-swe-2026-06-18 P-011. Distinct from pass-k (binary) + pareto (cost/accuracy).
export {
  meanAtK,
  bestAtK,
  armMeanAtK,
  armBestAtK,
  avgRank,
  dominance,
  frontierRankReport,
  type AggAtK,
  type PerTaskArmScores,
  type ArmTaskTrials,
  type FrontierArmSummary,
} from './frontier-rank';
export {
  wilsonInterval,
  bootstrapMeanCI,
  meanStderr,
  pairedBootstrapCI,
  mcnemarExact,
  type Interval,
  type PairedComparison,
  type McNemarResult,
} from './intervals';
export { dominates, paretoFrontier, costAccuracyFrontier, type Direction } from './pareto';

// METR-style time-horizon fit (plan benchmark-suite-metr-hcast-2026-06-17 / P-006).
export {
  computeTaskWeights,
  fitHorizonLogistic,
  fitHorizon,
  horizonMinutesAtQuantile,
  horizonLift,
  type HorizonTask,
  type HorizonWeighting,
  type HorizonFit,
  type HorizonFitOpts,
  type HorizonPoint,
  type HorizonResult,
  type HorizonCIOpts,
  type HorizonLift,
} from './horizon';

// Benchmark cost layer.
export {
  PRICE_TABLE_V1,
  DEFAULT_PRICE_TABLE,
  priceRun,
  resolveModelPrice,
  type PriceTable,
  type ModelPrice,
  type RunTokens,
} from './pricing';
export { accountTokens, verifyIsoBudget, budgetExceeded, isScored, type IsoBudgetCheck, type IsoBudgetCap } from './cost';

// Report builder — the importable aggregation surface for the Evaluation UI (P-020).
export { aggregateArm, buildSuiteReport, type AggregateOpts } from './aggregate';

// Per-capability attribution + cross-suite roll-up (capability-injection redesign / P-011).
export {
  buildCapabilityAttribution,
  buildCrossSuiteAttribution,
  formatAttributionLines,
  DEFAULT_CONTROL_ARM,
  ATTRIBUTION_CAVEATS,
  type AttributionMetric,
  type ArmCoverage,
  type CapabilityArmAttribution,
  type CapabilityAttributionReport,
  type CapabilityAttributionOpts,
  type CrossSuiteCell,
  type CrossSuiteAttribution,
  type CapabilityRollup,
} from './capability-attribution';

// Mandatory C1–C10 pre-claim fairness-audit table (capability-injection redesign / P-011 / C10).
export {
  buildFairnessAudit,
  formatFairnessAuditMarkdown,
  formatPerInstanceMatrix,
  type FairnessStatus,
  type FairnessCriterion,
  type ArmFairnessSummary,
  type FairnessAudit,
  type FairnessAuditOpts,
} from './fairness-audit';

// ── Hive layer (Phase 5 / D-010) — fleet-over-backlog metrics ──────────────
// L2 throughput + L3 value-capture + the report builder for the UI's
// Throughput / Value subtabs (P-030).
export {
  throughputMetrics,
  valueMetrics,
  buildHiveReport,
  mastHeadlineRate,
  MS_PER_HOUR,
  type FleetArmId,
  type FleetRunSummary,
  type ThroughputMetrics,
  type TaskValue,
  type ValueMetrics,
  type HiveArmReport,
  type HiveArmInput,
  type HiveDelta,
  type HiveBacklogReport,
  type HiveReportOpts,
} from './fleet';
// L4 coordination quality — the MAST failure-taxonomy scorer (P-026).
export {
  scoreMast,
  substrateSignalRates,
  buildMastJudgePrompt,
  mockMastJudge,
  MAST_CATEGORIES,
  MAST_MODES,
  MAS_FAILURE_BASELINE_BAND,
  TOKEN_DUPLICATION_BASELINE_BAND,
  INTERAGENT_MISALIGNMENT_BASELINE,
  type MastCategory,
  type MastMode,
  type MastModeId,
  type CoordEventKind,
  type CoordEvent,
  type CoordTrace,
  type SubstrateSignalRates,
  type MastVerdict,
  type MastReport,
} from './mast';
