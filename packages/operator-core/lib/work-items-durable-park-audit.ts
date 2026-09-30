/**
 * Deterministic, report-only durable-park audit (work-queue-admission-and-bulk-dedup P-020).
 *
 * This extends the existing admission run ledger instead of creating another audit store.
 * The four queue-control axes deliberately overlap: a row may have an active claim, a
 * hold-open lease, a durable park, and an agent-review state at the same time. The audit
 * path is report-only; the reconciliation path below accepts only explicit evidence plus
 * a control-state fingerprint and writes an atomic audit row for every successful clear.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { readAgentReviewState } from './harness/improvements/agent-review-policy';
import { saveTextArtifact } from './text-artifacts';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import type { AdmissionRunOutcome } from './work-items-admission-promoter';
import { readWorkItemClaimHoldProvenance, type OrgSql } from './work-items';

export const WORK_ITEM_DURABLE_PARK_AUDIT = 'work-item-durable-park-audit';
/**
 * This producer's own admission_runs.run_kind.
 *
 * It was 'daily-digest' until migration 1028 — not by choice, but because
 * migration 944 constrained run_kind to five literals and this producer was not
 * one of them. The result was that the ledger's own grouping key attributed
 * durable-park rows to the daily digest, which an acceptance grader following
 * the rubric's prescribed "group by run_kind" method ran straight into
 * (EI-21844734848781188). `detail.mode` still separates the audit and reconcile
 * passes within this kind, the same way 'promoter' and 'fail-open' are
 * separated within 'promoter-tick'.
 */
export const DURABLE_PARK_AUDIT_RUN_KIND = 'durable-park-audit' as const;
export const DEFAULT_AGENT_REVIEW_OVERDUE_HOURS = 24;
export const DURABLE_PARK_CLEAR_AUDIT_ACTION = 'work_items:durable_park:clear';

const DAY_MS = 24 * 60 * 60 * 1_000;
const STATED_UNPARK_CONDITION = /\b(?:unpark|unhold|release|resume|clear)\b|\b(?:when|once|after|until|unless)\b/i;

export type AuditAgeStatus = 'known' | 'missing' | 'invalid';
export type AuditAgeBucket = 'under-1d' | '1-7d' | '7-30d' | '30d-plus' | 'unknown';
export type UnparkConditionStatus = 'stated' | 'missing' | 'unresolved';
export type DurableParkReleaseReachability = 'reachable' | 'blocked' | 'unreachable' | 'satisfied';
export type DurableParkReleaseLivenessStatus =
  | 'tracked'
  | 'unverified'
  | 'unreachable'
  | 'satisfied-still-parked';
export type DurableParkReleaseLivenessFinding =
  | 'condition-missing'
  | 'condition-ambiguous'
  | 'owner-missing'
  | 'trigger-missing'
  | 'reachability-unverified'
  | 'evidence-missing'
  | 'condition-unreachable'
  | 'condition-satisfied-still-parked';

/**
 * Optional typed release contract stored at `payload.claim_hold_release`.
 *
 * A durable park deliberately outlives its parker, so `claim_hold_by` is provenance,
 * not proof that somebody still owns the condition. Likewise, release-looking prose
 * is not proof that the condition is realistic or will ever be checked again. This
 * contract supplies the liveness half without weakening the no-TTL safety rule.
 */
export interface DurableParkReleaseContract {
  condition: string;
  owner: string;
  trigger: string;
  reachability: DurableParkReleaseReachability;
  evidence: string;
}

export interface DurableParkReleaseLiveness {
  status: DurableParkReleaseLivenessStatus;
  contractPresent: boolean;
  condition: string | null;
  owner: string | null;
  trigger: string | null;
  reachability: DurableParkReleaseReachability | null;
  evidence: string | null;
  findings: DurableParkReleaseLivenessFinding[];
}

export interface DurableParkAuditSourceRow {
  id: string;
  title: string | null;
  state: string;
  takenBy: string | null;
  takenAt: string | null;
  updatedAtMs: number | null;
  payload: unknown;
  reviewRoutedAtMs: number | null;
}

export interface AuditAge {
  status: AuditAgeStatus;
  ageMs: number | null;
  bucket: AuditAgeBucket;
}

export interface DurableParkAuditParkRow {
  id: string;
  title: string | null;
  state: string;
  parker: string;
  reason: string | null;
  parkedAt: string | null;
  age: AuditAge;
  unparkCondition: {
    status: UnparkConditionStatus;
    text: string | null;
  };
  releaseLiveness: DurableParkReleaseLiveness;
}

export interface DurableParkAuditLeaseRow {
  id: string;
  holder: string;
  reason: string | null;
  heldAt: string | null;
  age: AuditAge;
}

export interface DurableParkAuditReviewRow {
  id: string;
  status: 'pending';
  submittedBy: string;
  ledgerIdeaId: string;
  round: number;
  routedAt: string;
  ageMs: number;
}

