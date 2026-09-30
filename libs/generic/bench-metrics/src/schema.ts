/**
 * THE canonical run-result schema for the impartial benchmark suite
 * (`impartial-benchmark-suite-2026-06-15`). Co-owned by P-011 (this lib —
 * cost/scoring) and P-010 (reproducibility harness). Every consumer imports
 * `TaskRunResult` from here so there is ONE shape across the wave:
 *   - P-005 (grader adapter) + the four arm runners (Baselines A/B/C + Papercusp)
 *     EMIT it; P-010's emission layer writes it to the PG `run_result` table.
 *   - P-010 wraps each row with a `rollout` (Rollout-Card repro artifact) + a
 *     `prereg` (pre-registered config) — those layers are P-010's, referenced
 *     here only by id/hash.
 *   - P-020 (Evaluation UI) + P-016 (methodology doc) READ the aggregates.
 *   - This lib's `aggregate.ts` folds `TaskRunResult[]` → per-arm reports.
 *
 * The row is the per-(task × arm × seed) scoreable unit. Reconciled from:
 *   P-010 v0 three-layer shape + P-011 deltas (cost DERIVED from raw tokens via
 *   a published price table; generation iso-budget fields; arm_meta; locked arm
 *   vocab; seed = attempt ordinal) + P-001 §5 grader slice + 2-modality finding
 *   (apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md).
 *
 * FAIRNESS INVARIANTS encoded by the field semantics:
 *  - `tokensTotal` is SUMMED across every agent + turn (all spine roles +
 *    coordination for Papercusp; all N candidates + the verifier for best-of-N),
 *    so coordination overhead is counted in OUR own number.
 *  - The iso-budget cap (`budgetTokens`) bounds GENERATION only; grading is
 *    uncapped and byte-for-byte identical across arms (P-001 §5).
 *  - `costUsd` is DERIVED from raw tokens × ONE published price table
 *    (`priceTableVersion`), applied identically to every arm — never
 *    provider-reported $ for one arm and computed for another. Always
 *    recomputable by a third party from the stored tokens + the table.
 */

/**
 * Comparison arm. The four SWE-pilot arms below are the canonical, documented
 * vocabulary the delta math keys on; the union is OPEN ((string & {})) so OTHER
 * benchmarks (tau2-bench, the-agent-company, …) ride the same schema + dual-arm
 * report with their own arm ids (e.g. 'hive' | 'su' | 'baseline-opus') — name
 * the treatment via `buildSuiteReport`'s `treatmentArm` opt. Same open-enum
 * pattern as `BenchSuite` / `FleetArmId`.
 */
export type ArmId =
  | 'papercusp' //            the treatment: full multi-agent spine + coordination substrate
  | 'baseline-a-ablation' //  single-worker ablation (identical tools/model/infra/budget)
  | 'baseline-b-native' //    native harness (Claude Code on the same model) — the headline baseline
  | 'baseline-c-bestofn' //   best-of-N + test-verifier at matched token budget
  | (string & {}); //         other benchmarks' arms (interactive/breadth suites)

export const ARM_IDS: readonly ArmId[] = [
  'papercusp',
  'baseline-a-ablation',
  'baseline-b-native',
  'baseline-c-bestofn',
] as const;

