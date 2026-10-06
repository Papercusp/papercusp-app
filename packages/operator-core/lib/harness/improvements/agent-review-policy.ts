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
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import type { OrgSql } from '../../work-items';
import { assertHoldRegistered } from '../../hold-registry';
import { ALL_SUCCESSFUL_STATUSES, ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import { WORK_ITEM_PRESENTATION_STAGES, type WorkItemPresentationStage } from '../../work-item-presentation-contract';
export { WORK_ITEM_PRESENTATION_STAGES, type WorkItemPresentationStage } from '../../work-item-presentation-contract';
import {
  BUG_REPRODUCTION_KINDS,
  BUG_REPRODUCTION_SCHEMA_VERSION,
  readBugReproductionReceipt,
  readStoredBugReproduction,
  type BugReproductionReceipt,
} from '../../attention/bug-reproduction';
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
/**
 * `creation-enrollment` (observation-candidate-acceptance-promotion D-009a / D-011):
 * the issue-family insert seam stamps every new non-observation row that arrived
 * without a verdict. It is always `unknown` — a producer with no acceptance
 * evidence can never write `ready`. Until P-007 records the enforcement cutover,
 * claim floors treat it exactly like the absent-key legacy exception (see
 * `implementationReadinessIsLegacyEquivalent`), so enrolling producers changes no
 * claimability on its own; it only makes the intake stage measurable.
 */
export const IMPLEMENTATION_READINESS_SOURCES = [
  'capture-policy',
  'agent-review',
  'triage-freshness',
  'creation-enrollment',
] as const;
export type ImplementationReadinessSource = (typeof IMPLEMENTATION_READINESS_SOURCES)[number];

/**
 * Current acceptance contract (R-4 / R-20 / R-21). It lives INSIDE the existing
 * readiness evidence object — there is no parallel acceptance store. A producer
 * may write a partial proposal; only `sealImplementationAcceptance` (an
 * independent reviewer or an allowlisted existing policy) produces a qualifying
 * contract, and the contract is bound to the source revision it judged.
 */
export const IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION = 'implementation-acceptance-v1' as const;

/**
 * Existing immediate policies allowed to write acceptance (D-003). Each must
 * still supply every contract field; the policy only replaces the reviewer as the
 * authority. Duplicate admission, severity/security tagging, explicit assignment
 * and confidence are deliberately absent: none of them is acceptance authority.
 */
export const IMPLEMENTATION_ACCEPTANCE_POLICIES = ['trusted-tool-failure-promotion', 'completion-verification'] as const;
/**
 * P-007 Phase C (D-028): the policy that admits a completion verification task. Valid
 * ONLY on a row whose own verification block is a `completion` check of the same subject
 * the contract names: what is to be verified is fully determined by the subject's
 * recorded completion, so no reviewer judgment is replaced.
 */
export const COMPLETION_VERIFICATION_POLICY = 'completion-verification' as const;
export type ImplementationAcceptancePolicy = (typeof IMPLEMENTATION_ACCEPTANCE_POLICIES)[number];

export type ImplementationAcceptanceAuthority =
  | { kind: 'agent-review'; reviewer: string; submittedBy: string; round: number }
  | { kind: 'policy'; policy: ImplementationAcceptancePolicy; actor: string };

/** What a producer or reviewer judges: the concrete, executable claim. */
export interface ImplementationAcceptanceProposal {
  problem: string;
  evidence: string[];
  outcome: string;
  scope: string;
  completionCheck: string;
}

/**
 * P-006 (unified-bug-pipeline D-019): acceptance is the ONE verification stage,
 * and the check it applies is chosen by kind. A bug needs a reproduction receipt
 * (D-023, or the D-024/D-011 encounter receipt recorded at filing). A change,
 * feature or task needs proposal review: agent-review authority from a reviewer
 * who is not the submitter. No other path makes a contract qualify.
 */
export type CandidateStageCheck = 'reproduction' | 'proposal-review';

export function candidateStageCheckForKind(kind: string): CandidateStageCheck {
  return kind === 'bug' ? 'reproduction' : 'proposal-review';
}

export type ImplementationAcceptanceVerification =
  | { check: 'reproduction'; receipt: BugReproductionReceipt }
  | { check: 'proposal-review' }
  /** P-007 Phase C (D-028): a completion verification task, admitted by policy. */
  | { check: 'completion'; subject: string };

export interface ImplementationAcceptanceContract extends ImplementationAcceptanceProposal {
  contractVersion: typeof IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION;
  authority: ImplementationAcceptanceAuthority;
  reason: string;
  sourceRevision: string;
  acceptedAt: string;
  /** Which kind-specific check cleared the contract (P-006). */
  verification: ImplementationAcceptanceVerification;
}

export const IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS = [
  'problem',
  'evidence',
  'outcome',
  'scope',
  'completionCheck',
] as const;
export const IMPLEMENTATION_ACCEPTANCE_SEAL_FIELDS = [
  'contractVersion',
  'authority',
  'reason',
  'sourceRevision',
  'acceptedAt',
] as const;
export type ImplementationAcceptanceField =
  | (typeof IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS)[number]
  | (typeof IMPLEMENTATION_ACCEPTANCE_SEAL_FIELDS)[number]
  /** The kind-specific check (P-006) did not pass: reported by readers, never by the seal. */
  | 'verification';

export interface ImplementationAcceptanceSource {
  /** Storage kind (`item_kind`): bug/change/task/feature. */
  kind: string;
  title: string;
  /** Storage `summary` (the issue body). */
  summary?: string | null;
}

const ACCEPTANCE_SOURCE_REVISION_PREFIX = 'src-v1:';
const ACCEPTANCE_SOURCE_REVISION_SEPARATOR = '\u001f';

/**
 * Revision of the candidate content an acceptance judged. Any edit to the kind,
 * title or body yields a different revision, which makes a sealed acceptance
 * stale (R-21). The SQL twin computes the identical value from the row columns,
 * so no writer can bypass invalidation by skipping a hook.
 */
export function acceptanceSourceRevision(source: ImplementationAcceptanceSource): string {
  const material = [source.kind, source.title, source.summary ?? ''].join(ACCEPTANCE_SOURCE_REVISION_SEPARATOR);
  return `${ACCEPTANCE_SOURCE_REVISION_PREFIX}${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export interface ImplementationReadinessEvidence {
  /**
   * Acceptance proposal or sealed contract. A proposal (no authority/revision)
   * keeps the row in intake; only a complete, independently authorized,
   * revision-current contract is qualifying acceptance.
   */
  acceptance?: Partial<ImplementationAcceptanceContract>;
  /**
   * P-009 (D-019): the contract an undone intake promotion had sealed. Kept for
   * audit and re-review under a key no claim floor reads, so a reversed row is
   * not-ready and never counts as accepted.
   */
  reversedAcceptance?: Partial<ImplementationAcceptanceContract>;
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

const IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';
const IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN = new RegExp(IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE);

export function createImplementationReadiness(
  input: Omit<ImplementationReadinessState, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): ImplementationReadinessState {
  // D-026: a non-ready verdict HOLDS the row, so its reason must name a clearer and a
  // re-check time in the hold registry. An unregistered reason is refused at the write
  // (UnmappedHoldError) instead of minting a hold nobody is responsible for ending.
  if (input.status !== 'ready') assertHoldRegistered('readiness', input.reason);
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
  if (
    typeof row.updatedAt !== 'string' ||
    !IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN.test(row.updatedAt) ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    return null;
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

/**
 * The visible legacy exception claim floors honour until P-007 records the
 * enforcement cutover: a row with no readiness key, or one the creation seam
 * enrolled as `unknown` without acceptance evidence. Neither is acceptance —
 * `deriveWorkItemIntakeStage` keeps both in intake — they are only the claim
 * behaviour that existed before producers were enrolled.
 */
/**
 * Recorded enforcement cutover (observation-candidate-acceptance-promotion D-009b,
 * D-016). Rows created at or after this instant pass ordinary claim floors only
 * with a `ready` verdict and a qualifying acceptance contract; older rows keep the
 * legacy exception until P-011 reviews their cohort. Migration 1301 repeats this
 * literal inside `work_item_claim_floors`; a unit test pins the two together.
 */
// D-018: the created-after-cutover arm is DEFERRED to P-011 (cohort baseline + named canary), so
// this is a far sentinel, not an enforcement date. Lowering it is P-011's job: a new migration that
// re-renders floor #16, plus first making every wall-clock claim test seed created_ts explicitly.
// A stale-revision or invalid-authority acceptance refuses regardless of this value.
export const IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER = '2100-01-01T00:00:00.000Z' as const;
export const IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS = Date.parse(IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER);

export function implementationReadinessIsLegacyEquivalent(payload: unknown): boolean {
  const value = record(payload);
  if (!Object.prototype.hasOwnProperty.call(value, 'implementationReadiness')) return true;
  const readiness = readImplementationReadiness(value);
  return readiness?.status === 'unknown' && readiness.source === 'creation-enrollment';
}

export type ImplementationAcceptanceState =
  | 'absent'
  | 'incomplete'
  | 'invalid-authority'
  | 'stale-revision'
  | 'qualifying';

export interface ImplementationAcceptanceVerdict {
  state: ImplementationAcceptanceState;
  /** Contract fields that are missing or empty (only for `incomplete`). */
  missing: ImplementationAcceptanceField[];
  /** Present only for `qualifying`. */
  contract?: ImplementationAcceptanceContract;
  acceptedRevision?: string;
  currentRevision?: string | null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function proposalFieldPresent(acceptance: Record<string, unknown>, field: string): boolean {
  return field === 'evidence' ? nonEmptyStringArray(acceptance.evidence) : nonEmptyString(acceptance[field]);
}

/** Read whatever proposal fields a producer/reviewer recorded, trimmed; empty fields are dropped. */
export function readImplementationAcceptanceProposal(payload: unknown): Partial<ImplementationAcceptanceProposal> {
  const readiness = readImplementationReadiness(payload);
  const acceptance = record(readiness?.evidence?.acceptance);
  const proposal: Partial<ImplementationAcceptanceProposal> = {};
  for (const field of IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS) {
    if (!proposalFieldPresent(acceptance, field)) continue;
    if (field === 'evidence') proposal.evidence = (acceptance.evidence as string[]).map((entry) => entry.trim());
    else proposal[field] = (acceptance[field] as string).trim();
  }
  return proposal;
}

/**
 * Independence and allowlist check for the acceptance authority (R-20). An
 * agent reviewer must differ from the submitter; a policy must be an existing
 * allowlisted immediate policy. No confidence, grade threshold or dedup verdict
 * is consulted — confidence never grants authority.
 */
export function acceptanceAuthorityValid(value: unknown): value is ImplementationAcceptanceAuthority {
  const authority = record(value);
  if (authority.kind === 'agent-review') {
    return (
      nonEmptyString(authority.reviewer) &&
      nonEmptyString(authority.submittedBy) &&
      authority.reviewer !== authority.submittedBy &&
      Number.isInteger(authority.round) &&
      Number(authority.round) >= 1
    );
  }
  if (authority.kind === 'policy') {
    return (
      IMPLEMENTATION_ACCEPTANCE_POLICIES.includes(authority.policy as ImplementationAcceptancePolicy) &&
      nonEmptyString(authority.actor)
    );
  }
  return false;
}

/**
 * Evaluate the acceptance recorded on a work-item payload against the current
 * source. Fail-closed: without the source (title/summary/kind) the revision
 * cannot be verified, so the verdict is `stale-revision`, never `qualifying`.
 * Independent of `status`; `deriveWorkItemIntakeStage` combines the two.
 */
export function evaluateImplementationAcceptance(
  payload: unknown,
  source: ImplementationAcceptanceSource | null | undefined,
): ImplementationAcceptanceVerdict {
  const readiness = readImplementationReadiness(payload);
  const raw = readiness?.evidence?.acceptance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return { state: 'absent', missing: [] };
  }
  const acceptance = raw as Record<string, unknown>;
  const missing: ImplementationAcceptanceField[] = [];
  for (const field of IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS) {
    if (!proposalFieldPresent(acceptance, field)) missing.push(field);
  }
  if (acceptance.contractVersion !== IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION) missing.push('contractVersion');
  if (!acceptance.authority || typeof acceptance.authority !== 'object' || Array.isArray(acceptance.authority)) {
    missing.push('authority');
  }
  if (!nonEmptyString(acceptance.reason)) missing.push('reason');
  if (!nonEmptyString(acceptance.sourceRevision)) missing.push('sourceRevision');
  if (
    typeof acceptance.acceptedAt !== 'string' ||
    !IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN.test(acceptance.acceptedAt)
  ) {
    missing.push('acceptedAt');
  }
  if (missing.length > 0) return { state: 'incomplete', missing };
  if (!acceptanceAuthorityValid(acceptance.authority)) return { state: 'invalid-authority', missing: [] };
  const acceptedRevision = acceptance.sourceRevision as string;
  const currentRevision = source ? acceptanceSourceRevision(source) : null;
  if (currentRevision !== acceptedRevision) {
    return { state: 'stale-revision', missing: [], acceptedRevision, currentRevision };
  }
  // A matching revision means `source` was supplied, so its kind is the judged kind.
  const verification = acceptanceVerificationFor(acceptance, (source as ImplementationAcceptanceSource).kind, payload);
  if (!verification) {
    return { state: 'incomplete', missing: ['verification'], acceptedRevision, currentRevision };
  }
  const contract: ImplementationAcceptanceContract = {
    contractVersion: IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
    ...(readImplementationAcceptanceProposal(payload) as ImplementationAcceptanceProposal),
    authority: acceptance.authority as ImplementationAcceptanceAuthority,
    reason: (acceptance.reason as string).trim(),
    sourceRevision: acceptedRevision,
    acceptedAt: acceptance.acceptedAt as string,
    verification,
  };
  return { state: 'qualifying', missing: [], contract, acceptedRevision, currentRevision };
}

/**
 * The kind-specific check of the one verification stage, read back from a
 * stored contract (P-006). A bug qualifies only with a recorded reproduction
 * receipt that would still parse today. A change, feature or task qualifies
 * through proposal review, which is agent-review authority; contracts sealed
 * before P-006 carry no `verification` marker but already name that authority.
 * P-007 Phase C (D-028): a non-bug row also qualifies under the completion policy,
 * but only when the row itself is a completion verification task for the subject
 * the contract names.
 */
function acceptanceVerificationFor(
  acceptance: Record<string, unknown>,
  kind: string,
  payload: unknown,
): ImplementationAcceptanceVerification | null {
  const recorded = record(acceptance.verification);
  if (candidateStageCheckForKind(kind) === 'reproduction') {
    if (recorded.check !== 'reproduction') return null;
    const receipt = readBugReproductionReceipt(recorded.receipt);
    return receipt ? { check: 'reproduction', receipt } : null;
  }
  const authority = record(acceptance.authority);
  if (authority.kind === 'agent-review') return { check: 'proposal-review' };
  if (authority.kind === 'policy' && authority.policy === COMPLETION_VERIFICATION_POLICY) {
    const subject = completionVerificationSubject(payload);
    return subject && recorded.check === 'completion' && recorded.subject === subject
      ? { check: 'completion', subject }
      : null;
  }
  return null;
}

/** The subject a row verifies, when the row is a current-version completion verification task. */
export function completionVerificationSubject(payload: unknown): string | null {
  const task = readVerificationTask(payload);
  return task?.check === 'completion' ? task.subject : null;
}

export type SealImplementationAcceptanceResult =
  | { ok: true; contract: ImplementationAcceptanceContract }
  | { ok: false; refusal: 'incomplete'; missing: ImplementationAcceptanceField[] }
  | { ok: false; refusal: 'invalid-authority' }
  /** P-006: a bug cannot be accepted without a reproduction receipt (D-023/D-024/D-011). */
  | { ok: false; refusal: 'reproduction-missing' }
  /** P-006: a change, feature or task is accepted only by proposal review (agent-review authority). */
  | { ok: false; refusal: 'proposal-review-missing' };

/**
 * The only constructor of a qualifying contract, and so the one verification
 * stage (P-006). Refuses — never defaults — when any of problem/evidence/outcome/
 * scope/completion check/authority/reason is missing or the kind-specific check
 * fails, and binds the result to the source revision judged.
 */
export function sealImplementationAcceptance(input: {
  proposal: Partial<ImplementationAcceptanceProposal> | null | undefined;
  authority: ImplementationAcceptanceAuthority;
  reason: string;
  source: ImplementationAcceptanceSource;
  acceptedAt?: string;
  /** Required when `source.kind` is a bug: the receipt the reviewer or the filer recorded. */
  reproduction?: unknown;
  /**
   * P-007 Phase C (D-028): the payload of the row being sealed. The completion policy is
   * valid only when it carries a current `completion` verification block.
   */
  rowPayload?: unknown;
}): SealImplementationAcceptanceResult {
  const proposal = record(input.proposal);
  const missing: ImplementationAcceptanceField[] = [];
  for (const field of IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS) {
    if (!proposalFieldPresent(proposal, field)) missing.push(field);
  }
  if (!nonEmptyString(input.reason)) missing.push('reason');
  if (!nonEmptyString(input.source?.title)) missing.push('sourceRevision');
  if (missing.length > 0) return { ok: false, refusal: 'incomplete', missing };
  if (!acceptanceAuthorityValid(input.authority)) return { ok: false, refusal: 'invalid-authority' };
  let verification: ImplementationAcceptanceVerification;
  if (candidateStageCheckForKind(input.source.kind) === 'reproduction') {
    const receipt = readBugReproductionReceipt(input.reproduction);
    if (!receipt) return { ok: false, refusal: 'reproduction-missing' };
    verification = { check: 'reproduction', receipt };
  } else if (input.authority.kind === 'agent-review') {
    verification = { check: 'proposal-review' };
  } else {
    const subject =
      input.authority.policy === COMPLETION_VERIFICATION_POLICY ? completionVerificationSubject(input.rowPayload) : null;
    if (!subject) return { ok: false, refusal: 'proposal-review-missing' };
    verification = { check: 'completion', subject };
  }
  const authority: ImplementationAcceptanceAuthority =
    input.authority.kind === 'agent-review'
      ? {
          kind: 'agent-review',
          reviewer: input.authority.reviewer,
          submittedBy: input.authority.submittedBy,
          round: input.authority.round,
        }
      : { kind: 'policy', policy: input.authority.policy, actor: input.authority.actor };
  return {
    ok: true,
    contract: {
      contractVersion: IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
      problem: (proposal.problem as string).trim(),
      evidence: (proposal.evidence as string[]).map((entry) => entry.trim()),
      outcome: (proposal.outcome as string).trim(),
      scope: (proposal.scope as string).trim(),
      completionCheck: (proposal.completionCheck as string).trim(),
      authority,
      reason: input.reason.trim(),
      sourceRevision: acceptanceSourceRevision(input.source),
      acceptedAt: input.acceptedAt ?? new Date().toISOString(),
      verification,
    },
  };
}

export const WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION = 'work-item-intake-stage-v1' as const;
export const WORK_ITEM_INTAKE_PRIMARY_STAGES = ['observation', 'candidate', 'accepted', 'terminal', 'unknown'] as const;
export type WorkItemIntakePrimaryStage = (typeof WORK_ITEM_INTAKE_PRIMARY_STAGES)[number];
export const WORK_ITEM_INTAKE_READINESS_CLASSES = [
  'not-applicable',
  'legacy-missing',
  'malformed',
  ...IMPLEMENTATION_READINESS_STATUSES,
] as const;
export type WorkItemIntakeReadinessClass = (typeof WORK_ITEM_INTAKE_READINESS_CLASSES)[number];

export interface WorkItemIntakeStageInput {
  kind: string;
  status: string;
  payload?: unknown;
  terminalOwner?: string | null;
  terminalCompletionRef?: string | null;
  /**
   * Current source content the acceptance revision is checked against. Omitted
   * ⇒ the revision cannot be verified and acceptance cannot qualify (fail-closed).
   */
  title?: string | null;
  summary?: string | null;
}

export interface WorkItemIntakeStageDecision {
  schemaVersion: typeof WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION;
  primaryStage: WorkItemIntakePrimaryStage;
  readiness: WorkItemIntakeReadinessClass;
  reason:
    | 'observation-evidence'
    | 'terminal-history'
    | 'legacy-readiness-unknown'
    | 'malformed-readiness-unknown'
    | 'qualifying-acceptance'
    | 'ready-without-executable-acceptance'
    | 'acceptance-authority-invalid'
    | 'acceptance-revision-stale'
    | 'awaiting-qualifying-acceptance';
  qualifyingAcceptance: boolean;
  /** Acceptance-contract verdict, independent of the readiness status. */
  acceptance: ImplementationAcceptanceState;
  /**
   * R-21: a ready decision whose judged source/scope/evidence changed is
   * invalidated and returned to intake for re-review.
   */
  reReviewRequested: boolean;
  countsAsBugWork: boolean;
}

/**
 * One primary intake stage for every supported work-item record.
 *
 * Observation identity outranks lifecycle state so closing or consuming a
 * sensor row never turns it into executable bug work. Terminal lifecycle is
 * otherwise authoritative. Missing and malformed versioned readiness remain
 * explicitly unknown; a current readiness verdict remains a candidate until a
 * minimal executable acceptance contract exists.
 */
export function deriveWorkItemIntakeStage(input: WorkItemIntakeStageInput): WorkItemIntakeStageDecision {
  const payload = record(input.payload);
  const observation = payload.lane === 'observation';
  const terminal =
    ALL_TERMINAL_STATUSES.has(input.status) ||
    Boolean(input.terminalOwner?.trim() && input.terminalCompletionRef?.trim());
  const readinessEnrolled = Object.prototype.hasOwnProperty.call(payload, 'implementationReadiness');
  const currentReadiness = readImplementationReadiness(payload);
  const readiness: WorkItemIntakeReadinessClass = observation
    ? 'not-applicable'
    : !readinessEnrolled
      ? 'legacy-missing'
      : (currentReadiness?.status ?? 'malformed');
  const acceptance = observation
    ? ({ state: 'absent', missing: [] } satisfies ImplementationAcceptanceVerdict)
    : evaluateImplementationAcceptance(
        payload,
        typeof input.title === 'string'
          ? { kind: input.kind, title: input.title, summary: input.summary ?? null }
          : null,
      );
  const qualifyingAcceptance = currentReadiness?.status === 'ready' && acceptance.state === 'qualifying';
  const reReviewRequested =
    !observation && !terminal && currentReadiness?.status === 'ready' && acceptance.state === 'stale-revision';

  let primaryStage: WorkItemIntakePrimaryStage;
  let reason: WorkItemIntakeStageDecision['reason'];
  if (observation) {
    primaryStage = 'observation';
    reason = 'observation-evidence';
  } else if (terminal) {
    primaryStage = 'terminal';
    reason = 'terminal-history';
  } else if (!readinessEnrolled) {
    primaryStage = 'unknown';
    reason = 'legacy-readiness-unknown';
  } else if (!currentReadiness) {
    primaryStage = 'unknown';
    reason = 'malformed-readiness-unknown';
  } else if (qualifyingAcceptance) {
    primaryStage = 'accepted';
    reason = 'qualifying-acceptance';
  } else {
    primaryStage = 'candidate';
    reason =
      currentReadiness.status !== 'ready'
        ? 'awaiting-qualifying-acceptance'
        : acceptance.state === 'stale-revision'
          ? 'acceptance-revision-stale'
          : acceptance.state === 'invalid-authority'
            ? 'acceptance-authority-invalid'
            : 'ready-without-executable-acceptance';
  }

  return {
    schemaVersion: WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION,
    primaryStage,
    readiness,
    reason,
    qualifyingAcceptance,
    acceptance: acceptance.state,
    reReviewRequested,
    countsAsBugWork: input.kind === 'bug' && !observation && qualifyingAcceptance,
  };
}

/** P-010: presentation partitions intake separately from accepted execution. */
export interface WorkItemPresentationInput extends WorkItemIntakeStageInput {
  assignee?: string | null;
  /** Includes dependency/claim-floor holds resolved by the calling reader. */
  blocked?: boolean;
  completionAuthority?: string | null;
}

export function deriveWorkItemPresentationStage(input: WorkItemPresentationInput): {
  stage: WorkItemPresentationStage;
  reason: string;
  intake: WorkItemIntakeStageDecision;
} {
  const intake = deriveWorkItemIntakeStage(input);
  if (intake.primaryStage === 'terminal') {
    const verified = intake.qualifyingAcceptance && ALL_SUCCESSFUL_STATUSES.has(input.status)
      && (input.completionAuthority === 'committed' || input.completionAuthority === 'validated');
    return { stage: verified ? 'verified-completion' : 'terminal-other',
      reason: verified ? 'accepted-work-with-verified-success' : 'terminal-without-verified-accepted-success', intake };
  }
  if (intake.primaryStage !== 'accepted') {
    return { stage: intake.primaryStage, reason: intake.reason, intake };
  }
  const payload = record(input.payload);
  // Holds outrank assignment: a claimed item blocked on a dependency is blocked,
  // while a claimed candidate remains intake regardless of lifecycle/assignment.
  const blocked = input.blocked === true || payload._claimHold === true || hasStrictOwnerAction(payload)
    || activeExternalBlockers(payload).length > 0
    || !['open', 'wip', 'in_progress', 'in-progress', 'active', 'running'].includes(input.status);
  if (blocked) return { stage: 'accepted-blocked', reason: 'accepted-work-held', intake };
  const assigned = Boolean(input.assignee?.trim() && input.assignee.trim().toLowerCase() !== 'unassigned');
  if (assigned || ['wip', 'in_progress', 'in-progress', 'active', 'running'].includes(input.status)) {
    return { stage: 'accepted-active', reason: 'accepted-work-in-progress', intake };
  }
  return { stage: 'accepted-ready', reason: 'qualifying-acceptance', intake };
}

/** Counts only the supplied population; processing/comparison counters are never inputs. */
export function countWorkItemPresentationStages(items: readonly WorkItemPresentationInput[]) {
  const counts = Object.fromEntries(WORK_ITEM_PRESENTATION_STAGES.map((stage) => [stage, 0])) as
    Record<WorkItemPresentationStage, number>;
  let remainingBugs = 0;
  for (const item of items) {
    const { stage } = deriveWorkItemPresentationStage(item);
    counts[stage] += 1;
    if (item.kind === 'bug' && stage.startsWith('accepted-')) remainingBugs += 1;
  }
  return {
    population: items.length,
    unit: 'work-item rows' as const,
    counts,
    remainingBugs,
    verifiedCompletions: counts['verified-completion'],
    mutuallyExclusive: true as const,
    writer: 'deriveWorkItemPresentationStage' as const,
  };
}

type WorkItemIntakeStageSqlColumns = {
  payload?: 'payload' | 'wi.payload' | 'ei.payload';
  itemKind?: 'item_kind' | 'wi.item_kind' | 'ei.item_kind';
  status?: 'status' | 'wi.status' | 'ei.status';
  terminalOwner?: 'terminal_owner' | 'wi.terminal_owner' | 'ei.terminal_owner';
  terminalCompletionRef?: 'terminal_completion_ref' | 'wi.terminal_completion_ref' | 'ei.terminal_completion_ref';
  title?: 'title' | 'wi.title' | 'ei.title';
  /** `summary` on work_items; the engineer_issues view exposes the same column as `body`. */
  summary?: 'summary' | 'wi.summary' | 'ei.body' | 'body';
};

/** SQL twin of `acceptanceSourceRevision` (sha256 is built into PostgreSQL ≥ 11). */
export function acceptanceSourceRevisionSql(
  sql: OrgSql,
  columns: Pick<WorkItemIntakeStageSqlColumns, 'itemKind' | 'title' | 'summary'> = {},
) {
  return acceptanceSourceRevisionFromFragmentsSql(
    sql,
    sql.unsafe(columns.itemKind ?? 'item_kind'),
    sql.unsafe(columns.title ?? 'title'),
    sql.unsafe(columns.summary ?? 'summary'),
  );
}

export function acceptanceSourceRevisionFromFragmentsSql(
  sql: OrgSql,
  itemKind: postgres.Fragment,
  title: postgres.Fragment,
  summary: postgres.Fragment,
) {
  return sql`(${ACCEPTANCE_SOURCE_REVISION_PREFIX}::text || encode(sha256(convert_to(
    ${itemKind} || chr(31) || ${title} || chr(31) || COALESCE(${summary}, ''),
    'UTF8'
  )), 'hex'))`;
}

/** SQL twin of `evaluateImplementationAcceptance(...).state`. */
export function implementationAcceptanceStateSql(sql: OrgSql, columns: WorkItemIntakeStageSqlColumns = {}) {
  const payload = sql.unsafe(columns.payload ?? 'payload');
  return implementationAcceptanceStateFromReadinessSql(
    sql,
    sql`(COALESCE(${payload}, '{}'::jsonb) -> 'implementationReadiness')`,
    acceptanceSourceRevisionSql(sql, columns),
    sql.unsafe(columns.itemKind ?? 'item_kind'),
    completionVerificationSubjectSql(sql, payload),
  );
}

/** SQL twin of `completionVerificationSubject`: the subject, or NULL when the row is not a completion task. */
export function completionVerificationSubjectSql(sql: OrgSql, payload: postgres.Fragment) {
  const verification = sql`(COALESCE(${payload}, '{}'::jsonb) -> 'verification')`;
  return sql`(CASE
    WHEN ${verification} ->> 'schemaVersion' = ${VERIFICATION_TASK_SCHEMA_VERSION}
      AND ${verification} ->> 'check' = 'completion'
      AND jsonb_typeof(${verification} -> 'subject') = 'string'
      AND btrim(${verification} ->> 'subject') <> ''
    THEN btrim(${verification} ->> 'subject')
  END)`;
}

/**
 * The same verdict over an already-extracted readiness document and the row's
 * current source revision, so a census that projects `implementationReadiness`
 * into its own column (the admission promoter) judges acceptance with the exact
 * predicate the claim floor uses.
 */
export function implementationAcceptanceStateFromReadinessSql(
  sql: OrgSql,
  readinessJson: postgres.Fragment,
  currentRevision: postgres.Fragment,
  /** The row's current kind: it picks the stage's kind-specific check (P-006). */
  itemKind: postgres.Fragment,
  /**
   * P-007 Phase C (D-028): `completionVerificationSubjectSql` over the same row. A census
   * that projected only the readiness document passes nothing, so the completion policy
   * reads 'incomplete' there (completion tasks are created admitted; no census promotes them).
   */
  completionSubject: postgres.Fragment = sql`NULL::text`,
) {
  const acc = sql`(${readinessJson} -> 'evidence' -> 'acceptance')`;
  const authority = sql`(${acc} -> 'authority')`;
  const policies = [...IMPLEMENTATION_ACCEPTANCE_POLICIES];
  // Twin of `nonEmptyString`: a JSON string with at least one non-space character.
  // Type-strict (a number is not a reason) and whitespace-class based, because
  // btrim() strips only spaces while String.prototype.trim strips all whitespace.
  const nonEmptyText = (value: postgres.Fragment) =>
    sql`COALESCE(jsonb_typeof(${value}) = 'string' AND (${value} #>> '{}') ~ '[^[:space:]]', FALSE)`;
  const nonEmpty = (path: string) => nonEmptyText(sql`(${acc} -> ${path})`);
  const readinessValid = implementationReadinessValidFromJsonSql(sql, readinessJson);
  // Every branch below is COALESCEd: a missing key yields SQL NULL, and a NULL
  // CASE condition silently falls through to the next branch (toward 'qualifying').
  const proposalComplete = sql`COALESCE((
    ${nonEmpty('problem')}
    AND ${nonEmpty('outcome')}
    AND ${nonEmpty('scope')}
    AND ${nonEmpty('completionCheck')}
    AND jsonb_typeof(${acc} -> 'evidence') = 'array'
    AND jsonb_array_length(${acc} -> 'evidence') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${acc} -> 'evidence') AS entry(value)
       WHERE NOT ${nonEmptyText(sql`entry.value`)}
    )
  ), FALSE)`;
  const sealComplete = sql`COALESCE((
    ${acc} ->> 'contractVersion' = ${IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION}
    AND jsonb_typeof(${authority}) = 'object'
    AND ${nonEmpty('reason')}
    AND ${nonEmpty('sourceRevision')}
    AND jsonb_typeof(${acc} -> 'acceptedAt') = 'string'
    AND (${acc} ->> 'acceptedAt') ~ ${IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE}
  ), FALSE)`;
  const authorityValid = sql`(
    CASE ${authority} ->> 'kind'
      WHEN 'agent-review' THEN COALESCE(
        ${nonEmptyText(sql`(${authority} -> 'reviewer')`)}
        AND ${nonEmptyText(sql`(${authority} -> 'submittedBy')`)}
        AND ${authority} ->> 'reviewer' <> ${authority} ->> 'submittedBy'
        AND jsonb_typeof(${authority} -> 'round') = 'number'
        AND (${authority} ->> 'round') ~ '^[1-9][0-9]*$',
        FALSE
      )
      WHEN 'policy' THEN COALESCE(
        jsonb_typeof(${authority} -> 'policy') = 'string'
        AND ${authority} ->> 'policy' = ANY(${policies}::text[])
        AND ${nonEmptyText(sql`(${authority} -> 'actor')`)},
        FALSE
      )
      ELSE FALSE
    END
  )`;
  // P-006 twin of `acceptanceVerificationFor` + `readBugReproductionReceipt`: a bug
  // needs a recorded reproduction receipt; any other kind needs agent-review authority.
  const reproductionKinds = [...BUG_REPRODUCTION_KINDS];
  const receipt = sql`(${acc} -> 'verification' -> 'receipt')`;
  const kindVerified = sql`COALESCE((
    CASE WHEN ${itemKind} = 'bug' THEN (
      ${acc} -> 'verification' ->> 'check' = 'reproduction'
      AND jsonb_typeof(${receipt}) = 'object'
      AND jsonb_typeof(${receipt} -> 'kind') = 'string'
      AND ${receipt} ->> 'kind' = ANY(${reproductionKinds}::text[])
      AND ${nonEmptyText(sql`(${receipt} -> 'ref')`)}
      AND jsonb_typeof(${receipt} -> 'buildSha') = 'string'
      AND (${receipt} ->> 'buildSha') ~ '^[[:space:]]*[0-9a-fA-F]{7,40}[[:space:]]*$'
    ) ELSE (
      ${authority} ->> 'kind' = 'agent-review'
      OR (
        ${authority} ->> 'kind' = 'policy'
        AND ${authority} ->> 'policy' = ${COMPLETION_VERIFICATION_POLICY}
        AND ${acc} -> 'verification' ->> 'check' = 'completion'
        AND ${acc} -> 'verification' ->> 'subject' = ${completionSubject}
      )
    ) END
  ), FALSE)`;
  return sql`(CASE
    WHEN NOT (${readinessValid})
      OR jsonb_typeof(${acc}) IS DISTINCT FROM 'object'
      OR ${acc} = '{}'::jsonb THEN 'absent'
    WHEN NOT (${proposalComplete} AND ${sealComplete}) THEN 'incomplete'
    WHEN NOT (${authorityValid}) THEN 'invalid-authority'
    WHEN (${acc} ->> 'sourceRevision') IS DISTINCT FROM ${currentRevision} THEN 'stale-revision'
    WHEN NOT (${kindVerified}) THEN 'incomplete'
    ELSE 'qualifying'
  END)`;
}

function implementationReadinessValidSql(sql: OrgSql, payloadColumn: string) {
  return implementationReadinessValidFromJsonSql(
    sql,
    sql`(COALESCE(${sql.unsafe(payloadColumn)}, '{}'::jsonb) -> 'implementationReadiness')`,
  );
}

export function implementationReadinessValidFromJsonSql(sql: OrgSql, readinessJson: postgres.Fragment) {
  const readinessStatuses = [...IMPLEMENTATION_READINESS_STATUSES];
  const readinessSources = [...IMPLEMENTATION_READINESS_SOURCES];
  // COALESCE: a missing key is SQL NULL, and `NOT (NULL)` would let a malformed
  // row skip the 'unknown' branch of the stage CASE (TS reads it as malformed).
  return sql`COALESCE((
    jsonb_typeof(${readinessJson}) = 'object'
    AND ${readinessJson} ->> 'schemaVersion' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
    AND ${readinessJson} ->> 'status' = ANY(${readinessStatuses}::text[])
    AND ${readinessJson} ->> 'source' = ANY(${readinessSources}::text[])
    AND jsonb_typeof(${readinessJson} -> 'reason') = 'string'
    AND (${readinessJson} ->> 'reason') ~ '[^[:space:]]'
    AND jsonb_typeof(${readinessJson} -> 'updatedAt') = 'string'
    AND (${readinessJson} ->> 'updatedAt') ~ ${IMPLEMENTATION_READINESS_UPDATED_AT_PATTERN_SOURCE}
  ), FALSE)`;
}

/** P-010 SQL twin over narrow stored projections. Compute acceptance once upstream. */
export function workItemPresentationStageFromSignalsSql(sql: OrgSql, row: {
  observation: postgres.Fragment;
  terminal: postgres.Fragment;
  readinessValid: postgres.Fragment;
  readinessEnrolled: postgres.Fragment;
  readiness: postgres.Fragment;
  acceptanceState: postgres.Fragment;
  status: postgres.Fragment;
  assigned: postgres.Fragment;
  blocked: postgres.Fragment;
  authority: postgres.Fragment;
}) {
  const accepted = sql`(${row.readinessValid} AND ${row.readiness} ->> 'status' = 'ready'
    AND ${row.acceptanceState} = 'qualifying')`;
  return sql`CASE
    WHEN ${row.observation} THEN 'observation'
    WHEN ${row.terminal} THEN CASE
      WHEN ${accepted} AND ${row.status} = ANY(${[...ALL_SUCCESSFUL_STATUSES]}::text[])
        AND ${row.authority} IN ('committed', 'validated') THEN 'verified-completion'
      ELSE 'terminal-other' END
    WHEN NOT COALESCE(${row.readinessEnrolled}, FALSE) OR NOT ${row.readinessValid} THEN 'unknown'
    WHEN NOT COALESCE(${accepted}, FALSE) THEN 'candidate'
    WHEN ${row.blocked}
      OR ${row.status} <> ALL(ARRAY['open','wip','in_progress','in-progress','active','running']::text[])
      THEN 'accepted-blocked'
    WHEN ${row.assigned} OR ${row.status} = ANY(ARRAY['wip','in_progress','in-progress','active','running']::text[])
      THEN 'accepted-active'
    ELSE 'accepted-ready'
  END`;
}

/** SQL twin of deriveWorkItemIntakeStage for set-based queue projections. */
export function workItemIntakeStageSql(sql: OrgSql, columns: WorkItemIntakeStageSqlColumns = {}) {
  const payload = sql.unsafe(columns.payload ?? 'payload');
  const itemKind = sql.unsafe(columns.itemKind ?? 'item_kind');
  const status = sql.unsafe(columns.status ?? 'status');
  const terminalOwner = sql.unsafe(columns.terminalOwner ?? 'terminal_owner');
  const terminalCompletionRef = sql.unsafe(columns.terminalCompletionRef ?? 'terminal_completion_ref');
  const terminalStatuses = [...ALL_TERMINAL_STATUSES];
  const payloadJson = sql`COALESCE(${payload}, '{}'::jsonb)`;
  const readinessJson = sql`${payloadJson} -> 'implementationReadiness'`;
  const observation = sql`COALESCE(${payloadJson} ->> 'lane' = 'observation', FALSE)`;
  const terminal = sql`(
    ${status} = ANY(${terminalStatuses}::text[])
    OR (${terminalOwner} IS NOT NULL AND ${terminalCompletionRef} IS NOT NULL)
  )`;
  const readinessEnrolled = sql`${payloadJson} ? 'implementationReadiness'`;
  const readinessValid = implementationReadinessValidSql(sql, columns.payload ?? 'payload');
  const acceptanceState = sql`(CASE WHEN ${observation} THEN 'absent' ELSE ${implementationAcceptanceStateSql(sql, columns)} END)`;
  const readyNow = sql`(${readinessValid} AND ${readinessJson} ->> 'status' = 'ready')`;
  const qualifyingAcceptance = sql`(${readyNow} AND ${acceptanceState} = 'qualifying')`;

  return sql`jsonb_build_object(
    'schemaVersion', ${WORK_ITEM_INTAKE_STAGE_SCHEMA_VERSION}::text,
    'primaryStage', CASE
      WHEN ${observation} THEN 'observation'
      WHEN ${terminal} THEN 'terminal'
      WHEN NOT (${readinessEnrolled}) THEN 'unknown'
      WHEN NOT (${readinessValid}) THEN 'unknown'
      WHEN ${qualifyingAcceptance} THEN 'accepted'
      ELSE 'candidate'
    END,
    'readiness', CASE
      WHEN ${observation} THEN 'not-applicable'
      WHEN NOT (${readinessEnrolled}) THEN 'legacy-missing'
      WHEN NOT (${readinessValid}) THEN 'malformed'
      ELSE ${readinessJson} ->> 'status'
    END,
    'reason', CASE
      WHEN ${observation} THEN 'observation-evidence'
      WHEN ${terminal} THEN 'terminal-history'
      WHEN NOT (${readinessEnrolled}) THEN 'legacy-readiness-unknown'
      WHEN NOT (${readinessValid}) THEN 'malformed-readiness-unknown'
      WHEN ${qualifyingAcceptance} THEN 'qualifying-acceptance'
      WHEN ${readinessJson} ->> 'status' <> 'ready' THEN 'awaiting-qualifying-acceptance'
      WHEN ${acceptanceState} = 'stale-revision' THEN 'acceptance-revision-stale'
      WHEN ${acceptanceState} = 'invalid-authority' THEN 'acceptance-authority-invalid'
      ELSE 'ready-without-executable-acceptance'
    END,
    'qualifyingAcceptance', ${qualifyingAcceptance},
    'acceptance', ${acceptanceState},
    'reReviewRequested', (
      NOT (${observation}) AND NOT (${terminal}) AND ${readyNow} AND ${acceptanceState} = 'stale-revision'
    ),
    'countsAsBugWork', (${itemKind} = 'bug' AND NOT (${observation}) AND ${qualifyingAcceptance})
  )`;
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
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

/*
 * P-007 (unified-bug-pipeline D-021): the verifier-conflict rule. A verification task
 * (an agent-review round, the repro task `investigate` spawns, a completion check) is
 * refused to its subject's REPORTER and to its IMPLEMENTER at every verification door.
 * One predicate and one SQL twin; the doors differ only in where they read the subject.
 *
 * Reporters: the filer (`_ei.created_by`), the agent-review submitter, the D-024
 * encounter filer, and any reporter a verification task carries. Implementers: the
 * row's terminal owner and any implementer a verification task carries. A subject's
 * prior implementation claimants are captured onto the TASK when it is created (never
 * read from the task's own claim history), so a reviewer of an earlier round is not
 * mistaken for an implementer.
 */
export const VERIFICATION_TASK_SCHEMA_VERSION = 'verification-task-v1' as const;
export const VERIFICATION_CHECKS = ['reproduction', 'proposal-review', 'completion'] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];
export type VerificationConflictRole = 'reporter' | 'implementer';

export interface VerificationParties {
  readonly reporters: readonly string[];
  readonly implementers: readonly string[];
}

export interface VerificationTask extends VerificationParties {
  readonly schemaVersion: typeof VERIFICATION_TASK_SCHEMA_VERSION;
  /** The work item being verified. */
  readonly subject: string;
  readonly check: VerificationCheck;
}

function distinctIds(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id) out.add(id);
  }
  return [...out];
}

export function createVerificationTask(input: {
  subject: string;
  check: VerificationCheck;
  reporters: readonly unknown[];
  implementers: readonly unknown[];
}): VerificationTask {
  return {
    schemaVersion: VERIFICATION_TASK_SCHEMA_VERSION,
    subject: input.subject.trim(),
    check: input.check,
    reporters: distinctIds(input.reporters),
    implementers: distinctIds(input.implementers),
  };
}

/** The verification block on a task row, when it is a current-version one. */
export function readVerificationTask(payload: unknown): VerificationTask | null {
  const stored = record(record(payload).verification);
  if (stored.schemaVersion !== VERIFICATION_TASK_SCHEMA_VERSION) return null;
  if (typeof stored.subject !== 'string' || !stored.subject.trim()) return null;
  if (!(VERIFICATION_CHECKS as readonly unknown[]).includes(stored.check)) return null;
  return createVerificationTask({
    subject: stored.subject,
    check: stored.check as VerificationCheck,
    reporters: Array.isArray(stored.reporters) ? stored.reporters : [],
    implementers: Array.isArray(stored.implementers) ? stored.implementers : [],
  });
}

/** Everyone a verifier of this row must not be, read from the row itself. */
export function verificationParties(subject: {
  createdBy?: string | null;
  terminalOwner?: string | null;
  payload: unknown;
}): VerificationParties {
  const payload = record(subject.payload);
  const task = readVerificationTask(payload);
  return {
    reporters: distinctIds([
      subject.createdBy,
      record(payload._ei).created_by,
      readAgentReviewState(payload)?.submittedBy,
      readStoredBugReproduction(payload)?.filedBy,
      ...(task?.reporters ?? []),
    ]),
    implementers: distinctIds([subject.terminalOwner, ...(task?.implementers ?? [])]),
  };
}

/** Which conflicting role `verifier` holds, or null when it may verify. */
export function verificationConflict(parties: VerificationParties, verifier: string): VerificationConflictRole | null {
  const who = verifier.trim();
  if (!who) return null;
  if (parties.reporters.includes(who)) return 'reporter';
  if (parties.implementers.includes(who)) return 'implementer';
  return null;
}

/**
 * The claim-writer leg: a row carrying a verification block refuses its reporters and
 * implementers whatever door the claim came through. Only the TASK's parties count
 * here: the task row's own filer is the reviewer who decided to investigate, who is
 * independent of the subject and may run the repro.
 */
export function verificationTaskConflict(payload: unknown, claimant: string): VerificationConflictRole | null {
  const task = readVerificationTask(payload);
  return task ? verificationConflict(task, claimant) : null;
}

type VerificationPayloadColumn = 'wi.payload' | 'payload' | 'target.payload';

/**
 * SQL twin of `verificationTaskConflict(payload, claimant)`: TRUE when the row carries a
 * current-version verification block naming `claimant` as a reporter or implementer.
 * Null-safe, so `NOT (...)` keeps every row without a verification block. The self-select
 * claim UPDATEs AND this in, because they do not funnel through `claimWorkItem`.
 */
export function verificationTaskConflictSql(sql: OrgSql, claimant: string, payloadColumn: VerificationPayloadColumn) {
  const payload = sql`COALESCE(${sql.unsafe(payloadColumn)}, '{}'::jsonb)`;
  const who = claimant.trim();
  // The outer COALESCE is load-bearing: a missing `check` makes `= ANY(...)` NULL, and a
  // NULL here would turn `NOT (...)` into NULL and silently drop the row from self-select.
  return sql`COALESCE((
    ${payload} -> 'verification' ->> 'schemaVersion' IS NOT DISTINCT FROM ${VERIFICATION_TASK_SCHEMA_VERSION}
    AND jsonb_typeof(${payload} -> 'verification' -> 'subject') IS NOT DISTINCT FROM 'string'
    AND btrim(${payload} -> 'verification' ->> 'subject') <> ''
    AND (${payload} -> 'verification' ->> 'check') = ANY(${[...VERIFICATION_CHECKS]}::text[])
    AND ${who} <> ''
    AND (
      (jsonb_typeof(${payload} -> 'verification' -> 'reporters') IS NOT DISTINCT FROM 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${payload} -> 'verification' -> 'reporters') AS r(v)
           WHERE jsonb_typeof(r.v) = 'string' AND btrim(r.v #>> '{}') = ${who}
        ))
      OR (jsonb_typeof(${payload} -> 'verification' -> 'implementers') IS NOT DISTINCT FROM 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${payload} -> 'verification' -> 'implementers') AS i(v)
           WHERE jsonb_typeof(i.v) = 'string' AND btrim(i.v #>> '{}') = ${who}
        ))
    )
  ), false)`;
}

/**
 * SQL twin of `verificationConflict(verificationParties(row), verifier)`: TRUE when
 * `verifier` is a reporter or implementer of the row. Every leg is null-safe, so the
 * expression is never NULL and `NOT (...)` keeps rows with no parties at all.
 */
export function verificationConflictSql(
  sql: OrgSql,
  verifier: string,
  columns: { payload: VerificationPayloadColumn; terminalOwner: 'wi.terminal_owner' | 'terminal_owner' | 'target.terminal_owner' },
) {
  const payload = sql`COALESCE(${sql.unsafe(columns.payload)}, '{}'::jsonb)`;
  const who = verifier.trim();
  return sql`(
    ${payload} -> '_ei' ->> 'created_by' IS NOT DISTINCT FROM ${who}
    OR ${payload} -> 'agentReview' ->> 'submittedBy' IS NOT DISTINCT FROM ${who}
    OR (
      ${payload} -> 'reproduction' ->> 'schemaVersion' IS NOT DISTINCT FROM ${BUG_REPRODUCTION_SCHEMA_VERSION}
      AND ${payload} -> 'reproduction' ->> 'filedBy' IS NOT DISTINCT FROM ${who}
    )
    OR ${verificationTaskConflictSql(sql, verifier, columns.payload)}
    OR ${sql.unsafe(columns.terminalOwner)} IS NOT DISTINCT FROM ${who}
  )`;
}

export function mintAgentReviewClaimAdmission(input: {
  itemId: string;
  reviewer: string;
  harnessSlug: string;
  review: AgentReviewState;
  /** P-007: the subject's reporters and implementers; a conflicting reviewer gets no admission. */
  parties: VerificationParties;
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
    verificationConflict(input.parties, reviewer) !== null ||
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
  item: { id: string; harness?: string | null; payload: unknown; createdBy?: string | null; terminalOwner?: string | null },
  reviewer: string,
): value is AgentReviewClaimAdmission {
  if (
    !isAgentReviewClaimAdmission(value) ||
    value.itemId !== item.id ||
    value.reviewer !== reviewer ||
    value.harnessSlug !== item.harness ||
    // P-007: re-derived from the row the writer is about to claim, not trusted from the mint.
    verificationConflict(verificationParties(item), reviewer) !== null
  ) {
    return false;
  }
  const current = readAgentReviewState(item.payload);
  return (
    current?.status === 'pending' &&
    current.submittedBy !== reviewer &&
    current.submittedBy === value.submittedBy &&
    current.ledgerIdeaId === value.ledgerIdeaId &&
    current.round === value.round
  );
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
export function agentReviewEligibility(
  candidate: AgentReviewCandidate,
):
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
 * The relation a claim-floor fragment reads. `work_items` (and its
 * `harness_features_consolidated` view) carry `item_kind`, `summary` and the
 * millisecond `created_ts`; the `engineer_issues` view exposes the same columns
 * as `kind`, `body` and the timestamptz `created_at`.
 */
export type ClaimFloorRelationShape = 'work_items' | 'engineer_issues';
export type ClaimFloorPayloadColumn = 'wi.payload' | 'ei.payload' | 'target.payload' | 'payload';

function claimFloorColumns(sql: OrgSql, payloadCol: ClaimFloorPayloadColumn, shape: ClaimFloorRelationShape) {
  const dot = payloadCol.indexOf('.');
  const prefix = dot >= 0 ? payloadCol.slice(0, dot + 1) : '';
  const columns = (
    shape === 'engineer_issues'
      ? { payload: payloadCol, itemKind: `${prefix}kind`, title: `${prefix}title`, summary: `${prefix}body` }
      : { payload: payloadCol, itemKind: `${prefix}item_kind`, title: `${prefix}title`, summary: `${prefix}summary` }
  ) as WorkItemIntakeStageSqlColumns;
  const createdBeforeCutover =
    shape === 'engineer_issues'
      ? sql`COALESCE(${sql.unsafe(`${prefix}created_at`)} < ${IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER}::timestamptz, TRUE)`
      : sql`(COALESCE(${sql.unsafe(`${prefix}created_ts`)}, 0) < ${IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS}::bigint)`;
  return { columns, createdBeforeCutover };
}

/**
 * The acceptance floor every ordinary execution path applies (P-007, D-016).
 * A row passes when it carries a valid `ready` verdict with a qualifying
 * acceptance contract. Rows created before the recorded enforcement cutover keep
 * the pre-P-007 legacy exception (absent key, `ready`, or `creation-enrollment`
 * `unknown` — SQL twin of `implementationReadinessIsLegacyEquivalent`) unless
 * their acceptance is stale or carries invalid authority. Pass the relation shape
 * the fragment is embedded in; the default is an aliased `work_items` row.
 */
export function implementationReadinessNormalExclusionSql(
  sql: OrgSql,
  payloadCol: ClaimFloorPayloadColumn = 'wi.payload',
  shape: ClaimFloorRelationShape = payloadCol === 'ei.payload' || payloadCol === 'target.payload'
    ? 'engineer_issues'
    : 'work_items',
) {
  const payload = sql.unsafe(payloadCol);
  const { columns, createdBeforeCutover } = claimFloorColumns(sql, payloadCol, shape);
  return implementationReadinessFloorSql(sql, {
    readiness: sql`(COALESCE(${payload}, '{}'::jsonb) -> 'implementationReadiness')`,
    enrolled: sql`(COALESCE(${payload}, '{}'::jsonb) ? 'implementationReadiness')`,
    acceptanceState: implementationAcceptanceStateSql(sql, columns),
    createdBeforeCutover,
  });
}

/**
 * The readiness floor over an already-extracted readiness document, so a census
 * that projects `implementationReadiness` into its own column (the admission
 * promoter's writer-ready census) judges rows with the SAME predicate the claim
 * floor uses instead of a hand-copied one. NULL-safe: a malformed enrolled row is
 * FALSE, never NULL, so `NOT (floor)` keeps meaning "held".
 */
export function implementationReadinessFloorSql(
  sql: OrgSql,
  expressions: {
    readiness: postgres.Fragment;
    enrolled: postgres.Fragment;
    /** `implementationAcceptanceState(FromReadiness)Sql` over the same row. */
    acceptanceState: postgres.Fragment;
    /** TRUE when the row was created before IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER. */
    createdBeforeCutover: postgres.Fragment;
  },
) {
  const { readiness, enrolled, acceptanceState, createdBeforeCutover } = expressions;
  return sql`COALESCE((
    (
      ${readiness} ->> 'schemaVersion' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
      AND ${readiness} ->> 'status' = 'ready'
      AND ${acceptanceState} = 'qualifying'
    )
    OR (
      ${createdBeforeCutover}
      AND ${acceptanceState} NOT IN ('stale-revision', 'invalid-authority')
      AND (
        NOT (${enrolled})
        OR (
          ${readiness} ->> 'schemaVersion' = ${IMPLEMENTATION_READINESS_SCHEMA_VERSION}
          AND (
            ${readiness} ->> 'status' = 'ready'
            OR (
              ${readiness} ->> 'status' = 'unknown'
              AND ${readiness} ->> 'source' = 'creation-enrollment'
            )
          )
        )
      )
    )
  ), FALSE)`;
}

/**
 * The same floor for a census that already projected the readiness document and
 * the row's identity columns (the admission promoter's writer-ready census).
 */
export function implementationReadinessProjectedFloorSql(
  sql: OrgSql,
  row: {
    readiness: postgres.Fragment;
    enrolled: postgres.Fragment;
    itemKind: postgres.Fragment;
    title: postgres.Fragment;
    summary: postgres.Fragment;
    /** Epoch-millisecond `work_items.created_ts`. */
    createdTs: postgres.Fragment;
  },
) {
  return implementationReadinessFloorSql(sql, {
    readiness: row.readiness,
    enrolled: row.enrolled,
    acceptanceState: implementationAcceptanceStateFromReadinessSql(
      sql,
      row.readiness,
      acceptanceSourceRevisionFromFragmentsSql(sql, row.itemKind, row.title, row.summary),
      row.itemKind,
    ),
    createdBeforeCutover: sql`(COALESCE(${row.createdTs}, 0) < ${IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS}::bigint)`,
  });
}

/**
 * TS twin of `implementationReadinessFloorSql` for one row: does the acceptance
 * floor admit it for an ordinary (non-reviewer) claim?
 */
export function implementationReadinessAdmitsClaim(input: {
  payload: unknown;
  kind: string;
  title: string;
  summary: string | null | undefined;
  /** Row creation time in epoch milliseconds; null/undefined is treated as legacy. */
  createdAtMs: number | null | undefined;
}): boolean {
  const value = record(input.payload);
  const acceptance = evaluateImplementationAcceptance(value, {
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? '',
  }).state;
  const readiness = readImplementationReadiness(value);
  if (readiness?.status === 'ready' && acceptance === 'qualifying') return true;
  const beforeCutover = (input.createdAtMs ?? 0) < IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS;
  if (!beforeCutover || acceptance === 'stale-revision' || acceptance === 'invalid-authority') return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'implementationReadiness')) return true;
  const raw = record(value.implementationReadiness);
  if (raw.schemaVersion !== IMPLEMENTATION_READINESS_SCHEMA_VERSION) return false;
  return raw.status === 'ready' || (raw.status === 'unknown' && raw.source === 'creation-enrollment');
}

/** Normal implementation lane: review/readiness work is invisible until approved. */
export function agentReviewNormalExclusionSql(
  sql: OrgSql,
  payloadCol: ClaimFloorPayloadColumn = 'wi.payload',
  shape?: ClaimFloorRelationShape,
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
      AND ${shape ? implementationReadinessNormalExclusionSql(sql, payloadCol, shape) : implementationReadinessNormalExclusionSql(sql, payloadCol)}
    )
  )`;
}

/** Reviewer lane: only submitted work, never revision work or approved work. */
export function agentReviewPendingSelectorSql(sql: OrgSql, payloadCol: 'wi.payload' | 'payload' = 'wi.payload') {
  const payload = sql.unsafe(payloadCol);
  return sql`COALESCE(${payload}, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'pending'`;
}
