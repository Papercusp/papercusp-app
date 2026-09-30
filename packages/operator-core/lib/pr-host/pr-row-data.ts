/**
 * PrRowData — the per-PR row data contract for the harness PRs tab.
 *
 * Pure type, NO UI. Produced by the backend PRs route
 * (lib/endpoint-route/routes/harness/prs.ts) and consumed by the UI
 * (app/harness/PrRow.tsx / PrsTab.tsx). Relocated out of the `'use client'`
 * PrRow component into core to cut the backend→UI back-edge during the
 * operator-core carve (plan operator-core-headless-serve-2026-06-04, Stage A).
 *
 * PR-3 (PLAN-pr-system-completion-dogfood) extends the row with the AGENT
 * review report (PR-2) + the linked WI (PR-4) so the report GUI renders on
 * the existing PRs surface, plus a PURE honest auto-status helper so the
 * GUI can say WHY a PR is / isn't auto-mergeable instead of a misleading
 * "merged" (the Brief-G / G-004 honesty discipline).
 */

import type {
  PrReviewRecommendation,
  PrReviewChecksObserved,
} from './pr-review-report-types';

/**
 * The agent review report attached to a PR row for the GUI (PR-3). A
 * GUI-shaped subset of PR-2's `StoredPrReviewReport` — the fields the
 * row renders, no provenance/token columns. null/absent ⇒ the PR has
 * not been reviewed by the agent yet.
 */
export interface PrRowReport {
  recommendation: PrReviewRecommendation;
  summary: string;
  rationale: string;
  risks: string[];
  checksObserved: PrReviewChecksObserved;
  /** Head commit the report was produced against. */
  headSha: string;
  /**
   * true when the report's head differs from the PR's CURRENT head — the
   * report may be out of date. The GUI shows a "reviewed an earlier
   * commit" badge rather than presenting a stale recommendation as live.
   */
  stale: boolean;
  /** The model that produced the recommendation (audit). */
  model: string;
  /** ISO timestamp the report was produced. */
  reviewedAt: string;
}

export interface PrRowData {
  remote: string;
  number: number;
  title: string;
  author_login: string;
  author_github_id: number;
  html_url: string;
  state: 'open' | 'merged' | 'closed' | 'gone';
  review_decision: 'none' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** null = no CI configured; 'success' | 'failure' | 'pending' | etc. */
  check_conclusion: string | null;
  /** Whether this author is in the viewer's trust list. */
  trusted: boolean;
  /** Whether pr_reviewer_role_enabled for this harness. */
  reviewerRoleEnabled: boolean;
  /**
   * The member harness this row came from, set ONLY by the hive-scoped
   * listing (`GET /harness/:slug/prs?scope=hive` — hive-pr-rollup P-005).
   * Review actions for the row must target this slug's routes. Absent on
   * single-harness listings.
   */
  member_slug?: string;
  /**
   * PR-3: the agent review report (PR-2). null/absent ⇒ not reviewed yet.
   * Attached server-side from `harness_shared.pr_review_reports`.
   */
  report?: PrRowReport | null;
  /**
   * PR-3: the WI/feature this PR satisfies (PR-4's harness_feature_prs
   * producer), independent of whether a report exists. null/absent ⇒
   * the PR isn't linked to a WI.
   */
  featureId?: string | null;
}

// ── Recommendation display (PR-3 — the report GUI) ────────────────────

/** Tone bucket for a recommendation — drives the chip tint. */
export type RecommendationTone = 'ok' | 'warn' | 'bad';

/** Human label for the agent's recommendation. Pure — unit-tested. */
export function recommendationLabel(r: PrReviewRecommendation): string {
  switch (r) {
    case 'approve':
      return 'Approve';
    case 'request_changes':
      return 'Request changes';
    case 'reject':
      return 'Reject';
    default:
      return r;
  }
}

/** Tone — approve=ok, request_changes=warn, reject=bad. Pure — unit-tested. */
export function recommendationTone(r: PrReviewRecommendation): RecommendationTone {
  switch (r) {
    case 'approve':
      return 'ok';
    case 'request_changes':
      return 'warn';
    case 'reject':
      return 'bad';
    default:
      return 'warn';
  }
}

// ── Honest auto-status (PR-3 §4 — never a misleading "merged") ─────────

/**
 * The harness-level auto-mode settings the auto-status helper reasons
 * over (a slice of pr_reviewer_settings). When auto-mode is OFF the GUI
 * is in MANUAL mode — the owner reads the report and approves by hand.
 */
