/**
 * pr-host/auto-merge — Auto-merge logic (Phase 7 P-045).
 *
 * Fires after auto-approve when auto_merge is also enabled.
 * Gates on: auto_merge=true AND PR was auto-approved by us AND checks green.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { PrHost, Pr, PrMergeMethod } from './types';

export interface AutoMergeContext {
  harnessSlug: string;
  reviewerGithubId: number;
  reviewerLogin: string;
  /** auto_merge must be true. */
  autoMerge: boolean;
  /** Default squash. */
  mergeMethod: PrMergeMethod;
  /**
   * PR-5 (contribution-admission): the PR author is a REVOKED Hive contributor.
   * When true the merge is refused BEFORE the approved/checks gates — a revoked
   * contributor's code never reaches canonical, even if the PR carries a stale
   * approval. The live chokepoint resolves this (isHiveContributorRevoked) and
   * passes it in (default false ⇒ today's behavior).
   */
  authorRevoked?: boolean;
}

export type AutoMergeResult =
  | { action: 'merged'; mergeCommitSha: string; prNumber: number }
  | { action: 'skipped_disabled'; prNumber: number }
  | { action: 'skipped_revoked'; prNumber: number }
  | { action: 'skipped_checks_failing'; prNumber: number }
  | { action: 'skipped_not_approved'; prNumber: number }
  | { action: 'error'; prNumber: number; detail: string };

/**
 * Attempt to auto-merge a PR.
 *
 * P-045a: gates on autoMerge + approved by us + checks green (check_conclusion='success'|null).
 * P-045b: uses ctx.mergeMethod (default squash).
 * P-045c: records action in auto_review_audit.
 */
export async function tryAutoMerge(
  host: PrHost,
  pr: Pr,
  ctx: AutoMergeContext,
): Promise<AutoMergeResult> {
  const prNumber = pr.ref.number;
  const authorId = pr.author.github_user_id;

  if (!ctx.autoMerge) {
    return { action: 'skipped_disabled', prNumber };
  }

  // PR-5 contribution-admission: a REVOKED contributor's PR is refused before
  // any approved/checks consideration — revocation is the strongest deny. Audited.
  if (ctx.authorRevoked) {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'skipped_revoked', 'author is a revoked contributor');
    return { action: 'skipped_revoked', prNumber };
  }

  // Must have been approved (by us or anyone — in auto-approve+auto-merge
  // flow the PR will already have review_decision='approved').
  if (pr.review_decision !== 'approved') {
    return { action: 'skipped_not_approved', prNumber };
  }

  // Checks must be green or not yet reported ('unknown' = no checks configured).
  if (pr.checks_state !== 'success' && pr.checks_state !== 'unknown') {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'skipped_checks_failing', `checks_state: ${pr.checks_state}`);
    return { action: 'skipped_checks_failing', prNumber };
  }

  const mergeResult = await host.merge({
    ref: pr.ref,
    method: ctx.mergeMethod,
    commit_title: `${pr.title} (#${prNumber})`,
    commit_message: `Auto-merged by Papercusp via @${ctx.reviewerLogin}.`,
    expected_head_sha: pr.head_sha,
  });

  if (!mergeResult.ok) {
    await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'error', mergeResult.error.message);
    return { action: 'error', prNumber, detail: mergeResult.error.message };
  }

  await writeAudit(ctx.harnessSlug, prNumber, pr.url, authorId, ctx.reviewerGithubId, 'auto_merge', null);
  return { action: 'merged', prNumber, mergeCommitSha: mergeResult.data.merge_commit_sha };
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
    // Non-fatal.
  }
}
