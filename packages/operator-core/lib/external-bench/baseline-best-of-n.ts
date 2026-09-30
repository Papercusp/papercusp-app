/**
 * Baseline C — best-of-N + test-verifier runner (impartial-benchmark-suite-2026-06-15, BRIEF 6 / P-008).
 *
 * The "is the orchestration worth its tokens?" control arm. At the SAME iso-budget the Papercusp
 * arm gets, run a SINGLE agent (one worker, no spine — the identical `coding-solo` primitive
 * Baseline A uses) `N` independent times, then a TEST-VERIFIER picks the most promising candidate;
 * the SELECTED diff is graded by the same arm-agnostic official grader as every other arm. If
 * Papercusp doesn't beat best-of-N at matched budget, the coordination isn't earning its extra
 * tokens (plan D-002 / "Large Language Monkeys" + a test-verifier).
 *
 * Baseline C IS literally "Baseline A sampled N times + a cheap verifier + select" — same model,
 * same tools, same infra, same total token budget. The ONLY difference vs Papercusp is HOW the
 * budget is spent: N independent samples + a verifier vs one coordinated multi-agent run.
 *
 * ── Fairness invariants encoded here (read before changing) ──────────────────────────────────
 *  1. ISO-BUDGET: `tokens_total` = SUM over ALL N candidate attempts + the verifier. That summed
 *     number is what the iso-budget cap and the $-accounting see — never a per-candidate number.
 *     A multi-agent arm "winning" must not secretly mean "spent N×"; best-of-N spends the same N×.
 *  2. THE VERIFIER USES VISIBLE SIGNAL ONLY. The test-verifier scores a candidate from information
 *     the arm could legitimately produce itself — the repo's pre-existing tests at `base_commit`
 *     (a regression gate) + an agent-authored reproduction test derived from the problem statement.
 *     It must NEVER see the hidden grader inputs (`FAIL_TO_PASS` / `test_patch` / the OfficialGrader):
 *     selecting on the exact held-out criterion would leak the metric and make the comparison a lie.
 *     This is enforced structurally — `verify()` receives only the task + candidate, `grade()` is a
 *     separate port; the verifier never receives `graderMeta`'s hidden tests.
 *  3. GRADING IS UNCAPPED + ARM-AGNOSTIC. The iso-budget governs GENERATION + the verifier only;
 *     the official grader (BRIEF 3 §1, dc09a feasibility D-008) runs identically for every arm.
 *
 * ── Architecture (hive-eval live-ports pattern) ──────────────────────────────────────────────
 * Pure orchestration over an injected {@link BestOfNPorts} seam, so the whole
 * sample→verify→select→grade→emit flow is unit-tested with deterministic fakes
 * ({@link makeFakeBestOfNPorts}) before any live LLM/grader/PG binding lands. The ports each bind
 * to a sibling brief's deliverable:
 *   - `sample` → P-006 `runSingleAgentAttempt` (BRIEF 4)  — the shared single-agent unit
 *   - `verify` → THIS brief's live test-verifier            — visible-tests-only (mine)
 *   - `grade`  → P-005 `OfficialGrader.grade` (BRIEF 3)    — arm-agnostic official grader
 *   - `emit`   → P-010 `emitRollout` (BRIEF 8)             — the ONE row+rollout emit entry point
 *
 * The runner BUILDS the locked `emitRollout` input (the `generation` + `grading` blocks) and calls
 * `emit` once — `emitRollout` derives `cost_usd` via P-011's `priceRun`, writes both the run_result
 * row + the rollout card in one tx, and UPSERTs idempotently on (run_id,suite,task_id,arm,seed).
 *
 * NOTE: the shared types (`BenchTask` from BRIEF 3, `SingleAgentAttempt` from BRIEF 4,
 * `EmitRolloutInput`/`emitRollout` from BRIEF 8's `external-bench/reproducibility/`) are MIRRORED
 * locally below while those modules land — the runner depends only on the port seam + these shapes,
 * so the swap to the canonical imports is a header-only edit (tracked via the schema-lock event).
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Canonical shared types — imported from the wave's single sources of truth (all landed):
//   - BenchTask / GradeResult                → ./types                  (BRIEF 3 / P-005)
//   - SingleAgentAttempt (= ArmAttempt)      → ./single-agent-attempt   (BRIEF 4 / P-006)
//   - EmitRolloutInput                       → ./reproducibility/schema (BRIEF 8 / P-010)
//   - budgetExceeded / ArmId / BenchSuite …  → @papercusp/bench-metrics (BRIEF 7 / P-011)
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { budgetExceeded, type ArmId, type BenchSuite, type GraderModality, type IsoBudgetCap } from '@papercusp/bench-metrics';
import type { BenchTask, GradeResult } from './types';
import type { SingleAgentAttempt } from './single-agent-attempt';
import type { EmitRolloutInput } from './reproducibility/schema';

export type { BenchTask, GradeResult, SingleAgentAttempt, EmitRolloutInput };

/** What P-010's `emitRollout` returns. */
export interface EmitRolloutResult {
  rolloutId: string;
  runId: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The test-verifier — Baseline C's arm-specific piece (nobody else builds it).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The result of running the VISIBLE-ONLY test-verifier on ONE candidate (invariant #2). The signals
 * are derived from the repo's pre-existing tests + an agent-authored reproduction test — never the
 * held-out grader. `score` is the selection signal in [0,1] (higher = more promising candidate).
 * Verifier cost is counted in the arm's summed tokens (≈0 for a pure test-exec verifier; nonzero
 * when the verifier authors a repro test with the model).
 */
