/**
 * pr-host/auto-approve — Auto-approve logic (Phase 7 P-044).
 *
 * Fires when:
 *   - pr_reviewer_role_enabled AND auto_review both true for this harness
 *   - PR author is in the reviewer's trust list
 *   - PR is in a state that allows approval (no pending review from us)
 *
 * Idempotent: re-running on an already-approved PR is a no-op.
 * Records every action in harness_shared.auto_review_audit.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { PrHost, Pr } from './types';

export interface AutoApproveContext {
  harnessSlug: string;
  /** GitHub user id of the reviewer (this operator instance). */
  reviewerGithubId: number;
  /** GitHub login of the reviewer. */
  reviewerLogin: string;
  /** Trust list: GitHub user ids whose PRs should be auto-approved. */
  trustedAuthorIds: ReadonlySet<number>;
  /** pr_reviewer_role_enabled setting for this harness. */
  reviewerRoleEnabled: boolean;
  /** auto_review setting for this harness. */
  autoReview: boolean;
  /**
   * PR-5 (contribution-admission): the PR author is a REVOKED Hive contributor —
   * the owner added all their device pubkeys to the Hive's revoked set
   * (isHiveContributorRevoked). When true the approve is refused BEFORE the
   * trust/checks gates: revocation is the strongest deny, and it must hold even
   * for an author who is otherwise in the trust list. The live chokepoint
   * resolves this and passes it in (default false ⇒ today's behavior).
   */
  authorRevoked?: boolean;
}

export interface AutoApproveResult {
  action:
    | 'approved'
    | 'skipped_already_approved'
    | 'skipped_untrusted'
    | 'skipped_revoked'
    | 'skipped_disabled'
    | 'error';
  prNumber: number;
  detail?: string;
}

/**
 * Attempt to auto-approve a single PR.
 *
 * P-044a: gates on reviewerRoleEnabled + autoReview + trusted author.
 * P-044b: idempotent — skips if already approved.
 * P-044c: records action in auto_review_audit.
 * P-044d: returns a one-line summary string for the toast.
 */
export async function tryAutoApprove(
  host: PrHost,
  pr: Pr,
  ctx: AutoApproveContext,
): Promise<AutoApproveResult> {
  const prNumber = pr.ref.number;
  const authorId = pr.author.github_user_id;

  // P-044a gate checks.
  if (!ctx.reviewerRoleEnabled || !ctx.autoReview) {
    return { action: 'skipped_disabled', prNumber };
  }
  // PR-5 contribution-admission: a REVOKED contributor is refused first — the
  // strongest deny, ahead of (and overriding) the trust gate. Audited so the
  // refusal is visible, never silent.
  if (ctx.authorRevoked) {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'skipped_revoked', 'author is a revoked contributor');
    return { action: 'skipped_revoked', prNumber };
  }
  if (!ctx.trustedAuthorIds.has(authorId)) {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'skipped_untrusted', null);
    return { action: 'skipped_untrusted', prNumber };
  }
  // P-044b idempotent: already approved by us → skip.
  if (pr.review_decision === 'approved') {
    return { action: 'skipped_already_approved', prNumber };
  }

  const reviewResult = await host.postReview({
    ref: pr.ref,
    event: 'approve',
    body: `Auto-approved by Papercusp — @${ctx.reviewerLogin} has @${pr.author.github_login} in their trust list.`,
  });

  if (!reviewResult.ok) {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'error', reviewResult.error.message);
    return { action: 'error', prNumber, detail: reviewResult.error.message };
  }

  await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'auto_approve', null);
  return { action: 'approved', prNumber };
}

/** Format P-044d one-line toast string. */
export function formatAutoApproveToast(result: AutoApproveResult, prUrl: string): string | null {
  if (result.action === 'approved') {
    return `Auto-approved PR #${result.prNumber} (${prUrl})`;
  }
  if (result.action === 'error') {
    return `Auto-approve failed for PR #${result.prNumber}: ${result.detail ?? 'unknown error'}`;
  }
  return null;
}

async function writeAudit(
  harnessSlug: string,
  prNumber: number,
  prUrl: string | undefined,
  authorId: number,
  reviewerId: number,
  action: string,
  detail: string | null,
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, harness_slug, pr_number, pr_url, author_github_id, reviewer_github_id, action, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['', harnessSlug, prNumber, prUrl ?? null, authorId, reviewerId, action, detail],
    );
  } catch {
    // Audit failure is non-fatal; the approve action still succeeds.
  }
}
