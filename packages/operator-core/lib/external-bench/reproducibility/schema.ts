/**
 * The reproducibility-layer types (BRIEF 8 / P-010). The per-(task × arm × seed)
 * scoreable row — `TaskRunResult` — is OWNED by P-011 (`@papercusp/bench-metrics`)
 * and imported here; this file owns the two repro artifacts that wrap it:
 *
 *   RolloutRecord — the Rollout-Card published unit (arXiv 2605.12131): the full
 *     config snapshot, exact model/harness versions + git sha, env fingerprint,
 *     VERBATIM raw grader output, the graded submission, and the trajectory
 *     pointer. 1:1 with a run_result via the shared `rolloutId`.
 *   PreregRecord — the pre-registered run config, content-hashed and committed to
 *     git before the run (the tune-to-test firewall).
 *   EmitRolloutInput — the structured input every arm runner hands to
 *     emitRollout(); one call writes the run_result row + the rollout card.
 *
 * snake_case (PG, migration 291) ↔ camelCase (TS) is the persistence seam, owned
 * here in store.ts (rows → TaskRunResult) + emit.ts (input → rows).
 */
import type {
  ArmId,
  BenchSuite,
  GenerationStatus,
  GraderModality,
  GraderStatus,
  TestOutcome,
} from '@papercusp/bench-metrics';

/** The Rollout Card — the published unit of reproducibility (1:1 with a run_result). */
export interface RolloutRecord {
  rolloutId: string;
  runId: string;
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  seed: number;
  /** The resolved per-run config incl. arm settings + model params. */
  configSnapshot?: Record<string, unknown> | null;
  modelId: string;
  /** Exact provider model version string if distinct from modelId. */
  modelVersion?: string | null;
  harnessVersion: string;
  /** Exact tree sha the harness ran from. */
  harnessGitSha?: string | null;
  /** os / node / docker image digests / grader image digest. */
  envFingerprint?: Record<string, unknown> | null;
  graderFamily: string;
  graderVersion: string;
  /** Structured grader report: { failToPass, passToPass, report }. */
  graderOutput?: unknown;
  /** The benchmark's own output, VERBATIM. */
  rawGraderOutput?: string | null;
  /** The exact submission graded — M1: the unified diff; M2: the env handle ref. */
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
  createdAt: string;
}

/** The pre-registered run config (committed to git before the run). */
export interface PreregRecord {
  preregHash: string;
  runId: string;
  label?: string | null;
  suites: BenchSuite[];
  config: Record<string, unknown>;
  /** Repo-relative path the committed file lands at (benchmarks/preregistrations/<runId>.json). */
  filePath: string;
  gitCommitted: boolean;
  gitCommitSha?: string | null;
  createdAt: string;
}

/**
 * What an arm runner hands to emitRollout(). The `generation` half is arm-specific
 * (tokens SUMMED across every agent/role/candidate+verifier — coordination
 * overhead counted in OUR number); the `grading` half comes verbatim from the
 * arm-agnostic OfficialGrader. cost_usd + price_table_version are DERIVED at emit
 * (P-011 priceRun) — never passed in, so one published price table applies to
 * every arm identically.
 */
export interface EmitRolloutInput {
  runId: string;
  /** Must match an existing benchmark_prereg row (tune-to-test firewall). */
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  /** Independent-attempt ordinal — ≥3 distinct per (task × arm). */
  seed: number;
  modality: GraderModality;
  /** The L2 fleet run that placed this task (Phase 5 / D-010); null for standalone L1 arms. */
  fleetRunId?: string | null;
  generation: {
    status: GenerationStatus;
    error?: string | null;
    tokensIn: number;
    tokensOut: number;
    /** SUMMED across every agent/role (Papercusp) or every candidate+verifier (best-of-N). */
    tokensTotal: number;
    tokensCacheRead?: number | null;
    tokensCacheWrite?: number | null;
    wallClockMs: number;
    turns?: number;
    /** GENERATION iso-budget cap this run ran under (null = uncapped / native). */
    budgetTokens?: number | null;
    /** Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail). */
    capped?: boolean;
    modelId: string;
    harnessVersion: string;
    /** Arm-specific detail; opaque to scoring, published for repro (best-of-N candidates, …). */
    armMeta?: Record<string, unknown> | null;
    /** The graded submission content (diff/env-ref) — stored in the rollout card. */
    submission?: string | null;
    trajectoryRef?: string | null;
    trajectoryKind?: string | null;
  };
  grading: {
    /** NULL when never genuinely graded (generation/grader infra) — excluded from accuracy. */
    resolved: boolean | null;
    status: GraderStatus;
    family: string;
    version: string;
    error?: string | null;
    failToPass?: TestOutcome[] | null;
    passToPass?: TestOutcome[] | null;
    /** Full grader report → rollout.grader_output. */
    structuredOutput?: unknown;
    /** Verbatim grader output → rollout.raw_grader_output. */
    rawOutput?: string | null;
    /**
     * Continuous partial-credit score in [0,1] for rubric/checkpoint/coordination suites
     * (TheAgentCompany, PaperBench, AgentsNet) → run_result.score. NULL for boolean-resolved
     * suites (SWE-bench family) where `resolved` is the score.
     */
    score?: number | null;
  };
  provenance?: {
    configSnapshot?: Record<string, unknown> | null;
    modelVersion?: string | null;
    harnessGitSha?: string | null;
    envFingerprint?: Record<string, unknown> | null;
  };
}
