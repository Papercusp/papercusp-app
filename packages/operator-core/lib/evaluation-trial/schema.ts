/**
 * The canonical `EvaluationTrial` / `EvidenceEnvelope` contract (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-004).
 *
 * ## What this is, and what it deliberately is NOT
 *
 * P-001's capability map (WI-41656) surveyed every validation/eval writer,
 * reader and datastore in the tree and returned an explicit verdict for this
 * item: **EXTEND, not parallel** — the binding mechanism already exists in-tree
 * (`shardInputsHash`'s content-addressed `(shardId, inputsHash)` pair) and the
 * ingredients are already recorded (`llm_test_runs` already stores
 * `scenario_hash` + `identity_hash`), so a canonical trial contract needs **no
 * new table and no new columns**.
 *
 * This module is therefore a *projection* layer, exactly as D-003 requires
 * ("compact views, vendor formats, and reports are projections, not competing
 * authorities"). The authoritative rows stay where they are:
 *
 *   - external-bench: `TaskRunResult` (@papercusp/bench-metrics) + `RolloutRecord`
 *     (`lib/external-bench/reproducibility/schema.ts`)
 *   - pot-eval:      `HiveEvalRunRow` + `HiveEvalScoreRow` (`lib/pot-eval/store.ts`)
 *   - llm-testing:   `harness_shared.llm_test_runs` (`lib/llm-testing/storage.ts`)
 *
 * Each family projects INTO this shape (see `adapters.ts`). Nothing writes back
 * through it, and no adapter is permitted to invent a value a source row does
 * not carry — see the `undefined` vs `null` rule below, which is the single most
 * load-bearing convention in this file.
 *
 * ## The correctness property this contract exists to provide
 *
 * P-001's central finding: three gates in this tree bind a stored verdict to its
 * subject three different ways. The assertion/test gate DERIVES live (immune by
 * construction). The P2P gate is CONTENT-ADDRESSED by `(shard_id, inputs_hash)`
 * (correct reuse *and* correct invalidation). The delta gate is TIME-WINDOWED,
 * so a seven-day-old green clears any candidate — **freshness does not imply
 * relevance**.
 *
 * LLM evaluation is the one family that structurally cannot re-derive (re-deriving
 * means re-running a model), so binding is the only thing that can keep its stored
 * verdict honest — and binding is exactly what it lacked. `identity.ts` supplies
 * it, in the content-addressed shape P-001 named.
 *
 * ## `undefined` means NOT RECORDED; `null` means RECORDED ABSENT
 *
 * Every optional field here is `T | null | undefined`, and the two empty values
 * are **not** interchangeable:
 *
 *   - `undefined` — the source surface does not record this fact at all. The
 *     trial's identity is INCOMPLETE and the field is named in
 *     `TrialIdentity.missingBindings`.
 *   - `null` — the source recorded it as genuinely absent or not applicable
 *     (an unseeded suite, a grader with no judge model). This is a *recorded*
 *     fact and hashes as a distinct token, so identity stays complete.
 *
 * Collapsing the two is the failure this whole contract is built to prevent: two
 * trials run under different-but-unrecorded harness versions would otherwise hash
 * identically and read as comparable. An unknown binding must fail toward SPLIT
 * (two comparable trials stop being compared — visible, recoverable), never
 * toward MERGE (incomparable trials silently pooled — invisible, and it makes a
 * broken comparison look sound). That asymmetry is the same one
 * `deriveRubricVersion` documents for rubric versions, applied one layer up.
 *
 * @see identity.ts   — the derived contract version and content-addressed identity
 * @see adapters.ts   — the per-family projections
 */

/** Which measurement family a trial was projected from. */
export type TrialFamily = 'external-bench' | 'pot-eval' | 'llm-testing' | 'scorecard';

/**
 * Privacy classification of the evidence an envelope points at.
 *
 * P-004 requires this and no eval surface in the tree records it today (measured:
 * zero repo-wide matches for any privacy/classification field across all four
 * families). It is therefore the one required field group with no existing
 * ingredient — adapters emit `'unclassified'` rather than guessing, which keeps
 * the gap visible and countable instead of dressing it as a decision.
 */
export type PrivacyClass = 'public' | 'internal' | 'sensitive' | 'restricted' | 'unclassified';

/** How a trial's verdict was produced. */
export type GraderKind = 'deterministic' | 'llm-judge' | 'rubric' | 'mixed' | 'unknown';

/**
 * Normalized trial disposition. `error`/`timeout` are INFRA failures and are
 * excluded from accuracy — they are not a genuine `failed` (METR elicitation
 * discipline, already honoured by `GraderStatus`/`GenerationStatus` upstream).
 */
export type TrialStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'incomplete' | 'unknown';

