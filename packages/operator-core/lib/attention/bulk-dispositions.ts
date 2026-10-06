/**
 * Canonical bulk-run dispositions (P-001 of
 * bulk-resolve-dispositions-confidence-2026-08-28).
 *
 * `skipped` was useful as an internal escape hatch, but it collapses several
 * materially different owner outcomes into one bucket: an owner-authority
 * decision, a stale duplicate, an unavailable detail read, and an engineering
 * hand-off all looked identical in the UI.  This module is deliberately pure so
 * the Inbox and Plans stores can share the vocabulary without sharing their
 * persistence or dispatch code.
 *
 * The legacy outcome remains a wire-compatible input.  New writers should set a
 * typed disposition and a recommendation.  Readers can call
 * `canonicalDispositionForRow` for old rows; an unknown/ambiguous reason becomes
 * `investigate` with `insufficient` confidence rather than being silently
 * treated as resolved.
 */

import {
  bugReproductionMissingText,
  parseBugReproductionReceipt,
  readBugReproductionReceipt,
  type BugReproductionReceipt,
} from './bug-reproduction';

export const BULK_CONFIDENCE_LEVELS = [
  'high',
  'medium',
  'low',
  'insufficient',
] as const;

export type BulkConfidence = (typeof BULK_CONFIDENCE_LEVELS)[number];

/** Owner-selectable automation posture for a bulk run (legacy audit shape). */
export const BULK_AUTOMATION_MODES = [
  'review-all',
  'safe-high',
  'safe-medium-plus',
] as const;

export type BulkAutomationMode = (typeof BULK_AUTOMATION_MODES)[number];

/** Ordered authority ladder stored once per workspace (P-006/P-007). */
export const BULK_AUTOMATION_LEVELS = ['L0', 'L1', 'L2'] as const;
export type BulkAutomationLevel = (typeof BULK_AUTOMATION_LEVELS)[number];

export interface BulkAutomationPolicy {
  /** `safe-high` is the default when a legacy run has no policy snapshot. */
  mode: BulkAutomationMode;
  /** Minimum confidence required before a terminal action may auto-apply. */
  minConfidence: BulkConfidence;
  /** P-006 snapshot metadata; absent on legacy run rows. */
  level?: BulkAutomationLevel;
}

export const DEFAULT_BULK_AUTOMATION_POLICY: Readonly<BulkAutomationPolicy> = {
  mode: 'safe-high',
  minConfidence: 'high',
};

/**
 * The mutable workspace source of truth. Unlike the legacy run snapshot's
 * combined `mode`, these axes are independent by construction.
 */
export interface StandingBulkAutomationPolicy {
  level: BulkAutomationLevel;
  minConfidence: BulkConfidence;
}

export const DEFAULT_STANDING_BULK_AUTOMATION_POLICY: Readonly<StandingBulkAutomationPolicy> = {
  level: 'L0',
  minConfidence: 'high',
};

