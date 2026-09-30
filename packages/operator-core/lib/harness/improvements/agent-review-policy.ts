/**
 * Agent-review routing policy (abolish-human-review-agent-review-only-2026-08-02 D-003).
 *
 * This leaf owns the two complementary queue predicates:
 *   - ordinary self-select excludes pending/revision-requested review work;
 *   - the reviewer lane admits pending review work only.
 *
 * It deliberately has no persistence dependencies. Both the queue implementation and
 * the lifecycle module import this file so the status vocabulary cannot drift.
 */
import type { OrgSql } from '../../work-items';
import {
  activeExternalBlockers,
  externalBlockerCapabilityPolicy,
  type ExternalBlockerCapability,
  type ExternalBlockerRecord,
} from '../../external-blockers';

export const AGENT_REVIEW_STATUSES = ['pending', 'revision-requested', 'approved'] as const;
export type AgentReviewStatus = (typeof AGENT_REVIEW_STATUSES)[number];

/**
 * Migration 864 cannot recover an originating principal for every legacy park.
 * The sentinel is deliberately not a routable owner id: revision handling treats
 * it as an instruction to release the item back to normal implementation instead
 * of assigning or waking a nonexistent submitter.
 */
export const LEGACY_AGENT_REVIEW_SUBMITTER = 'system:legacy-agent-review' as const;

export interface AgentReviewState {
  status: AgentReviewStatus;
  submittedBy: string;
  ledgerIdeaId: string;
  round: number;
}

/**
 * Versioned contract consumed by ordinary implementation self-selection.
 *
 * `unknown` is not a softer spelling of ready: it means the remaining problem,
 * its current evidence, or its acceptance check has not yet been established.
 * `not-ready` is an affirmative contradiction (for example a revision request,
 * terminal cited evidence, or a repair that is already present but undeployed).
 * `ready` is reserved for an explicit review approval or an existing immediate
 * capture-policy path. The `source` + `reason` fields keep those two bases honest.
 *
 * Rows without this payload predate the contract and retain the legacy claim
 * behavior. Presence of the key enrolls a row; malformed/unknown versions are
 * therefore held by the SQL floor instead of being mistaken for legacy rows.
 */
export const IMPLEMENTATION_READINESS_SCHEMA_VERSION = 'implementation-readiness-v1' as const;
export const IMPLEMENTATION_READINESS_STATUSES = ['unknown', 'not-ready', 'ready'] as const;
export type ImplementationReadinessStatus = (typeof IMPLEMENTATION_READINESS_STATUSES)[number];
export const IMPLEMENTATION_READINESS_SOURCES = ['capture-policy', 'agent-review', 'triage-freshness'] as const;
export type ImplementationReadinessSource = (typeof IMPLEMENTATION_READINESS_SOURCES)[number];

export interface ImplementationReadinessEvidence {
  review?: {
    submittedBy?: string;
    reviewer?: string;
    round: number;
    grade?: number;
  };
  deployment?: {
    state: 'current' | 'stale' | 'unknown';
    toolName?: string;
    relPath?: string;
    unknownReason?: string;
  };
  citations?: {
    citedIds: string[];
    staleIds: string[];
    unresolvedIds: string[];
    circularIds: string[];
    lookupFailedIds: string[];
  };
}

export interface ImplementationReadinessState {
  schemaVersion: typeof IMPLEMENTATION_READINESS_SCHEMA_VERSION;
  status: ImplementationReadinessStatus;
  source: ImplementationReadinessSource;
  reason: string;
  updatedAt: string;
  evidence?: ImplementationReadinessEvidence;
}