/** Benchmark family. Open string union — new suites add a literal here. */
export type BenchSuite =
  | 'swe-bench-pro'
  | 'swe-bench-verified'
  | 'terminal-bench'
  | 'harness-bench'
  | 'swe-evo'
  | 'swe-rebench'
  // Non-coding / generic-professional + decomposable-deliverable suites that score a
  // CONTINUOUS partial-credit value (TheAgentCompany checkpoints; PaperBench Replication
  // Score) rather than a boolean diff pass — see TaskRunResult.score.
  | 'the-agent-company'
  | 'paperbench'
  // METR HCAST / time-horizon suite (plan benchmark-suite-metr-hcast-2026-06-17). The per-task
  // pass/fail rides the normal fields; the HEADLINE is a derived run-level metric (a logistic
  // 50%/80%-time-horizon fit + the two-arm hive-vs-single-opus LIFT — see @papercusp/bench-metrics
  // horizon.ts). The absolute horizon on the ~31-task open subset is illustrative-only (D-002).
  | 'metr-hcast'
  // GAIA — broad general-assistant / research suite (plan benchmark-suite-gaia-2026-06-17). BINARY
  // quasi-exact-match per task (resolved); the suite headline is per-level L1/L2/L3 + overall accuracy
  // (pass@1), with `score` left null (resolved IS the score, like the SWE-bench family).
  | 'gaia'
  // AgentsNet coordination benchmark (plan benchmark-suite-agentsnet-2026-06-17): per-node
  // opus, neighbor-only message passing, deterministic get_score() → continuous [0,1]
  // coordination score on TaskRunResult.score; official BINARY headline = (score === 1).
  | 'agentsnet'
  // SwarmBench (plan benchmark-suite-swarmbench-2026-06-17). Coordination-native decentralized 2D-grid
  // swarm sim; deterministic per-task sim score on TaskRunResult.score. Headline = the decentralized-vs-
  // centralized topology delta (D-001: the fair queen sees aggregated-local views only, not the global grid).
  | 'swarmbench'
  // GDPval (OpenAI, plan benchmark-suite-gdpval-2026-06-17). Real-world professional DELIVERABLES graded by a
  // blinded PAIRWISE comparison vs an expert reference → win/tie/loss → win-or-tie rate. resolved = win-or-tie;
  // `score` carries the win=1/tie=.5/loss=0 value (the suite headline is the mean = the win-rate).
  | 'gdpval'
  // FrontierSWE (Proximal Labs; plan benchmark-suite-frontier-swe-2026-06-18). Ultra-long-horizon
  // implementation / perf-eng / ML-research; CONTINUOUS [0,1] score on TaskRunResult.score (no model
  // fully solves the implementation tasks). M2 in-container + own-scorer. Headline = mean@5/best@5 +
  // AVG-RANK/dominance across a coordination-topology arm pool; resolved = (score === 1) is degenerate.
  | 'frontier-swe'
  | (string & {});

/** Grader modality (P-001 §1): offline diff-batch · online in-container · qa (a single FINAL ANSWER string,
 *  quasi-exact-match graded — GAIA; plan benchmark-suite-gaia-2026-06-17) · interactive (a synchronous
 *  per-turn agent↔simulator loop graded by a reward-model — tau2-bench / the-agent-company; the agent↔sim
 *  DRIVE lives in the runner layer (external-bench), this lib only scores the result) · deliverable-bundle (a
 *  professional deliverable graded by a blinded pairwise judge vs an expert reference — GDPval). */
export type GraderModality = 'diff' | 'in-container' | 'qa' | 'interactive' | 'deliverable-bundle';

/**
 * Normalized grader outcome. `error`/`timeout` are INFRA failures, distinct
 * from a genuine `failed` — they are excluded from accuracy and surfaced
 * separately (METR elicitation discipline; P-001 §5).
 */
export type GraderStatus = 'passed' | 'failed' | 'error' | 'timeout';

/**
 * Outcome of the GENERATION half (parallel to GraderStatus, distinct surface —
 * P-006/P-008). `completed` = the arm produced a submission (graded normally,
 * even if it ran to the iso-budget cap — see `capped`). `error`/`timeout` =
 * generation itself failed (agent crashed, OOM, no submission produced) — an
 * INFRA failure excluded from accuracy and surfaced separately, NOT a genuine
 * `failed`. So a row is scored for accuracy only when BOTH generationStatus and
 * graderStatus are non-infra.
 */
export type GenerationStatus = 'completed' | 'error' | 'timeout';

/** Per-test result (SWE-bench FAIL_TO_PASS / PASS_TO_PASS; M1/diff only). */
export interface TestOutcome {
  test: string;
  passed: boolean;
}

