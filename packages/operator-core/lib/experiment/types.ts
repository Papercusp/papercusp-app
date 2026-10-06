/**
 * The experiment request/result/ctx shapes (`experiment-registry-invocation-api`
 * P-011/P-031). A {@link TestDescriptor}'s `run(request, ctx)` is bound to these:
 * the REQUEST is the common envelope (the arms to compare + a subject-specific
 * payload), the CTX is the operator-bound dep bundle, and the RESULT is the
 * NORMALIZED outcome (per-arm scores + the `compareArms` verdict) the ledger +
 * scoreboard read regardless of which Subject ran.
 */
import type { CompareSelectResult, FidelityTier, JudgeLlmCall } from '@papercusp/eval-battery';
import type { KnobArm } from './knob-space';
import type { ReplayRunner, ReplayStore } from '../replay/types';

/** What a caller asks an experiment to do. `arms` are the variants to compare —
 *  an arm with empty `knobs` is the champion/baseline. `payload` is the
 *  Subject-specific battery input (e.g. `{ cases }` for replay). */
export interface ExperimentRequest {
  /** Groups this invocation's cells/rows. */
  batteryId: string;
  /** The variants to compare (one empty-knobs arm = the baseline anchor). */
  arms: KnobArm[];
  /** Repeats per (arm × case) — the variance sample. */
  repeats: number;
  /** Judge-trace cap handed to the Subject. */
  maxDistillChars?: number;
  /** Spend cap for this run (non-offline tiers; the governor is the upstream gate). */
  budgetUsd?: number;
  /** Subject-specific battery input — each descriptor casts it to its own shape. */
  payload: unknown;
}

/** One arm's normalized outcome. */
export interface ExperimentArmResult {
  id: string;
  label: string;
  /** Mean judge composite over scored cells, or null when none scored. */
  meanScore: number | null;
  cells: number;
  scored: number;
  costUsd: number;
  /** False means costUsd is a known lower bound, not settled spend. */
  costMeasured?: boolean;
}

export type ExperimentScorecardScores = Record<string, number | null>;

/** The normalized result every Subject maps to — the one shape the ledger,
 *  the scoreboard, and Scout meta-learning read. */
export interface ExperimentRunResult {
  testId: string;
  tier: FidelityTier;
  /** The baseline arm's id (the `compareArms` anchor). */
  baselineId: string;
  arms: ExperimentArmResult[];
  /** The baseline-vs-candidates ranking (compareArms), or null. */
  comparison: Omit<CompareSelectResult, 'scenarioId'> | null;
  /** The selected winning arm id (only on a strict improvement ≥ minDelta), else null. */
  winner: string | null;
  totalCostUsd: number;
  /** False withholds a winner and scorecard until spend is reconciled. */
  costMeasured?: boolean;
  budgetExhausted: boolean;
  /**
   * Optional per-rubric-criterion scores preserved from the subject's native judge
   * dimensions. `experiment:run` maps these onto the descriptor's store `rubricRef`
   * and emits a rubric-graded observation after the verdict is recorded.
   */
  scorecardScores?: ExperimentScorecardScores;
}

/**
 * The operator-bound dep bundle handed to every descriptor's `run`. The
 * `experiment:run` tool builds ONE of these; each descriptor reads the slice it
 * needs. v1 wires the offline (replay) tier; the heavy-tier ports land as they are
 * bound (P-011 follow-on).
 */
export interface ExperimentRunCtx {
  workspaceId: string;
  now(): number;
  /** The frozen judge LLM client (shared across Subjects). */
  llmCall: JudgeLlmCall;
  /** The replay runner — required for the offline (replay) tier. */
  replayRunner?: ReplayRunner;
  /** Optional per-Subject persistence. */
  store?: { replay?: ReplayStore };
  /** Live gym AbDeps (createGymRunnerPorts) — present only when the gym tier is armed.
   *  Absent ⇒ the gym descriptor stays staged (run refuses). */
  gym?: { abDeps?: import('../gym/ab-runner').AbDeps };
  /** Live iq-battery deps (the InstanceSubject boot) — present only when the
   *  whole-instance tier is armed by its own infra/loop. Absent ⇒ the instance
   *  descriptor stays staged (run refuses) — its apiary loop drives it (D-002/D-017). */
  instance?: { deps?: import('../iq-battery/beekeeper-runner').BeekeeperDeps };
  /** Live hive-eval ports (the whole-Hive runner) — present only when the whole-Hive
   *  tier is armed by its own infra/loop. Absent ⇒ the hive descriptor stays staged
   *  (run refuses) — its hive-eval loop drives it (D-002/D-017). */
  hive?: { ports?: import('../pot-eval/run-harness').HiveRunPorts };
  /** Injected for the rate-pause wait (defaults to real setTimeout in the runner). */
  sleep?(ms: number): Promise<void>;
}