export function createImplementationReadiness(
  input: Omit<ImplementationReadinessState, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ImplementationReadinessState {
  return {
    schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
    status: input.status,
    source: input.source,
    reason: input.reason,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

/** Read only a complete current-version payload; malformed enrolled rows stay held in SQL. */
export function readImplementationReadiness(payload: unknown): ImplementationReadinessState | null {
  const row = record(record(payload).implementationReadiness);
  if (row.schemaVersion !== IMPLEMENTATION_READINESS_SCHEMA_VERSION) return null;
  if (!IMPLEMENTATION_READINESS_STATUSES.includes(row.status as ImplementationReadinessStatus)) return null;
  if (!IMPLEMENTATION_READINESS_SOURCES.includes(row.source as ImplementationReadinessSource)) return null;
  if (typeof row.reason !== 'string' || !row.reason.trim()) return null;
  if (typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return null;
  const evidence = record(row.evidence);
  return {
    schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
    status: row.status as ImplementationReadinessStatus,
    source: row.source as ImplementationReadinessSource,
    reason: row.reason,
    updatedAt: row.updatedAt,
    ...(Object.keys(evidence).length > 0 ? { evidence: evidence as ImplementationReadinessEvidence } : {}),
  };
}

const STRICT_OWNER_CAPABILITIES = new Set<ExternalBlockerCapability>([
  'credential',
  'physical-device',
  'external-service-action',
  'product-decision',
]);

// Product decisions are strict owner capabilities for typed blocker/lifecycle
// writes, but resolve-core deliberately sends them through agent review. Keep
// that review-specific distinction local instead of weakening the shared
// structured-owner-ask validator.
const AGENT_REVIEW_OWNER_ACTION_CAPABILITIES = new Set<ExternalBlockerCapability>([
  'credential',
  'physical-device',
  'external-service-action',
]);

export function isStrictOwnerActionCapability(value: unknown): value is ExternalBlockerCapability {
  return typeof value === 'string' && STRICT_OWNER_CAPABILITIES.has(value as ExternalBlockerCapability);
}

function isAgentReviewOwnerActionCapability(value: unknown): value is ExternalBlockerCapability {
  return typeof value === 'string' && AGENT_REVIEW_OWNER_ACTION_CAPABILITIES.has(value as ExternalBlockerCapability);
}

export function hasStrictOwnerAction(payloadValue: unknown): boolean {
  const payload = record(payloadValue);
  if (payload.needsOwnerAction === true) return true;
  if (isAgentReviewOwnerActionCapability(payload.humanCapability)) return true;
  return activeExternalBlockers(payload).some((blocker) => isAgentReviewOwnerActionCapability(blocker.capability));
}

/**
 * A durable owner ask encoded on the existing typed external-blocker surface.
 * The record already carries the four facts EI-13766 requires, under the shared
 * blocker vocabulary rather than a second parallel payload object:
 *   question    = summary
 *   askedOf     = the capability policy's resolutionOwner
 *   askedAt     = createdAt (createdBy records the asker)
 *   unblockedBy = nextVerb (ref is the stable condition identity)
 */
export interface StructuredOwnerAsk {
  blocker: ExternalBlockerRecord;
  question: string;
  askedOf: ReturnType<typeof externalBlockerCapabilityPolicy>['resolutionOwner'];
  askedAt: string;
  askedBy: string;
  unblockedBy: string;
}

export function readStructuredOwnerAsk(payloadValue: unknown): StructuredOwnerAsk | null {
  for (const blocker of activeExternalBlockers(payloadValue)) {
    if (blocker.kind !== 'human' || !isStrictOwnerActionCapability(blocker.capability)) continue;
    const question = blocker.summary.trim();
    const askedBy = blocker.createdBy.trim();
    const unblockedBy = blocker.nextVerb?.trim() ?? '';
    if (!question || !askedBy || !unblockedBy || !Number.isFinite(Date.parse(blocker.createdAt))) continue;
    return {
      blocker,
      question,
      askedOf: externalBlockerCapabilityPolicy(blocker.capability).resolutionOwner,
      askedAt: blocker.createdAt,
      askedBy,
      unblockedBy,
    };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readAgentReviewState(payload: unknown): AgentReviewState | null {
  const value = record(payload).agentReview;
  const row = record(value);
  if (!AGENT_REVIEW_STATUSES.includes(row.status as AgentReviewStatus)) return null;
  if (typeof row.submittedBy !== 'string' || !row.submittedBy.trim()) return null;
  if (typeof row.ledgerIdeaId !== 'string' || !row.ledgerIdeaId.trim()) return null;
  if (!Number.isInteger(row.round) || Number(row.round) < 1) return null;
  return {
    status: row.status as AgentReviewStatus,
    submittedBy: row.submittedBy,
    ledgerIdeaId: row.ledgerIdeaId,
    round: Number(row.round),
  };
}

/**
 * Narrow, server-only authority to claim one exact pending review. It is minted
 * after the reviewer lane checks the work-item and consumed by the shared claim
 * writer; the SQL still compares the full review snapshot so a concurrent grade,
 * resubmit, or submitter change invalidates the bypass.
 */
export interface AgentReviewClaimAdmission {
  readonly itemId: string;
  readonly reviewer: string;
  readonly harnessSlug: string;
  readonly submittedBy: string;
  readonly ledgerIdeaId: string;
  readonly round: number;
}

const agentReviewClaimAdmissions = new WeakSet<object>();

export function mintAgentReviewClaimAdmission(input: {
  itemId: string;
  reviewer: string;
  harnessSlug: string;
  review: AgentReviewState;
}): AgentReviewClaimAdmission | null {
  const itemId = input.itemId.trim();
  const reviewer = input.reviewer.trim();
  const harnessSlug = input.harnessSlug.trim();
  const review = input.review;
  if (
    !itemId ||
    !reviewer ||
    !harnessSlug ||
    review.status !== 'pending' ||
    review.submittedBy === reviewer ||
    !review.ledgerIdeaId.trim() ||
    !Number.isInteger(review.round) ||
    review.round < 1
  ) {
    return null;
  }
  const admission = Object.freeze({
    itemId,
    reviewer,
    harnessSlug,
    submittedBy: review.submittedBy,
    ledgerIdeaId: review.ledgerIdeaId,
    round: review.round,
  });
  agentReviewClaimAdmissions.add(admission);
  return admission;
}

export function isAgentReviewClaimAdmission(value: unknown): value is AgentReviewClaimAdmission {
  return typeof value === 'object' && value !== null && agentReviewClaimAdmissions.has(value);
}

export function matchesAgentReviewClaimAdmission(
  value: unknown,
  item: { id: string; harness?: string | null; payload: unknown },
  reviewer: string,
): value is AgentReviewClaimAdmission {
  if (
    !isAgentReviewClaimAdmission(value) ||
    value.itemId !== item.id ||
    value.reviewer !== reviewer ||
    value.harnessSlug !== item.harness
  ) {
    return false;
  }
  const current = readAgentReviewState(item.payload);
  return current?.status === 'pending' &&
    current.submittedBy !== reviewer &&
    current.submittedBy === value.submittedBy &&
    current.ledgerIdeaId === value.ledgerIdeaId &&
    current.round === value.round;
}

/**
 * Admission-floor exception for an already-validated reviewer capability. The
 * UPDATE must still see `admission='pending'` and the same pending review payload
 * the reviewer inspected; an ordinary claim gets no such exception.
 */
export function agentReviewPendingAdmissionSql(
  sql: OrgSql,
  value: unknown,
  columns: { payload?: 'payload' | 'target.payload'; admission?: 'admission' | 'target.admission' } = {},
) {
  if (!isAgentReviewClaimAdmission(value)) return sql`FALSE`;
  const payload = sql.unsafe(columns.payload ?? 'payload');
  const admission = sql.unsafe(columns.admission ?? 'admission');
  return sql`(
    ${admission} = 'pending'
    AND ${payload} -> 'agentReview' ->> 'status' = 'pending'
    AND ${payload} -> 'agentReview' ->> 'submittedBy' = ${value.submittedBy}
    AND ${payload} -> 'agentReview' ->> 'ledgerIdeaId' = ${value.ledgerIdeaId}
    AND ${payload} -> 'agentReview' ->> 'round' = ${String(value.round)}
    AND ${value.submittedBy} <> ${value.reviewer}
  )`;
}

export interface AgentReviewCandidate {
  kind: string;
  origin?: string | null;
  payload?: unknown;
}

/**
 * Pure enrollment gate. Product decisions remain agent-reviewable by explicit
 * decision; only capabilities an agent cannot supply stay on the owner-capability
 * path. Remote rows remain owned by their authoring peer and never enter local review.
 */
export function agentReviewEligibility(candidate: AgentReviewCandidate):
  | { eligible: true }
  | { eligible: false; reason: 'not-review-kind' | 'remote-owned' | 'observation' | 'owner-capability' } {
  const payload = record(candidate.payload);
  // D-004: enrollment is a lifecycle layered onto the existing work-item. It must
  // preserve historical kinds rather than coercing review work to `change`.
  if (!['bug', 'change', 'task', 'feature'].includes(candidate.kind)) {
    return { eligible: false, reason: 'not-review-kind' };
  }
  if (candidate.origin === 'remote') return { eligible: false, reason: 'remote-owned' };
  if (payload.lane === 'observation') return { eligible: false, reason: 'observation' };
  if (hasStrictOwnerAction(payload)) {
    return { eligible: false, reason: 'owner-capability' };
  }
  return { eligible: true };
}

/**
 * Versioned readiness floor for ordinary self-selection. An absent key is the
 * explicit legacy exception; a present key passes only when this reader knows
 * its schema and it carries an affirmative ready verdict.
 */
export function implementationReadinessNormalExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'ei.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`(
    NOT (COALESCE(${payload}, '{}'::jsonb) ? 'implementationReadiness')
    OR (
      COALESCE(${payload}, '{}'::jsonb) #>> '{implementationReadiness,schemaVersion}' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
      AND COALESCE(${payload}, '{}'::jsonb) #>> '{implementationReadiness,status}' = 'ready'
    )
  )`;
}

/** Normal implementation lane: review/readiness work is invisible until approved. */
export function agentReviewNormalExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'ei.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`(
    (
      COALESCE(
        COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'revision-requested',
        FALSE
      )
      AND COALESCE(
        COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' = ${LEGACY_AGENT_REVIEW_SUBMITTER},
        FALSE
      )
    )
    OR (
      COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'pending'
      AND COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' IS DISTINCT FROM 'revision-requested'
      AND ${implementationReadinessNormalExclusionSql(sql, payloadCol)}
    )
  )`;
}

/** Reviewer lane: only submitted work, never revision work or approved work. */
export function agentReviewPendingSelectorSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'payload' = 'wi.payload',
) {
  const payload = sql.unsafe(payloadCol);
  return sql`COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'pending'`;
}
