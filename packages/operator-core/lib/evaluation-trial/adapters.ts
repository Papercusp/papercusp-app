/**
 * Projections from the authoritative measurement families INTO the canonical
 * `EvaluationTrial` (P-004).
 *
 * Direction is one-way by design (D-003): each family's own rows stay the
 * authority and these functions produce a view of them. Nothing here writes, and
 * P-001's verdict — extend, do not fork — is honoured literally: no new table, no
 * new column, no second store.
 *
 * ## The one rule every adapter obeys
 *
 * `undefined` means the source surface DOES NOT RECORD this fact. `null` means the
 * source records it as genuinely absent or not applicable. An adapter may never
 * substitute a plausible value for a fact its source does not carry, and may never
 * emit `null` merely because a field was inconvenient to find — that would convert
 * an unrecorded binding into a recorded one and let two incomparable trials hash
 * alike, which is precisely the silent merge this contract exists to prevent.
 *
 * The consequence is deliberate and useful: a family that does not record its
 * model or harness version produces trials whose identity is INCOMPLETE, and
 * `TrialIdentity.missingBindings` names exactly what it must start recording. The
 * contract doubles as a coverage instrument for the gaps P-001 found.
 */

import { createHash } from 'node:crypto';

import type { TaskRunResult } from '@papercusp/bench-metrics';

import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import type { RolloutRecord } from '../external-bench/reproducibility/schema';
import type { InstanceManifest } from '../iq-battery/instance-manifest';
import type { HiveEvalRunRow, HiveEvalScoreRow } from '../pot-eval/store';
import type { ScorecardRow } from '../scorecards';

import { EVALUATION_TRIAL_CONTRACT_VERSION } from './identity';
import type { EvaluationTrial, GraderKind, TrialStatus } from './schema';

/**
 * Hash a structured value into a stable fingerprint.
 *
 * Reuses the reproducibility layer's `canonicalJson` (recursive key sort) rather
 * than adding a sixth copy of that helper — key order in a config snapshot or an
 * environment fingerprint read back from PG is not stable, and a fingerprint that
 * moved on key order would split identities for no measurement reason.
 *
 * Returns `undefined` for an absent input so a missing snapshot stays UNRECORDED
 * rather than collapsing to the hash of `null`.
 */
export function fingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// external-bench — TaskRunResult (+ its Rollout Card)
// ───────────────────────────────────────────────────────────────────────────

/** Map a grader modality onto how the verdict was actually produced. */
function graderKindForModality(modality: string): GraderKind {
  switch (modality) {
    case 'deliverable-bundle':
      // A blinded pairwise judge — a model decides.
      return 'llm-judge';
    case 'interactive':
      // A synchronous agent↔simulator loop graded by a reward model.
      return 'mixed';
    case 'diff':
    case 'in-container':
    case 'qa':
      return 'deterministic';
    default:
      return 'unknown';
  }
}

function statusForBench(row: TaskRunResult): TrialStatus {
  if (row.generationStatus === 'error' || row.graderStatus === 'error') return 'error';
  if (row.generationStatus === 'timeout' || row.graderStatus === 'timeout') return 'timeout';
  if (row.graderStatus === 'passed') return 'passed';
  if (row.graderStatus === 'failed') return 'failed';
  return 'unknown';
}

/**
 * Project one benchmark run into a canonical trial.
 *
 * Pass the Rollout Card whenever it is available: without it the exact model
 * version, harness git sha, environment fingerprint and config snapshot are
 * genuinely unavailable, and the resulting identity is (correctly) incomplete.
 */