export interface VerifierResult {
  /** Did the candidate diff apply cleanly to a fresh base checkout? (The grader has its own apply
   *  fallbacks, so a verifier-apply failure does not hard-exclude a candidate from SUBMISSION —
   *  only from being scored as a verified candidate.) */
  applied: boolean;
  /** The agent-authored reproduction test (derived from the problem statement) passed. */
  reproPassed: boolean;
  /** The repo's pre-existing visible suite at base_commit still passes (no regressions). */
  regressionsPassed: boolean;
  visiblePassed: number;
  visibleTotal: number;
  score: number;
  rawOutput: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  /** Verifier infra failure (e.g. the visible test harness crashed). */
  generationError?: string;
}

/**
 * The default verifier scoring policy — a reference the live verifier + tests share so "best" means
 * the same thing everywhere. Pure function of the visible signals. Repro-pass dominates (it is the
 * strongest visible evidence the bug is fixed); regression-pass and visible-fraction break ties.
 * Range [0,1]. A non-applying candidate scores 0 (it could not be evaluated).
 */
export function defaultVerifierScore(
  s: Pick<VerifierResult, 'applied' | 'reproPassed' | 'regressionsPassed' | 'visiblePassed' | 'visibleTotal'>,
): number {
  if (!s.applied) return 0;
  const frac = s.visibleTotal > 0 ? s.visiblePassed / s.visibleTotal : 0;
  // 0.6 repro · 0.25 no-regressions · 0.15 visible-fraction — repro is the decisive visible signal.
  return 0.6 * (s.reproPassed ? 1 : 0) + 0.25 * (s.regressionsPassed ? 1 : 0) + 0.15 * frac;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// arm_meta — Baseline C's arm-specific slice of the locked schema (jsonb).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BestOfNCandidateMeta {
  /** The inner sample seed (`<outerSeed>-c<i>`) — distinct per candidate; recorded for repro. */
  seed: string;
  tokens_in: number;
  tokens_out: number;
  turns: number;
  stop_reason: SingleAgentAttempt['stopReason'];
  generation_error: string | null;
  applied: boolean;
  verifier_score: number;
  /** Passed the verifier's decisive visible signal (the reproduction test). */
  verifier_pass: boolean;
  selected: boolean;
}

