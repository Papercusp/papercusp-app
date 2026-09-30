/**
 * external-bench — the SHARED CONTRACT for the impartial benchmark suite
 * (plan `impartial-benchmark-suite-2026-06-15`). One normalized vocabulary every arm
 * (Papercusp full spine / Baseline A ablation / Baseline B native / Baseline C best-of-N)
 * and the official graders build to, so the comparison is fair by construction:
 *
 *   the GENERATION half is arm-specific  → each arm produces an {@link ArmAttempt}/{@link ArmSubmission}
 *   the GRADING half is byte-identical    → every arm hands its submission to the SAME {@link OfficialGrader}
 *
 * Two grader MODALITIES (feasibility spike D-008, dc09a, `external-bench-grader-feasibility-2026-06-15.md`):
 *   M1 offline diff-batch  — SWE-bench Pro etc.: arm → unified diff; grading is a separate, arm-agnostic
 *                            Docker batch over a predictions JSON. PILOT BACKBONE (P-009) — built first.
 *   M2 online in-container — Terminal-Bench/Harbor, Harness-Bench: no diff; agent mutates a benchmark
 *                            sandbox, grading runs in-sandbox. Built second.
 *
 * OWNERSHIP (this file = BRIEF 3 / P-005, su-ec8fe): the normalized types + port aliases live here so the
 * whole wave imports ONE source of truth. Implementations live in their owners' files:
 *   - clone/diff (Port 1)            → ./clone.ts                         (P-005, this brief)
 *   - OfficialGrader + M1 backend    → ./grader/*                         (P-005, this brief)
 *   - runArmGeneration / Papercusp   → ./arm-generation.ts               (P-005, this brief)
 *   - runSingleAgentAttempt (Port 2) → ./single-agent-attempt.ts          (P-006 / BRIEF 4, su-136a4)
 *   - instantiateBenchHarness        → ./run-loop.ts (or a sibling)       (P-019 / BRIEF 2, su-1226c)
 *   - run-result row / scoring       → BRIEF 7/8 (P-011/P-010) consume {@link ArmAttempt}+{@link GradeResult}
 */

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

/** Which benchmark family a task belongs to (open string — new families add a literal). */
export type BenchmarkFamily =
  | 'swe-bench-pro'
  | 'swe-bench-verified'
  | 'terminal-bench'
  | 'harness-bench'
  | 'swe-lancer'
  // Non-coding / generic-professional + decomposable-deliverable suites (plans
  // benchmark-suite-theagentcompany-2026-06-17 / benchmark-suite-paperbench-2026-06-17).
  // Both grade a CONTINUOUS partial-credit score, not a single diff pass/fail — see
  // GradeResult.score + the the-agent-company / paperbench graders.
  | 'the-agent-company'
  | 'paperbench'
  // METR HCAST / time-horizon (plan benchmark-suite-metr-hcast-2026-06-17). M2 in-container, but
  // each task brings its OWN Docker image + its OWN score() (the Task Standard) — we don't author a
  // verifier. Headline is a derived run-level horizon LIFT (single-opus vs hive), not a per-task %.
  | 'metr-hcast'
  // AgentsNet (plan benchmark-suite-agentsnet-2026-06-17). Coordination-native: one opus
  // agent per graph node, neighbor-only message passing, deterministic get_score(). The
  // continuous coordination score in [0,1] rides GradeResult.score; the official BINARY
  // headline = (score === 1). D-002: a model-coordination number (not queen orchestration).
  | 'agentsnet'
  // Broad general-assistant / research suite (plan benchmark-suite-gaia-2026-06-17). GAIA ships no harness:
  // it is Q&A data + a quasi-exact-match string scorer (grader/gaia.ts), graded BINARY per task (resolved),
  // with per-level L1/L2/L3 + overall accuracy. Its submission is a final-answer STRING (not a diff or a
  // mutated container), so it self-grades through the standalone gaia/ pipeline (grader/gaia.ts + gaia/run.ts),
  // not the diff/in-container OfficialGrader registry.
  | 'gaia'
  // SwarmBench (plan benchmark-suite-swarmbench-2026-06-17). Coordination-NATIVE 2D-grid sim: N agents,
  // local k×k view + local messaging, deterministic per-task sim score. The arm = swarm-control TOPOLOGY
  // (decentralized peers vs aggregated-local coordinator); rides makePoolBacklogDriver (one scenario = one
  // perTask), the sim score on attempt.armMeta. D-001: a global-view queen would violate the local-only premise.
  | 'swarmbench'
  // GDPval (OpenAI, arXiv:2510.04374; plan benchmark-suite-gdpval-2026-06-17). Real-world professional
  // DELIVERABLES (docs/slides/spreadsheets/…) across 44 occupations × 9 GDP sectors. Graded by a BLINDED
  // PAIRWISE comparison vs an expert reference deliverable → win/tie/loss → win-or-tie rate (NOT a diff/exact
  // match). The new `deliverable-bundle` modality; the pairwise autograder is grader/gdpval.ts.
  | 'gdpval'
  // FrontierSWE (Proximal Labs; plan benchmark-suite-frontier-swe-2026-06-18). Ultra-long-horizon
  // implementation / perf-eng / ML-research — 17 tasks, 5 trials/task, CONTINUOUS [0,1] score (no model
  // fully solves the implementation tasks). M2 in-container + own-scorer (each task ships its own scorer:
  // a Rust benchmark-runner + *.expected fixtures), driven via Harbor. The headline is mean@5/best@5 +
  // AVG-RANK/dominance across a coordination-topology arm pool (D-002), never a single resolved%;
  // GradeResult.score carries the [0,1] value and resolved = (score === 1) is the degenerate binary.
  | 'frontier-swe'
  | (string & {});

