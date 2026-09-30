/**
 * local-audit-row-types — types for the LOCAL audit + trust tables
 * per papercusp-dogfood-v5 §7.4 + §9.4.
 *
 * Types-only and PURE. No PG client, no I/O.
 *
 * Nineteenth module in the dogfood-arc types-only spine.
 *
 * "LOCAL" tables are per-engineer and NEVER sync via Hyperbee. Five
 * tables fall in this bucket; they share enough shape (audit-row-ish:
 * `(harness_slug, ...) PK + ts`) that one module covers all five:
 *
 *   1. `auto_review_audit`   — P-044/P-045 auto-action log
 *   2. `claim_audit`         — orchestrator claim-attempt log
 *   3. `webhook_audit`       — Discord-webhook failure log
 *   4. `insights_first_visit` — per-(workspace,harness) first-visit flag
 *   5. `trusted_authors`     — per-harness trust list (§9.4)
 *
 * Per v5 §9.4 + line 1056: "LOCAL only; NEVER synced. Your trust list
 * is yours." Applies to all 5 — they never appear in Hyperbee keys
 * (see lib/harness/hyperbee-key-types.ts — no entries for any of them).
 *
 * Why one module covering five: each is tiny (3-5 columns), the
 * shapes share patterns (harness_slug + identity PK + ts), and a
 * single import for all LOCAL audit/state shapes keeps consumers
 * tidy. Splitting later is trivial if any of them grows.
 */

// ─────────────────────────────────────────────────────────────────
// auto_review_audit — P-044/P-045 actions log
// ─────────────────────────────────────────────────────────────────

/**
 * Per-engineer log of auto-approve / auto-merge actions per v5
 * line 600. Recorded by the daemon when decideAutoReview returns
 * approve or approve_and_merge AND the side-effect actually fires.
 *
 *   auto_review_audit(harness_slug, pr_number, action, ts)
 */
export const AUTO_REVIEW_AUDIT_ACTIONS = ['approved', 'merged'] as const;
export type AutoReviewAuditAction = (typeof AUTO_REVIEW_AUDIT_ACTIONS)[number];

export interface AutoReviewAuditRow {
  harness_slug: string;
  pr_number: number;
  action: AutoReviewAuditAction;
  /** Epoch ms when the action fired. */
  ts: number;
}

export function isAutoReviewAuditRow(input: unknown): input is AutoReviewAuditRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.pr_number === 'number' &&
    Number.isInteger(r.pr_number) &&
    r.pr_number > 0 &&
    typeof r.action === 'string' &&
    (AUTO_REVIEW_AUDIT_ACTIONS as readonly string[]).includes(r.action) &&
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    r.ts > 0
  );
}

// ─────────────────────────────────────────────────────────────────
// claim_audit — orchestrator attempt log
// ─────────────────────────────────────────────────────────────────

/**
 * Per-engineer log of orchestrator claim attempts per v5 line 601.
 *
 *   claim_audit(harness_slug, feature_id, attempt_ts, outcome)
 *
 * Outcome shares vocabulary with `feature-claim-types.ClaimOutcomeStamped`
 * + adds 'error' for attempts that never reached arbitration.
 */
export const CLAIM_AUDIT_OUTCOMES = ['won', 'lost', 'error'] as const;
export type ClaimAuditOutcome = (typeof CLAIM_AUDIT_OUTCOMES)[number];

export interface ClaimAuditRow {
  harness_slug: string;
  feature_id: string;
  /** Epoch ms when the claim attempt fired locally. */
  attempt_ts: number;
  outcome: ClaimAuditOutcome;
}

export function isClaimAuditRow(input: unknown): input is ClaimAuditRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.feature_id === 'string' &&
    r.feature_id.length > 0 &&
    typeof r.attempt_ts === 'number' &&
    Number.isFinite(r.attempt_ts) &&
    r.attempt_ts > 0 &&
    typeof r.outcome === 'string' &&
    (CLAIM_AUDIT_OUTCOMES as readonly string[]).includes(r.outcome)
  );
}

// ─────────────────────────────────────────────────────────────────
// webhook_audit — Discord-webhook failure log
// ─────────────────────────────────────────────────────────────────

/**
 * LOCAL log of webhook-post failures per v5 line 930. Used by the
 * §11 Discord posting path when a POST to the channel webhook URL
 * fails. Success cases don't write here — only failures, so the
 * row count == "how many missed notifications."
 */
export interface WebhookAuditRow {
  harness_slug: string;
  /** Epoch ms when the attempt fired. */
  attempt_ts: number;
  /** HTTP status returned (0 if network never reached). */
  status: number;
  /** Truncated error message (≤ 500 chars). */
  error_message: string;
  /** What kind of notification was being posted (e.g.
   * 'feature_shipped', 'pr_opened'). */
  notification_kind: string;
}