/** Numeric ordering used only for the additional confidence floor. */
const CONFIDENCE_RANK: Record<BulkConfidence, number> = {
  insufficient: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function meetsBulkConfidenceFloor(
  confidence: BulkConfidence | null | undefined,
  minimum: BulkConfidence,
): boolean {
  return confidence != null && CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[minimum];
}

export interface BulkAutomationEligibility {
  allowed: boolean;
  reason: 'review-all' | 'confidence-below-floor' | 'confidence-missing' | null;
}

/**
 * Apply the owner-selected confidence floor. This helper intentionally knows
 * nothing about action authority or risk: callers must run the existing
 * autonomy/dispatcher gate first, then use this as an additional restriction.
 */
export function bulkAutomationEligibility(
  policy: BulkAutomationPolicy,
  confidence: BulkConfidence | null | undefined,
): BulkAutomationEligibility {
  const level = policy.level ?? (policy.mode === 'review-all' ? 'L0' : 'L1');
  if (level === 'L0') {
    return { allowed: false, reason: 'review-all' };
  }
  if (confidence == null) {
    return { allowed: false, reason: 'confidence-missing' };
  }
  if (!meetsBulkConfidenceFloor(confidence, policy.minConfidence)) {
    return { allowed: false, reason: 'confidence-below-floor' };
  }
  return { allowed: true, reason: null };
}

export function isBulkAutomationMode(value: unknown): value is BulkAutomationMode {
  return typeof value === 'string' && (BULK_AUTOMATION_MODES as readonly string[]).includes(value);
}

export function isBulkAutomationLevel(value: unknown): value is BulkAutomationLevel {
  return typeof value === 'string' && (BULK_AUTOMATION_LEVELS as readonly string[]).includes(value);
}

export function normalizeStandingBulkAutomationPolicy(
  value: Partial<StandingBulkAutomationPolicy> | null | undefined,
): StandingBulkAutomationPolicy {
  return {
    level: isBulkAutomationLevel(value?.level)
      ? value!.level
      : DEFAULT_STANDING_BULK_AUTOMATION_POLICY.level,
    minConfidence: isBulkConfidence(value?.minConfidence)
      ? value!.minConfidence
      : DEFAULT_STANDING_BULK_AUTOMATION_POLICY.minConfidence,
  };
}

/** Immutable run receipt derived from the standing policy at launch. */
export function bulkAutomationSnapshot(
  policy: StandingBulkAutomationPolicy,
): BulkAutomationPolicy {
  return {
    level: policy.level,
    mode: policy.level === 'L0' ? 'review-all' : 'safe-high',
    minConfidence: policy.minConfidence,
  };
}

export type BulkAutomationPolicyInput = Partial<BulkAutomationPolicy> & {
  /** Pre-P-006 compatibility input; never persisted by the canonical writer. */
  mode?: BulkAutomationMode;
};

export function normalizeBulkAutomationPolicy(
  value: BulkAutomationPolicyInput | null | undefined,
): BulkAutomationPolicy {
  const legacyMode = isBulkAutomationMode(value?.mode) ? value!.mode : null;
  const explicitLevel = isBulkAutomationLevel(value?.level) ? value!.level : null;
  const level = explicitLevel
    ? explicitLevel
    : legacyMode === 'review-all'
      ? 'L0'
      : legacyMode === 'safe-high' || legacyMode === 'safe-medium-plus'
        ? 'L1'
        : undefined;
  // Legacy mode values had an implicit floor (review-all/safe-high => high,
  // safe-medium-plus => medium). Preserve that read compatibility only when
  // no explicit standing level is present; the new standing shape keeps the
  // confidence axis wholly independent.
  const requestedConfidence = isBulkConfidence(value?.minConfidence)
    ? value!.minConfidence
    : legacyMode === 'safe-medium-plus'
      ? 'medium'
      : DEFAULT_BULK_AUTOMATION_POLICY.minConfidence;
  const legacyFloor: BulkConfidence = legacyMode === 'safe-medium-plus' ? 'medium' : 'high';
  const minConfidence = explicitLevel
    ? requestedConfidence
    : CONFIDENCE_RANK[requestedConfidence] >= CONFIDENCE_RANK[legacyFloor]
      ? requestedConfidence
      : legacyFloor;
  return {
    mode:
      legacyMode ??
      (level === 'L0' ? 'review-all' : level ? 'safe-high' : DEFAULT_BULK_AUTOMATION_POLICY.mode),
    minConfidence,
    ...(explicitLevel ? { level: explicitLevel } : {}),
  };
}

/** The owner-readable, non-terminal next-step classes. */
export const BULK_RECOMMENDATION_KINDS = [
  'owner_action',
  'cleanup_candidate',
  'retry_needed',
  'routed',
  'investigate',
] as const;

export type BulkRecommendationKind = (typeof BULK_RECOMMENDATION_KINDS)[number];

export const BULK_RESPONSIBILITIES = [
  'owner',
  'agent',
  'system',
  'engineering',
  'unknown',
] as const;

export type BulkResponsibility = (typeof BULK_RESPONSIBILITIES)[number];

/**
 * The persisted/derived disposition vocabulary. `legacy_skipped` is read-only
 * compatibility; it must never be emitted by a new resolver report.
 */
export const BULK_DISPOSITION_KINDS = [
  'pending',
  'auto_resolved',
  'recommended',
  'owner_action',
  'cleanup_candidate',
  'retry_needed',
  'routed',
  'investigate',
  'failed',
  'dismissed',
  'legacy_skipped',
] as const;

export type BulkDispositionKind = (typeof BULK_DISPOSITION_KINDS)[number];

/** The old item outcome values accepted by migrations and legacy readers. */
export const LEGACY_BULK_OUTCOMES = [
  'pending',
  'auto_resolved',
  'recommended',
  'skipped',
  'failed',
  'dismissed',
] as const;

export type LegacyBulkOutcome = (typeof LEGACY_BULK_OUTCOMES)[number];

export interface BulkRecommendation {
  /** The non-terminal owner-readable next-step class. */
  kind: BulkRecommendationKind;
  /** Short label suitable for a report row or group heading. */
  label: string;
  /** Why this is the proposed next step. Must be evidence-based. */
  rationale: string;
  /** References or facts that support the proposal. */
  evidenceBasis: string[];
  /** Confidence in the proposal, not permission to execute it. */
  confidence: BulkConfidence;
  /** Who owns the next step when it cannot be auto-applied. */
  responsibility: BulkResponsibility;
  /** A real offered terminal action, when one exists; never invented. */
  actionId: string | null;
  /** Condition under which a retry should be attempted, when relevant. */
  retryCondition?: string | null;
  /** Stable source/work-item reference, when available. */
  targetRef?: string | null;
}

export interface BulkDispositionRecord {
  disposition: BulkDispositionKind;
  recommendation: BulkRecommendation | null;
  /** Original wire outcome, retained for audit and migration compatibility. */
  legacyOutcome?: LegacyBulkOutcome | null;
  /** Machine-readable reason used by the legacy classifier. */
  reasonCode?: LegacySkipReasonCode | null;
}

export type LegacySkipReasonCode =
  | 'owner-authority'
  | 'owner-external-dependency'
  | 'stale-duplicate-or-moot'
  | 'retry-data-unavailable'
  | 'engineering-route'
  | 'owner-investigation'
  | 'unknown';

export interface LegacySkippedRow {
  itemId?: string | null;
  itemKind?: string | null;
  title?: string | null;
  error?: string | null;
  rationale?: string | null;
  /** Optional source reference used in evidence text. */
  targetRef?: string | null;
}

export interface LegacySkipClassification {
  disposition: Exclude<
    BulkDispositionKind,
    'pending' | 'auto_resolved' | 'recommended' | 'failed' | 'dismissed' | 'legacy_skipped'
  >;
  reasonCode: LegacySkipReasonCode;
  recommendation: BulkRecommendation;
}

function textOf(row: LegacySkippedRow): string {
  return [row.itemKind, row.title, row.error, row.rationale]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function evidenceFor(row: LegacySkippedRow, fallback: string): string[] {
  const refs = row.targetRef?.trim() ? [row.targetRef.trim()] : [];
  const reason = row.error?.trim() || row.rationale?.trim() || fallback;
  return [...refs, reason];
}

function recommendation(
  row: LegacySkippedRow,
  kind: BulkRecommendationKind,
  label: string,
  rationale: string,
  confidence: BulkConfidence,
  responsibility: BulkResponsibility,
  reasonCode: LegacySkipReasonCode,
  retryCondition?: string,
): LegacySkipClassification {
  return {
    disposition: kind,
    reasonCode,
    recommendation: {
      kind,
      label,
      rationale,
      evidenceBasis: evidenceFor(row, rationale),
      confidence,
      responsibility,
      actionId: null,
      ...(retryCondition ? { retryCondition } : {}),
      ...(row.targetRef?.trim() ? { targetRef: row.targetRef.trim() } : {}),
    },
  };
}

/**
 * Deterministically classify a legacy `skipped` row.
 *
 * Match order is intentional.  Availability failures are checked before
 * semantic words such as "owner", because a row can mention an owner while its
 * real problem is that the detail/action projection never loaded.  Strong
 * stale/duplicate markers precede the broader owner-dependency markers.  The
 * final branch is deliberately conservative: an ambiguous row needs an owner
 * investigation, never an automatic action.
 */
export function classifyLegacySkipped(row: LegacySkippedRow): LegacySkipClassification {
  const haystack = textOf(row);

  if (
    /no options offered/.test(haystack) &&
    /(detail not loaded|left the feed|actions? (?:never )?loaded|not available)/.test(haystack)
  ) {
    return recommendation(
      row,
      'retry_needed',
      'Retry when item details are available',
      'The resolver could not read the current item actions, so it must not guess.',
      'insufficient',
      'system',
      'retry-data-unavailable',
      'Reload the item detail/actions projection, then retry this row.',
    );
  }

  if (
    /(real defect report|engineering work|route(?:d)? to engineering|self-re-exec|code defect)/.test(
      haystack,
    )
  ) {
    return recommendation(
      row,
      'routed',
      'Route to engineering',
      'This is engineering work rather than an owner decision; track it in the engineering queue.',
      'high',
      'engineering',
      'engineering-route',
    );
  }

  if (
    /(moot|already done|duplicate|test residue|stale feed|byte-identical|not genuinely needs-human|nothing to resolve)/.test(
      haystack,
    )
  ) {
    return recommendation(
      row,
      'cleanup_candidate',
      'Review cleanup / reconciliation',
      'The source appears stale, duplicated, test-only, or already complete; verify the evidence and reconcile the row.',
      'high',
      'owner',
      'stale-duplicate-or-moot',
    );
  }

  if (row.itemKind === 'dark-flag-ratification' || /dark-flag|owner authority|owner-only/.test(haystack)) {
    return recommendation(
      row,
      'owner_action',
      'Review and ratify the protected decision',
      'This disposition is owner-authority by policy and must remain manual regardless of resolver confidence.',
      'high',
      'owner',
      'owner-authority',
    );
  }

  if (
    /(owner-gated|owner-attended|owner-run|owner hard-stop|awaits owner|credential|credentials|\bmoney\b|apple developer|authenticode|multi-machine|physical-device|external service|scheduling)/.test(
      haystack,
    )
  ) {
    return recommendation(
      row,
      'owner_action',
      'Complete the owner action in its source surface',
      'The next step depends on an owner-held credential, device, purchase, review, scheduling choice, or other external dependency.',
      'high',
      'owner',
      'owner-external-dependency',
    );
  }

  // The common historical work-item row said only "open/discuss". That is not
  // evidence for a terminal action, so make the uncertainty explicit.
  return recommendation(
    row,
    'investigate',
    'Investigate before choosing a disposition',
    'The resolver found no safe terminal action and the recorded reason is not specific enough to choose an owner action automatically.',
    'insufficient',
    'owner',
    'owner-investigation',
  );
}

/** Map any old outcome into the canonical disposition vocabulary. */
export function canonicalDispositionForRow(row: {
  outcome: LegacyBulkOutcome | string | null | undefined;
  disposition?: BulkDispositionKind | null;
  itemKind?: string | null;
  title?: string | null;
  error?: string | null;
  rationale?: string | null;
  itemId?: string | null;
  targetRef?: string | null;
}): BulkDispositionRecord {
  if (
    row.disposition &&
    isBulkDispositionKind(row.disposition) &&
    row.disposition !== 'legacy_skipped'
  ) {
    const hasRecommendation = BULK_RECOMMENDATION_KINDS.includes(
      row.disposition as BulkRecommendationKind,
    );
    return {
      disposition: row.disposition,
      recommendation: hasRecommendation
        ? classifyLegacySkipped({
            itemId: row.itemId,
            itemKind: row.itemKind,
            title: row.title,
            error: row.error,
            rationale: row.rationale,
            targetRef: row.targetRef,
          }).recommendation
        : null,
      legacyOutcome: (row.outcome as LegacyBulkOutcome) ?? null,
    };
  }

  if (row.outcome === 'skipped' || row.disposition === 'legacy_skipped') {
    const classified = classifyLegacySkipped(row);
    return {
      ...classified,
      legacyOutcome: 'skipped',
    };
  }

  if (row.outcome === 'pending') {
    return { disposition: 'pending', recommendation: null, legacyOutcome: 'pending' };
  }
  if (row.outcome === 'auto_resolved') {
    return { disposition: 'auto_resolved', recommendation: null, legacyOutcome: 'auto_resolved' };
  }
  if (row.outcome === 'recommended') {
    return { disposition: 'recommended', recommendation: null, legacyOutcome: 'recommended' };
  }
  if (row.outcome === 'failed') {
    return { disposition: 'failed', recommendation: null, legacyOutcome: 'failed' };
  }
  if (row.outcome === 'dismissed') {
    return { disposition: 'dismissed', recommendation: null, legacyOutcome: 'dismissed' };
  }

  // Unknown values are never allowed to look terminal. Preserve the original
  // value only in the evidence text and route it to an explicit investigation.
  const classified = classifyLegacySkipped({
    itemId: row.itemId,
    itemKind: row.itemKind,
    title: row.title,
    error: row.error || `unknown bulk outcome: ${String(row.outcome)}`,
    rationale: row.rationale,
    targetRef: row.targetRef,
  });
  return { ...classified, legacyOutcome: null };
}

export interface BulkAccountingCounts {
  total: number;
  pending: number;
  autoResolved: number;
  recommended: number;
  ownerAction: number;
  cleanupCandidate: number;
  retryNeeded: number;
  routed: number;
  investigate: number;
  failed: number;
  dismissed: number;
  /** Rows still requiring an owner/system next step. */
  unresolved: number;
}

/**
 * Count canonical dispositions. The conservation invariant is structural:
 * every input row increments exactly one bucket, and `unresolved` is derived
 * from all non-terminal buckets rather than a guessed subtraction.
 */
export function countBulkDispositions(
  rows: readonly Parameters<typeof canonicalDispositionForRow>[0][],
): BulkAccountingCounts {
  const counts: BulkAccountingCounts = {
    total: rows.length,
    pending: 0,
    autoResolved: 0,
    recommended: 0,
    ownerAction: 0,
    cleanupCandidate: 0,
    retryNeeded: 0,
    routed: 0,
    investigate: 0,
    failed: 0,
    dismissed: 0,
    unresolved: 0,
  };

  for (const row of rows) {
    switch (canonicalDispositionForRow(row).disposition) {
      case 'pending':
        counts.pending += 1;
        break;
      case 'auto_resolved':
        counts.autoResolved += 1;
        break;
      case 'recommended':
        counts.recommended += 1;
        break;
      case 'owner_action':
        counts.ownerAction += 1;
        break;
      case 'cleanup_candidate':
        counts.cleanupCandidate += 1;
        break;
      case 'retry_needed':
        counts.retryNeeded += 1;
        break;
      case 'routed':
        counts.routed += 1;
        break;
      case 'investigate':
        counts.investigate += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'dismissed':
        counts.dismissed += 1;
        break;
      case 'legacy_skipped':
        // canonicalDispositionForRow classifies this before returning. Keep a
        // defensive branch so a future extension cannot break conservation.
        counts.investigate += 1;
        break;
    }
  }

  counts.unresolved =
    counts.pending +
    counts.recommended +
    counts.ownerAction +
    counts.cleanupCandidate +
    counts.retryNeeded +
    counts.routed +
    counts.investigate +
    counts.failed;
  return counts;
}

/** A cheap runtime guard for values crossing the HTTP/sync boundary. */
export function isBulkConfidence(value: unknown): value is BulkConfidence {
  return typeof value === 'string' && (BULK_CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

export function isBulkRecommendationKind(value: unknown): value is BulkRecommendationKind {
  return typeof value === 'string' && (BULK_RECOMMENDATION_KINDS as readonly string[]).includes(value);
}

export function isBulkDispositionKind(value: unknown): value is BulkDispositionKind {
  return typeof value === 'string' && (BULK_DISPOSITION_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Intake dispositions (observation-candidate-acceptance-promotion-2026-09-30
// P-004, BARs R-3 / R-18 / R-19).
//
// An INTAKE input is an observation or unverified candidate surfaced in the
// attention feed. Reviewing one in a saved bulk run ends in exactly one of six
// typed decisions. The decision rides BESIDE the existing disposition /
// recommendation columns (migration 1296 `intake_decision`): each intake
// disposition also projects onto the existing recommendation vocabulary, so the
// run counters, settle and report UI keep reading the columns they already read.
// Promotion itself (creating/updating canonical work) is P-006; this layer only
// records an attributable, validated decision with an owned next step.
// ---------------------------------------------------------------------------

export const BULK_INTAKE_DISPOSITIONS = [
  'promote',
  'merge',
  'investigate',
  'retain',
  'reject',
  'retry',
] as const;

export type BulkIntakeDisposition = (typeof BULK_INTAKE_DISPOSITIONS)[number];

/** Attention-item kinds that are intake inputs (observations / candidates). */
export const INTAKE_ATTENTION_KINDS = ['improvement'] as const;

export function isIntakeAttentionKind(kind: unknown): boolean {
  return typeof kind === 'string' && (INTAKE_ATTENTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Bulk-run kinds whose items are NOT attention-feed members, so feed membership
 * cannot be their liveness check (observation-candidate plan P-008 / D-020). An
 * intake-triage item is an observation-lane row, and the feed admits improvement
 * rows only when they are flagged for a human, so a feed-membership gate would
 * refuse every intake-triage application. Their liveness is the source row's own
 * state, which `executeIntakeDecision` re-reads under its row lock
 * (`source-not-found` / `source-terminal` refusals write nothing).
 */
export function isSourceLivenessRunKind(kind: unknown): boolean {
  return kind === 'intake-triage';
}

/**
 * P-008 / D-020 §4: an uncertain report cannot become accepted fix work. A promote
 * whose confidence is `low` or `insufficient` is refused when it is REPORTED, so it
 * never reaches application; the resolver records investigate or retry instead.
 * Returns the refusal text, or null when the decision may be recorded.
 */
export function intakeConfidenceRefusal(disposition: string, confidenceLevel: string | null | undefined): string | null {
  if (disposition !== 'promote') return null;
  if (confidenceLevel !== 'low' && confidenceLevel !== 'insufficient') return null;
  return (
    `a ${confidenceLevel}-confidence report cannot become accepted work: promote needs confidenceLevel high or medium. ` +
    'Record investigate (the open question, evidence to collect and exit check) or retry (with the missing information) instead'
  );
}

/** One run row as the intake-drain summary reads it. */
export interface IntakeDrainRow {
  outcome: string;
  actionId: string | null;
  intakeDecision: BulkIntakeDecision | null;
  /** The accepted item's delivery state, when the caller has read it. */
  promoted?: { state: string; completionAuthority?: string | null } | null;
}

export interface IntakeDrainSummary {
  /** Intake dispositions: what was DECIDED about each input. */
  intake: {
    total: number;
    decided: number;
    undecided: number;
    failed: number;
    applied: number;
    byDisposition: Record<BulkIntakeDisposition, number>;
  };
  /** Accepted-work delivery: a separate question from the decision. */
  delivery: { accepted: number; delivered: number; notDelivered: number };
}

/**
 * P-008 / D-020 §5 (R-27): summarize an intake drain with dispositions SEPARATE from
 * implementation delivery. An applied promote/investigate counts as accepted, and
 * only as delivered once its item is terminal `done` with committed completion
 * authority, so "accepted" can never read as "shipped". Intake never feeds the run's
 * resolved counters; this summary is the only place its outcomes are counted.
 */
export function summarizeIntakeDrain(rows: readonly IntakeDrainRow[]): IntakeDrainSummary {
  const byDisposition = Object.fromEntries(BULK_INTAKE_DISPOSITIONS.map((d) => [d, 0])) as Record<
    BulkIntakeDisposition,
    number
  >;
  const summary: IntakeDrainSummary = {
    intake: { total: rows.length, decided: 0, undecided: 0, failed: 0, applied: 0, byDisposition },
    delivery: { accepted: 0, delivered: 0, notDelivered: 0 },
  };
  for (const row of rows) {
    const decision = row.intakeDecision;
    if (!decision) {
      if (row.outcome === 'failed') summary.intake.failed += 1;
      else summary.intake.undecided += 1;
      continue;
    }
    summary.intake.decided += 1;
    byDisposition[decision.disposition] += 1;
    const applied = row.outcome === 'auto_resolved' && row.actionId === INTAKE_APPLY_ACTION_ID;
    if (!applied) continue;
    summary.intake.applied += 1;
    if (decision.disposition !== 'promote' && decision.disposition !== 'investigate') continue;
    summary.delivery.accepted += 1;
    const delivered = row.promoted?.state === 'done' && row.promoted.completionAuthority === 'committed';
    if (delivered) summary.delivery.delivered += 1;
    else summary.delivery.notDelivered += 1;
  }
  return summary;
}

export function isBulkIntakeDisposition(value: unknown): value is BulkIntakeDisposition {
  return typeof value === 'string' && (BULK_INTAKE_DISPOSITIONS as readonly string[]).includes(value);
}

/** A persisted, validated intake decision. Every field a reader needs to
 *  attribute the outcome and find its owner is present (R-18). */
export interface BulkIntakeDecision {
  disposition: BulkIntakeDisposition;
  /** Why — required for every disposition, so a reject always has a reason. */
  reason: string;
  /** Who decided (the resolver's coord owner id). */
  decidedBy: string;
  /** Who owns the next step. */
  owner: BulkResponsibility;
  /** merge: the canonical item/candidate this input merges into. */
  targetRef: string | null;
  /** retry: what information is missing before the input can be decided. */
  missingInformation: string | null;
  decidedAt: string;
  /**
   * P-006 (D-013): promote only — `fix` → a bug, `build` → a change. Null keeps the
   * candidate's own kind (an observation defaults to a fix). `investigate` always
   * executes as an investigation task.
   */
  workKind: IntakeWorkKind | null;
  /**
   * P-006: promote/investigate only — the acceptance proposal the resolver drafted
   * (problem/evidence/outcome/scope/completionCheck). Fields here win over the
   * source's own proposal; completeness is checked when the decision is EXECUTED,
   * where an incomplete contract refuses rather than defaults.
   */
  acceptance: IntakeAcceptanceProposalInput | null;
  /**
   * P-006: the source revision (`src-v1:<sha256>`) the decision judged, stamped
   * server-side when it is recorded. Executing against an edited source refuses.
   */
  sourceRevision: string | null;
  /**
   * P-013 (D-023): promote only — the reproduction receipt that makes a BUG promote
   * acceptable. Null on every other decision, and on a bug whose source was born
   * verified by its filer's encounter receipt (D-024).
   */
  reproduction: BugReproductionReceipt | null;
}

export const INTAKE_WORK_KINDS = ['fix', 'build'] as const;
export type IntakeWorkKind = (typeof INTAKE_WORK_KINDS)[number];

/** The storage kind an executed intake decision creates or keeps. */
export type IntakeTargetKind = 'bug' | 'change' | 'task';

const INTAKE_WORK_STORAGE_KINDS = new Set(['bug', 'change', 'task']);

/**
 * promote → bug/change (default: the candidate's own kind; observations default to a
 * fix); investigate → task. Pure, so the report path and the executor agree on
 * whether a promote is a BUG promote (the one D-023 gates).
 */
export function intakeTargetKindFor(
  decision: Pick<BulkIntakeDecision, 'disposition' | 'workKind'>,
  source: { kind: string; observation: boolean },
): IntakeTargetKind {
  if (decision.disposition === 'investigate') return 'task';
  if (decision.workKind === 'fix') return 'bug';
  if (decision.workKind === 'build') return 'change';
  if (!source.observation && INTAKE_WORK_STORAGE_KINDS.has(source.kind)) return source.kind as IntakeTargetKind;
  return 'bug';
}

/** What the reproduction gate needs to know about a decision's source. */
export interface IntakeReproductionSource {
  kind: string;
  observation: boolean;
  /** D-024: the receipt the source was born verified with, if any. */
  bornVerified: BugReproductionReceipt | null;
}

/**
 * P-013 (D-023 §1-2, D-024 §1): a promote that yields a BUG needs a reproduction
 * receipt — on the decision, or the source's born-verified encounter receipt.
 * Returns the refusal text (steering to investigate / reject / retain), or null
 * when the decision may stand. change/task/feature acceptance is unchanged (§6).
 */
export function intakeReproductionRefusal(
  decision: Pick<BulkIntakeDecision, 'disposition' | 'workKind' | 'reproduction'>,
  source: IntakeReproductionSource,
  subject = 'this input',
): string | null {
  if (decision.disposition !== 'promote') return null;
  if (intakeTargetKindFor(decision, source) !== 'bug') return null;
  if (decision.reproduction || source.bornVerified) return null;
  return bugReproductionMissingText(subject);
}

/** A resolver-drafted acceptance proposal; shape only — completeness is judged at execution. */
export interface IntakeAcceptanceProposalInput {
  problem?: string | null;
  evidence?: string[] | null;
  outcome?: string | null;
  scope?: string | null;
  completionCheck?: string | null;
}

/**
 * The terminal action that EXECUTES a recorded intake decision (P-006). It is not a
 * card button: the bulk resolver applies it to a row that already carries a
 * validated `intake_decision`, through the shared terminal dispatcher.
 */
export const INTAKE_APPLY_ACTION_ID = 'apply-intake' as const;

/** What a resolver submits; validated by `parseIntakeDecision`. */
export interface BulkIntakeDecisionInput {
  disposition: string;
  reason?: string | null;
  owner?: BulkResponsibility | null;
  targetRef?: string | null;
  missingInformation?: string | null;
  workKind?: string | null;
  acceptance?: IntakeAcceptanceProposalInput | null;
  /** promote: the reproduction receipt (required when the promote yields a bug). */
  reproduction?: unknown;
}

interface IntakeDispositionSpec {
  disposition: BulkIntakeDisposition;
  label: string;
  /** Fields beyond `reason` this disposition requires. */
  requires: readonly ('targetRef' | 'missingInformation')[];
  /** Default owner of the next step. */
  owner: BulkResponsibility;
  /** Projection onto the existing recommendation vocabulary (CHECK-constrained). */
  recommendationKind: BulkRecommendationKind;
}

const INTAKE_DISPOSITION_SPECS: Record<BulkIntakeDisposition, IntakeDispositionSpec> = {
  promote: {
    disposition: 'promote',
    label: 'Promote to accepted work',
    requires: [],
    owner: 'engineering',
    recommendationKind: 'routed',
  },
  merge: {
    disposition: 'merge',
    label: 'Merge / link into existing work',
    requires: ['targetRef'],
    owner: 'agent',
    recommendationKind: 'cleanup_candidate',
  },
  investigate: {
    disposition: 'investigate',
    label: 'Investigate before deciding',
    requires: [],
    owner: 'agent',
    recommendationKind: 'investigate',
  },
  retain: {
    disposition: 'retain',
    label: 'Retain as evidence',
    requires: [],
    owner: 'system',
    recommendationKind: 'cleanup_candidate',
  },
  reject: {
    disposition: 'reject',
    label: 'Reject with reason',
    requires: [],
    owner: 'system',
    recommendationKind: 'cleanup_candidate',
  },
  retry: {
    disposition: 'retry',
    label: 'Retry when information is supplied',
    requires: ['missingInformation'],
    owner: 'agent',
    recommendationKind: 'retry_needed',
  },
};

/** The six dispositions offered for every intake input, as the manifest shows them. */
export const BULK_INTAKE_DISPOSITION_OFFER: readonly {
  disposition: BulkIntakeDisposition;
  label: string;
  requires: readonly string[];
}[] = BULK_INTAKE_DISPOSITIONS.map((d) => ({
  disposition: d,
  label: INTAKE_DISPOSITION_SPECS[d].label,
  requires: ['reason', ...INTAKE_DISPOSITION_SPECS[d].requires],
}));

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Validate a resolver's intake decision. Refuses (never defaults) a missing
 * reason, a merge without a target, or a retry that does not say what is
 * missing. Migration 1296 repeats these rules as a CHECK constraint.
 */
export function parseIntakeDecision(
  input: BulkIntakeDecisionInput,
  ctx: { decidedBy: string; now?: Date; sourceRevision?: string | null },
): { ok: true; decision: BulkIntakeDecision } | { ok: false; error: string } {
  if (!isBulkIntakeDisposition(input?.disposition)) {
    return {
      ok: false,
      error: `intake disposition must be one of ${BULK_INTAKE_DISPOSITIONS.join(', ')} (got ${JSON.stringify(input?.disposition)})`,
    };
  }
  const spec = INTAKE_DISPOSITION_SPECS[input.disposition];
  const reason = nonBlank(input.reason);
  if (!reason) return { ok: false, error: `intake disposition "${spec.disposition}" requires a non-blank reason` };
  const decidedBy = nonBlank(ctx.decidedBy);
  if (!decidedBy) return { ok: false, error: 'intake decision requires an attributable decider' };
  const targetRef = nonBlank(input.targetRef);
  const missingInformation = nonBlank(input.missingInformation);
  if (spec.requires.includes('targetRef') && !targetRef) {
    return { ok: false, error: `intake disposition "${spec.disposition}" requires targetRef (the work it merges into)` };
  }
  if (spec.requires.includes('missingInformation') && !missingInformation) {
    return {
      ok: false,
      error: `intake disposition "${spec.disposition}" requires missingInformation (what must be supplied before retrying)`,
    };
  }
  const owner =
    input.owner && (BULK_RESPONSIBILITIES as readonly string[]).includes(input.owner) ? input.owner : spec.owner;
  const workKindRaw = nonBlank(input.workKind);
  if (workKindRaw && spec.disposition !== 'promote') {
    return { ok: false, error: `workKind applies to promote only (got it on "${spec.disposition}")` };
  }
  if (workKindRaw && !(INTAKE_WORK_KINDS as readonly string[]).includes(workKindRaw)) {
    return { ok: false, error: `workKind must be one of ${INTAKE_WORK_KINDS.join(', ')} (got ${JSON.stringify(workKindRaw)})` };
  }
  const acceptance = readAcceptanceProposalInput(input.acceptance);
  if (acceptance && spec.disposition !== 'promote' && spec.disposition !== 'investigate') {
    return { ok: false, error: `acceptance applies to promote/investigate only (got it on "${spec.disposition}")` };
  }
  let reproduction: BugReproductionReceipt | null = null;
  if (input.reproduction !== undefined && input.reproduction !== null) {
    if (spec.disposition !== 'promote') {
      return {
        ok: false,
        error: `reproduction applies to promote only (got it on "${spec.disposition}"); an unreproduced bug is investigate, reject or retain`,
      };
    }
    const parsedReceipt = parseBugReproductionReceipt(input.reproduction);
    if (!parsedReceipt.ok) return { ok: false, error: parsedReceipt.error };
    reproduction = parsedReceipt.receipt;
  }
  return {
    ok: true,
    decision: {
      disposition: spec.disposition,
      reason,
      decidedBy,
      owner,
      targetRef,
      missingInformation,
      decidedAt: (ctx.now ?? new Date()).toISOString(),
      workKind: (workKindRaw as IntakeWorkKind | null) ?? null,
      acceptance,
      sourceRevision: nonBlank(ctx.sourceRevision) ?? null,
      reproduction,
    },
  };
}

/** Trimmed proposal fields; null when nothing usable was supplied. */
function readAcceptanceProposalInput(raw: unknown): IntakeAcceptanceProposalInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const out: IntakeAcceptanceProposalInput = {};
  for (const field of ['problem', 'outcome', 'scope', 'completionCheck'] as const) {
    const value = nonBlank(v[field]);
    if (value) out[field] = value;
  }
  if (Array.isArray(v.evidence)) {
    const evidence = v.evidence.map(nonBlank).filter((e): e is string => e !== null);
    if (evidence.length > 0) out.evidence = evidence;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Project an intake decision onto the existing disposition/recommendation columns. */
export function intakeRecommendationFor(decision: BulkIntakeDecision): {
  disposition: BulkDispositionKind;
  recommendationKind: BulkRecommendationKind;
  label: string;
  responsibility: BulkResponsibility;
  retryCondition: string | null;
} {
  const spec = INTAKE_DISPOSITION_SPECS[decision.disposition];
  return {
    disposition: spec.recommendationKind,
    recommendationKind: spec.recommendationKind,
    label: spec.label,
    responsibility: decision.owner,
    retryCondition: decision.disposition === 'retry' ? decision.missingInformation : null,
  };
}

/** Tolerant read of a persisted `intake_decision` value (jsonb, parsed or string). */
export function readIntakeDecision(raw: unknown): BulkIntakeDecision | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isBulkIntakeDisposition(v.disposition)) return null;
  const reason = nonBlank(v.reason);
  const decidedBy = nonBlank(v.decidedBy);
  if (!reason || !decidedBy) return null;
  const owner = (BULK_RESPONSIBILITIES as readonly string[]).includes(String(v.owner))
    ? (v.owner as BulkResponsibility)
    : INTAKE_DISPOSITION_SPECS[v.disposition].owner;
  return {
    disposition: v.disposition,
    reason,
    decidedBy,
    owner,
    targetRef: nonBlank(v.targetRef),
    missingInformation: nonBlank(v.missingInformation),
    decidedAt: nonBlank(v.decidedAt) ?? '',
    workKind: (INTAKE_WORK_KINDS as readonly string[]).includes(String(v.workKind))
      ? (v.workKind as IntakeWorkKind)
      : null,
    acceptance: readAcceptanceProposalInput(v.acceptance),
    sourceRevision: nonBlank(v.sourceRevision),
    reproduction: v.disposition === 'promote' ? readBugReproductionReceipt(v.reproduction) : null,
  };
}