export interface BestOfNArmMeta {
  /** Requested number of independent samples. */
  n: number;
  /** Samples actually run (== n unless the iso-budget was exhausted early). */
  samples_run: number;
  /** Index into `candidates` of the submitted candidate, or -1 if none (whole-arm generation fail). */
  selected_candidate: number;
  selection_reason: 'verified-best' | 'fallback:unverified-diff' | 'none:all-samples-failed';
  /** The blueprint the SAMPLES ran under — `coding-solo` (spine OFF), same primitive as Baseline A. */
  blueprint_id: string;
  verifier: { kind: string; visible_only: true; tokens_in: number; tokens_out: number; turns: number };
  /** Fraction of budget reserved for a model-driven verifier (0 for a pure test-exec verifier). */
  verifier_reserve_frac: number;
  /** The per-candidate generation token cap (= floor(generationBudget / n)). */
  per_candidate_budget_tokens: number;
  candidates: BestOfNCandidateMeta[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The injectable port seam + run config.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BestOfNPorts {
  /** ONE single-agent, no-spine attempt at `seed` within a `budgetTokens` cap (P-006). */
  sample(input: { task: BenchTask; seed: string; budgetTokens: number }): Promise<SingleAgentAttempt>;
  /** The visible-tests-only test-verifier over one candidate (invariant #2 — never the grader). */
  verify(input: { task: BenchTask; attempt: SingleAgentAttempt }): Promise<VerifierResult>;
  /** The official arm-agnostic grader on the SELECTED diff; `prefix` = the seed (P-005 / P-001 §2).
   *  The live binding wraps P-005's batch `OfficialGrader.grade([diffSubmission], [task]) → [GradeResult]`. */
  grade(input: { task: BenchTask; patch: string; prefix: string }): Promise<GradeResult>;
  /** The ONE emit entry point — writes run_result + rollout, derives cost_usd via priceRun (P-010). */
  emit(input: EmitRolloutInput): Promise<EmitRolloutResult>;
  now(): number;
}

export interface BestOfNConfig {
  // Identity / provenance (from the pre-registered run config — P-010).
  runId: string;
  preregHash: string;
  suite: BenchSuite;
  modelId: string;
  harnessVersion: string;
  modality?: GraderModality;
  blueprintId?: string;

  // Task + the attempt.
  task: BenchTask;
  /** The OUTER independent-attempt ordinal → the submission prefix. The caller (pilot/battery) loops
   *  this ≥3 times per (task, arm) for the pass@1 + CI protocol; each call here yields one row. */
  seed: number;
  /** Number of independent samples. Default {@link DEFAULT_BEST_OF_N}. */
  n?: number;
  /** The matched iso-budget cap (tokens) for this (task, arm) — held equal to the Papercusp arm.
   *  Stored on the row as `budget_tokens`; the cap is enforced with the SHARED `budgetExceeded`. */
  budgetTokens: number;
  /** Optional matched $ cap (the shared cap is `{tokens, usd}`); omit for a tokens-only cap. */
  budgetUsd?: number;
  /** Fraction of budget reserved for a model-driven verifier (authoring repro tests). 0 for a pure
   *  test-exec verifier (default), so all of `budgetTokens` funds generation. */
  verifierReserveFrac?: number;
  /** Verifier kind label for arm_meta (e.g. 'repro+regression'). */
  verifierKind?: string;
}

export const DEFAULT_BEST_OF_N = 5;
export const BASELINE_C_ARM_ID: ArmId = 'baseline-c-bestofn';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The orchestration.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  attempt: SingleAgentAttempt;
  verify?: VerifierResult;
}

export interface BestOfNRunOutput {
  /** The exact input handed to `emit` — the runner's testable product (the run_result + rollout). */
  emitted: EmitRolloutInput;
  /** The TYPED arm_meta (same object that rides `emitted.generation.armMeta` as opaque jsonb). */
  armMeta: BestOfNArmMeta;
  /** What `emit` returned (the persisted ids). */
  rolloutId: string;
  runId: string;
}

/**
 * Run ONE best-of-N attempt for one (task, seed): sample N times under the per-candidate cap,
 * verify each usable candidate with the visible-tests-only verifier, select the most promising,
 * grade the selected diff with the official grader, account every token (samples + verifier) into
 * the summed iso-budget number, and emit the run_result row + rollout via {@link BestOfNPorts.emit}.
 *
 * Pure orchestration: all IO is the injected `ports`. Never throws on a RUN outcome — a generation
 * failure / grader error is RECORDED on the row (METR infra discipline), not raised; only a
 * programming error in the orchestration itself would throw.
 */
export async function runBestOfNOnce(config: BestOfNConfig, ports: BestOfNPorts): Promise<BestOfNRunOutput> {
  const n = Math.max(1, config.n ?? DEFAULT_BEST_OF_N);
  const reserve = clamp01(config.verifierReserveFrac ?? 0);
  const generationBudget = Math.floor(config.budgetTokens * (1 - reserve));
  const perCandidateBudget = Math.max(1, Math.floor(generationBudget / n));

  // The SHARED iso-budget cap — every arm caps generation with this exact check, so "iso-budget"
  // is real and not per-arm-rolled (P-011 fairness invariant). The per-candidate split below is
  // arm-specific; the ARM TOTAL is what `budgetExceeded` governs.
  const cap: IsoBudgetCap = {
    tokens: config.budgetTokens,
    ...(config.budgetUsd != null ? { usd: config.budgetUsd } : {}),
  };

  const startedAtMs = ports.now();
  const candidates: Candidate[] = [];
  let usedTokens = 0; // generation + verifier, summed — the iso-budget number (invariant #1)
  let usedCostUsd = 0;
  let samplesRun = 0;

  for (let i = 0; i < n; i++) {
    // Stop launching samples once the arm's shared iso-budget is spent (the per-candidate cap
    // bounds any single-sample overshoot to one slice). Identical check to every other arm.
    if (budgetExceeded({ tokensTotal: usedTokens, costUsd: usedCostUsd }, cap)) break;

    const innerSeed = `${config.seed}-c${i}`;
    const attempt = await ports.sample({ task: config.task, seed: innerSeed, budgetTokens: perCandidateBudget });
    samplesRun++;
    usedTokens += attempt.tokensIn + attempt.tokensOut;
    usedCostUsd += attempt.costUsd;

    // Verify only a usable candidate (produced a non-empty diff, no generation error). A pure
    // test-exec verifier spends ~0 model tokens; a model-driven one is funded by the reserve.
    let verify: VerifierResult | undefined;
    if (!attempt.generationError && attempt.diff.trim() !== '') {
      verify = await ports.verify({ task: config.task, attempt });
      usedTokens += verify.tokensIn + verify.tokensOut;
      usedCostUsd += verify.costUsd;
    }
    candidates.push({ attempt, verify });
  }

  const selection = selectCandidate(candidates);
  const wholeArmFailed = selection.index < 0;
  const selected = wholeArmFailed ? undefined : candidates[selection.index];

  // Grade the selected diff (uncapped, arm-agnostic). No submission ⇒ skip grading (generation fail).
  let grade: GradeResult | undefined;
  if (selected) {
    grade = await ports.grade({ task: config.task, patch: selected.attempt.diff, prefix: String(config.seed) });
  }

  const wallClockMs = Math.max(0, ports.now() - startedAtMs);

  // ── Token accounting (summed across all samples + verifiers; invariant #1) ──
  const tokensIn = sum(candidates, (c) => c.attempt.tokensIn) + sum(candidates, (c) => c.verify?.tokensIn ?? 0);
  const tokensOut = sum(candidates, (c) => c.attempt.tokensOut) + sum(candidates, (c) => c.verify?.tokensOut ?? 0);
  const turns = sum(candidates, (c) => c.attempt.turns) + sum(candidates, (c) => c.verify?.turns ?? 0);
  // The shared generation unit (ArmAttempt) carries no cache-token breakdown yet, so the row's
  // (nullable) cache columns are null for this arm. If ArmAttempt+telemetry add cache tokens, sum
  // them here — priceRun already prices cache read/write separately (P-011 price-table-v1).

  // ── capped: did this run bump the iso-budget ceiling anywhere? (P-011 honest-reporting signal) ──
  // A capped run that still produced a diff is graded normally — capped ≠ infra fail.
  const capped =
    budgetExceeded({ tokensTotal: usedTokens, costUsd: usedCostUsd }, cap) ||
    samplesRun < n ||
    candidates.some((c) => c.attempt.stopReason === 'budget-exhausted');

  const generationErrors = candidates
    .filter((c) => c.attempt.generationError)
    .map((c) => c.attempt.generationError!);

  const armMeta = buildArmMeta(config, n, samplesRun, perCandidateBudget, reserve, candidates, selection);

  const emitted: EmitRolloutInput = {
    runId: config.runId,
    preregHash: config.preregHash,
    suite: config.suite,
    taskId: config.task.instanceId,
    arm: BASELINE_C_ARM_ID,
    seed: config.seed,
    modality: config.modality ?? 'diff',
    generation: {
      // A whole-arm generation failure (all N samples errored) ⇒ no submission ⇒ infra, excluded
      // from accuracy (scoreable iff generationStatus='completed'); a partial (some samples errored
      // but ≥1 usable) still produced a valid submission ⇒ 'completed'.
      status: wholeArmFailed ? 'error' : 'completed',
      error: wholeArmFailed
        ? `all ${samplesRun} samples failed: ${generationErrors.join('; ')}`
        : generationErrors.length > 0
          ? `partial: ${generationErrors.length}/${samplesRun} samples errored: ${generationErrors.join('; ')}`
          : null,
      tokensIn,
      tokensOut,
      tokensTotal: tokensIn + tokensOut,
      // The shared generation unit (ArmAttempt) carries no cache-token breakdown, so the row's
      // (nullable) cache columns are null for this arm (see note above).
      tokensCacheRead: null,
      tokensCacheWrite: null,
      wallClockMs,
      turns,
      budgetTokens: config.budgetTokens,
      capped,
      modelId: config.modelId,
      harnessVersion: config.harnessVersion,
      // arm_meta is opaque jsonb on the row; we keep the typed object on the runner's output.
      armMeta: armMeta as unknown as Record<string, unknown>,
      submission: selected ? selected.attempt.diff : null,
      trajectoryRef: selected ? selected.attempt.trajectoryRef : null,
      trajectoryKind: selected ? 'best-of-n-selected' : null,
    },
    grading: buildGrading(grade, wholeArmFailed),
  };

  const res = await ports.emit(emitted);
  return { emitted, armMeta, rolloutId: res.rolloutId, runId: res.runId };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Selection — verified-best, with a METR best-effort fallback ("elicit each baseline's best").
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Selection {
  index: number;
  reason: BestOfNArmMeta['selection_reason'];
}

/**
 * Pick the candidate to SUBMIT. Prefer a verified candidate (applied cleanly + scored) by highest
 * verifier score; tie-break by fewer tokens (cheaper), then earliest sample. If none verified,
 * fall back to the cheapest non-empty diff (the grader has its own apply fallbacks, so an unverified
 * diff may still resolve — never WITHHOLD a submission we have; METR anti-strawman). Only if every
 * sample errored or produced no diff is there nothing to submit.
 */
function selectCandidate(candidates: Candidate[]): Selection {
  const verified = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.verify && c.verify.applied && !c.attempt.generationError && c.attempt.diff.trim() !== '');

  if (verified.length > 0) {
    verified.sort((a, b) => {
      const ds = b.c.verify!.score - a.c.verify!.score;
      if (ds !== 0) return ds;
      const dt = attemptTokens(a.c.attempt) - attemptTokens(b.c.attempt);
      if (dt !== 0) return dt;
      return a.index - b.index;
    });
    return { index: verified[0].index, reason: 'verified-best' };
  }

  const withDiff = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => !c.attempt.generationError && c.attempt.diff.trim() !== '');
  if (withDiff.length > 0) {
    withDiff.sort((a, b) => attemptTokens(a.c.attempt) - attemptTokens(b.c.attempt) || a.index - b.index);
    return { index: withDiff[0].index, reason: 'fallback:unverified-diff' };
  }