/**
 * One benchmark task, normalized across families. The arm only ever sees the
 * `problemStatement` (the work_item brief) + the repo coordinates; everything the grader needs
 * is carried opaquely in {@link BenchTask.graderMeta} so a new family adds NO new arm-facing fields.
 */
export interface BenchTask {
  benchmark: BenchmarkFamily;
  /** e.g. "instance_astropy__astropy-12345" — the stable per-task id (matches across submission/grade). */
  instanceId: string;
  /** The brief fed to the harness as the work_item. NEVER the gold patch. */
  problemStatement: string;

  // ---- M1 (diff-batch) repo coordinates — present for SWE-bench-family tasks ----
  /** owner/name (M1). */
  repo?: string;
  /** Clone @ this SHA; the diff is taken against it (M1). */
  baseCommit?: string;
  /** Multi-language families (Pro is polyglot): the task's primary language. */
  language?: string;

  /**
   * Difficulty tier for stratified task-sets (e.g. the `stratified-30` set). Carried through so resolved%
   * can be reported per-tier. Derived from empirical per-task solve rate across reference models + a
   * structural difficulty score (see {@link loadBenchTaskSet} / the `stratified-30` loader). Omitted by
   * non-stratified sets.
   */
  tier?: 'easy' | 'medium' | 'hard';

  /**
   * $-payout for value-weighted families (SWE-Lancer, the L3 value-capture layer): a RESOLVED task
   * "captures" this value. The Hive's $-aware placement (P-022) reads it; the value-captured-under-budget
   * metric (P-025) sums it over resolved rows under a fixed budget. Omitted by non-value benchmarks.
   */
  valueUsd?: number;