/** WHAT was measured — the task and the exact revision of it. */
export interface TrialSubject {
  family: TrialFamily;
  /** The suite / scenario corpus the task belongs to (`suite`, `shape`, `scenario_target`). */
  corpus: string;
  /** The task identifier within that corpus (`taskId`, `scenarioId`, `scenario_id`). */
  taskId: string;
  /**
   * The revision of the task/corpus content — a hash or monotonic version, never
   * a human name. `scenario_hash` and `preregHash` are the in-tree ingredients.
   */
  taskRevision?: string | null;
}

/** The system under test: model, harness, environment. */
export interface TrialSystemIdentity {
  modelId?: string | null;
  /** Exact provider version string when distinct from `modelId`. */
  modelVersion?: string | null;
  harnessVersion?: string | null;
  harnessGitSha?: string | null;
  /**
   * A HASH of the environment fingerprint, never the blob — identity must stay
   * cheap to compare and stable across serializations.
   */
  environmentFingerprint?: string | null;
}

/** Budget ceilings the trial ran under, and whether it hit them. */
export interface TrialBudgets {
  tokens?: number | null;
  usd?: number | null;
  wallClockMs?: number | null;
  /** Concurrency ceiling (bee cap / arm fan-out). */
  agents?: number | null;
  /** Did the run terminate at a cap? A capped run is not a genuine fail. */
  capped?: boolean | null;
  /** Named caps that were breached (`cap_breaches`). */
  breaches?: string[];
}

/** The knobs the trial ran under. */
export interface TrialConfiguration {
  /** Content hash of the resolved config snapshot (never the snapshot itself). */
  configHash?: string | null;
  seed?: number | null;
  /** Arm / variant identifier for a comparative pilot. */
  arm?: string | null;
  /** Position within a matrix sweep (`matrix_index`). */
  matrixIndex?: number | null;
  budgets?: TrialBudgets;
}

/** Who or what produced the verdict. */
export interface TrialGrader {
  kind: GraderKind;
  /** Grader family / rubric id (`graderFamily`, `rubricHash`). */
  family?: string | null;
  /** Grader or rubric version — the value that decides which verdicts are comparable. */
  version?: string | null;
  /** The judging model, for an LLM judge. `null` for a deterministic grader. */
  judgeModel?: string | null;
}

/** What the trial concluded. Never part of the trial's identity. */
export interface TrialOutcome {
  status: TrialStatus;
  /**
   * The binary verdict when the trial produced one. `null` means never genuinely
   * graded (infra failure) — excluded from accuracy, NOT counted as a fail.
   */
  resolved?: boolean | null;
  /** Continuous partial-credit score in [0,1] for rubric/checkpoint suites. */
  score?: number | null;
  /** True when the trial failed for infrastructure reasons rather than on merit. */
  infraFailure: boolean;
  errors?: string[];
}

/** What the trial cost. Never part of the trial's identity. */
export interface TrialUsage {
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensTotal?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  costUsd?: number | null;
  /** The price table `costUsd` was derived under — cost is recomputable without it. */
  priceTableVersion?: string | null;
  wallClockMs?: number | null;
  turns?: number | null;
}

/**
 * Pointers to the trial's replayable evidence, plus its privacy classification.
 *
 * P-004 fixes the SLOTS; P-005 fills them (full replayable trajectory/environment/
 * artifact preservation, integrity checks, and the Inspect / OpenTelemetry
 * adapters). Everything here is a REF: the envelope must stay small enough to
 * carry beside a verdict without dragging a transcript with it.
 */
export interface EvidenceEnvelope {
  trajectoryRef?: string | null;
  /** What `trajectoryRef` points at (`inspect`, `otel`, `transcript-zstd`, …). */
  trajectoryKind?: string | null;
  submissionRef?: string | null;
  rawGraderOutputRef?: string | null;
  artifactRefs?: string[];
  privacy: PrivacyClass;
  /** Integrity: content hash of the referenced evidence, when the source records one. */
  contentHash?: string | null;
}

/** How this trial relates to the runs around it. Never part of its identity. */
export interface TrialLineage {
  /** Groups one execution of the trial itself. */
  runId: string;
  /** Groups sibling trials — a matrix group, a fleet run, a pilot. */
  groupId?: string | null;
  /** Independent-repeat ordinal, so a score can be a distribution rather than a point. */
  repeat?: number | null;
  /** The trial this one was derived or replayed from. */
  parentTrialKey?: string | null;
  /** The authoritative source row this was projected from, as `<family>:<pk>`. */
  sourceRef: string;
}

/**
 * One canonical evaluation trial — the projection every measurement family
 * shares. Compact judge views, vendor formats and reports are projections OF
 * this; none of them is an authority (D-003).
 */
export interface EvaluationTrial {
  /** DERIVED from the contract's field shape — never a hand-maintained literal (D-014). */
  contractVersion: string;
  subject: TrialSubject;
  system: TrialSystemIdentity;
  configuration: TrialConfiguration;
  grader: TrialGrader;
  outcome: TrialOutcome;
  usage: TrialUsage;
  evidence: EvidenceEnvelope;
  lineage: TrialLineage;
  startedAt?: string | null;
  finishedAt?: string | null;
}
