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
import { createHash } from 'node:crypto';

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

/** Freeze the detached JSON receipt, including evidence and inherited decisions. */
function freezeReceipt<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeReceipt(child);
  }
  return value;
}

/** Build the one common contract from any producer's already-recorded output. */
export function buildProducerLifecycleContract(
  producer: LearningProducer,
  input: ProducerLifecycleInput,
): LifecycleAdapterResult {
  // Validate and retain the same snapshot; caller mutation cannot change the
  // evidence behind an already-computed verdict, and callers stay writable.
  input = structuredClone(input);
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
  return freezeReceipt({ producer, contract, validation: validateLearningContract(contract) });
}

/** Discovery and domain verdicts are observations until the complete contract exists. */
export interface ProducerObservationInput {
  stage: 'observation';
  workspaceId: string;
  sourceRef: string;
  recordedAt: string;
  /** The actual persisted row, including its original verdict/provenance. */
  source: Record<string, unknown>;
  /** Actual producer evaluation, including partial/unknown pins. It remains
   * evidence on an observation and never implies contract acceptance. */
  evaluation?: unknown;
  /** Supplied only by a producer's evaluated decision path. */
  contract?: LearningContract;
}

export interface ProducerLifecycleObservation {
  receiptVersion: '1';
  stage: 'observation' | 'decision';
  producer: LearningProducer;
  workspaceId: string;
  sourceRef: string;
  sourceHash: string;
  source: Record<string, unknown>;
  recordedAt: string;
  contract: LearningContract | null;
  promotionAllowed: boolean;
  validation?: ReturnType<typeof validateLearningContract>;
  /** Immutable evaluated decisions survive subsequent native observations. */
  decisions?: readonly { contract: LearningContract; sourceHash: string; recordedAt: string }[];
  /** Added on read; an unadapted later source update is visibly stale. */
  sourceCurrent?: boolean;
  /** Missing full-contract sections; no synthetic pins, actors or zero-dollar spend. */
  missing: readonly string[];
  evaluation?: unknown;
  evaluationSourceHash?: string;
  evaluationCurrent?: boolean;
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function adaptProducerObservation(producer: LearningProducer, input: ProducerObservationInput): ProducerLifecycleObservation {
  input = structuredClone(input);
  if (!input.workspaceId.trim() || !input.sourceRef.trim() || !Number.isFinite(Date.parse(input.recordedAt))) {
    throw new Error('producer observation requires workspace, source identity and a valid recording time');
  }
  // Exclude our receipt to avoid recursively hashing a previous snapshot.
  const { learning_lifecycle: previousValue, ...fields } = input.source;
  const source = canonical(fields) as Record<string, unknown>;
  const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const decodedPrevious = typeof previousValue === 'string' ? JSON.parse(previousValue) : previousValue;
  const previous = decodedPrevious && typeof decodedPrevious === 'object'
    ? decodedPrevious as Partial<ProducerLifecycleObservation> : undefined;
  const evaluation = input.evaluation === undefined ? previous?.evaluation : input.evaluation;
  const evaluationSourceHash = input.evaluation === undefined ? previous?.evaluationSourceHash : sourceHash;
  const contract = input.contract ?? null;
  const validation = contract ? validateLearningContract(contract) : undefined;
  const bound = input.sourceRef === `${producer}:${contract?.candidate.id}` &&
    contract?.candidate.potScope.workspaceId === input.workspaceId &&
    contract.evidence.some((item) => item.artifactRefs.includes(input.sourceRef));
  const decisions = [...(previous?.decisions ?? [])];
  if (contract) {
    const prior = decisions.find((item) => item.contract.experiment.batteryId === contract.experiment.batteryId);
    if (prior && JSON.stringify(canonical(prior.contract)) !== JSON.stringify(canonical(contract))) {
      throw new Error(`producer common decision is immutable: ${contract.experiment.batteryId}`);
    }
    if (!prior) decisions.push({ contract, sourceHash, recordedAt: input.recordedAt });
  }
  return freezeReceipt({
    receiptVersion: '1', stage: contract ? 'decision' : 'observation', producer,
    workspaceId: input.workspaceId, sourceRef: input.sourceRef,
    sourceHash,
    source, recordedAt: input.recordedAt, contract,
    promotionAllowed: !!(validation?.ok && bound && contract?.decision.verdict === 'accepted' &&
      contract.spend.unsettledUsd === 0 && contract.spend.settledAt),
    ...(validation ? { validation } : {}),
    ...(decisions.length ? { decisions } : {}),
    missing: contract ? [] : ['candidate', 'experiment', 'evidence', 'spend', 'decision'],
    ...(evaluation === undefined ? {} : { evaluation, evaluationSourceHash, evaluationCurrent: evaluationSourceHash === sourceHash }),
  });
}

interface ProducerAdapter {
  (input: ProducerLifecycleInput): LifecycleAdapterResult;
  (input: ProducerObservationInput): ProducerLifecycleObservation;
}

function producerAdapter(producer: LearningProducer): ProducerAdapter {
  return ((input: ProducerLifecycleInput | ProducerObservationInput) =>
    'stage' in input ? adaptProducerObservation(producer, input) : buildProducerLifecycleContract(producer, input)) as ProducerAdapter;
}

/** All production writers and complete-contract callers share these entry points. */
export const adaptScoutOutput = producerAdapter('scout');
export const adaptGymOutput = producerAdapter('gym');
export const adaptCalibrationOutput = producerAdapter('calibration');
export const adaptTransferOutput = producerAdapter('transfer');
export const adaptRegretOutput = producerAdapter('regret');
export const adaptRedQueenOutput = producerAdapter('red-queen');

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