  /**
   * Opaque grader inputs threaded verbatim to the {@link OfficialGrader} backend — e.g. SWE-bench Pro's
   * `dockerhub_tag`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, test commands; Harbor's image ref.
   * The arm MUST NOT read this (keeps generation grader-agnostic / un-gameable). The grader owns its keys.
   */
  graderMeta: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Generation — what an arm produces                                           */
/* -------------------------------------------------------------------------- */

/**
 * The iso-budget ceiling for ONE generation attempt. BRIEF 7 (P-011) defines the canonical
 * type + the enforcement semantics; this is the minimal structural shape the generation side consumes.
 * Reconcile to BRIEF 7's exported type when it lands (alias or re-export — single source of truth).
 */
export interface GenerationBudget {
  /** Hard cap on total tokens (in+out, across every agent incl. coordination overhead). */
  maxTokens?: number;
  /** Hard cap on total $ for the attempt (coordination overhead counted — D fairness #2). */
  maxUsd?: number;
  /** Wall-clock ceiling for the attempt. */
  maxWallClockMs?: number;
}

/**
 * Why a generation attempt stopped — separates a clean finish from a cap-hit from an infra failure.
 *
 * FAIRNESS (benchmark-fairness-fix): the stop reasons split into two scoring classes, and the split
 * IS the fairness fix. {@link isScoredStopReason} is the single source of truth; do NOT re-derive it.
 *  - SCORED terminals (a genuine capability outcome — counted in the resolved% denominator):
 *      'done'           — the harness reached DONE (resolved=true|false by the grader)
 *      'escalate'       — the harness gave up / needs a human (a genuine non-resolution)
 *      'budget-exhausted' — hit the iso-budget cap (the arm spent its whole budget and didn't solve it)
 *      'max-turns'      — hit the GENUINE turn bound (the arm ran its full turn budget and didn't settle)
 *  - NON-SCORED terminals (an external/transient/infra failure — EXCLUDED, resolved=null, never a fail):
 *      'error'          — infra failure during generation (crash, OOM, diff-extract fail)
 *      'timeout'        — wall-clock ceiling hit under contention (NOT the arm's fault → not a capability
 *                         fail; was wrongly routed to 'max-turns'-as-scored — the central bug this fixes)
 *      'infra-failed'   — an explicit transient/external failure: spawn rc≠0-with-empty-output
 *                         (a 429 / gateway-contention symptom), a RateLimit/RetryError at the spawn
 *                         boundary, or a drain-unsettled-under-contention member (the fleet was paused
 *                         to bound spend before the task got a fair chance to run)
 */
export type GenerationStopReason =
  | 'done' // the harness reached DONE
  | 'escalate' // the harness ESCALATEd (needs human / blocked)
  | 'budget-exhausted' // hit the iso-budget cap
  | 'max-turns' // hit the GENUINE turn bound (scored — the arm ran its full turn budget)
  | 'timeout' // wall-clock ceiling under contention (NON-scored — external, not a capability fail)
  | 'infra-failed' // transient/external failure: 429/contention spawn, drain-unsettled (NON-scored)
  | 'error'; // infra failure during generation (NON-scored)

/**
 * The set of stop reasons that are NON-SCORED — an external/transient/infra failure excluded from the
 * resolved% denominator (treated as resolved=null, never counted as a capability fail). The single
 * source of truth for the fairness exclusion; {@link generationStatusForStopReason} maps these onto the
 * bench-metrics `generationStatus` ('error'|'timeout') so `isScored` drops them, and every live rollup
 * (run-store / preserved-runs / _xbench_report) excludes them via {@link isScoredStopReason}.
 */
export const NON_SCORED_STOP_REASONS: ReadonlySet<GenerationStopReason> = new Set<GenerationStopReason>([
  'error',
  'timeout',
  'infra-failed',
]);

/** True when a stop reason is a GENUINE capability terminal (counted in resolved%); false when it is an
 *  external/transient/infra failure (excluded — resolved=null, never a fail). The fairness predicate. */
export function isScoredStopReason(stopReason: GenerationStopReason | string | null | undefined): boolean {
  if (stopReason == null) return true; // absent reason → don't exclude (a graded row stands on its grade)
  return !NON_SCORED_STOP_REASONS.has(stopReason as GenerationStopReason);
}

/**
 * Bridge a generation `stopReason` → the bench-metrics `GenerationStatus` ('completed'|'error'|'timeout')
 * the canonical scoring layer (`@papercusp/bench-metrics` `isScored` / `aggregateArm`) keys on. A scored
 * terminal → 'completed' (graded normally; the grader's verdict stands); 'timeout' → 'timeout' (infra,
 * excluded); every other non-scored reason ('error'|'infra-failed') → 'error' (infra, excluded). This is
 * the SINGLE place the live external-bench stopReason vocabulary maps onto the bench-metrics status
 * vocabulary, so wiring the live rollups into bench-metrics `isScored` is a derive, not a fork.
 */
export function generationStatusForStopReason(
  stopReason: GenerationStopReason | string | null | undefined,
): 'completed' | 'error' | 'timeout' {
  if (stopReason === 'timeout') return 'timeout';
  if (isScoredStopReason(stopReason)) return 'completed';
  return 'error';
}

/**
 * What ONE generation attempt produces — the SHARED generation unit across arms (Baseline A is exactly
 * one of these; Baseline C is N + a verifier + select; the full Papercusp arm is one with the full spine).
 * `arm` + `blueprintId` make spine-ON vs spine-OFF unambiguous on the row (D-002 causal isolation).
 */
export interface ArmAttempt {
  /** Arm id on the row — 'papercusp' | 'ablation-solo' | 'native' | 'best-of-n' (BRIEF 7/8 own the enum). */
  arm: string;
  /** The blueprint that produced it — 'external-bench' (full spine) | 'coding-solo' (single worker) | … */
  blueprintId: string;
  instanceId: string;
  /** Reproducibility seed; == {@link ArmSubmission.prefix} (one prefix per seed for the ≥3-seed pass@1). */
  seed: string;