export interface AutoModeSettings {
  /** Master kill-switch — no auto-action fires when false. */
  reviewerRoleEnabled: boolean;
  /** Auto-approve trusted PRs. */
  autoReview: boolean;
  /** Auto-merge approved PRs once checks are green. */
  autoMerge: boolean;
}

/**
 * The honest auto-status of a single PR row. Either:
 *   - `manual`  — auto-mode is off; the owner approves by hand.
 *   - `auto` + `willMerge:true`  — every gate clears; the daemon would
 *      auto-approve (+ merge if auto_merge) on its next poll.
 *   - `auto` + `willMerge:false` — auto-mode is on but at least one gate
 *      blocks; `blockers` says exactly why (checks red, untrusted author,
 *      report not `approve`, …). NEVER claims the PR is merged/approved.
 */
export type PrAutoStatus =
  | { mode: 'manual' }
  | { mode: 'auto'; willMerge: true }
  | { mode: 'auto'; willMerge: false; blockers: string[] };

/**
 * Honest blocker strings — exported so the GUI + tests match stably.
 * Mirrors the gate vocabulary in auto-review-decision-types
 * (AutoReviewSkipReason / AutoMergeSkipReason) but is computed only from
 * what a ROW actually knows — it never fabricates fields (is_draft,
 * mergeable_state) the row lacks, so it can't lie in either direction.
 */
export const AUTO_BLOCKER = {
  not_open: 'PR is not open',
  role_disabled: 'PR-reviewer role is off for this harness',
  untrusted: 'PR author is not in the trust list',
  changes_requested: 'A reviewer requested changes',
  report_missing: 'No agent review yet',
  report_not_approve: 'Agent did not recommend approve',
  report_stale: 'Agent reviewed an earlier commit',
  checks_failing: 'CI checks are failing',
  checks_pending: 'CI checks have not finished',
  checks_unknown: 'CI status is unknown',
  auto_merge_off: 'Auto-merge is off (will auto-approve only)',
} as const;

/**
 * Compute the honest auto-status for a PR row. PURE — no I/O.
 *
 * The result drives the GUI line "Will auto-merge" / "Auto-merge
 * blocked: <reasons>" / (manual mode → no auto line). It is deliberately
 * conservative: any uncertainty (no report, unknown checks) is a blocker,
 * never a green light. `willMerge` is true ONLY when auto_merge is on AND
 * every gate clears AND checks are green — matching the real
 * decideAutoReview + tryAutoMerge gate so the GUI promise can't exceed
 * what the daemon will do.
 */
export function computeAutoStatus(
  row: Pick<
    PrRowData,
    'state' | 'check_conclusion' | 'review_decision' | 'trusted' | 'report'
  >,
  settings: AutoModeSettings,
): PrAutoStatus {
  // Auto-mode is off → manual review. No auto line, no false promises.
  if (!settings.reviewerRoleEnabled || !settings.autoReview) {
    return { mode: 'manual' };
  }

  const blockers: string[] = [];

  if (row.state !== 'open') blockers.push(AUTO_BLOCKER.not_open);
  if (!row.trusted) blockers.push(AUTO_BLOCKER.untrusted);
  if (row.review_decision === 'changes_requested') {
    blockers.push(AUTO_BLOCKER.changes_requested);
  }

  // The agent report is required and must recommend approve (the S0
  // "a defective PR is never auto-approved" property, surfaced here).
  if (!row.report) {
    blockers.push(AUTO_BLOCKER.report_missing);
  } else {
    if (row.report.recommendation !== 'approve') {
      blockers.push(AUTO_BLOCKER.report_not_approve);
    }
    if (row.report.stale) {
      blockers.push(AUTO_BLOCKER.report_stale);
    }
  }

  // Checks gate (only `success` is green — matches isChecksGreen).
  const checksGreen = row.check_conclusion === 'success';
  if (!checksGreen) {
    if (row.check_conclusion === 'failure' || row.check_conclusion === 'error') {
      blockers.push(AUTO_BLOCKER.checks_failing);
    } else if (row.check_conclusion === 'pending') {
      blockers.push(AUTO_BLOCKER.checks_pending);
    } else {
      // null (no CI) or any other non-success value.
      blockers.push(AUTO_BLOCKER.checks_unknown);
    }
  }

  if (blockers.length > 0) {
    return { mode: 'auto', willMerge: false, blockers };
  }

  // Every approve+merge gate clears. If auto_merge is off, the daemon
  // auto-APPROVES but stops short of merge — say so honestly.
  if (!settings.autoMerge) {
    return { mode: 'auto', willMerge: false, blockers: [AUTO_BLOCKER.auto_merge_off] };
  }

  return { mode: 'auto', willMerge: true };
}
