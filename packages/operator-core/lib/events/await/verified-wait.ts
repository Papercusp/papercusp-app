/**
 * Shared contract for waits whose completion event is produced asynchronously.
 *
 * Push delivery remains the primary path.  This certificate gives a bounded
 * timeout wake enough information to re-check the producer authoritatively and
 * decide whether to park again or surface a stalled/absent producer for
 * ownership takeover.
 */

export const PRODUCER_HEALTH_CERTIFICATE_VERSION = 1 as const;

export interface ProducerIdentity {
  /** Stable producer family, for example `green-checkpoint`. */
  kind: string;
  /** Stable instance/run identifier within the family. */
  id: string;
}

export interface ProducerOwnerReference {
  ownerId: string | null;
  workItemId: string | null;
}

export type ProgressLeaseSourceKind =
  | 'state-cell'
  | 'tool-call-delta'
  | 'checkpoint-revision'
  | 'managed-task-advance'
  | 'claim-transition';

export type ProgressLeaseRemedy =
  | { kind: 'spec-widen'; instructions: string }
  | { kind: 'outside-lane-placement'; instructions: string }
  | { kind: 'leader-claim'; workItemId?: string | null; harness?: string | null }
  | {
      kind: 'create-unblock-item';
      title: string;
      summary?: string | null;
      harness: string;
    };

export interface ProgressLeaseEvidence {
  writer: string;
  units: string;
  observedAtMs: number;
  valuePreview: unknown;
  valueFingerprint: string;
  reference: { tool: string; args: Record<string, unknown>; path: string };
  uncertainty: string | null;
}

export interface ProgressLeaseRemedyOutcome {
  kind: ProgressLeaseRemedy['kind'];
  disposition: 'executed' | 'surfaced' | 'failed';
  summary: string;
  workItemId?: string | null;
}

export interface ProgressLeaseTransition {
  state: 'armed' | 'progress' | 'miss' | 'owner-wake' | 'remedy';
  atMs: number;
  writer: string;
  units: string;
  missCount: number;
  evidence: ProgressLeaseEvidence;
  wake?: { attempted: boolean; queued: number; staged: number };
  remedy?: ProgressLeaseRemedyOutcome;
}

export interface ProgressLeaseState {
  leaseId: string;
  sourceKind: ProgressLeaseSourceKind;
  resolver: {
    tool: string;
    args: Record<string, unknown>;
    path: string;
    op: 'changed' | 'increased';
    workspaceId: string;
    harnessSlug: string | null;
    role: string;
    onBehalfOf: string;
  };
  subscriberId: string;
  writer: string;
  units: string;
  baselineFingerprint: string;
  latestEvidence: ProgressLeaseEvidence;
  missCount: number;
  remedyAfterMisses: number;
  remedy: ProgressLeaseRemedy;
  history: ProgressLeaseTransition[];
}

export interface ProducerHealthCertificate {
  version: typeof PRODUCER_HEALTH_CERTIFICATE_VERSION;
  producer: ProducerIdentity;
  owner: ProducerOwnerReference;
  /** When the certificate was constructed. */
  issuedAtMs: number;
  /** Latest authoritative progress known when the wait was armed. */
  lastProgressAtMs: number | null;
  /** Latest authoritative completion-event fire known when the wait was armed. */
  lastFireAtMs: number | null;
  /** Maximum expected interval between producer progress signals. */
  expectedCadenceMs: number;
  /** Earliest instant at which the fallback verifier may classify a timeout. */
  verificationDeadlineMs: number;
  /** Producer-family inputs needed by its authoritative verifier. */
  details?: Record<string, unknown>;
  /** Delegated-wait progress contract. Absent on legacy producer-health waits. */
  progressLease?: ProgressLeaseState;
}

/**
 * A producer's configured routine is not the same thing as an in-flight run.
 * The checkpoint adapter uses these states when the authoritative run probe can
 * tell us that the routine is idle, or cannot tell whether a run exists.
 *
 * EI-21502021074096764: `paused` is split out from `idle` for AGENT LEGIBILITY,
 * not for behaviour — both classify as `expected-idle`/`re-await`. A
 * deliberately paused producer previously reported `producerState: "idle"`
 * alongside `active: false`, `routineActive: false`, `candidate: null` and
 * `verdictStatus: null`. Every one of those five fields reads as "the thing you
 * are waiting on is not running", so a reader applying the standard
 * stranded-blocker rule ("if the blocker is not progressing, clearing it is now
 * YOUR responsibility") is walked straight toward taking over a gate that a live
 * owner had paused on purpose. The pause provenance WAS present in the same
 * payload (`routinePauseReason`), but as one explanatory field against five
 * alarming ones. `paused` puts the answer in the token the reader anchors on.
 */
export type ProducerHealthObservationState = "active" | "idle" | "paused" | "unknown";