  /** Unified diff base..HEAD, grader test-files excluded; "" when the arm produced no change (M1). */
  diff: string;
  /**
   * The agent's final answer STRING — the Q&A-modality output (GAIA: the `FINAL ANSWER` text the arm wrote).
   * Carried alongside `diff` (which is "" for a qa-modality arm) so the same ArmAttempt shape serves both the
   * diff arms (SWE-bench) and the answer arms (GAIA). Absent for diff/in-container arms. See {@link qaSubmission}.
   */
  answer?: string;

  // ---- cost accounting (coordination overhead INCLUDED — fairness #2) ----
  tokensIn: number;
  tokensOut: number;
  /** Anthropic prompt-cache tokens, when the arm reports them — material to $ on Opus (folded into cost). */
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd: number;
  turns: number;
  wallClockMs: number;

  /** BRIEF 8 (P-010) rollout-record handle for this attempt's full trajectory. */
  trajectoryRef: string;

  stopReason: GenerationStopReason;
  /** Infra failure during GENERATION — distinct from "not resolved" AND from the grader's graderError. */
  generationError?: string;

  /**
   * Arm-specific extra metadata MERGED into the run-result row's `arm_meta` (the canonical `blueprintId` +
   * `stopReason` always win over it). e.g. native-harness: toolCalls / costSource / retriesUsed / model;
   * best-of-N: { n, candidates, verifierTokens }. Keeps the row self-describing without forking the schema.
   */
  armMeta?: Record<string, unknown>;
}

/**
 * What an arm hands to the grader. M1 → a unified diff (+ its seed as `prefix`); M2 → a mutated env handle.
 * BRIEF 5 (native) and BRIEF 6 (best-of-N) emit the SAME `{modality:'diff', …}` record as Papercusp so all
 * arms hit identical grading machinery — the fairness invariant (D-004/D-005).
 */
export type ArmSubmission =
  | {
      modality: 'diff'; // M1 (SWE-bench Pro etc.)
      instanceId: string;
      /** The unified diff to apply + grade. */
      patch: string;
      /** Seed/sample discriminator → the predictions-JSON `prefix` field. == {@link ArmAttempt.seed}. */
      prefix: string;
    }
  | {
      modality: 'in-container'; // M2 (Terminal-Bench/Harbor) — env left mutated for in-sandbox grading
      instanceId: string;
      envRef: string;
      prefix: string;
    }
  | {
      modality: 'qa'; // M3 (GAIA) — a single FINAL ANSWER string, quasi-exact-match graded (no diff, no env)
      instanceId: string;
      /** The agent's final answer text the grader scores against the gold answer. */
      answer: string;
      prefix: string;
    }
  | {
      modality: 'deliverable-bundle'; // M4 (GDPval) — a professional deliverable bundle reduced to text,
      // graded by a BLINDED PAIRWISE comparison vs the expert reference deliverable (win/tie/loss).
      instanceId: string;
      /** The arm's deliverable, reduced to text/markdown for the pairwise judge. */
      deliverable: string;
      prefix: string;
    };

/** Build the M1 predictions record for an attempt (the shape `swe_bench_pro_eval.py` ingests). */
export function diffSubmission(attempt: ArmAttempt): ArmSubmission {
  return { modality: 'diff', instanceId: attempt.instanceId, patch: attempt.diff, prefix: attempt.seed };
}

/** Build the M3 (qa) submission for an attempt — the GAIA arm hands its FINAL ANSWER string to the grader. */
export function qaSubmission(attempt: ArmAttempt): ArmSubmission {
  return { modality: 'qa', instanceId: attempt.instanceId, answer: attempt.answer ?? '', prefix: attempt.seed };
}

/** Build the M4 (deliverable-bundle) submission — the GDPval arm hands its deliverable text to the pairwise judge. */
export function deliverableSubmission(attempt: ArmAttempt): ArmSubmission {
  return { modality: 'deliverable-bundle', instanceId: attempt.instanceId, deliverable: attempt.answer ?? '', prefix: attempt.seed };
}

/* -------------------------------------------------------------------------- */
/* Grading — the official, arm-agnostic half                                   */
/* -------------------------------------------------------------------------- */

/** Per-test outcome for the SWE-bench FAIL_TO_PASS / PASS_TO_PASS split (M1 only). */
export interface TestOutcome {
  test: string;
  passed: boolean;
}

/**
 * Normalized grader output → the grader-emitted slice of the run-result row (feasibility doc §5).
 * `rawGraderOutput` is stored VERBATIM (Rollout-Cards reproducibility); `graderError` (an infra failure
 * such as an image-pull fail or timeout) is DISTINCT from `resolved:false` and is excluded from accuracy.
 */
export interface GradeResult {
  instanceId: string;
  /** Seed/sample this graded — matches {@link ArmSubmission} `prefix` (one grade per (instance, seed)). */
  prefix: string;
  /** The headline pass/fail. M1: all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass; M2: verifier pass.
   *  For partial-credit suites (the-agent-company / paperbench) this is the all-or-nothing roll-up
   *  (every checkpoint passed / score === 1) — the meaningful headline there is {@link GradeResult.score}. */
  resolved: boolean;
  /**
   * Partial-credit / continuous score in [0,1] for rubric/checkpoint suites — TheAgentCompany
   * (S = 0.5·Σresult/Σtotal + 0.5·all-pass) and PaperBench (Replication Score). Absent/null for the
   * boolean-resolved SWE-bench family (where `resolved` is the score). Mirrors bench-metrics
   * `TaskRunResult.score`; the suite headline is the mean of this over scored rows.
   */
  score?: number | null;
  /** Per-test (M1 / SWE-bench semantics); undefined for M2 (all-or-nothing). */
  failToPass?: TestOutcome[];
  passToPass?: TestOutcome[];
  /** The benchmark's own report JSON, stored verbatim. */
  rawGraderOutput: unknown;
  /** Family + exact version pinned for pre-registration (P-010): image tag / harbor ver / clawbench commit. */
  graderFamily: string;
  graderVersion: string;
  /** Infra failure (NOT "not resolved"): image pull fail, grader timeout, apply error. Surfaced, not scored. */
  graderError?: string;
}

/**
 * The grader-interface BRIEF 3 implements two backends for (M1 diff-batch first, M2 in-container second).
 * `grade` is PURE w.r.t. the arm — it cannot tell which arm produced a submission, which is what makes the
 * comparison fair. The same instance + graderVersion grades every arm for a given (task, seed).
 */
export interface OfficialGrader {
  family: BenchmarkFamily;
  modality: 'diff' | 'in-container' | 'qa' | 'deliverable-bundle';
  /** Grade a batch. `tasks` carries each instance's {@link BenchTask.graderMeta}; matched by instanceId. */
  grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]>;
}