/**
 * The shared lifecycle contract for a learning change (P-001).
 *
 * Producers (Scout, Gym, regret mining, and transfer) may discover different
 * candidate kinds, but they all publish this same envelope before a change can
 * be promoted.  Keeping the contract beside the existing experiment types lets
 * each producer reuse the experiment/eval-battery and provenance seams without
 * inventing another acceptance shape.
 */
export type LearningEvidenceStatus = 'pass' | 'fail' | 'not-measured';

export type LearningActorKind = 'human' | 'agent' | 'auto-grader' | 'system';

export interface LearningActor {
  readonly kind: LearningActorKind;
  /** Stable owner/session id, or `human`/`auto-grader` for those surfaces. */
  readonly id: string;
  readonly role?: string;
}

export interface LearningPotScope {
  /** The pot that owns the candidate and its policy updates. */
  readonly potId: string;
  /** Workspace containing the owning pot. */
  readonly workspaceId: string;
  /** Explicitly permitted transfer targets; empty means pot-local only. */
  readonly applicablePots?: readonly string[];
}

export interface LearningCandidate {
  readonly id: string;
  readonly version: string;
  /** Parent version that the candidate was evaluated against. */
  readonly parentVersion: string;
  /** Hash of the complete immutable variant/artifact. */
  readonly variantHash: string;
  readonly actor: LearningActor;
  readonly potScope: LearningPotScope;
  readonly createdAt: string;
}