  return { index: -1, reason: 'none:all-samples-failed' };
}

function buildArmMeta(
  config: BestOfNConfig,
  n: number,
  samplesRun: number,
  perCandidateBudget: number,
  reserve: number,
  candidates: Candidate[],
  selection: Selection,
): BestOfNArmMeta {
  return {
    n,
    samples_run: samplesRun,
    selected_candidate: selection.index,
    selection_reason: selection.reason,
    blueprint_id: config.blueprintId ?? 'coding-solo',
    verifier: {
      kind: config.verifierKind ?? 'repro+regression',
      visible_only: true,
      tokens_in: sum(candidates, (c) => c.verify?.tokensIn ?? 0),
      tokens_out: sum(candidates, (c) => c.verify?.tokensOut ?? 0),
      turns: sum(candidates, (c) => c.verify?.turns ?? 0),
    },
    verifier_reserve_frac: reserve,
    per_candidate_budget_tokens: perCandidateBudget,
    candidates: candidates.map((c, index) => ({
      seed: c.attempt.seed,
      tokens_in: c.attempt.tokensIn,
      tokens_out: c.attempt.tokensOut,
      turns: c.attempt.turns,
      stop_reason: c.attempt.stopReason,
      generation_error: c.attempt.generationError ?? null,
      applied: c.verify?.applied ?? false,
      verifier_score: c.verify?.score ?? 0,
      verifier_pass: c.verify?.reproPassed ?? false,
      selected: index === selection.index,
    })),
  };
}

