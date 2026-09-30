/**
 * pr-host/pr-reviewer-settings-types — PG row shape for the
 * `harness_shared.pr_reviewer_settings` LOCAL table per
 * papercusp-dogfood-v5 §7.8.
 *
 * Types-only and PURE. No PG client, no I/O.
 *
 * Seventeenth module in the dogfood-arc types-only spine.
 *
 * Backs the in-memory `AutoReviewSettings` consumed by
 * `decideAutoReview()` (auto-review-decision-types). The runtime
 * reads this PG row + the trust_list from a separate `trusted_authors`
 * table, joins them into AutoReviewSettings, and passes to the
 * decision function. Spelling out the row shape lets the PG-reader
 * + the join code + the migration writer share one source of truth.
 *
 * Per v5 §7.8 schema:
 *   CREATE TABLE IF NOT EXISTS harness_shared.pr_reviewer_settings (
 *     harness_slug TEXT NOT NULL,
 *     github_user_id BIGINT NOT NULL,
 *     pr_reviewer_role_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 *     auto_review BOOLEAN NOT NULL DEFAULT FALSE,
 *     auto_merge BOOLEAN NOT NULL DEFAULT FALSE,
 *     merge_method TEXT NOT NULL DEFAULT 'squash'
 *       CHECK (merge_method IN ('squash','merge','rebase')),
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     PRIMARY KEY (harness_slug, github_user_id)
 *   );
 */

import {
  PR_MERGE_METHODS,
  type PrMergeMethod,
} from './types';

/**
 * Wire-version. Matches the PG `schema_version` default; bump
 * together when columns change.
 *
 * Note: v5 §7.8's stated schema doesn't currently include
 * `schema_version`. We're forward-defining it here so the eventual
 * runtime can upgrade additively when needed. PG-reader callers
 * default missing values to v1.
 */
export const PR_REVIEWER_SETTINGS_SCHEMA_VERSION = 1 as const;
export type PrReviewerSettingsSchemaVersion =
  typeof PR_REVIEWER_SETTINGS_SCHEMA_VERSION;

/**
 * The full row shape per §7.8. PK is (harness_slug, github_user_id) —
 * one row per (harness, user) pair.
 */
export interface PrReviewerSettingsRow {
  harness_slug: string;
  github_user_id: number;
  /** Master kill-switch for any PR-side auto-action by this
   * (harness, user). When false, no auto-review or auto-merge
   * fires. Default FALSE — opt-in only. */
  pr_reviewer_role_enabled: boolean;
  /** Auto-approve PRs from trusted authors. Default FALSE. */
  auto_review: boolean;
  /** Auto-merge PRs that auto-approve fired on. Default FALSE. */
  auto_merge: boolean;
  /** Merge method when auto-merging (or manual-merging via the UI). */
  merge_method: PrMergeMethod;
  /** Epoch ms of last write. */
  updated_at: number;
  /** Optional — forward-defined for future schema bumps. */
  schema_version?: PrReviewerSettingsSchemaVersion;
}

/**
 * The default row when no explicit settings exist for a (harness,
 * user). Mirrors the PG DEFAULTs. Used by the PG-reader when no
 * row is returned to avoid forcing UI surfaces to handle null.
 *
 * Pure function — caller passes the (harness, user) identity.
 */
export function defaultPrReviewerSettings(args: {
  harness_slug: string;
  github_user_id: number;
  now: number;
}): PrReviewerSettingsRow {
  return {
    harness_slug: args.harness_slug,
    github_user_id: args.github_user_id,
    pr_reviewer_role_enabled: false,
    auto_review: false,
    auto_merge: false,
    merge_method: 'squash',
    updated_at: args.now,
    schema_version: PR_REVIEWER_SETTINGS_SCHEMA_VERSION,
  };
}

/**
 * Structural predicate. Verifies required fields are present +
 * typed. Used by the PG-read path defensively against legacy rows
 * (pre-merge_method default) — those fail the predicate and the
 * caller can backfill from `defaultPrReviewerSettings`.
 */
export function isPrReviewerSettingsRow(input: unknown): input is PrReviewerSettingsRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (
    typeof r.github_user_id !== 'number' ||
    !Number.isInteger(r.github_user_id) ||
    r.github_user_id <= 0
  ) {
    return false;
  }
  if (typeof r.pr_reviewer_role_enabled !== 'boolean') return false;
  if (typeof r.auto_review !== 'boolean') return false;
  if (typeof r.auto_merge !== 'boolean') return false;
  if (
    typeof r.merge_method !== 'string' ||
    !(PR_MERGE_METHODS as readonly string[]).includes(r.merge_method)
  ) {
    return false;
  }
  if (typeof r.updated_at !== 'number' || !Number.isFinite(r.updated_at)) return false;
  if (
    r.schema_version !== undefined &&
    r.schema_version !== PR_REVIEWER_SETTINGS_SCHEMA_VERSION
  ) {
    return false;
  }
  return true;
}

/**
 * Patch shape for partial updates. The settings UI POSTs this; the
 * write handler merges into the existing row and bumps updated_at.
 *
 * Patches are per-field opt-in — missing fields preserve their
 * existing values.
 */
export interface PrReviewerSettingsPatch {
  pr_reviewer_role_enabled?: boolean;
  auto_review?: boolean;
  auto_merge?: boolean;
  merge_method?: PrMergeMethod;
}

/**
 * Apply a patch to an existing row, bumping updated_at. Pure —
 * doesn't write to PG. Used by the write handler so the merge
 * logic is testable in isolation.
 */
export function applyPrReviewerSettingsPatch(
  existing: PrReviewerSettingsRow,
  patch: PrReviewerSettingsPatch,
  now: number,
): PrReviewerSettingsRow {
  // Defensive: validate merge_method if supplied.
  if (
    patch.merge_method !== undefined &&
    !(PR_MERGE_METHODS as readonly string[]).includes(patch.merge_method)
  ) {
    throw new TypeError('merge_method must be one of ' + PR_MERGE_METHODS.join(', '));
  }
  return {
    ...existing,
    ...(patch.pr_reviewer_role_enabled !== undefined
      ? { pr_reviewer_role_enabled: patch.pr_reviewer_role_enabled }
      : {}),
    ...(patch.auto_review !== undefined ? { auto_review: patch.auto_review } : {}),
    ...(patch.auto_merge !== undefined ? { auto_merge: patch.auto_merge } : {}),
    ...(patch.merge_method !== undefined ? { merge_method: patch.merge_method } : {}),
    updated_at: now,
  };
}

/**
 * Predicate: are any auto-actions enabled for this row? Used by
 * the §9.3 PRs tab to decide whether to render the "Auto-review:
 * on / off" indicator.
 */
export function hasAnyAutoActionEnabled(row: PrReviewerSettingsRow): boolean {
  return row.pr_reviewer_role_enabled && (row.auto_review || row.auto_merge);
}

/**
 * Predicate: is the row in the safest possible state? i.e. master
 * kill-switch off OR all auto-action toggles off. Used by the
 * "settings audit" tool to confirm safe defaults are in place.
 */
export function isSafeDefaultState(row: PrReviewerSettingsRow): boolean {
  if (!row.pr_reviewer_role_enabled) return true;
  return !row.auto_review && !row.auto_merge;
}