export interface LearningExperiment {
  readonly batteryId: string;
  readonly testId: string;
  readonly baselineId: string;
  readonly challengerId: string;
  readonly taskHash: string;
  /** Unknown execution pins remain explicit on inconclusive producer receipts.
   * Validation still refuses them before acceptance or activation. */
  readonly modelHash: string | null;
  readonly promptHash: string | null;
  readonly rubricHash: string;
  readonly codeHash: string | null;
  readonly repeats: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export type LearningEvidenceKind = 'objective' | 'judgment' | 'regression' | 'probe' | 'cost' | 'rollback';

export interface LearningEvidence {
  readonly id: string;
  readonly kind: LearningEvidenceKind;
  readonly status: LearningEvidenceStatus;
  readonly coverage: { readonly required: number; readonly measured: number };
  readonly artifactRefs: readonly string[];
  readonly recordedAt: string;
}

export interface LearningSpend {
  readonly requestedUsd: number;
  readonly reservedUsd: number;
  readonly usedUsd: number;
  readonly unsettledUsd: number;
  readonly settledAt?: string;
}

export type LearningDecisionVerdict = 'accepted' | 'rejected' | 'inconclusive';

export interface LearningDecision {
  readonly verdict: LearningDecisionVerdict;
  readonly authority: LearningActor;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly decidedAt: string;
}

export interface LearningActivation {
  readonly version: string;
  readonly parentVersion: string;
  /** Rollback target captured before the new version is exposed. */
  readonly rollbackVersion: string;
  readonly exposure: { readonly population: string; readonly percentage: number };
  readonly activatedAt: string;
}

export type LearningOutcomeStatus = 'pending' | 'matured' | 'right-censored';

export interface LearningOutcome {
  readonly status: LearningOutcomeStatus;
  readonly measuredAt?: string;
  readonly value?: number;
  readonly artifactRefs?: readonly string[];
}

export interface LearningContract {
  readonly contractVersion: '1';
  readonly candidate: LearningCandidate;
  readonly experiment: LearningExperiment;
  readonly evidence: readonly LearningEvidence[];
  readonly spend: LearningSpend;
  readonly decision: LearningDecision;
  readonly activation?: LearningActivation;
  readonly outcomes: readonly LearningOutcome[];
}

export interface LearningContractValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate the fail-closed invariants shared by every learning producer.
 * This is deliberately side-effect free so adapters can run it before any
 * governor reservation, promotion write, or prompt activation.
 */
export function validateLearningContract(contract: LearningContract): LearningContractValidation {
  const errors: string[] = [];
  const nonEmpty = (value: string | null | undefined, field: string) => {
    if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${field} must be non-empty`);
  };
  const finiteNonNegative = (value: number, field: string) => {
    if (!Number.isFinite(value) || value < 0) errors.push(`${field} must be a finite non-negative number`);
  };

  if (contract.contractVersion !== '1') errors.push('contractVersion must be 1');
  for (const [value, field] of [
    [contract.candidate.id, 'candidate.id'],
    [contract.candidate.version, 'candidate.version'],
    [contract.candidate.parentVersion, 'candidate.parentVersion'],
    [contract.candidate.variantHash, 'candidate.variantHash'],
    [contract.candidate.actor.id, 'candidate.actor.id'],
    [contract.candidate.potScope.potId, 'candidate.potScope.potId'],
    [contract.candidate.potScope.workspaceId, 'candidate.potScope.workspaceId'],
    [contract.experiment.batteryId, 'experiment.batteryId'],
    [contract.experiment.testId, 'experiment.testId'],
    [contract.experiment.baselineId, 'experiment.baselineId'],
    [contract.experiment.challengerId, 'experiment.challengerId'],
    [contract.experiment.taskHash, 'experiment.taskHash'],
    [contract.experiment.modelHash, 'experiment.modelHash'],
    [contract.experiment.promptHash, 'experiment.promptHash'],
    [contract.experiment.rubricHash, 'experiment.rubricHash'],
    [contract.experiment.codeHash, 'experiment.codeHash'],
    [contract.decision.authority.id, 'decision.authority.id'],
    [contract.decision.reason, 'decision.reason'],
  ] as const) nonEmpty(value, field);

  if (contract.experiment.baselineId === contract.experiment.challengerId) {
    errors.push('experiment baseline and challenger must differ');
  }
  if (!Number.isInteger(contract.experiment.repeats) || contract.experiment.repeats < 1) {
    errors.push('experiment.repeats must be a positive integer');
  }

  for (const [value, field] of [
    [contract.spend.requestedUsd, 'spend.requestedUsd'],
    [contract.spend.reservedUsd, 'spend.reservedUsd'],
    [contract.spend.usedUsd, 'spend.usedUsd'],
    [contract.spend.unsettledUsd, 'spend.unsettledUsd'],
  ] as const) finiteNonNegative(value, field);
  if (contract.spend.reservedUsd > contract.spend.requestedUsd) errors.push('spend.reservedUsd cannot exceed requestedUsd');
  if (contract.spend.usedUsd + contract.spend.unsettledUsd > contract.spend.reservedUsd) {
    errors.push('spend.usedUsd + unsettledUsd cannot exceed reservedUsd');
  }

  const evidenceById = new Map<string, LearningEvidence>();
  for (const evidence of contract.evidence) {
    nonEmpty(evidence.id, 'evidence.id');
    if (evidenceById.has(evidence.id)) errors.push(`evidence id is duplicated: ${evidence.id}`);
    evidenceById.set(evidence.id, evidence);
    if (!Number.isInteger(evidence.coverage.required) || evidence.coverage.required < 0) {
      errors.push(`evidence ${evidence.id} required coverage must be a non-negative integer`);
    }
    if (!Number.isInteger(evidence.coverage.measured) || evidence.coverage.measured < 0) {
      errors.push(`evidence ${evidence.id} measured coverage must be a non-negative integer`);
    }
    if (evidence.coverage.measured > evidence.coverage.required) {
      errors.push(`evidence ${evidence.id} measured coverage cannot exceed required coverage`);
    }
    if (evidence.artifactRefs.length === 0) errors.push(`evidence ${evidence.id} needs an artifact reference`);
    for (const ref of evidence.artifactRefs) nonEmpty(ref, 'evidence.artifactRef');
  }
  for (const id of contract.decision.evidenceIds) {
    if (!evidenceById.has(id)) errors.push(`decision references unknown evidence: ${id}`);
  }

  if (contract.decision.verdict === 'accepted') {
    if (contract.evidence.length === 0) errors.push('accepted decision requires evidence');
    // Validate the required population, not only the rows a caller supplied.
    // Removing an unmeasured gate must never turn an inconclusive result green.
    for (const kind of ['objective', 'judgment', 'regression', 'probe', 'cost', 'rollback'] as const) {
      if (!contract.evidence.some((evidence) => evidence.kind === kind)) {
        errors.push(`accepted decision is missing required evidence: ${kind}`);
      }
    }
    if (contract.spend.unsettledUsd !== 0) errors.push('accepted decision requires settled spend');
    if (!contract.spend.settledAt || !Number.isFinite(Date.parse(contract.spend.settledAt))) {
      errors.push('accepted decision requires a valid spend.settledAt');
    }
    if (new Set(contract.decision.evidenceIds).size !== contract.decision.evidenceIds.length) {
      errors.push('accepted decision has duplicate evidence citations');
    }
    for (const evidence of contract.evidence) {
      if (evidence.status !== 'pass') errors.push(`accepted decision has ${evidence.status} evidence: ${evidence.id}`);
      if (evidence.coverage.measured < evidence.coverage.required) errors.push(`accepted decision has incomplete evidence: ${evidence.id}`);
      if (evidence.coverage.required < 1) errors.push(`accepted decision has no required coverage: ${evidence.id}`);
      if (!contract.decision.evidenceIds.includes(evidence.id)) errors.push(`accepted decision does not cite evidence: ${evidence.id}`);
    }
  }
  if (contract.activation) {
    if (contract.decision.verdict !== 'accepted') errors.push('activation requires an accepted decision');
    nonEmpty(contract.activation.version, 'activation.version');
    nonEmpty(contract.activation.parentVersion, 'activation.parentVersion');
    nonEmpty(contract.activation.rollbackVersion, 'activation.rollbackVersion');
    nonEmpty(contract.activation.exposure.population, 'activation.exposure.population');
    if (!Number.isFinite(contract.activation.exposure.percentage) || contract.activation.exposure.percentage <= 0 || contract.activation.exposure.percentage > 100) {
      errors.push('activation exposure percentage must be in (0, 100]');
    }
  }

  return { ok: errors.length === 0, errors };
}