/**
 * One graded, costed task run: the per-(task × arm × seed) row. Mirrors the PG
 * `run_result` table (P-010 owns the migration since P-010 emits). Field groups
 * are tagged by owner so consumers know which half they fill.
 */
export interface TaskRunResult {
  // ── identity ──────────────────────────────────────────────────────────────
  /** Groups one pilot execution (all tasks × arms × seeds). */
  runId: string;
  suite: BenchSuite;
  modality: GraderModality;
  /** Benchmark task identifier (e.g. SWE-bench Pro `instance_id`). */
  taskId: string;
  arm: ArmId;
  /** Independent-attempt ordinal — ≥3 distinct per (task × arm). SWE-bench Pro `prefix`. */
  seed: number;

  // ── grader slice (P-001 §5; emitted by the OfficialGrader, identical per arm)
  /** Headline pass/fail. M1: FAIL_TO_PASS ∧ PASS_TO_PASS; M2: verifier pass/fail.
   *  NULL when the row was never genuinely graded (generation or grader infra
   *  error) — null ≠ false; null rows are excluded from accuracy, not counted as
   *  fails (P-010 co-def + METR discipline). Scored rows carry a real boolean. */
  resolved: boolean | null;
  graderStatus: GraderStatus;
  graderFamily: string;
  /** Pinned exactly for pre-registration (image tag / `terminal-bench@2.0`+harbor ver / clawbench commit). */
  graderVersion: string;
  /** M1 only (null for M2): per-test breakdown. */
  failToPass?: TestOutcome[] | null;
  passToPass?: TestOutcome[] | null;
  /**
   * Partial-credit / continuous score in [0,1] for suites that grade a weighted RUBRIC or
   * CHECKPOINT set rather than a single diff pass — TheAgentCompany checkpoint partial-credit
   * (S = 0.5·Σresult/Σtotal + 0.5·all-pass) and PaperBench Replication Score. NULL/absent for
   * boolean-resolved suites (SWE-bench family), where `resolved` IS the score. When present,
   * `resolved` is the all-or-nothing roll-up (score === 1 / every checkpoint passed); the
   * meaningful headline for these suites is the MEAN of `score` over scored rows (aggregate.ts
   * `meanScore`), not pass@1 (which would be the near-zero full-completion rate).
   */
  score?: number | null;

  // ── generation / cost slice (P-011 — this lib) ────────────────────────────
  /** SUMMED across every agent + turn (coordination overhead counted). */
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  /** Prompt-cache tokens (nullable) — they move $ materially; counted in cost. */
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  /** DERIVED via priceRun(tokens, modelId, table). Recomputable from raw tokens. */
  costUsd: number;
  /** The price table version `costUsd` was computed under (e.g. 'price-table-v1'). */
  priceTableVersion: string;
  wallClockMs: number;
  /** Agent steps / turns. */
  turns: number;
  /** GENERATION iso-budget cap this run ran under (null = uncapped / native). */
  budgetTokens?: number | null;
  /** Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail). */
  capped: boolean;
  /** Generation outcome (parallel to graderStatus). error/timeout = infra, excluded from accuracy. */
  generationStatus: GenerationStatus;
  /** Free-text generation failure detail (null unless generationStatus is error/timeout). */
  generationError?: string | null;
  /** Arm-specific detail; OPAQUE to scoring, published for reproducibility.
   *  Baseline C: { n, selectedCandidate, candidates:[{tokensIn,tokensOut,verifierPass,score}], verifierTokens }. */
  armMeta?: Record<string, unknown> | null;

