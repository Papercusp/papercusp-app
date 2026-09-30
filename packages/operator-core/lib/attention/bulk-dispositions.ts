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