/** Build the `grading` block from the official grader's outcome (or an infra `error` block when
 *  there was no submission to grade — generationStatus already carries the real reason; GraderStatus
 *  has no 'skipped', and P-010's emitFromAttempt uses 'error' for the no-grade case too). A grader
 *  infra error → resolved:null + status error/timeout (excluded from accuracy); a genuine outcome →
 *  passed/failed with the per-test breakdown + the verbatim report. */
function buildGrading(grade: GradeResult | undefined, wholeArmFailed: boolean): EmitRolloutInput['grading'] {
  if (wholeArmFailed || !grade) {
    return { resolved: null, status: 'error', family: '', version: '', error: 'generation failed: no submission to grade' };
  }
  if (grade.graderError) {
    return {
      resolved: null,
      status: /timeout/i.test(grade.graderError) ? 'timeout' : 'error',
      family: grade.graderFamily,
      version: grade.graderVersion,
      error: grade.graderError,
      rawOutput: stringifyGraderOutput(grade.rawGraderOutput),
    };
  }
  return {
    resolved: grade.resolved,
    status: grade.resolved ? 'passed' : 'failed',
    family: grade.graderFamily,
    version: grade.graderVersion,
    failToPass: grade.failToPass ?? null,
    passToPass: grade.passToPass ?? null,
    structuredOutput: grade.rawGraderOutput,
    rawOutput: stringifyGraderOutput(grade.rawGraderOutput),
  };
}

