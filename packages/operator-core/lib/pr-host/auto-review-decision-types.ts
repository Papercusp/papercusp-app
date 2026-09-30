/**
 * pr-host/auto-review-decision-types — pure decision functions for
 * the P-044 auto-approve + P-045 auto-merge gates (Phase 7).
 *
 * Types-only and PURE. No Octokit, no PG, no I/O. The PR poll
 * daemon (P-042) calls `decideAutoReview()` on each PR update; the
 * function inspects the inputs and returns a discriminated decision.
 * The daemon then either fires the PrHost call or skips, per the
 * decision.kind.
 *
 * Why the decision lives in its own module: P-044's sub-acceptances
 * read as a 4-clause AND that's tedious to debug in the daemon.
 * Pulling it out makes the gate testable in isolation against every
 * input permutation (~16 test cases here) and lets the UI re-use
 * the same `decideAutoReview()` to render "auto-approve would fire
 * if you flipped X" hints without duplicating logic.
 *
 * Eighth module in the dogfood-arc types-only spine. Same one-per-
 * design-anchor pattern as:
 *   - apps/operator/lib/harness/binding-types.ts                  (P-068)
 *   - apps/operator/lib/identity/binding-verifier-types.ts        (P-075)
 *   - apps/operator/lib/identity/attestation-types.ts             (P-011)
 *   - apps/operator/lib/identity/contributor-file-types.ts        (P-075 Channel 2)
 *   - apps/operator/lib/harness/contributor-usage-event-types.ts  (P-070)
 *   - apps/operator/lib/harness/feature-claim-types.ts            (P-036)
 *   - apps/operator/lib/pr-host/types.ts                          (P-040)
 *
 * Source: `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24.md`
 * P-044a, P-044b, P-045a, P-045b sub-acceptances.
 */

import {
  PR_CHECKS_STATES,
  type Pr,
  type PrChecksState,
  type PrReviewDecision,
} from './types';

/**
 * Per-(viewer, harness) auto-review settings. Mirrors the
 * `pr_reviewer_settings` PG-augmented table per v5 §8.6 — the subset
 * read at gate-decision time.
 *
 * `pr_reviewer_role_enabled` is the master kill-switch: if false,
 * NO auto-review action fires (P-044a). The two `auto_*` flags are
 * independent (D-007) — `auto_review=true, auto_merge=false` means
 * "auto-approve but never auto-merge."
 */
export interface AutoReviewSettings {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  /** Set of github_user_ids in this viewer's trust list, scoped to
   * this harness. Membership in this set is the "trust gate" of
   * P-044a's clause "PR author is in my trust list." */
  trust_list: ReadonlySet<number>;
  /** Viewer's own github_user_id. Used to detect self-review
   * (never auto-approve your own PR). */
  viewer_github_user_id: number;
}

/**
 * Discriminated decision returned by `decideAutoReview()`. Three
 * outcomes:
 *
 * `skip`        — the gate did not pass. `reason` describes why so
 *                 the UI can render diagnostic hints ("auto-approve
 *                 would fire if you added @alice to your trust list").
 * `approve`     — auto-approve should fire now. The daemon calls
 *                 PrHost.postReview({event: 'approve', body}). The
 *                 body is included so audit logs match what the
 *                 daemon will post.
 * `approve_and_merge` — auto-approve + auto-merge fire in sequence.
 *                       The daemon calls postReview, awaits a
 *                       success result, then calls merge.
 */
export type AutoReviewDecision =
  | { kind: 'skip'; reason: AutoReviewSkipReason }
  | { kind: 'approve'; approval_body: string }
  | { kind: 'approve_and_merge'; approval_body: string };

/**
 * Why an auto-review gate did NOT fire. Surfaced in the UI hint +
 * the auto_review_audit log row.
 */
export type AutoReviewSkipReason =
  /** Master kill-switch off (P-044a). */
  | 'pr_reviewer_role_disabled'
  /** `auto_review` is off (P-044a). */
  | 'auto_review_off'
  /** PR is closed / merged / gone. */
  | 'pr_state_not_open'
  /** Viewer is the PR author (no self-approve). */
  | 'pr_author_is_viewer'
  /** PR author not in viewer's trust list (P-044a). */
  | 'pr_author_not_trusted'
  /** Viewer already left an approve review (P-044b idempotency). */
  | 'already_approved_by_viewer'
  /** Viewer left a changes-requested review (P-044a). */
  | 'viewer_requested_changes'
  /** PR is a draft. */
  | 'pr_is_draft';

/**
 * Reason auto-merge specifically did NOT fire (in addition to
 * approve-side skip reasons). Encoded as a separate union so the
 * "approve fired but merge skipped" path can be surfaced — UI
 * shows "Auto-approved; not auto-merging because <reason>."
 */
export type AutoMergeSkipReason =
  /** `auto_merge` is off (P-045a). */
  | 'auto_merge_off'
  /** Checks not green (P-045a). */
  | 'checks_not_green'
  /** PR's mergeable_state is not 'mergeable' (P-045a). */
  | 'not_mergeable';

/**
 * Pure gate function. Inspects settings + PR state, returns a
 * decision. No side effects, no async — call from anywhere
 * (daemon, UI hint renderer, audit log replay).
 */