export interface ProducerHealthObservation {
  checkedAtMs: number;
  /** False only when the authoritative producer record no longer exists. */
  producerPresent: boolean;
  /**
   * Optional source-specific state. `idle` and `unknown` are deliberately
   * non-takeover outcomes: a configured producer with no candidate is not
   * evidence that its owner is stalled.
   */
  state?: ProducerHealthObservationState;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  /** Authoritative completion state; does not infer completion from liveness. */
  completedAtMs: number | null;
  /** Source-specific evidence suitable for a leader brief or checkpoint. */
  evidence?: Record<string, unknown>;
}

export type VerifiedWaitTimeoutClassification =
  | "progressing"
  | "expected-idle"
  | "unknown"
  | "stalled"
  | "absent"
  | "already-complete";

export type VerifiedWaitNextAction = "re-await" | "resume" | "wake-owner-or-takeover";

export interface VerifiedWaitTimeoutResult {
  classification: VerifiedWaitTimeoutClassification;
  nextAction: VerifiedWaitNextAction;
  producer: ProducerIdentity;
  owner: ProducerOwnerReference;
  checkedAtMs: number;
  verificationDeadlineMs: number;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  evidence?: Record<string, unknown>;
}

function latestTimestamp(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? Math.max(...present) : null;
}

/**
 * Classify one authoritative producer re-check after the certificate deadline.
 * A timeout is deliberately not treated as failure by itself.
 */
export function classifyVerifiedWaitTimeout(
  certificate: ProducerHealthCertificate,
  observation: ProducerHealthObservation,
): VerifiedWaitTimeoutResult {
  if (certificate.expectedCadenceMs <= 0 || !Number.isFinite(certificate.expectedCadenceMs)) {
    throw new RangeError("expectedCadenceMs must be a finite positive number");
  }
  if (observation.checkedAtMs < certificate.verificationDeadlineMs) {
    throw new RangeError("producer health cannot be classified before the verification deadline");
  }

  const base = {
    producer: certificate.producer,
    owner: certificate.owner,
    checkedAtMs: observation.checkedAtMs,
    verificationDeadlineMs: certificate.verificationDeadlineMs,
    lastProgressAtMs: observation.lastProgressAtMs,
    lastFireAtMs: observation.lastFireAtMs,
    ...(observation.evidence ? { evidence: observation.evidence } : {}),
  };

  if (observation.completedAtMs != null || observation.lastFireAtMs != null) {
    return { ...base, classification: "already-complete", nextAction: "resume" };
  }

  // A routine row being active only means it is configured to run. When its
  // authoritative adapter reports no candidate/run, the correct timeout
  // action is to re-await, not to wake someone for a takeover. `unknown` is
  // likewise conservative when the run probe could not establish a state.
  // `paused` is deliberately handled with `idle` and NOT given a classification
  // of its own: an explicit pause is the strongest possible evidence that no run
  // is expected right now, so the correct remedy is identical (`re-await`). The
  // split exists only so the state token the reader sees says WHY no run is
  // expected. Keeping one classification also means no persisted
  // `timeout_verification` row, takeover filter, or consumer branch has to learn
  // a new value (EI-21502021074096764).
  if (observation.state === "idle" || observation.state === "paused") {
    return { ...base, classification: "expected-idle", nextAction: "re-await" };
  }
  if (observation.state === "unknown") {
    return { ...base, classification: "unknown", nextAction: "re-await" };
  }
  // EI-21045433666635330: `active` is the adapter's OWN authoritative liveness probe
  // (e.g. a systemd/run-lock read) confirming the producer is executing right now —
  // strictly stronger evidence than the timestamp-cadence heuristic below, which only
  // infers liveness from how recently a progress/fire marker moved. A genuinely active
  // producer can go quiet on that heuristic (a long-running phase with no new progress
  // line inside `expectedCadenceMs`) without being stalled at all; falling through to
  // the heuristic in that case is exactly what misclassified an active writer as
  // stalled. An explicit `active` observation must win outright, never be weighed
  // against a staleness inference it already supersedes.
  if (observation.state === "active") {
    return { ...base, classification: "progressing", nextAction: "re-await" };
  }

  if (!observation.producerPresent) {
    return { ...base, classification: "absent", nextAction: "wake-owner-or-takeover" };
  }

  const baselineActivity = latestTimestamp(
    certificate.lastProgressAtMs,
    certificate.lastFireAtMs,
    certificate.issuedAtMs,
  );
  const observedActivity = latestTimestamp(observation.lastProgressAtMs, observation.lastFireAtMs);
  const advanced = observedActivity != null && baselineActivity != null && observedActivity > baselineActivity;
  const fresh =
    observedActivity != null && observation.checkedAtMs - observedActivity <= certificate.expectedCadenceMs;

  if (advanced || fresh) {
    return { ...base, classification: "progressing", nextAction: "re-await" };
  }

  return { ...base, classification: "stalled", nextAction: "wake-owner-or-takeover" };
}
