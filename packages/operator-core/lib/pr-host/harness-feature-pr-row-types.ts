/**
 * pr-host/harness-feature-pr-row-types — extended row shape for the
 * `harness_shared.harness_feature_prs` HYPERBEE table that the P-042
 * poll daemon writes per papercusp-dogfood-v5 line 452.
 *
 * Types-only. No PG client, no Octokit. The runtime
 * (`apps/operator/lib/pr-host/poll-daemon.ts`) imports these to
 * shape its UPSERT statements + diff logic; the consumer-side
 * (PRs tab UI, feature row, completion_ref verifier) reads the
 * same shape.
 *
 * Ninth module in the dogfood-arc types-only spine. Builds on
 * pr-host/types — converts between the neutral `Pr` shape and the
 * extended row shape.
 *
 * Per v5 §8.4 + line 452: P-042 extends `harness_feature_prs` with
 * `last_polled_at`, `checks_status` (summary), `mergeable_state`,
 * `review_decision`, `reviewers[]`. The existing minimal columns
 * (`pr_url`, `pr_state`, `opened_ts`, `updated_ts`) stay as-is.
 *
 * Why types-first: the row shape is the boundary between the poll
 * daemon (which understands GitHub) and the PRs tab UI (which
 * understands display). Both consume the same row; pinning the
 * shape early prevents drift.
 */

import {
  PR_CHECKS_STATES,
  PR_MERGEABLE_STATES,
  PR_REVIEW_DECISIONS,
  PR_STATES,
  type Pr,
  type PrChecksState,
  type PrMergeableState,
  type PrReviewDecision,
  type PrReviewer,
  type PrState,
} from './types';

/**
 * The extended `harness_feature_prs` row shape per v5 line 452.
 *
 * NEW columns (P-042 schema migration when it lands):
 *   - last_polled_at_ts
 *   - checks_status (PrChecksState)
 *   - mergeable_state (PrMergeableState)
 *   - review_decision (PrReviewDecision)
 *   - reviewers (PrReviewer[])
 *
 * EXISTING columns retained:
 *   - workspace_id, harness_slug, feature_id (PK)
 *   - pr_url, pr_state, opened_ts, updated_ts
 *
 * Field naming: snake_case to match the PG mirror table + the
 * existing legacy column names. Conversion to/from the neutral
 * `Pr` shape goes through `prToRow()` / `rowToPrSummary()`.
 */
export interface HarnessFeaturePrRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  /** Full PR URL on the host (e.g. https://github.com/.../pull/42). */
  pr_url: string;
  /** PR state; one of PR_STATES. NB: `pr_state` (NOT `state`) to
   * match the existing legacy column name. */
  pr_state: PrState;
  /** Epoch ms when the PR was opened on the host. Legacy column. */
  opened_ts: number;
  /** Epoch ms of most-recent update (host-reported). Legacy column. */
  updated_ts: number;
  /** Epoch ms of most-recent poll completion (any outcome). NEW. */
  last_polled_at_ts: number;
  /** Summary checks state for the PR. NEW. */
  checks_status: PrChecksState;
  /** Mergeable summary for the PR. NEW. */
  mergeable_state: PrMergeableState;
  /** Aggregated review decision. NEW. */
  review_decision: PrReviewDecision;
  /** Requested reviewers (display + auto-approve gate scoping).
   * Stored as JSONB on the PG side. NEW. */
  reviewers: PrReviewer[];
}

/**
 * The minimal subset of `Pr` shape needed to drive a row update.
 * Used as the input to `prToRow()` so test fixtures don't need to
 * spell out every Pr field.
 */
export type PrUpdateSlice = Pick<
  Pr,
  | 'ref'
  | 'state'
  | 'review_decision'
  | 'checks_state'
  | 'mergeable_state'
  | 'reviewers_requested'
  | 'updated_at'
  | 'url'
>;

/**
 * Convert a Pr (from PrHost) into a HarnessFeaturePrRow ready for
 * UPSERT. Caller supplies (workspace_id, harness_slug, feature_id)
 * since the Pr doesn't carry them.
 *
 *   prToRow({ workspace_id, harness_slug, feature_id, opened_ts, pr, now })
 *
 * `opened_ts` is preserved across polls — the daemon reads the
 * existing row's opened_ts and passes it back here. First-poll has
 * no existing row; pass `pr.updated_at` as the opened_ts.
 *
 * `now` is the poll-completion timestamp; the daemon passes
 * `Date.now()`.
 *
 * Pure function — no I/O.
 */
export function prToRow(args: {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  opened_ts: number;
  pr: PrUpdateSlice;
  now: number;
}): HarnessFeaturePrRow {
  return {
    workspace_id: args.workspace_id,
    harness_slug: args.harness_slug,
    feature_id: args.feature_id,
    pr_url: args.pr.url,
    pr_state: args.pr.state,
    opened_ts: args.opened_ts,
    updated_ts: args.pr.updated_at,
    last_polled_at_ts: args.now,
    checks_status: args.pr.checks_state,
    mergeable_state: args.pr.mergeable_state,
    review_decision: args.pr.review_decision,
    // Defensive copy so the daemon doesn't mutate the caller's array.
    reviewers: args.pr.reviewers_requested.slice(),
  };
}

