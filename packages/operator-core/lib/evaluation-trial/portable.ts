/**
 * Lossless edge adapters for evaluation evidence (P-005 / D-006).
 *
 * These shapes are projections OF the canonical Papercusp trial + evidence
 * manifest, not a second authority. The portable object carries the complete
 * canonical payload in a namespaced field, and then adds the consumer-friendly
 * Inspect / OpenTelemetry/OpenInference view on top. That makes the adapter
 * lossless while keeping identity, lineage and conclusions owned by
 * `EvaluationTrial`, `EvidenceManifest`, and `PreservedEvidence`.
 */

import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import type { EvidenceManifest, PreservedEvidence, TrajectoryStep } from './evidence';
import { computeTrialIdentity } from './identity';
import type { EvaluationTrial } from './schema';

export interface CanonicalPortablePayload {
  trial: EvaluationTrial;
  evidence: PreservedEvidence;
  manifest: EvidenceManifest;
}

export interface InspectCompatibleEvaluation {
  format: 'inspect-compatible';
  schemaVersion: 'papercusp.inspect-projection.v1';
  sample: {
    id: string;
    input: string;
    target?: string;
    metadata: Record<string, unknown>;
  };
  messages: Array<{
    role: string;
    content: string;
    metadata: Record<string, unknown>;
  }>;
  files: Array<{
    name: string;
    ref: string | null;
    mediaType: string;
    bytes: number;
    sha256: string;
  }>;
  papercusp: CanonicalPortablePayload;
}

export interface PortableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    timeUnixNano?: string;
    attributes: Record<string, string | number | boolean>;
  }>;
}

export interface OpenTelemetryOpenInferenceTrace {
  format: 'opentelemetry-openinference-compatible';
  schemaVersion: 'papercusp.otel-openinference-projection.v1';
  resourceSpans: Array<{
    resource: { attributes: Record<string, string | number | boolean> };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: PortableSpan[];
    }>;
  }>;
  papercusp: CanonicalPortablePayload;
}

function roleForInspect(step: TrajectoryStep): string {
  if (step.role) return step.role;
  switch (step.kind) {
    case 'input':
      return 'user';
    case 'model-output':
      return 'assistant';
    case 'tool-call':
    case 'tool-result':
      return 'tool';
    default:
      return 'system';
  }
}

function firstInput(evidence: PreservedEvidence): string {
  return evidence.trajectory.find((candidate) => candidate.kind === 'input')?.content ?? '';
}

function isoToUnixNano(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return String(BigInt(ms) * 1_000_000n);
}

function shortHex(input: string, length: number): string {
  return input.replace(/[^0-9a-f]/gi, '').padEnd(length, '0').slice(0, length).toLowerCase();
}

function canonicalPayload(
  trial: EvaluationTrial,
  evidence: PreservedEvidence,
  manifest: EvidenceManifest,
): CanonicalPortablePayload {
  return { trial, evidence, manifest };
}

/** Project to an Inspect-readable sample while preserving the canonical payload verbatim. */
export function toInspectCompatibleEvaluation(
  trial: EvaluationTrial,
  evidence: PreservedEvidence,
  manifest: EvidenceManifest,
): InspectCompatibleEvaluation {
  const identity = computeTrialIdentity(trial);

  return {
    format: 'inspect-compatible',
    schemaVersion: 'papercusp.inspect-projection.v1',
    sample: {
      id: identity.trialKey,
      input: firstInput(evidence),
      ...(evidence.submission === undefined ? {} : { target: evidence.submission ?? '' }),
      metadata: {
        subjectKey: identity.subjectKey,
        bindingHash: identity.bindingHash,
        evidenceRootHash: manifest.rootHash,
        sourceRef: trial.lineage.sourceRef,
        outcomeStatus: trial.outcome.status,
        outcomeResolved: trial.outcome.resolved ?? null,
      },
    },
    messages: evidence.trajectory.map((step) => ({
      role: roleForInspect(step),
      content: step.content,
      metadata: {
        index: step.index,
        kind: step.kind,
        at: step.at ?? null,
        name: step.name ?? null,
        metadata: step.metadata ?? null,
      },
    })),
    files: evidence.artifacts.map((artifact) => ({
      name: artifact.id,
      ref: artifact.ref ?? null,
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    papercusp: canonicalPayload(trial, evidence, manifest),
  };
}

/** Project to OTEL/OpenInference-shaped spans while preserving the canonical payload verbatim. */
export function toOpenTelemetryOpenInferenceTrace(
  trial: EvaluationTrial,
  evidence: PreservedEvidence,
  manifest: EvidenceManifest,
): OpenTelemetryOpenInferenceTrace {
  const identity = computeTrialIdentity(trial);
  const traceId = shortHex(identity.bindingHash, 32);
  const rootSpanId = shortHex(identity.trialKey + identity.bindingHash, 16);
  const evidenceJson = canonicalJson({ evidence, manifest });

  const rootSpan: PortableSpan = {
    traceId,
    spanId: rootSpanId,
    name: 'papercusp.evaluation_trial',
    startTimeUnixNano: isoToUnixNano(trial.startedAt),
    endTimeUnixNano: isoToUnixNano(trial.finishedAt),
    attributes: {
      'openinference.span.kind': 'CHAIN',
      'papercusp.trial_key': identity.trialKey,
      'papercusp.subject_key': identity.subjectKey,
      'papercusp.binding_hash': identity.bindingHash,
      'papercusp.evidence_root_hash': manifest.rootHash,
      'papercusp.contract_version': trial.contractVersion,
      'papercusp.source_ref': trial.lineage.sourceRef,
      'llm.model_name': trial.system.modelId ?? '',
      'papercusp.outcome.status': trial.outcome.status,
      'papercusp.evidence.canonical_json': evidenceJson,
    },
    events: evidence.trajectory.map((step) => ({
      name: `papercusp.trajectory.${step.kind}`,
      timeUnixNano: isoToUnixNano(step.at),
      attributes: {
        'papercusp.step.index': step.index,
        'papercusp.step.kind': step.kind,
        'papercusp.step.role': step.role ?? '',
        'papercusp.step.name': step.name ?? '',
        'papercusp.step.content': step.content,
        'papercusp.step.metadata_json': canonicalJson(step.metadata ?? null),
      },
    })),
  };

  return {
    format: 'opentelemetry-openinference-compatible',
    schemaVersion: 'papercusp.otel-openinference-projection.v1',
    resourceSpans: [
      {
        resource: {
          attributes: {
            'service.name': 'papercusp-evaluation',
            'papercusp.evidence_domain': manifest.domain,
            'papercusp.privacy': manifest.privacy,
          },
        },
        scopeSpans: [
          {
            scope: { name: 'papercusp.evaluation-trial', version: trial.contractVersion },
            spans: [rootSpan],
          },
        ],
      },
    ],
    papercusp: canonicalPayload(trial, evidence, manifest),
  };
}