/** The verbatim grader output is stored as text — stringify a non-string report (matches P-010). */
function stringifyGraderOutput(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small pure helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function attemptTokens(a: SingleAgentAttempt): number {
  return a.tokensIn + a.tokensOut;
}
function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((acc, x) => acc + f(x), 0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic fake ports — for unit tests of the orchestration (no LLM / git / grader / PG).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Per-sample script for the fake. `i` is the 0-based sample index. */
export interface FakeSampleScript {
  diff?: string;
  tokensIn?: number;
  tokensOut?: number;
  turns?: number;
  stopReason?: SingleAgentAttempt['stopReason'];
  generationError?: string;
  /** The verifier signals for THIS candidate (omit ⇒ a clean apply, repro+regression pass). */
  verify?: Partial<VerifierResult>;
}

export interface FakeBestOfNScript {
  samples: (i: number) => FakeSampleScript;
  /** Resolved-by-grader predicate over the submitted patch (default: any non-empty patch resolves). */
  resolves?: (patch: string) => boolean;
  graderError?: string;
  /** ms the virtual clock advances per `sample`/`verify`/`grade` op (deterministic wall-clock). */
  advanceMs?: number;
}

export interface FakeBestOfNPorts {
  ports: BestOfNPorts;
  /** Inner seeds the runner asked `sample` for, in order — assert N + ordering. */
  sampledSeeds: string[];
  /** The patch(es) handed to `grade`, in order — assert exactly the selected diff is graded. */
  gradedPatches: string[];
  /** The inputs handed to `emit`, in order. */
  emitted: EmitRolloutInput[];
}

/**
 * Build deterministic fake ports driving the orchestration without IO. A virtual clock advances
 * only inside ops (so `wall_clock_ms` is exactly `advanceMs × op-count`). Tracks the inner seeds
 * sampled, the patches graded, and the emit inputs so tests can assert the N-sampling, the
 * verifier-driven selection, and that ONLY the selected diff is submitted to the grader.
 */
export function makeFakeBestOfNPorts(script: FakeBestOfNScript): FakeBestOfNPorts {
  const advanceMs = script.advanceMs ?? 1000;
  const resolves = script.resolves ?? ((patch: string) => patch.trim() !== '');
  let clock = 0;
  let emitSeq = 0;
  const sampledSeeds: string[] = [];
  const gradedPatches: string[] = [];
  const emitted: EmitRolloutInput[] = [];

  const ports: BestOfNPorts = {
    now: () => clock,
    async sample({ task, seed }) {
      clock += advanceMs;
      sampledSeeds.push(seed);
      const i = sampledSeeds.length - 1;
      const s = script.samples(i);
      return {
        arm: 'baseline-a-ablation', // the sample's own arm; the runner re-stamps to baseline-c at emit
        blueprintId: 'coding-solo',
        instanceId: task.instanceId,
        seed,
        diff: s.diff ?? `diff-${i}`,
        tokensIn: s.tokensIn ?? 100,
        tokensOut: s.tokensOut ?? 100,
        costUsd: 0, // derived at emit via priceRun — attempts don't self-report authoritative $
        turns: s.turns ?? 3,
        wallClockMs: advanceMs,
        trajectoryRef: `traj://${seed}`,
        stopReason: s.stopReason ?? 'done',
        ...(s.generationError ? { generationError: s.generationError } : {}),
      };
    },
    async verify({ attempt }) {
      clock += advanceMs;
      // The script indexes verify by the candidate's inner seed suffix (…-c<i>).
      const i = Number(attempt.seed.split('-c').pop() ?? 0);
      const v = script.samples(i).verify ?? {};
      const applied = v.applied ?? true;
      const reproPassed = v.reproPassed ?? true;
      const regressionsPassed = v.regressionsPassed ?? true;
      const visiblePassed = v.visiblePassed ?? (reproPassed ? 2 : 1);
      const visibleTotal = v.visibleTotal ?? 2;
      const score =
        v.score ?? defaultVerifierScore({ applied, reproPassed, regressionsPassed, visiblePassed, visibleTotal });
      return {
        applied,
        reproPassed,
        regressionsPassed,
        visiblePassed,
        visibleTotal,
        score,
        rawOutput: v.rawOutput ?? `verify-${attempt.seed}`,
        tokensIn: v.tokensIn ?? 0,
        tokensOut: v.tokensOut ?? 0,
        costUsd: 0,
        turns: v.turns ?? 0,
        generationError: v.generationError,
      };
    },
    async grade({ task, patch, prefix }) {
      clock += advanceMs;
      gradedPatches.push(patch);
      if (script.graderError) {
        return {
          instanceId: task.instanceId,
          prefix,
          resolved: false,
          rawGraderOutput: null,
          graderFamily: 'fake',
          graderVersion: 'fake-1',
          graderError: script.graderError,
        };
      }
      const resolved = resolves(patch);
      return {
        instanceId: task.instanceId,
        prefix,
        resolved,
        failToPass: [{ test: 'test_repro', passed: resolved }],
        passToPass: [{ test: 'test_existing', passed: true }],
        rawGraderOutput: { resolved, patch },
        graderFamily: 'swe-bench-pro',
        graderVersion: 'fake-1',
      };
    },
    async emit(input) {
      emitted.push(input);
      emitSeq += 1;
      return { rolloutId: `rollout-${emitSeq}`, runId: input.runId };
    },
  };

  return { ports, sampledSeeds, gradedPatches, emitted };
}
