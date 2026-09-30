/**
 * The reproducibility harness (BRIEF 8 / P-010) for the impartial benchmark suite
 * (plan `impartial-benchmark-suite-2026-06-15`). Public surface:
 *
 *   preregister / verifyPreregistration / computePreregHash  — the git
 *     pre-registration firewall (benchmarks/preregistrations/<runId>.json).
 *   emitRollout / emitFromAttempt                            — THE emission entry
 *     point: writes the run_result row + the Rollout Card in one tx, derives cost
 *     via @papercusp/bench-metrics priceRun, enforces the prereg firewall.
 *   listRunResults / listSuites / getRollout / getPrereg     — reads (run_result
 *     rows as P-011's TaskRunResult; the rollout/prereg artifacts).
 *   exportRunBundle                                          — publish a run's
 *     rollout cards + manifest to benchmarks/ for the third-party reproducer.
 *
 * The per-(task × arm × seed) row type itself is `TaskRunResult` from
 * `@papercusp/bench-metrics` (co-owned with P-011); the PG tables are migration
 * 291 (benchmark_run_result / benchmark_rollout / benchmark_prereg).
 */
export { canonicalJson } from './canonical-json';
export {
  preregister,
  verifyPreregistration,
  computePreregHash,
  preregFilePath,
  PREREG_DIR_REL,
  type PreregisterInput,
  type PreregisterResult,
  type VerifyPreregResult,
} from './prereg';
export {
  emitRollout,
  emitFromAttempt,
  rolloutIdFor,
  type EmitOptions,
  type EmitFromAttemptInput,
} from './emit';
export {
  listRunResults,
  listSuites,
  getRollout,
  getPrereg,
  type SuiteSummary,
} from './store';
export { exportRunBundle, type ExportResult } from './export';
export type { RolloutRecord, PreregRecord, EmitRolloutInput } from './schema';
// L2 Hive layer (Phase 5 / D-010) — fleet runs + the MAST coordination trace.
export {
  emitFleetRun,
  emitCoordEvents,
  fleetRunIdFor,
  listFleetRuns,
  listFleetRunsFull,
  getCoordTrace,
  type FleetRunInput,
  type FleetRunRecord,
} from './fleet';