export interface DurableParkAuditReport {
  schemaVersion: 'durable-park-audit-v2';
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  generatedAt: string;
  reportOnly: true;
  modelCalled: false;
  population: {
    nonTerminal: number;
    axes: {
      activeClaims: number;
      rawClaimHolds: number;
      holdOpenLeases: number;
      durableParks: number;
      pendingAgentReview: number;
      revisionRequestedAgentReview: number;
    };
    note: string;
  };
  parkAgeBuckets: Record<AuditAgeBucket, number>;
  unparkConditions: Record<UnparkConditionStatus, number>;
  releaseConditionHealth: {
    statusCounts: Record<DurableParkReleaseLivenessStatus, number>;
    findingCounts: Record<DurableParkReleaseLivenessFinding, number>;
    flagged: number;
    requirement: string;
  };
  missingMetadata: {
    unattributedClaimHolds: number;
    parkReason: number;
    parkTimestamp: number;
    invalidParkTimestamp: number;
    pendingReviewTimestamp: number;
  };
  reasons: Array<{ reason: string; count: number }>;
  durableParks: DurableParkAuditParkRow[];
  holdOpenLeases: DurableParkAuditLeaseRow[];
  overdueReviews: {
    thresholdHours: number;
    timestampBasis: 'scout_routed_ideas.routed_at';
    rows: DurableParkAuditReviewRow[];
  };
}

export type DurableParkClearReason =
  | 'condition-satisfied'
  | 'duplicate-terminal'
  | 'review-completed'
  | 'typed-blocker-resolved'
  | 'operator-directed';

export interface DurableParkReconcileDecision {
  id: string;
  expectedParkFingerprint: string;
  reasonCode: DurableParkClearReason;
  /** Concrete, owner-inspectable proof. A reason code without evidence is refused. */
  evidence: string;
}

export type DurableParkReconcileOutcome =
  | 'cleared'
  | 'already-cleared'
  | 'assigned'
  | 'missing'
  | 'not-durable-park'
  | 'stale-fingerprint';

export interface DurableParkReconcileRowResult {
  id: string;
  outcome: DurableParkReconcileOutcome;
  expectedParkFingerprint: string;
  observedParkFingerprint: string | null;
  reasonCode: DurableParkClearReason;
  evidence: string;
  preservedLease: boolean;
  takenBy: string | null;
}

export interface DurableParkReconcileResult {
  schemaVersion: 'durable-park-reconcile-v1';
  runId: string;
  inputSha256: string;
  workspaceId: string;
  harnessSlug: string;
  generatedAt: string;
  actor: string;
  requested: number;
  cleared: number;
  unchanged: number;
  rows: DurableParkReconcileRowResult[];
  artifactPath: string;
}

export interface DurableParkEvidenceMatrixRow {
  id: string;
  title: string | null;
  state: string;
  takenBy: string | null;
  takenAt: string | null;
  updatedAtMs: number | null;
  parkFingerprint: string;
  axes: {
    rawClaimHold: true;
    durablePark: {
      by: string;
      reason: string | null;
      at: string | null;
    } | null;
    holdOpenLease: {
      by: string;
      reason: string | null;
      at: string | null;
    } | null;
    agentReview: ReturnType<typeof readAgentReviewState>;
  };
  /** Exact source payload makes every item-level conclusion independently re-checkable. */
  sourcePayload: Record<string, unknown>;
}

