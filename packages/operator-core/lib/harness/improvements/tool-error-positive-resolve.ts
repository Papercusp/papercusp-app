/**
 * Positive repair resolution for repeated-tool-error filings.
 *
 * A quiet invocation window is not evidence that a rejected tool call was fixed:
 * traffic may simply have stopped.  This module therefore accepts only durable,
 * per-class evidence that names either a deployed contract/handler change or a
 * passing positive probe.  The report-shaped watchdogKey is deliberately not
 * used as the lifecycle identity; classKey is the exact filing identity.
 */

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

export const TOOL_FAILURE_REPAIR_EVIDENCE_KINDS = ['contract-change', 'positive-probe'] as const;
export type ToolFailureRepairEvidenceKind = (typeof TOOL_FAILURE_REPAIR_EVIDENCE_KINDS)[number];

export interface ToolFailureRepairCandidate {
  watchdogKey?: string;
  classKey?: string;
  contractFingerprint?: string;
  deployedRevision?: string;
}

/** A verified change from the revision that emitted the failing class to a new deployed revision. */
export interface ToolFailureContractChangeEvidence {
  classKey: string;
  kind: 'contract-change';
  /** The contract identity of the failing filing, not the replacement contract. */
  contractFingerprint: string;
  fromRevision: string;
  toRevision: string;
  changeRef: string;
  verifiedAt?: string;
}

/** A positive call/schema probe that passed for the exact failing class. */
export interface ToolFailurePositiveProbeEvidence {
  classKey: string;
  kind: 'positive-probe';
  contractFingerprint: string;
  deployedRevision: string;
  probeRef: string;
  passed: true;
  verifiedAt?: string;
}

export type ToolFailureRepairEvidence =
  | ToolFailureContractChangeEvidence
  | ToolFailurePositiveProbeEvidence;

export interface ToolFailureRepairDecision {
  resolve: boolean;
  reason: string;
  /** Real positive completion evidence, present only when resolution is allowed. */
  evidence?: CompletionVerificationEvidence;
  /** Durable completion reference, present only when resolution is allowed. */
  completionRef?: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse the durable repair-evidence shape stored under
 * `payload.toolFailureProbation.repairEvidence`. Malformed or revision-only
 * assertions fail closed and are treated as no evidence.
 */
export function parseToolFailureRepairEvidence(value: unknown): ToolFailureRepairEvidence | null {
  const raw = recordOf(value);
  if (!raw || !nonEmptyString(raw.classKey) || !nonEmptyString(raw.contractFingerprint) || !nonEmptyString(raw.kind)) {
    return null;
  }
  if (raw.kind === 'contract-change') {
    if (!nonEmptyString(raw.fromRevision) || !nonEmptyString(raw.toRevision) || !nonEmptyString(raw.changeRef)) {
      return null;
    }
    return {
      classKey: raw.classKey,
      kind: 'contract-change',
      contractFingerprint: raw.contractFingerprint,
      fromRevision: raw.fromRevision,
      toRevision: raw.toRevision,
      changeRef: raw.changeRef,
      ...(nonEmptyString(raw.verifiedAt) ? { verifiedAt: raw.verifiedAt } : {}),
    };
  }
  if (raw.kind === 'positive-probe') {
    if (!nonEmptyString(raw.deployedRevision) || !nonEmptyString(raw.probeRef) || raw.passed !== true) {
      return null;
    }
    return {
      classKey: raw.classKey,
      kind: 'positive-probe',
      contractFingerprint: raw.contractFingerprint,
      deployedRevision: raw.deployedRevision,
      probeRef: raw.probeRef,
      passed: true,
      ...(nonEmptyString(raw.verifiedAt) ? { verifiedAt: raw.verifiedAt } : {}),
    };
  }
  return null;
}

/** Read the repair evidence from one issue's durable payload. */
export function toolFailureRepairEvidenceOf(payload: unknown): ToolFailureRepairEvidence | null {
  const root = recordOf(payload);
  const probation = recordOf(root?.toolFailureProbation);
  return parseToolFailureRepairEvidence(probation?.repairEvidence);
}

function completionEvidence(
  candidate: Required<Pick<ToolFailureRepairCandidate, 'classKey' | 'contractFingerprint'>>,
  evidence: ToolFailureRepairEvidence,
): CompletionVerificationEvidence {
  const verification = evidence.kind === 'contract-change'
    ? `verified contract/handler change ${evidence.changeRef} (${evidence.fromRevision} → ${evidence.toRevision})`
    : `passing positive probe ${evidence.probeRef} at ${evidence.deployedRevision}`;
  return {
    testsRun: `repeated-tool-error positive repair for ${candidate.classKey}: ${verification}`,
    testResult: `pass — exact class ${candidate.classKey} verified; no absence-only inference`,
    verifiedHow: 'already-passing',
    addedTests: false,
  };
}

/**
 * Pure: decide whether one repeated-tool-error filing has exact positive repair
 * evidence.  A tool-wide or report-key-only assertion cannot pass this function.
 */
export function decideToolFailurePositiveRepair(
  candidate: ToolFailureRepairCandidate,
  evidence: ToolFailureRepairEvidence | null | undefined,
): ToolFailureRepairDecision {
  if (!candidate.watchdogKey?.startsWith('repeated-tool-error:')) {
    return { resolve: false, reason: 'not-repeated-tool-error' };
  }
  if (!nonEmptyString(candidate.classKey)) {
    return { resolve: false, reason: 'no-class-key' };
  }
  if (!nonEmptyString(candidate.contractFingerprint)) {
    return { resolve: false, reason: 'no-contract-fingerprint' };
  }
  if (!nonEmptyString(candidate.deployedRevision)) {
    return { resolve: false, reason: 'no-deployed-revision' };
  }
  if (!evidence) return { resolve: false, reason: 'no-positive-repair-evidence' };
  if (evidence.classKey !== candidate.classKey) {
    return { resolve: false, reason: 'class-key-mismatch' };
  }
  if (evidence.contractFingerprint !== candidate.contractFingerprint) {
    return { resolve: false, reason: 'contract-fingerprint-mismatch' };
  }

  if (evidence.kind === 'contract-change') {
    if (evidence.fromRevision !== candidate.deployedRevision) {
      return { resolve: false, reason: 'contract-change-not-for-failing-revision' };
    }
    if (evidence.toRevision === evidence.fromRevision) {
      return { resolve: false, reason: 'contract-change-did-not-change-revision' };
    }
  } else if (evidence.deployedRevision !== candidate.deployedRevision) {
    return { resolve: false, reason: 'positive-probe-not-for-failing-revision' };
  }

  const completion = completionEvidence(
    { classKey: candidate.classKey, contractFingerprint: candidate.contractFingerprint },
    evidence,
  );
  const reference = evidence.kind === 'contract-change' ? evidence.changeRef : evidence.probeRef;
  return {
    resolve: true,
    reason: `positive ${evidence.kind} evidence for exact class ${candidate.classKey} (${reference})`,
    evidence: completion,
    completionRef: `Auto-resolved repeated-tool-error class ${candidate.classKey} on ${evidence.kind} evidence: ${reference}.`,
  };
}