  // ── reproducibility slice (P-010 — referenced here by id/hash/ref) ────────
  /** Exact model id, e.g. 'claude-opus-4-8[1m]'. */
  modelId: string;
  /** Blueprint version + git sha of the harness. */
  harnessVersion: string;
  /** The pre-registered config hash this ran under; every row must match a prereg. */
  preregHash: string;
  /** FK → P-010's `rollout` (the Rollout-Card published artifact). */
  rolloutId: string;
  /** Artifact pointer — the benchmark's own report JSON, stored verbatim. */
  rawGraderOutputRef?: string | null;
  /** Artifact pointer — M1: the exact diff graded, per seed. */
  submissionRef?: string | null;
  createdAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Report shapes — what `aggregate.ts` produces and the UI (P-020) + doc (P-016)
// read. These are the OUTPUT contract; TaskRunResult is the INPUT contract.
// ───────────────────────────────────────────────────────────────────────────

import type { Interval } from './intervals';

/** Token + dollar accounting for an arm (or arm × suite), all SUMMED. */
export interface CostAccount {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  /** Mean generation tokens per task-attempt (the iso-budget axis). */
  tokensPerRun: number;
  /** $ per resolved task — the "more resolved per dollar" headline denominator. */
  costPerResolved: number | null;
}

/** A pass@k point at one k, with the tasks it was estimated over. */
export interface PassAtKPoint {
  k: number;
  value: number;
  tasksUsed: number;
  skipped: number;
}

/** The aggregated result for ONE arm on ONE suite. */
export interface ArmReport {
  arm: ArmId;
  suite: BenchSuite;
  /** Distinct tasks and total scored attempts (excludes infra-error rows). */
  tasks: number;
  attempts: number;
  /** Attempts dropped because graderStatus was error/timeout (surfaced, not scored). */
  infraErrors: number;
  /** Of the GENERATION runs, how many hit the iso-budget cap. */
  cappedRuns: number;
  /** The iso-budget cap shared by these runs (null = uncapped, or mixed → see verifyIsoBudget). */
  budgetTokens: number | null;
  /** pass@1 = mean over tasks of (mean over seeds of resolved). The headline accuracy. */
  passAt1: number;
  /** Bootstrap CI over tasks for pass@1 (task heterogeneity is the dominant noise). */
  passAt1Ci: Interval;
  /** Wilson interval on the pooled task×seed Bernoulli resolved-rate (cross-check). */
  resolvedRateWilson: Interval;
  /** pass@k / pass^k at the protocol k's (same k for every arm). */
  passAtK: PassAtKPoint[];
  passHatK: PassAtKPoint[];
  cost: CostAccount;
}

/** Papercusp − baseline on the two headline axes (the system-value delta, D-001). */
export interface ArmDelta {
  suite: BenchSuite;
  treatment: ArmId; // 'papercusp'
  baseline: ArmId;
  /** passAt1(treatment) − passAt1(baseline). Positive = treatment resolves more. */
  accuracyDelta: number;
  /** costPerResolved ratio treatment/baseline (null if a denominator is 0). */
  costRatio: number | null;
  /** treatment cost as a fraction of baseline cost ("at Z% of the cost"). */
  costFraction: number | null;
  /** Is the treatment strictly Pareto-better (≥ accuracy AND ≤ cost, > on one)? */
  paretoDominates: boolean;
}

/** One point on the cost/accuracy frontier (per arm). */
export interface ParetoPoint {
  arm: ArmId;
  accuracy: number;
  /** Mean $ per task-attempt (the cost axis). */
  cost: number;
  costPerResolved: number | null;
  onFrontier: boolean;
}

/** The full per-suite report the Evaluation surface renders. */
export interface SuiteReport {
  runId: string;
  suite: BenchSuite;
  arms: ArmReport[];
  /** Cost/accuracy frontier across arms; `onFrontier` flags the non-dominated set. */
  frontier: ParetoPoint[];
  /** Papercusp vs each baseline on the headline axes. */
  deltas: ArmDelta[];
  /** Iso-budget invariant check across arms (all arms share the same cap?). */
  isoBudget: { ok: boolean; budgetTokens: number | null; violations: string[] };
  /** The k's the pass@k/pass^k protocol used (identical across arms). */
  protocolKs: number[];
}