export function trialFromTaskRunResult(
  row: TaskRunResult,
  rollout?: RolloutRecord | null,
): EvaluationTrial {
  const graderKind = graderKindForModality(row.modality);
  const infraFailure =
    row.generationStatus === 'error' ||
    row.generationStatus === 'timeout' ||
    row.graderStatus === 'error' ||
    row.graderStatus === 'timeout';

  const errors: string[] = [];
  if (row.generationError) errors.push(`generation: ${row.generationError}`);

  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: {
      family: 'external-bench',
      corpus: row.suite,
      taskId: row.taskId,
      // The pre-registered config hash pins the exact task set this ran under.
      taskRevision: row.preregHash,
    },
    system: {
      modelId: row.modelId,
      // Recorded only on the Rollout Card; absent card ⇒ genuinely unrecorded.
      modelVersion: rollout ? (rollout.modelVersion ?? null) : undefined,
      harnessVersion: row.harnessVersion,
      harnessGitSha: rollout ? (rollout.harnessGitSha ?? null) : undefined,
      environmentFingerprint: rollout ? (fingerprint(rollout.envFingerprint) ?? null) : undefined,
    },
    configuration: {
      configHash: rollout ? (fingerprint(rollout.configSnapshot) ?? null) : undefined,
      seed: row.seed,
      arm: row.arm,
      // This family runs arms, not matrix sweeps — a recorded absence, not a gap.
      matrixIndex: null,
      budgets: {
        tokens: row.budgetTokens ?? null,
        usd: null,
        wallClockMs: null,
        agents: null,
        capped: row.capped,
        breaches: row.capped ? ['generation-tokens'] : [],
      },
    },
    grader: {
      kind: graderKind,
      family: row.graderFamily,
      version: row.graderVersion,
      // A deterministic grader genuinely has no judge model; a judged modality has
      // one that this family does not record.
      judgeModel: graderKind === 'deterministic' ? null : undefined,
    },
    outcome: {
      status: statusForBench(row),
      resolved: row.resolved,
      score: row.score ?? null,
      infraFailure,
      errors,
    },
    usage: {
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      tokensTotal: row.tokensTotal,
      tokensCacheRead: row.tokensCacheRead ?? null,
      tokensCacheWrite: row.tokensCacheWrite ?? null,
      costUsd: row.costUsd,
      priceTableVersion: row.priceTableVersion,
      wallClockMs: row.wallClockMs,
      turns: row.turns,
    },
    evidence: {
      trajectoryRef: rollout ? (rollout.trajectoryRef ?? null) : undefined,
      trajectoryKind: rollout ? (rollout.trajectoryKind ?? null) : undefined,
      submissionRef: row.submissionRef ?? null,
      rawGraderOutputRef: row.rawGraderOutputRef ?? null,
      artifactRefs: [],
      // No eval surface in this tree classifies its evidence yet (P-004 gap).
      privacy: 'unclassified',
      contentHash: undefined,
    },
    lineage: {
      runId: row.runId,
      groupId: row.rolloutId,
      repeat: row.seed,
      parentTrialKey: null,
      sourceRef: `external-bench:${row.rolloutId}`,
    },
    startedAt: undefined,
    finishedAt: row.createdAt,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// pot-eval — HiveEvalRunRow (+ its score row and instance manifest)
// ───────────────────────────────────────────────────────────────────────────

function statusForHive(run: HiveEvalRunRow): TrialStatus {
  if (!run.observations) return 'incomplete';
  switch (run.observations.terminalState) {
    case 'drained':
      return 'passed';
    case 'timeout':
      return 'timeout';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * Project one Hive-eval run into a canonical trial.
 *
 * Note what this family does NOT record, which the resulting identity reports
 * rather than papers over: no model identity anywhere on the run row (the
 * instance manifest pins a code sha, not a model), and no content revision for
 * the scenario it ran. Both surface in `missingBindings`, which is the honest
 * answer to "may I compare last week's Hive score to today's?".
 */
export function trialFromHiveEvalRun(
  run: HiveEvalRunRow,
  score?: HiveEvalScoreRow | null,
  manifest?: InstanceManifest | null,
): EvaluationTrial {
  const observations = run.observations;

  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: {
      family: 'pot-eval',
      corpus: run.shape,
      taskId: run.scenarioId,
      // Scenario rows carry no content hash — a real, named gap.
      taskRevision: undefined,
    },
    system: {
      // The instance manifest identifies an instance, never a model.
      modelId: undefined,
      modelVersion: undefined,
      harnessVersion: undefined,
      harnessGitSha: manifest ? manifest.codeSha : undefined,
      environmentFingerprint: observations?.repoPath ? fingerprint(observations.repoPath) : undefined,
    },
    configuration: {
      configHash: manifest
        ? (fingerprint({
            genomeId: manifest.genomeId ?? null,
            memorySnapshotId: manifest.memorySnapshotId ?? null,
            batterySliceId: manifest.batterySliceId ?? null,
          }) ?? null)
        : undefined,
      seed: run.seed,
      // This family runs repeats of one configuration, not named arms.
      arm: null,
      matrixIndex: null,
      budgets: {
        tokens: null,
        usd: run.budgetUsdCap,
        wallClockMs: null,
        agents: run.beeCap,
        capped: observations ? observations.terminalState === 'timeout' : null,
        breaches: observations?.terminalState === 'timeout' ? ['wall-clock'] : [],
      },
    },
    grader: score
      ? {
          // The composite is deterministic; the advisory judge composite is recorded
          // beside it but never folded in (P-041), so the binding grader is the rubric.
          kind: 'rubric',
          family: score.rubricHash,
          version: score.rubricVersion,
          judgeModel: score.judgeComposite === undefined ? null : undefined,
        }
      : { kind: 'unknown', family: undefined, version: undefined, judgeModel: undefined },
    outcome: {
      status: statusForHive(run),
      resolved: score ? score.outcomeGatePassed : null,
      score: score ? score.composite : null,
      infraFailure: observations?.terminalState === 'failed',
      errors: [],
    },
    usage: {
      tokensIn: undefined,
      tokensOut: undefined,
      tokensTotal: undefined,
      tokensCacheRead: undefined,
      tokensCacheWrite: undefined,
      costUsd: observations?.costUsd ?? null,
      priceTableVersion: undefined,
      wallClockMs: observations?.wallClockMs ?? null,
      turns: undefined,
    },
    evidence: {
      trajectoryRef: run.traceRef ?? null,
      trajectoryKind: run.traceRef ? 'hive-coord-trace' : null,
      submissionRef: observations?.repoPath ?? null,
      rawGraderOutputRef: null,
      artifactRefs: [],
      privacy: 'unclassified',
      contentHash: undefined,
    },
    lineage: {
      runId: run.runId,
      groupId: run.instanceId,
      repeat: run.repeat,
      parentTrialKey: null,
      sourceRef: `pot-eval:${run.instanceId}/${run.runId}`,
    },
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// llm-testing — harness_shared.llm_test_runs
// ───────────────────────────────────────────────────────────────────────────

/**
 * The durable `llm_test_runs` row as a reader gets it back.
 *
 * Declared structurally rather than importing the in-memory `SingleRunReport`
 * this family writes FROM: the projection's subject is the persisted row (what a
 * later reader, replay, or export actually has), and coupling to the writer's
 * report shape would make the adapter depend on state that no longer exists by
 * the time anyone reads a trial back.
 */
export interface LlmTestRunRow {
  id: string;
  scenario_id: string;
  scenario_version: number;
  scenario_target: string;
  scenario_hash: string;
  identity_hash: string;
  matrix_group_id: string | null;
  matrix_index: number | null;
  rubric_version: string;
  sut_model: string;
  judge_model: string;
  persona_id: string;
  persona_traits_json: unknown;
  workspace_mode: string;
  transport_mode: string;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  cost_usd: number | string;
  cap_breaches: string[];
}

function statusForLlmTest(status: string): TrialStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'errored':
      return 'error';
    default:
      return 'unknown';
  }
}

const isoOrNull = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v;

/**
 * Project one persisted LLM-testing run into a canonical trial.
 *
 * This is the family P-001 singled out: it cannot re-derive its verdict (that
 * means re-running a model), so a content-addressed binding is the only thing
 * that can keep its stored verdict honest. It already records the two hardest
 * ingredients — `scenario_hash` (what was asked) and `rubric_version` (how it was
 * judged, itself derived from rubric content) — which is why P-001 concluded the
 * mechanism needed no new columns.
 *
 * What it still does not record: the harness version/sha the SUT ran at, and the
 * seed. Both appear in `missingBindings` rather than being invented here.
 */
export function trialFromLlmTestRun(row: LlmTestRunRow): EvaluationTrial {
  const cost = typeof row.cost_usd === 'string' ? Number(row.cost_usd) : row.cost_usd;

  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: {
      family: 'llm-testing',
      corpus: row.scenario_target,
      taskId: row.scenario_id,
      // The scenario's own content hash — the ingredient that makes this family
      // bindable without a schema change.
      taskRevision: row.scenario_hash,
    },
    system: {
      modelId: row.sut_model,
      modelVersion: undefined,
      harnessVersion: undefined,
      harnessGitSha: undefined,
      environmentFingerprint: undefined,
    },
    configuration: {
      configHash:
        fingerprint({
          workspaceMode: row.workspace_mode,
          transportMode: row.transport_mode,
          personaId: row.persona_id,
          personaTraits: row.persona_traits_json,
          scenarioVersion: row.scenario_version,
        }) ?? null,
      // Not recorded by this family — a real gap, not a recorded absence.
      seed: undefined,
      arm: null,
      matrixIndex: row.matrix_index,
      budgets: {
        tokens: null,
        usd: null,
        wallClockMs: null,
        agents: null,
        capped: row.cap_breaches.length > 0,
        breaches: row.cap_breaches,
      },
    },
    grader: {
      kind: 'llm-judge',
      family: 'llm-testing',
      version: row.rubric_version,
      judgeModel: row.judge_model,
    },
    outcome: {
      status: statusForLlmTest(row.status),
      resolved: row.status === 'passed' ? true : row.status === 'failed' ? false : null,
      score: null,
      infraFailure: row.status === 'errored',
      errors: [],
    },
    usage: {
      tokensIn: undefined,
      tokensOut: undefined,
      tokensTotal: undefined,
      tokensCacheRead: undefined,
      tokensCacheWrite: undefined,
      costUsd: Number.isFinite(cost) ? cost : null,
      priceTableVersion: undefined,
      wallClockMs: undefined,
      turns: undefined,
    },
    evidence: {
      trajectoryRef: `llm_test_runs:${row.id}#transcript_raw_zstd`,
      trajectoryKind: 'transcript-zstd',
      submissionRef: null,
      rawGraderOutputRef: `llm_test_runs:${row.id}#judge_json`,
      artifactRefs: [],
      privacy: 'unclassified',
      // The row's own identity hash is an integrity anchor for the recorded run.
      contentHash: row.identity_hash,
    },
    lineage: {
      runId: row.id,
      groupId: row.matrix_group_id,
      repeat: null,
      parentTrialKey: null,
      sourceRef: `llm-testing:${row.id}`,
    },
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// scorecards — a rubric grading of a named subject
// ───────────────────────────────────────────────────────────────────────────

/**
 * Project one scorecard into a canonical trial.
 *
 * A scorecard is not an execution: it is a grading of some other subject, so the
 * mapping is deliberately skewed. `subject.kind` is the corpus, `subject.ref` is
 * the task, and `evidenceFingerprint` — the canonical evidence identity filed
 * through `scorecards:emit` — is the task revision.
 *
 * `ScorecardRow.rubricRevision` is the plan-row revision captured by the writer for
 * cards emitted after the revision-tracking fix. Historical rows without that field
 * remain incomplete: the adapter never back-fills from the rubric's current text,
 * which would falsely assert that an old card was graded under today's criteria.
 */
export function trialFromScorecard(card: ScorecardRow): EvaluationTrial {
  const subject = card.subject;
  const acceptance = card.acceptance;

  const status: TrialStatus = acceptance
    ? acceptance.verdict === 'accept'
      ? 'passed'
      : // An accepted-pending-delivery verdict is NOT a failed trial: the work
        // was judged healthy and only an unreachable delivery plane is
        // outstanding. Reporting it as 'failed' would turn a disclosure into a
        // fabricated negative result wherever trials are aggregated.
        acceptance.verdict === 'accept-pending-delivery'
        ? 'incomplete'
        : 'failed'
    : card.missingKeys.length > 0
      ? 'incomplete'
      : 'unknown';

  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: {
      family: 'scorecard',
      corpus: subject?.kind ?? 'unbound',
      taskId: subject?.ref ?? card.issueId,
      // Absent on pre-P-009 cards, and absence means NOT RECORDED — never
      // "graded nothing" (ScorecardRow's own doc comment makes that distinction).
      taskRevision: card.evidenceFingerprint ?? undefined,
    },
    system: {
      // A scorecard records the grader's host generation, never a model or a
      // harness version for what it graded.
      modelId: undefined,
      modelVersion: undefined,
      harnessVersion: undefined,
      harnessGitSha: undefined,
      environmentFingerprint: card.gradedGeneration
        ? (fingerprint(card.gradedGeneration) ?? null)
        : undefined,
    },
    configuration: {
      // A windowed grading's window IS its configuration.
      configHash: subject
        ? (fingerprint({
            windowStart: subject.windowStart ?? null,
            windowEnd: subject.windowEnd ?? null,
          }) ?? null)
        : null,
      seed: null,
      arm: null,
      matrixIndex: null,
      budgets: {
        tokens: null,
        usd: null,
        wallClockMs: null,
        agents: null,
        capped: null,
        breaches: [],
      },
    },
    grader: {
      kind: 'rubric',
      family: card.rubricRef,
      // TrialGrader.version is a string binding; preserve the numeric plan revision
      // without inventing one for pre-fix scorecards.
      version: card.rubricRevision == null ? undefined : String(card.rubricRevision),
      judgeModel: null,
    },
    outcome: {
      status,
      resolved: acceptance ? acceptance.verdict === 'accept' : null,
      // score10 is a read-time 0–10 projection; normalize to the contract's [0,1].
      score: card.score10 === null ? null : card.score10 / 10,
      infraFailure: false,
      errors: card.missingKeys.length > 0 ? [`unrated criteria: ${card.missingKeys.join(', ')}`] : [],
    },
    usage: {
      tokensIn: undefined,
      tokensOut: undefined,
      tokensTotal: undefined,
      tokensCacheRead: undefined,
      tokensCacheWrite: undefined,
      costUsd: undefined,
      priceTableVersion: undefined,
      wallClockMs: undefined,
      turns: undefined,
    },
    evidence: {
      trajectoryRef: null,
      trajectoryKind: null,
      submissionRef: null,
      rawGraderOutputRef: `scorecard:${card.issueId}#ratings`,
      artifactRefs: [],
      privacy: 'unclassified',
      contentHash: card.evidenceFingerprint ?? null,
    },
    lineage: {
      runId: card.issueId,
      groupId: card.sourceHive ?? null,
      repeat: null,
      // A correcting card names the one it superseded — real measurement lineage.
      parentTrialKey: card.supersedes ?? null,
      sourceRef: `scorecard:${card.issueId}`,
    },
    startedAt: subject?.windowStart ?? null,
    finishedAt: card.createdAt,
  };
}