/**
 * "Demote to gone" mutation per v5 §8.4 P-042f. When the poll
 * receives 404 for a previously-known PR, the row is preserved
 * but `pr_state` flips to `'gone'`; `last_polled_at_ts` updates.
 *
 * Other fields kept verbatim so consumers can still render the
 * historical metadata. Pure function — caller passes the existing
 * row + `now`.
 */
export function demoteRowToGone(
  existing: HarnessFeaturePrRow,
  now: number,
): HarnessFeaturePrRow {
  if (existing.pr_state === 'gone') return existing;
  return {
    ...existing,
    pr_state: 'gone',
    last_polled_at_ts: now,
  };
}

/**
 * Build a default row when nothing has been polled yet. Used by the
 * `harness_feature_prs` UPSERT path for the very first poll of a
 * feature's PR. Empty/unknown values for everything except identity
 * + the URL the user pasted at PR-open time.
 */
export function defaultRowForNewPr(args: {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  pr_url: string;
  opened_ts: number;
}): HarnessFeaturePrRow {
  return {
    workspace_id: args.workspace_id,
    harness_slug: args.harness_slug,
    feature_id: args.feature_id,
    pr_url: args.pr_url,
    pr_state: 'open',
    opened_ts: args.opened_ts,
    updated_ts: args.opened_ts,
    last_polled_at_ts: 0,
    checks_status: 'unknown',
    mergeable_state: 'unknown',
    review_decision: 'none',
    reviewers: [],
  };
}

/**
 * Structural predicate. Verifies every column is present + typed
 * correctly. Used by the PG-read path before applying rows to the
 * UI cache (defensive against legacy rows that haven't been
 * upgraded yet — those will fail the predicate and be replaced
 * with `defaultRowForNewPr` on next poll).
 */
export function isHarnessFeaturePrRow(input: unknown): input is HarnessFeaturePrRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.workspace_id !== 'string') return false;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.feature_id !== 'string' || r.feature_id.length === 0) return false;
  if (typeof r.pr_url !== 'string' || r.pr_url.length === 0) return false;
  if (typeof r.pr_state !== 'string' || !(PR_STATES as readonly string[]).includes(r.pr_state)) {
    return false;
  }
  if (typeof r.opened_ts !== 'number' || !Number.isFinite(r.opened_ts)) return false;
  if (typeof r.updated_ts !== 'number' || !Number.isFinite(r.updated_ts)) return false;
  if (typeof r.last_polled_at_ts !== 'number' || !Number.isFinite(r.last_polled_at_ts)) return false;
  if (
    typeof r.checks_status !== 'string' ||
    !(PR_CHECKS_STATES as readonly string[]).includes(r.checks_status)
  ) {
    return false;
  }
  if (
    typeof r.mergeable_state !== 'string' ||
    !(PR_MERGEABLE_STATES as readonly string[]).includes(r.mergeable_state)
  ) {
    return false;
  }
  if (
    typeof r.review_decision !== 'string' ||
    !(PR_REVIEW_DECISIONS as readonly string[]).includes(r.review_decision)
  ) {
    return false;
  }
  if (!Array.isArray(r.reviewers)) return false;
  return true;
}

/**
 * Predicate: has the row had a successful poll since opening? `false`
 * for fresh rows that haven't been polled yet (last_polled_at_ts ===
 * 0); `true` once any poll completes.
 */
export function hasBeenPolled(row: HarnessFeaturePrRow): boolean {
  return row.last_polled_at_ts > 0;
}

/**
 * Predicate: should the "cannot reach GitHub" badge surface per v5
 * §9.3 P-043a? Triggers when `last_polled_at_ts` is stale by more
 * than the threshold (5 min per spec) AND we have polled at least
 * once (otherwise the badge is misleading on a fresh row).
 *
 * Pure — caller passes `now`.
 */
export const STALE_POLL_THRESHOLD_MS = 5 * 60 * 1000; // 5 min per P-043a
export function isPollStale(row: HarnessFeaturePrRow, now: number): boolean {
  if (!hasBeenPolled(row)) return false;
  return now - row.last_polled_at_ts > STALE_POLL_THRESHOLD_MS;
}

/**
 * The columns this P-042 extension ADDS to the existing
 * `harness_feature_prs` table. Lets the migration writer + the
 * verify-schema sentinel cross-check that the schema has the new
 * columns in place. Per v5 line 452.
 */
export const P_042_ADDED_COLUMNS = [
  'last_polled_at_ts',
  'checks_status',
  'mergeable_state',
  'review_decision',
  'reviewers',
] as const;
export type P042AddedColumn = (typeof P_042_ADDED_COLUMNS)[number];