export const WEBHOOK_AUDIT_MESSAGE_MAX = 500;

export function isWebhookAuditRow(input: unknown): input is WebhookAuditRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.attempt_ts === 'number' &&
    Number.isFinite(r.attempt_ts) &&
    r.attempt_ts > 0 &&
    typeof r.status === 'number' &&
    Number.isInteger(r.status) &&
    r.status >= 0 &&
    typeof r.error_message === 'string' &&
    r.error_message.length <= WEBHOOK_AUDIT_MESSAGE_MAX &&
    typeof r.notification_kind === 'string' &&
    r.notification_kind.length > 0
  );
}

export function clampWebhookErrorMessage(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.length <= WEBHOOK_AUDIT_MESSAGE_MAX
    ? raw
    : raw.slice(0, WEBHOOK_AUDIT_MESSAGE_MAX);
}

// ─────────────────────────────────────────────────────────────────
// insights_first_visit — per-(workspace,harness) first-visit flag
// ─────────────────────────────────────────────────────────────────

/**
 * Per-(workspace, harness, user) first-visit row per v5 line 602.
 * `seen_at_ts` null → operator force-routes new contributor to
 * `/harness/<slug>/insights` on next nav (§9.0 post-install landing).
 * Set to now() on first dismissal.
 */
export interface InsightsFirstVisitRow {
  harness_slug: string;
  github_user_id: number;
  /** Epoch ms when Insights was first dismissed. null = unseen. */
  seen_at_ts: number | null;
}

export function isInsightsFirstVisitRow(input: unknown): input is InsightsFirstVisitRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.github_user_id === 'number' &&
    Number.isInteger(r.github_user_id) &&
    r.github_user_id > 0 &&
    (r.seen_at_ts === null ||
      (typeof r.seen_at_ts === 'number' && Number.isFinite(r.seen_at_ts) && r.seen_at_ts > 0))
  );
}

/**
 * Predicate: should the operator force-route this user to Insights
 * on the next harness nav? True iff `seen_at_ts` is null.
 */
export function shouldForceInsightsRedirect(row: InsightsFirstVisitRow): boolean {
  return row.seen_at_ts === null;
}

// ─────────────────────────────────────────────────────────────────
// trusted_authors — per-harness trust list
// ─────────────────────────────────────────────────────────────────

/**
 * Per-harness trust list per v5 §9.4 (line 1056 schema). LOCAL
 * only — never synced. Keyed by `trusted_github_user_id` so trust
 * persists across the trusted user's device additions + GitHub
 * renames.
 */
export interface TrustedAuthorRow {
  harness_slug: string;
  trusted_github_user_id: number;
  /** Epoch ms when trust was added. */
  trusted_at: number;
  /** The user who added this trust entry. Identity audit. */
  trusted_by_github_user_id: number;
}

export function isTrustedAuthorRow(input: unknown): input is TrustedAuthorRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.trusted_github_user_id === 'number' &&
    Number.isInteger(r.trusted_github_user_id) &&
    r.trusted_github_user_id > 0 &&
    typeof r.trusted_at === 'number' &&
    Number.isFinite(r.trusted_at) &&
    r.trusted_at > 0 &&
    typeof r.trusted_by_github_user_id === 'number' &&
    Number.isInteger(r.trusted_by_github_user_id) &&
    r.trusted_by_github_user_id > 0
  );
}

/**
 * Build a trust-list lookup Set from a list of rows. The
 * `decideAutoReview` gate (auto-review-decision-types) takes a
 * `trust_list: ReadonlySet<number>`; this is the canonical builder.
 */
export function buildTrustListSet(
  rows: ReadonlyArray<TrustedAuthorRow>,
  harnessSlug: string,
): ReadonlySet<number> {
  const set = new Set<number>();
  for (const r of rows) {
    if (r.harness_slug === harnessSlug) {
      set.add(r.trusted_github_user_id);
    }
  }
  return set;
}

/**
 * Predicate: is the given github_user_id in the trust list for the
 * given harness?
 */
export function isTrusted(
  rows: ReadonlyArray<TrustedAuthorRow>,
  harnessSlug: string,
  candidateGithubUserId: number,
): boolean {
  for (const r of rows) {
    if (
      r.harness_slug === harnessSlug &&
      r.trusted_github_user_id === candidateGithubUserId
    ) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// shared metadata
// ─────────────────────────────────────────────────────────────────

/**
 * The 5 LOCAL audit/state table names this module covers. Useful
 * for migration writers + the verify-schema sentinel to confirm
 * all five exist.
 */
export const LOCAL_AUDIT_TABLE_NAMES = [
  'auto_review_audit',
  'claim_audit',
  'webhook_audit',
  'insights_first_visit',
  'trusted_authors',
] as const;
export type LocalAuditTableName = (typeof LOCAL_AUDIT_TABLE_NAMES)[number];