export function decideAutoReview(
  pr: Pr,
  settings: AutoReviewSettings,
): AutoReviewDecision {
  // P-044a master kill-switch.
  if (!settings.pr_reviewer_role_enabled) {
    return { kind: 'skip', reason: 'pr_reviewer_role_disabled' };
  }
  if (!settings.auto_review) {
    return { kind: 'skip', reason: 'auto_review_off' };
  }
  // PR state guards.
  if (pr.state !== 'open') {
    return { kind: 'skip', reason: 'pr_state_not_open' };
  }
  if (pr.is_draft) {
    return { kind: 'skip', reason: 'pr_is_draft' };
  }
  // Identity guards.
  if (pr.author.github_user_id === settings.viewer_github_user_id) {
    return { kind: 'skip', reason: 'pr_author_is_viewer' };
  }
  if (!settings.trust_list.has(pr.author.github_user_id)) {
    return { kind: 'skip', reason: 'pr_author_not_trusted' };
  }
  // Review-state guards (P-044b idempotency + P-044a clause).
  if (pr.review_decision === 'approved') {
    // Approved already — could be by us or someone else. The
    // daemon may have a more-detailed per-reviewer check; we
    // conservatively treat any `approved` decision as "no
    // further auto-action needed" — re-running is a no-op.
    return { kind: 'skip', reason: 'already_approved_by_viewer' };
  }
  if (pr.review_decision === 'changes_requested') {
    // If anyone (including us) requested changes, refuse to
    // auto-approve. The "us specifically" check requires the
    // caller to peek at individual reviews; from the PR-summary
    // shape we conservatively skip.
    return { kind: 'skip', reason: 'viewer_requested_changes' };
  }

  // Approve gate clears. Now decide between approve-only and
  // approve+merge per P-045a.
  const approval_body =
    'Auto-approved by Papercusp — @' + pr.author.github_login + ' in trust list.';

  if (!settings.auto_merge) {
    return { kind: 'approve', approval_body };
  }
  // P-045a auto-merge sub-clauses.
  if (!isChecksGreen(pr.checks_state)) {
    // Approve still fires; merge skipped. The decision shape
    // doesn't carry a separate "approved-but-merge-skipped"
    // variant — surfaces as `approve` here; the daemon checks
    // the merge gate separately AFTER the approve resolves.
    return { kind: 'approve', approval_body };
  }
  if (pr.mergeable_state !== 'mergeable') {
    return { kind: 'approve', approval_body };
  }
  return { kind: 'approve_and_merge', approval_body };
}

/**
 * Pure helper: is the checks-summary state considered "green"
 * for the auto-merge gate? Per v5 §8.5: only `success` counts.
 * `pending` / `unknown` / `failure` / `error` / `cancelled` all
 * fail the gate.
 */
export function isChecksGreen(state: PrChecksState): boolean {
  return state === 'success';
}

/**
 * The set of skip reasons that are CONFIGURATION issues (the user
 * could flip a setting to make the gate pass). Used by UI hint
 * renderer to highlight "you could enable this by..." cases.
 */
export const CONFIG_SKIP_REASONS: ReadonlySet<AutoReviewSkipReason> = new Set([
  'pr_reviewer_role_disabled',
  'auto_review_off',
  'pr_author_not_trusted',
]);

/**
 * The set of skip reasons that are STATE issues (no user action
 * can change them; the PR has to evolve). Used by the UI to either
 * suppress the hint or render a passive "waiting for..." indicator.
 */
export const STATE_SKIP_REASONS: ReadonlySet<AutoReviewSkipReason> = new Set([
  'pr_state_not_open',
  'pr_author_is_viewer',
  'already_approved_by_viewer',
  'viewer_requested_changes',
  'pr_is_draft',
]);

/**
 * The sub-set of PR-checks states that an auto-merge gate would
 * call "transient" — worth polling again on. `failure` / `cancelled`
 * are terminal-ish; the user is expected to push a fix or retry CI.
 */
export const TRANSIENT_CHECKS_STATES: ReadonlySet<PrChecksState> = new Set([
  'pending',
  'unknown',
] as const);

/**
 * Predicate: would `decideAutoReview` change its mind if the user
 * added the PR author to their trust list? Lets UI render a
 * one-line "add to trust list" CTA only when it'd actually flip.
 */
export function wouldFireIfTrusted(pr: Pr, settings: AutoReviewSettings): boolean {
  if (!settings.pr_reviewer_role_enabled) return false;
  if (!settings.auto_review) return false;
  if (pr.state !== 'open') return false;
  if (pr.is_draft) return false;
  if (pr.author.github_user_id === settings.viewer_github_user_id) return false;
  if (pr.review_decision === 'approved') return false;
  if (pr.review_decision === 'changes_requested') return false;
  // Only the trust-list gate matters now.
  return !settings.trust_list.has(pr.author.github_user_id);
}

/**
 * The five canonical PrChecksState values that the daemon treats
 * as definitive (not pending). Convenience export so external
 * callers don't have to subtract `pending` from `PR_CHECKS_STATES`
 * themselves.
 */
export const DEFINITIVE_CHECKS_STATES: ReadonlySet<PrChecksState> = new Set(
  PR_CHECKS_STATES.filter((s) => s !== 'pending' && s !== 'unknown'),
);

/**
 * The review-decision values that pass the "no-blockers" pre-flight
 * for auto-approve. Currently `none` and `commented`; `approved` is
 * a no-op skip, `changes_requested` blocks.
 */
export const AUTO_APPROVE_COMPATIBLE_REVIEW_DECISIONS: ReadonlySet<PrReviewDecision> =
  new Set(['none', 'commented']);