/* -------------------------------------------------------------------------- */
/* Port aliases — the seams arms inject (hive-eval live-ports pattern)         */
/* -------------------------------------------------------------------------- */

/** A clean checkout of a task repo @ its base commit. `cleanup` removes the scratch dir. */
export interface TaskCheckout {
  /** Absolute path to the clean worktree the arm edits. */
  dir: string;
  repo: string;
  baseCommit: string;
  cleanup(): Promise<void>;
}

export interface CloneOpts {
  /** Scratch root to clone under (default: an OS temp dir). */
  workRoot?: string;
}

/** Port 1a (P-005): clone a task repo @ base commit into a clean scratch worktree. */
export type CloneTaskRepo = (task: BenchTask, opts?: CloneOpts) => Promise<TaskCheckout>;

/**
 * Port 1b (P-005): extract the final unified diff from a checkout the arm has edited — `git diff` against
 * the base commit, EXCLUDING any test files the grader supplies (so the arm can't slip the hidden tests in).
 */
export type ExtractDiff = (checkout: TaskCheckout, task: BenchTask) => Promise<string>;

/** Telemetry a harness run reports back — the cost/stop accounting that flows into {@link ArmAttempt}. */
export interface GenerationTelemetry {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  wallClockMs: number;
  trajectoryRef: string;
  stopReason: GenerationStopReason;
  generationError?: string;
}

/** What instantiating + running a throwaway bench harness to DONE yields. */
export interface BenchHarnessRun {
  /** The worktree the harness edited (diff is taken from here). Usually === checkout.dir. */
  worktreePath: string;
  telemetry: GenerationTelemetry;
}

/**
 * Port (P-019 / BRIEF 2 carries the impl): spin a throwaway harness of `blueprintId` over the
 * checkout, feed `task.problemStatement` as the work_item, run to DONE under `budget`, return telemetry.
 * The FULL Papercusp arm passes 'external-bench' (full spine); Baseline A passes 'coding-solo' (one worker).
 * Everything else (clone, infra, cap, diff-extract, grader) is byte-identical → the only delta is the spine.
 */
export type InstantiateBenchHarness = (
  blueprintId: string,
  task: BenchTask,
  checkout: TaskCheckout,
  budget: GenerationBudget,
) => Promise<BenchHarnessRun>;

/** The injected port set a generation attempt needs (fakes in tests; live fns in production). */
export interface GenerationPorts {
  clone: CloneTaskRepo;
  extractDiff: ExtractDiff;
  instantiate: InstantiateBenchHarness;
}
