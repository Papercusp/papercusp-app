/**
 * Common lifecycle adapters for Blender learning producers (P-011).
 *
 * Scout, Gym, calibration, transfer, regret, and Red Queen each have useful
 * domain-specific stores.  This module gives their outputs one typed boundary
 * before a decision or activation is allowed: candidate → experiment → typed
 * evidence → spend → decision → activation/outcomes.  The adapters are pure;
 * callers supply the already-recorded source evidence and remain responsible
 * for their existing stores and governor reservations.
 *
 * Legacy writers are intentionally not removed here.  `evaluateLifecycleParity`
 * and `canRetireLegacyWriter` make the retirement condition explicit and
 * testable, so a source can be retired only after its evidence is represented
 * in the common contract and no legacy rows remain to drain.
 */

import {
  validateLearningContract,
  type LearningActivation,
  type LearningActor,
  type LearningCandidate,
  type LearningContract,
  type LearningDecision,
  type LearningEvidence,
  type LearningEvidenceKind,
  type LearningExperiment,
  type LearningOutcome,
  type LearningSpend,
} from './types';

export const LEARNING_PRODUCERS = ['scout', 'gym', 'calibration', 'transfer', 'regret', 'red-queen'] as const;
export type LearningProducer = (typeof LEARNING_PRODUCERS)[number];

export type ProducerVerdict = 'accept' | 'reject' | 'inconclusive';

export interface ProducerLifecycleInput {
  candidate: LearningCandidate;
  experiment: LearningExperiment;
  evidence: readonly LearningEvidence[];
  spend: LearningSpend;
  verdict: ProducerVerdict;
  authority: LearningActor;
  reason: string;
  decidedAt: string;
  activation?: LearningActivation;
  outcomes?: readonly LearningOutcome[];
}

export interface LifecycleAdapterResult {
  producer: LearningProducer;
  contract: LearningContract;
  validation: ReturnType<typeof validateLearningContract>;
}

const verdictMap: Record<ProducerVerdict, LearningDecision['verdict']> = {
  accept: 'accepted',
  reject: 'rejected',
  inconclusive: 'inconclusive',
};

/** Build the one common contract from any producer's already-recorded output. */
export function buildProducerLifecycleContract(
  producer: LearningProducer,
  input: ProducerLifecycleInput,
): LifecycleAdapterResult {
  const decision: LearningDecision = {
    verdict: verdictMap[input.verdict],
    authority: input.authority,
    reason: input.reason,
    evidenceIds: input.evidence.map((evidence) => evidence.id),
    decidedAt: input.decidedAt,
  };
  const contract: LearningContract = {
    contractVersion: '1',
    candidate: input.candidate,
    experiment: input.experiment,
    evidence: input.evidence,
    spend: input.spend,
    decision,
    ...(input.activation ? { activation: input.activation } : {}),
    outcomes: input.outcomes ?? [],
  };
  return { producer, contract, validation: validateLearningContract(contract) };
}

/** The six producer-specific entry points all share the same contract builder. */
export const adaptScoutOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('scout', input);
export const adaptGymOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('gym', input);
export const adaptCalibrationOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('calibration', input);
export const adaptTransferOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('transfer', input);
export const adaptRegretOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('regret', input);
export const adaptRedQueenOutput = (input: ProducerLifecycleInput): LifecycleAdapterResult =>
  buildProducerLifecycleContract('red-queen', input);

export interface LifecycleParityInput {
  producer: LearningProducer;
  contract: LearningContract;
  /** Legacy row/artifact references that must be visible in common evidence. */
  legacyArtifactRefs: readonly string[];
  /** Evidence kinds emitted by the legacy source and required for parity. */
  requiredEvidenceKinds?: readonly LearningEvidenceKind[];
}

export interface LifecycleParityResult {
  producer: LearningProducer;
  validContract: boolean;
  missingArtifactRefs: string[];
  missingEvidenceKinds: LearningEvidenceKind[];
  ok: boolean;
}

/**
 * Check that an adapter preserved legacy source evidence before retiring its
 * writer.  This intentionally checks artifact references, not just counts:
 * two rows can have the same count while dropping the source identity.
 */
export function evaluateLifecycleParity(input: LifecycleParityInput): LifecycleParityResult {
  const validation = validateLearningContract(input.contract);
  const artifactRefs = new Set(input.contract.evidence.flatMap((evidence) => evidence.artifactRefs));
  const missingArtifactRefs = input.legacyArtifactRefs.filter((ref) => !artifactRefs.has(ref));
  const kinds = new Set(input.contract.evidence.map((evidence) => evidence.kind));
  const missingEvidenceKinds = (input.requiredEvidenceKinds ?? []).filter((kind) => !kinds.has(kind));
  return {
    producer: input.producer,
    validContract: validation.ok,
    missingArtifactRefs,
    missingEvidenceKinds,
    ok: validation.ok && missingArtifactRefs.length === 0 && missingEvidenceKinds.length === 0,
  };
}

/**
 * The alternate writer may be retired only when parity is proven and its
 * backlog has drained.  A positive parity result alone is insufficient: rows
 * written by the old path still need a migration/drain pass.
 */
export function canRetireLegacyWriter(input: { parity: LifecycleParityResult; remainingLegacyWrites: number }): boolean {
  return input.parity.ok && Number.isInteger(input.remainingLegacyWrites) && input.remainingLegacyWrites === 0;
}

/** Return the source identities represented by a common contract. */
export function contractArtifactRefs(contract: LearningContract): string[] {
  return [...new Set(contract.evidence.flatMap((evidence) => evidence.artifactRefs))].sort();
}