export interface DurableParkEvidenceMatrix {
  schemaVersion: 'durable-park-evidence-matrix-v1';
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  generatedAt: string;
  population: {
    rawClaimHolds: number;
    durableParks: number;
    holdOpenLeases: number;
    leaseAndPark: number;
    assigned: number;
  };
  rows: DurableParkEvidenceMatrixRow[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

const RELEASE_REACHABILITY = new Set<DurableParkReleaseReachability>([
  'reachable',
  'blocked',
  'unreachable',
  'satisfied',
]);

/**
 * Fail-closed liveness assessment for a retained durable park.
 *
 * The legacy reason remains a valid condition description when it explicitly
 * names an unpark transition, but it cannot prove ownership, reachability, or a
 * re-evaluation trigger. Only the typed `claim_hold_release` contract can close
 * those gaps. `unreachable` and `satisfied` are findings, never auto-clear
 * instructions: reconciliation still requires a fingerprinted, evidence-backed
 * decision through the existing CAS path.
 */
export function classifyDurableParkReleaseLiveness(
  payloadValue: unknown,
  parkReason: string | null,
): DurableParkReleaseLiveness {
  const payload = record(payloadValue);
  const rawContract = record(payload.claim_hold_release);
  const contractPresent = Object.keys(rawContract).length > 0;
  const proseCondition = classifyUnparkCondition(parkReason);
  const condition = textOrNull(rawContract.condition) ??
    (proseCondition.status === 'stated' ? proseCondition.text : null);
  const owner = textOrNull(rawContract.owner);
  const trigger = textOrNull(rawContract.trigger);
  const reachabilityText = textOrNull(rawContract.reachability);
  const reachability = reachabilityText && RELEASE_REACHABILITY.has(reachabilityText as DurableParkReleaseReachability)
    ? (reachabilityText as DurableParkReleaseReachability)
    : null;
  const evidence = textOrNull(rawContract.evidence);
  const findings: DurableParkReleaseLivenessFinding[] = [];

  if (!condition) {
    findings.push(proseCondition.status === 'missing' ? 'condition-missing' : 'condition-ambiguous');
  }
  if (!owner) findings.push('owner-missing');
  if (!trigger) findings.push('trigger-missing');
  if (!reachability) findings.push('reachability-unverified');
  if (!evidence) findings.push('evidence-missing');
  if (reachability === 'unreachable') findings.push('condition-unreachable');
  if (reachability === 'satisfied') findings.push('condition-satisfied-still-parked');

  const status: DurableParkReleaseLivenessStatus = reachability === 'unreachable'
    ? 'unreachable'
    : reachability === 'satisfied'
      ? 'satisfied-still-parked'
      : findings.length === 0
        ? 'tracked'
        : 'unverified';

  return {
    status,
    contractPresent,
    condition,
    owner,
    trigger,
    reachability,
    evidence,
    findings,
  };
}

/**
 * Fingerprint only the control state a durable-park clear is allowed to rely on.
 * Unrelated payload edits (a checkpoint mirror, tags, UI metadata) deliberately do
 * not invalidate a disposition, while a state/claim/park/lease change always does.
 */
export function durableParkFingerprint(input: { state: string; takenBy: string | null; payload: unknown }): string {
  const payload = record(input.payload);
  const control = {
    state: input.state,
    takenBy: textOrNull(input.takenBy),
    rawClaimHold: String(payload._claimHold) === 'true',
    durablePark: {
      by: textOrNull(payload.claim_hold_by),
      reason: textOrNull(payload.claim_hold_reason),
      at: textOrNull(payload.claim_hold_at),
    },
    holdOpenLease: {
      by: textOrNull(payload.held_open_by),
      reason: textOrNull(payload.held_open_reason),
      at: textOrNull(payload.held_open_at),
    },
  };
  return createHash('sha256').update(JSON.stringify(control)).digest('hex');
}

export function buildDurableParkEvidenceMatrix(input: {
  rows: readonly DurableParkAuditSourceRow[];
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  nowMs: number;
}): DurableParkEvidenceMatrix {
  const rows: DurableParkEvidenceMatrixRow[] = [];
  let durableParks = 0;
  let holdOpenLeases = 0;
  let leaseAndPark = 0;
  let assigned = 0;

  for (const row of input.rows) {
    const payload = record(row.payload);
    if (String(payload._claimHold) !== 'true') continue;
    const provenance = readWorkItemClaimHoldProvenance(payload);
    if (provenance.parked) durableParks += 1;
    if (provenance.heldOpen) holdOpenLeases += 1;
    if (provenance.parked && provenance.heldOpen) leaseAndPark += 1;
    if (textOrNull(row.takenBy)) assigned += 1;
    rows.push({
      id: row.id,
      title: row.title,
      state: row.state,
      takenBy: textOrNull(row.takenBy),
      takenAt: row.takenAt,
      updatedAtMs: row.updatedAtMs,
      parkFingerprint: durableParkFingerprint({ state: row.state, takenBy: row.takenBy, payload }),
      axes: {
        rawClaimHold: true,
        durablePark: provenance.parked
          ? { by: provenance.parked.by, reason: provenance.parked.reason, at: provenance.parked.at }
          : null,
        holdOpenLease: provenance.heldOpen
          ? { by: provenance.heldOpen.by, reason: provenance.heldOpen.reason, at: provenance.heldOpen.at }
          : null,
        agentReview: readAgentReviewState(payload),
      },
      sourcePayload: payload,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion: 'durable-park-evidence-matrix-v1',
    runId: input.runId,
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    generatedAt: new Date(input.nowMs).toISOString(),
    population: {
      rawClaimHolds: rows.length,
      durableParks,
      holdOpenLeases,
      leaseAndPark,
      assigned,
    },
    rows,
  };
}

export interface DurableParkClearPlan extends DurableParkReconcileRowResult {
  nextPayload: Record<string, unknown> | null;
}

/** Pure per-row CAS planner; the transaction wrapper below applies only `cleared`. */
export function planDurableParkClear(
  row: { id: string; state: string; takenBy: string | null; payload: unknown },
  decision: DurableParkReconcileDecision,
): DurableParkClearPlan {
  const payload = record(row.payload);
  const observedParkFingerprint = durableParkFingerprint({
    state: row.state,
    takenBy: row.takenBy,
    payload,
  });
  const result = (outcome: DurableParkReconcileOutcome, preservedLease = false): DurableParkClearPlan => ({
    id: decision.id,
    outcome,
    expectedParkFingerprint: decision.expectedParkFingerprint,
    observedParkFingerprint,
    reasonCode: decision.reasonCode,
    evidence: decision.evidence,
    preservedLease,
    takenBy: textOrNull(row.takenBy),
    nextPayload: null,
  });
  const provenance = readWorkItemClaimHoldProvenance(payload);
  if (!provenance.parked) return result('already-cleared', !!provenance.heldOpen);
  if (String(payload._claimHold) !== 'true') return result('not-durable-park', !!provenance.heldOpen);
  if (textOrNull(row.takenBy)) return result('assigned', !!provenance.heldOpen);
  if (decision.expectedParkFingerprint !== observedParkFingerprint) {
    return result('stale-fingerprint', !!provenance.heldOpen);
  }

  const nextPayload = { ...payload };
  delete nextPayload.claim_hold_by;
  delete nextPayload.claim_hold_reason;
  delete nextPayload.claim_hold_at;
  delete nextPayload.claim_hold_release;
  const preservedLease = !!provenance.heldOpen;
  if (preservedLease) nextPayload._claimHold = true;
  else delete nextPayload._claimHold;
  return { ...result('cleared', preservedLease), nextPayload };
}

export interface EventDurableParkReconcileResult {
  matched: number;
  cleared: number;
  skipped: number;
  preservedLeases: number;
}

type EventDurableParkSql = OrgSql | TransactionSql;

type EventDurableParkRow = {
  workspace_id: string;
  feature_id: string;
  state: string;
  taken_by: string | null;
  payload: unknown;
};

/**
 * Clear durable parks whose typed release contract names the event that just
 * fired. This is intentionally narrower than external-blocker reconciliation:
 * a durable park has no TTL and must only be cleared by its own exact trigger,
 * never by an unrelated event or by the holder's liveness changing.
 *
 * The caller supplies its transaction so announcement latching and park
 * settlement commit together. Rows are selected and updated with the same
 * control-state fingerprint/CAS discipline as the explicit reconciliation
 * path. A coexisting held-open lease remains in place and keeps `_claimHold`.
 */
export async function reconcileEventDurableParks(
  tx: EventDurableParkSql,
  eventKey: string,
  actor?: string,
  now = new Date().toISOString(),
): Promise<EventDurableParkReconcileResult> {
  const trigger = eventKey.trim();
  if (!trigger) return { matched: 0, cleared: 0, skipped: 0, preservedLeases: 0 };

  const parsedNow = Date.parse(now);
  const updatedTs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const settledBy = actor?.trim() || 'system:event-settlement';
  const rows = await tx<EventDurableParkRow[]>`
    SELECT workspace_id, feature_id, status AS state, taken_by, payload
      FROM harness_shared.work_items
     WHERE COALESCE(payload, '{}'::jsonb) ->> '_claimHold' = 'true'
       AND NULLIF(COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by', '') IS NOT NULL
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND COALESCE(payload, '{}'::jsonb) -> 'claim_hold_release' ->> 'trigger' = ${trigger}
     FOR UPDATE
  `;

  let cleared = 0;
  let skipped = 0;
  let preservedLeases = 0;
  for (const row of rows) {
    const expectedParkFingerprint = durableParkFingerprint({
      state: row.state,
      takenBy: row.taken_by,
      payload: row.payload,
    });
    const plan = planDurableParkClear(
      { id: row.feature_id, state: row.state, takenBy: row.taken_by, payload: row.payload },
      {
        id: row.feature_id,
        expectedParkFingerprint,
        reasonCode: 'condition-satisfied',
        evidence: `announcement trigger "${trigger}" fired${actor?.trim() ? ` by ${settledBy}` : ''}`,
      },
    );
    if (plan.outcome !== 'cleared' || !plan.nextPayload) {
      skipped += 1;
      continue;
    }

    const priorPayload = record(row.payload);
    const updated = await tx<Array<{ feature_id: string }>>`
      UPDATE harness_shared.work_items
         SET payload = ${JSON.stringify(plan.nextPayload)}::text::jsonb,
             updated_ts = ${updatedTs}
       WHERE workspace_id = ${row.workspace_id}
         AND feature_id = ${row.feature_id}
         AND status = ${row.state}
         AND (taken_by IS NULL OR btrim(taken_by) = '')
         AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' = 'true'
         AND NULLIF(COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by', '') IS NOT NULL
         AND COALESCE(payload, '{}'::jsonb) -> 'claim_hold_release' ->> 'trigger' = ${trigger}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_by)}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_reason')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_reason)}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_at')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_at)}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_by')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_by)}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_reason')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_reason)}
         AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_at')
               IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_at)}
       RETURNING feature_id
    `;
    if (updated.length === 0) {
      skipped += 1;
      continue;
    }
    cleared += 1;
    if (plan.preservedLease) preservedLeases += 1;
  }

  return { matched: rows.length, cleared, skipped, preservedLeases };
}

function ageBucket(ageMs: number): AuditAgeBucket {
  if (ageMs < DAY_MS) return 'under-1d';
  if (ageMs < 7 * DAY_MS) return '1-7d';
  if (ageMs < 30 * DAY_MS) return '7-30d';
  return '30d-plus';
}

export function classifyAuditAge(at: string | null, nowMs: number): AuditAge {
  if (!at) return { status: 'missing', ageMs: null, bucket: 'unknown' };
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return { status: 'invalid', ageMs: null, bucket: 'unknown' };
  const ageMs = Math.max(0, nowMs - parsed);
  return { status: 'known', ageMs, bucket: ageBucket(ageMs) };
}

export function classifyUnparkCondition(reason: string | null): {
  status: UnparkConditionStatus;
  text: string | null;
} {
  const text = reason?.trim() || null;
  if (!text) return { status: 'missing', text: null };
  return {
    status: STATED_UNPARK_CONDITION.test(text) ? 'stated' : 'unresolved',
    text,
  };
}

export function buildDurableParkAuditReport(input: {
  rows: readonly DurableParkAuditSourceRow[];
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  nowMs: number;
  reviewOverdueHours?: number;
}): DurableParkAuditReport {
  const parkAgeBuckets: Record<AuditAgeBucket, number> = {
    'under-1d': 0,
    '1-7d': 0,
    '7-30d': 0,
    '30d-plus': 0,
    unknown: 0,
  };
  const unparkConditions: Record<UnparkConditionStatus, number> = {
    stated: 0,
    missing: 0,
    unresolved: 0,
  };
  const releaseStatusCounts: Record<DurableParkReleaseLivenessStatus, number> = {
    tracked: 0,
    unverified: 0,
    unreachable: 0,
    'satisfied-still-parked': 0,
  };
  const releaseFindingCounts: Record<DurableParkReleaseLivenessFinding, number> = {
    'condition-missing': 0,
    'condition-ambiguous': 0,
    'owner-missing': 0,
    'trigger-missing': 0,
    'reachability-unverified': 0,
    'evidence-missing': 0,
    'condition-unreachable': 0,
    'condition-satisfied-still-parked': 0,
  };
  let releaseConditionFlagged = 0;
  const missingMetadata = {
    unattributedClaimHolds: 0,
    parkReason: 0,
    parkTimestamp: 0,
    invalidParkTimestamp: 0,
    pendingReviewTimestamp: 0,
  };
  const axes = {
    activeClaims: 0,
    rawClaimHolds: 0,
    holdOpenLeases: 0,
    durableParks: 0,
    pendingAgentReview: 0,
    revisionRequestedAgentReview: 0,
  };
  const durableParks: DurableParkAuditParkRow[] = [];
  const holdOpenLeases: DurableParkAuditLeaseRow[] = [];
  const overdueRows: DurableParkAuditReviewRow[] = [];
  const reasonCounts = new Map<string, number>();
  const reviewOverdueHours = Math.max(1, Math.floor(input.reviewOverdueHours ?? DEFAULT_AGENT_REVIEW_OVERDUE_HOURS));
  const reviewOverdueMs = reviewOverdueHours * 60 * 60 * 1_000;

  for (const row of input.rows) {
    if (row.takenBy) axes.activeClaims += 1;
    const payload = record(row.payload);
    const rawClaimHold = String(payload._claimHold) === 'true';
    if (rawClaimHold) axes.rawClaimHolds += 1;
    const provenance = readWorkItemClaimHoldProvenance(payload);
    if (rawClaimHold && !provenance.attributed) missingMetadata.unattributedClaimHolds += 1;

    if (provenance.heldOpen) {
      axes.holdOpenLeases += 1;
      holdOpenLeases.push({
        id: row.id,
        holder: provenance.heldOpen.by,
        reason: provenance.heldOpen.reason,
        heldAt: provenance.heldOpen.at,
        age: classifyAuditAge(provenance.heldOpen.at, input.nowMs),
      });
    }

    if (provenance.parked) {
      axes.durableParks += 1;
      const age = classifyAuditAge(provenance.parked.at, input.nowMs);
      const unparkCondition = classifyUnparkCondition(provenance.parked.reason);
      const releaseLiveness = classifyDurableParkReleaseLiveness(payload, provenance.parked.reason);
      parkAgeBuckets[age.bucket] += 1;
      unparkConditions[unparkCondition.status] += 1;
      releaseStatusCounts[releaseLiveness.status] += 1;
      if (releaseLiveness.status !== 'tracked') releaseConditionFlagged += 1;
      for (const finding of releaseLiveness.findings) releaseFindingCounts[finding] += 1;
      if (!provenance.parked.reason?.trim()) missingMetadata.parkReason += 1;
      if (age.status === 'missing') missingMetadata.parkTimestamp += 1;
      if (age.status === 'invalid') missingMetadata.invalidParkTimestamp += 1;
      const reason = provenance.parked.reason?.trim();
      if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      durableParks.push({
        id: row.id,
        title: row.title,
        state: row.state,
        parker: provenance.parked.by,
        reason: provenance.parked.reason,
        parkedAt: provenance.parked.at,
        age,
        unparkCondition,
        releaseLiveness,
      });
    }

    const review = readAgentReviewState(payload);
    if (review?.status === 'pending') {
      axes.pendingAgentReview += 1;
      const routedAtMs = numberOrNull(row.reviewRoutedAtMs);
      if (routedAtMs == null) {
        missingMetadata.pendingReviewTimestamp += 1;
      } else {
        const reviewAgeMs = Math.max(0, input.nowMs - routedAtMs);
        if (reviewAgeMs >= reviewOverdueMs) {
          overdueRows.push({
            id: row.id,
            status: 'pending',
            submittedBy: review.submittedBy,
            ledgerIdeaId: review.ledgerIdeaId,
            round: review.round,
            routedAt: new Date(routedAtMs).toISOString(),
            ageMs: reviewAgeMs,
          });
        }
      }
    } else if (review?.status === 'revision-requested') {
      axes.revisionRequestedAgentReview += 1;
    }
  }

  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  durableParks.sort(byId);
  holdOpenLeases.sort(byId);
  overdueRows.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
  const reasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    schemaVersion: 'durable-park-audit-v2',
    runId: input.runId,
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    generatedAt: new Date(input.nowMs).toISOString(),
    reportOnly: true,
    modelCalled: false,
    population: {
      nonTerminal: input.rows.length,
      axes,
      note: 'Axes overlap by design: active claim, hold-open lease, durable park, and agent review are independent facts.',
    },
    parkAgeBuckets,
    unparkConditions,
    releaseConditionHealth: {
      statusCounts: releaseStatusCounts,
      findingCounts: releaseFindingCounts,
      flagged: releaseConditionFlagged,
      requirement:
        'Every retained durable park needs a realistically reachable condition, accountable owner/source, ' +
        'concrete re-evaluation trigger, and evidence. Unreachable or satisfied conditions require explicit ' +
        'reconciliation, reframing/terminalization, or escalation; age and parker death never auto-clear a park.',
    },
    missingMetadata,
    reasons,
    durableParks,
    holdOpenLeases,
    overdueReviews: {
      thresholdHours: reviewOverdueHours,
      timestampBasis: 'scout_routed_ideas.routed_at',
      rows: overdueRows,
    },
  };
}

type AuditDbRow = {
  id: string;
  title: string | null;
  state: string;
  taken_by: string | null;
  taken_at: Date | string | null;
  updated_ts: bigint | number | string | null;
  payload: unknown;
  review_routed_at_ms: bigint | number | string | null;
};

function instant(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function runWorkItemDurableParkAudit(opts: {
  workspaceId: string;
  harnessSlug: string;
  runId?: string;
  now?: () => number;
  reviewOverdueHours?: number;
  sql?: OrgSql;
  /** Existing text-artifact surface; false/omitted keeps library callers side-effect compatible. */
  artifactPath?: string | false;
  saveArtifact?: (harnessSlug: string, relPath: string, content: string) => Promise<void>;
}): Promise<DurableParkAuditReport> {
  const sql = opts.sql ?? getOrgPg().sql;
  const runId = opts.runId?.trim() || `${WORK_ITEM_DURABLE_PARK_AUDIT}:${randomUUID()}`;
  const now = opts.now ?? Date.now;
  const startedAtMs = now();

  const existing = await sql<Array<{ detail: Record<string, unknown> | null }>>`
    SELECT detail
      FROM harness_shared.admission_runs
     WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}
     LIMIT 1`;
  const existingDetail = record(existing[0]?.detail);
  if (existingDetail.status === 'complete' && existingDetail.mode === 'durable-park-audit') {
    const report = record(existingDetail.report);
    if (report.schemaVersion === 'durable-park-audit-v2') return report as unknown as DurableParkAuditReport;
  }

  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES
      (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, ${DURABLE_PARK_AUDIT_RUN_KIND},
       ${new Date(startedAtMs)},
       ${JSON.stringify({
         status: 'running',
         mode: 'durable-park-audit',
         reportOnly: true,
         outcome: {
           unit: 'snapshots',
           attempted: 1,
           successful: null,
           rolledBack: null,
           unchanged: null,
           uniqueRowsChanged: 0,
           failureReason: null,
           blockedReason: null,
         } satisfies AdmissionRunOutcome,
       })}::text::jsonb)
    ON CONFLICT (id) DO NOTHING`;

  try {
    const rows = await sql<AuditDbRow[]>`
      SELECT wi.feature_id AS id,
             wi.title,
             wi.status AS state,
             wi.taken_by,
             wi.taken_at,
             wi.updated_ts,
             wi.payload,
             sri.routed_at AS review_routed_at_ms
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.scout_routed_ideas sri
          ON sri.workspace_id = wi.workspace_id
         AND sri.idea_id = COALESCE(wi.payload, '{}'::jsonb) -> 'agentReview' ->> 'ledgerIdeaId'
       WHERE wi.workspace_id = ${opts.workspaceId}
         AND wi.harness_slug = ${opts.harnessSlug}
         AND NOT (wi.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       ORDER BY wi.feature_id`;
    const sourceRows: DurableParkAuditSourceRow[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      takenBy: row.taken_by,
      takenAt: instant(row.taken_at),
      updatedAtMs: numberOrNull(row.updated_ts),
      payload: row.payload,
      reviewRoutedAtMs: numberOrNull(row.review_routed_at_ms),
    }));
    const completedAtMs = now();
    const report = buildDurableParkAuditReport({
      rows: sourceRows,
      runId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      nowMs: completedAtMs,
      reviewOverdueHours: opts.reviewOverdueHours,
    });
    const matrix = buildDurableParkEvidenceMatrix({
      rows: sourceRows,
      runId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      nowMs: completedAtMs,
    });
    const artifactPath = typeof opts.artifactPath === 'string' ? opts.artifactPath.trim() : '';
    const matrixJson = JSON.stringify(matrix, null, 2);
    const matrixSha256 = createHash('sha256').update(matrixJson).digest('hex');
    if (artifactPath) {
      await (opts.saveArtifact ?? saveTextArtifact)(opts.harnessSlug, artifactPath, matrixJson);
    }
    const latencyMs = Math.max(0, now() - startedAtMs);
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(now())},
             batch_size = ${report.population.nonTerminal},
             held = ${report.population.axes.durableParks},
             model_id = NULL,
             tokens_in = 0,
             tokens_out = 0,
             latency_ms = ${latencyMs},
             detail = ${JSON.stringify({
               status: 'complete',
               mode: 'durable-park-audit',
               reportOnly: true,
               report,
               evidenceMatrix: {
                 artifactPath: artifactPath || null,
                 sha256: matrixSha256,
                 rows: matrix.population.rawClaimHolds,
                 durableParks: matrix.population.durableParks,
                 holdOpenLeases: matrix.population.holdOpenLeases,
               },
               outcome: {
                 unit: 'snapshots',
                 attempted: 1,
                 successful: 1,
                 rolledBack: 0,
                 unchanged: 0,
                 uniqueRowsChanged: 0,
                 failureReason: null,
                 blockedReason: null,
               } satisfies AdmissionRunOutcome,
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    return report;
  } catch (error) {
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(now())},
             latency_ms = ${Math.max(0, now() - startedAtMs)},
             detail = ${JSON.stringify({
               status: 'failed',
               mode: 'durable-park-audit',
               reportOnly: true,
               error: error instanceof Error ? error.message : String(error),
               outcome: {
                 unit: 'snapshots',
                 attempted: 1,
                 successful: 0,
                 rolledBack: 0,
                 unchanged: 0,
                 uniqueRowsChanged: 0,
                 failureReason: error instanceof Error ? error.message : String(error),
                 blockedReason: null,
               } satisfies AdmissionRunOutcome,
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    throw error;
  }
}

const DURABLE_PARK_CLEAR_REASONS = new Set<DurableParkClearReason>([
  'condition-satisfied',
  'duplicate-terminal',
  'review-completed',
  'typed-blocker-resolved',
  'operator-directed',
]);

type ReconcileDbRow = {
  id: string;
  state: string;
  taken_by: string | null;
  payload: unknown;
};

function reconcileArtifactPath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return `reports/durable-parks/${safe}-reconcile.json`;
}

function validateReconcileInput(opts: { actor: string; decisions: readonly DurableParkReconcileDecision[] }): void {
  if (!opts.actor.trim()) throw new Error('durable-park reconciliation requires actor');
  if (opts.decisions.length === 0) throw new Error('durable-park reconciliation requires at least one decision');
  if (opts.decisions.length > 500) throw new Error('durable-park reconciliation is capped at 500 decisions per run');
  const ids = new Set<string>();
  for (const decision of opts.decisions) {
    if (!decision.id.trim()) throw new Error('durable-park reconciliation decision id is required');
    if (ids.has(decision.id)) throw new Error(`duplicate durable-park reconciliation id: ${decision.id}`);
    ids.add(decision.id);
    if (!/^[0-9a-f]{64}$/.test(decision.expectedParkFingerprint)) {
      throw new Error(`invalid expectedParkFingerprint for ${decision.id}`);
    }
    if (!DURABLE_PARK_CLEAR_REASONS.has(decision.reasonCode)) {
      throw new Error(`invalid durable-park reasonCode for ${decision.id}: ${String(decision.reasonCode)}`);
    }
    if (!decision.evidence.trim())
      throw new Error(`durable-park reconciliation evidence is required for ${decision.id}`);
  }
}

function reconcileInputSha256(input: {
  workspaceId: string;
  harnessSlug: string;
  actor: string;
  decisions: readonly DurableParkReconcileDecision[];
}): string {
  const canonical = {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    actor: input.actor.trim(),
    decisions: [...input.decisions]
      .map((decision) => ({
        id: decision.id,
        expectedParkFingerprint: decision.expectedParkFingerprint,
        reasonCode: decision.reasonCode,
        evidence: decision.evidence,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Apply explicit, evidence-backed durable-park dispositions through a predicate CAS.
 * A coexisting liveness lease survives intact; an assignment, state/control drift, or
 * missing fingerprint converts that row to a report-only outcome.
 */
export async function runWorkItemDurableParkReconciliation(opts: {
  workspaceId: string;
  harnessSlug: string;
  actor: string;
  decisions: readonly DurableParkReconcileDecision[];
  runId?: string;
  now?: () => number;
  sql?: OrgSql;
  artifactPath?: string;
  saveArtifact?: (harnessSlug: string, relPath: string, content: string) => Promise<void>;
}): Promise<DurableParkReconcileResult> {
  validateReconcileInput(opts);
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const runId = opts.runId?.trim() || `${WORK_ITEM_DURABLE_PARK_AUDIT}:reconcile:${randomUUID()}`;
  const artifactPath = opts.artifactPath?.trim() || reconcileArtifactPath(runId);
  const startedAtMs = now();
  const inputSha256 = reconcileInputSha256(opts);

  const existing = await sql<Array<{ detail: Record<string, unknown> | null }>>`
    SELECT detail
      FROM harness_shared.admission_runs
     WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}
     LIMIT 1`;
  const existingDetail = record(existing[0]?.detail);
  if (existingDetail.status === 'complete' && existingDetail.mode === 'durable-park-reconcile') {
    const prior = record(existingDetail.result);
    if (prior.schemaVersion === 'durable-park-reconcile-v1') {
      const priorRows = Array.isArray(prior.rows)
        ? prior.rows.filter((row): row is DurableParkReconcileRowResult => !!row && typeof row === 'object')
        : [];
      const priorActor = textOrNull(prior.actor) ?? textOrNull(existingDetail.actor);
      const priorInputSha256 =
        textOrNull(existingDetail.inputSha256) ??
        (priorActor && priorRows.length
          ? reconcileInputSha256({
              workspaceId: textOrNull(prior.workspaceId) ?? opts.workspaceId,
              harnessSlug: textOrNull(prior.harnessSlug) ?? opts.harnessSlug,
              actor: priorActor,
              decisions: priorRows.map((row) => ({
                id: row.id,
                expectedParkFingerprint: row.expectedParkFingerprint,
                reasonCode: row.reasonCode,
                evidence: row.evidence,
              })),
            })
          : null);
      if (priorInputSha256 !== inputSha256) {
        throw new Error(`durable-park reconciliation runId ${runId} was already used with different input`);
      }
      return { ...(prior as unknown as DurableParkReconcileResult), inputSha256 };
    }
  }

  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES
      (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, ${DURABLE_PARK_AUDIT_RUN_KIND},
       ${new Date(startedAtMs)},
       ${JSON.stringify({
         status: 'running',
         mode: 'durable-park-reconcile',
         actor: opts.actor,
         inputSha256,
         requested: opts.decisions.length,
         outcome: {
           unit: 'parks',
           attempted: null,
           successful: null,
           rolledBack: null,
           unchanged: null,
           uniqueRowsChanged: null,
           failureReason: null,
           blockedReason: null,
         } satisfies AdmissionRunOutcome,
       })}::text::jsonb)
    ON CONFLICT (id) DO NOTHING`;

  try {
    const rowResults: DurableParkReconcileRowResult[] = [];
    for (const decision of opts.decisions) {
      const result = await sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as OrgSql;
        const rows = await tx<ReconcileDbRow[]>`
          SELECT feature_id AS id, status AS state, taken_by, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${opts.workspaceId}
             AND harness_slug = ${opts.harnessSlug}
             AND feature_id = ${decision.id}`;
        const row = rows[0];
        if (!row) {
          return {
            id: decision.id,
            outcome: 'missing' as const,
            expectedParkFingerprint: decision.expectedParkFingerprint,
            observedParkFingerprint: null,
            reasonCode: decision.reasonCode,
            evidence: decision.evidence,
            preservedLease: false,
            takenBy: null,
          };
        }

        const plan = planDurableParkClear(
          { id: row.id, state: row.state, takenBy: row.taken_by, payload: row.payload },
          decision,
        );
        const { nextPayload, ...outcome } = plan;
        if (plan.outcome !== 'cleared' || !nextPayload) return outcome;

        const priorPayload = record(row.payload);
        const updated = await tx<Array<{ payload: unknown }>>`
          UPDATE harness_shared.work_items
             SET payload = CASE
                   WHEN COALESCE(payload, '{}'::jsonb) ->> 'held_open_by' IS NOT NULL
                    AND COALESCE(payload, '{}'::jsonb) ->> 'held_open_by' <> ''
                   THEN COALESCE(payload, '{}'::jsonb)
                          - 'claim_hold_by' - 'claim_hold_reason' - 'claim_hold_at' - 'claim_hold_release'
                   ELSE COALESCE(payload, '{}'::jsonb)
                          - '_claimHold' - 'claim_hold_by' - 'claim_hold_reason' - 'claim_hold_at' - 'claim_hold_release'
                 END,
                 updated_ts = ${now()}
           WHERE workspace_id = ${opts.workspaceId}
             AND harness_slug = ${opts.harnessSlug}
             AND feature_id = ${decision.id}
             AND status = ${row.state}
             AND taken_by IS NULL
             AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' = 'true'
             AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_by)}
             AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_reason')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_reason)}
             AND (COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_at')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.claim_hold_at)}
             AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_by')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_by)}
             AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_reason')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_reason)}
             AND (COALESCE(payload, '{}'::jsonb) ->> 'held_open_at')
                   IS NOT DISTINCT FROM ${textOrNull(priorPayload.held_open_at)}
          RETURNING payload`;
        if (!updated[0]) {
          const raced = await tx<ReconcileDbRow[]>`
            SELECT feature_id AS id, status AS state, taken_by, payload
              FROM harness_shared.work_items
             WHERE workspace_id = ${opts.workspaceId}
               AND harness_slug = ${opts.harnessSlug}
               AND feature_id = ${decision.id}`;
          if (!raced[0]) return { ...outcome, outcome: 'missing' as const, observedParkFingerprint: null };
          const retryPlan = planDurableParkClear(
            {
              id: raced[0].id,
              state: raced[0].state,
              takenBy: raced[0].taken_by,
              payload: raced[0].payload,
            },
            decision,
          );
          const { nextPayload: _ignored, ...retryOutcome } = retryPlan;
          return retryOutcome;
        }
        const before = readWorkItemClaimHoldProvenance(row.payload);
        await tx`
          INSERT INTO harness_shared.audit_log
            (id, ts, actor, action, subject, details, workspace_id)
          VALUES
            (${`durable-park-clear-${randomUUID()}`}, ${now()}, ${opts.actor},
             ${DURABLE_PARK_CLEAR_AUDIT_ACTION}, ${decision.id},
             ${JSON.stringify({
               runId,
               harness: opts.harnessSlug,
               reasonCode: decision.reasonCode,
               evidence: decision.evidence,
               expectedParkFingerprint: decision.expectedParkFingerprint,
               observedParkFingerprint: plan.observedParkFingerprint,
               preservedLease: plan.preservedLease,
               priorPark: before.parked,
             })}::text::jsonb,
             ${opts.workspaceId})`;
        return outcome;
      });
      rowResults.push(result);
    }

    const finishedAtMs = now();
    const result: DurableParkReconcileResult = {
      schemaVersion: 'durable-park-reconcile-v1',
      runId,
      inputSha256,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      generatedAt: new Date(finishedAtMs).toISOString(),
      actor: opts.actor,
      requested: rowResults.length,
      cleared: rowResults.filter((row) => row.outcome === 'cleared').length,
      unchanged: rowResults.filter((row) => row.outcome !== 'cleared').length,
      rows: rowResults,
      artifactPath,
    };
    await (opts.saveArtifact ?? saveTextArtifact)(opts.harnessSlug, artifactPath, JSON.stringify(result, null, 2));
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(finishedAtMs)},
             batch_size = ${result.requested},
             promoted = ${result.cleared},
             held = ${result.unchanged},
             model_id = NULL,
             tokens_in = 0,
             tokens_out = 0,
             latency_ms = ${Math.max(0, finishedAtMs - startedAtMs)},
             detail = ${JSON.stringify({
               status: 'complete',
               mode: 'durable-park-reconcile',
               actor: opts.actor,
               inputSha256,
               artifactPath,
             result,
             outcome: {
               unit: 'parks',
               attempted: result.requested,
               successful: result.cleared,
               rolledBack: 0,
               unchanged: result.unchanged,
               uniqueRowsChanged: result.cleared,
               failureReason: null,
               blockedReason: null,
             } satisfies AdmissionRunOutcome,
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    return result;
  } catch (error) {
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = ${new Date(now())},
             latency_ms = ${Math.max(0, now() - startedAtMs)},
             detail = ${JSON.stringify({
               status: 'failed',
               mode: 'durable-park-reconcile',
               actor: opts.actor,
               error: error instanceof Error ? error.message : String(error),
               outcome: {
                 unit: 'parks',
                 attempted: opts.decisions.length,
                 successful: null,
                 rolledBack: null,
                 unchanged: null,
                 uniqueRowsChanged: null,
                 failureReason: error instanceof Error ? error.message : String(error),
                 blockedReason: null,
               } satisfies AdmissionRunOutcome,
             })}::text::jsonb
       WHERE id = ${runId} AND workspace_id = ${opts.workspaceId}`;
    throw error;
  }
}
