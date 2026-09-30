/**
 * Phase 2 completion_ref writer (papercusp-dogfood-phase2 D-001).
 *
 * The Phase-2 verifier daemon + the CompletionRefCard UI + the tier-B
 * "features shipped ✓" stat were INERT because NOTHING wrote `completion_ref`.
 * This is the writer: when a PR is approved-and-merged (prs.ts `reviewPr` →
 * `tryAutoMerge`), stamp the merge SHA + remote + branch onto the feature row
 * so the verifier can re-derive "this actually shipped" from the canonical
 * remote.
 *
 * Two pieces, both PG-only (substrate-independent — they survive the model-B
 * substrate rewrite):
 *
 *   - `resolveMergedPrFeatureId` — the PR→feature linkage. `harness_features_
 *     consolidated` is keyed by `(harness_slug, feature_id)` but `reviewPr` only
 *     has `slug` + PR number. Resolution order: (1) the caller-supplied
 *     `feature_id` (a feature-context review knows it); (2) fallback lookup in
 *     `harness_feature_prs` by `pr_url`. NOTE: `harness_feature_prs` is a PG-local
 *     table (sync:'none'). It had NO producer for a long time — the GitHub poll
 *     daemon was vaporware (marked shipped, never built) and the Hyperbee `prs`
 *     projection was retired as never-firing (EI-479). The poll daemon is now real
 *     (`pr-host/poll-daemon.ts`, PR-1 of pr-system-completion-dogfood-2026-06-19):
 *     it best-effort upserts this row (resolving feature_id via `completion_ref`)
 *     so the fallback fires for polled PRs that map to a tracked WI. PR-4 owns the
 *     full WI→PR→state producer (at-open + inbound-PR rows); until it lands, an
 *     inbound PR with no completion_ref link still has no row here.
 *
 *   - `stampCompletionRefOnMerge` — the write. `status='shipped'` + a fresh
 *     `updated_ts` are REQUIRED: the verifier's select only picks up
 *     `completion_ref IS NOT NULL AND (status='pending_done' OR (status='shipped'
 *     AND updated_ts within 24h))`. Idempotent via `completion_ref IS NULL`.
 *     Skips silently (never throws) on no feature_id / empty SHA / invalid ref —
 *     the merge already succeeded; stamping is best-effort.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { buildCompletionRef } from './completion-ref-types';

export async function resolveMergedPrFeatureId(opts: {
  harnessSlug: string;
  prUrl: string;
  bodyFeatureId?: string | null;
  sql?: Sql;
}): Promise<string | null> {
  if (opts.bodyFeatureId) return opts.bodyFeatureId;
  if (!opts.prUrl) return null;
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.harness_feature_prs
     WHERE harness_slug = ${opts.harnessSlug} AND pr_url = ${opts.prUrl}
     LIMIT 1
  `;
  return rows[0]?.feature_id ?? null;
}

export type StampResult =
  | { stamped: true; feature_id: string }
  | { stamped: false; reason: 'no_feature_id' | 'empty_sha' | 'invalid_ref' };

export async function stampCompletionRefOnMerge(opts: {
  harnessSlug: string;
  featureId: string | null;
  remote: string;
  branch: string;
  mergeCommitSha: string;
  prUrl: string;
  prNumber: number;
  nowMs?: number;
  sql?: Sql;
}): Promise<StampResult> {
  if (!opts.featureId) return { stamped: false, reason: 'no_feature_id' };
  // github.ts returns `?? ''` for a missing SHA; an empty SHA would make
  // buildCompletionRef throw, so guard it explicitly.
  if (!opts.mergeCommitSha) return { stamped: false, reason: 'empty_sha' };

  let completionRef;
  try {
    completionRef = buildCompletionRef({
      remote: opts.remote,
      branch: opts.branch,
      commit_sha: opts.mergeCommitSha.toLowerCase(),
      pr_url: opts.prUrl || undefined,
      pr_number: opts.prNumber,
    });
  } catch {
    return { stamped: false, reason: 'invalid_ref' };
  }

  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.nowMs ?? Date.now();
  // Scope by (harness_slug, feature_id) only — no workspace_id (that column is
  // on harness_feature_prs, not harness_features_consolidated).
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET completion_ref = ${JSON.stringify(completionRef)}::text::jsonb,
           status = 'shipped',
           updated_ts = ${now}
     WHERE harness_slug = ${opts.harnessSlug}
       AND feature_id = ${opts.featureId}
       AND completion_ref IS NULL
  `;
  return { stamped: true, feature_id: opts.featureId };
}
