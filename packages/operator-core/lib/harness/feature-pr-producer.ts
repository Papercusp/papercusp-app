/**
 * feature-pr-producer — the WI↔PR PRODUCER for `harness_shared.harness_feature_prs`
 * (PLAN-pr-system-completion-dogfood Phase PR-4 / Brief PR-4 (b)).
 *
 * The table existed since baseline (mig 000) but had NO producer — so
 * `resolveMergedPrFeatureId`'s fallback was always empty and the WI→PR→merged
 * plane never linked (completion-ref-writer.ts EI-479; the GitHub poll daemon
 * P-042 was never built). This module is the missing writer:
 *
 *   - `upsertFeaturePrOnOpen` — at fork→PR open (the fork-pr-on-feature-pass hook
 *     + the manual contribute path), UPSERT `(workspace_id, harness_slug,
 *     feature_id) → pr_url, pr_state='open', opened_ts, updated_ts,
 *     author_github_user_id`. The PK is the feature, so a re-open / re-push of the
 *     same feature updates the row in place. `author_github_user_id` is the HUMAN
 *     operator's `gh` id (owner decision (c): per-operator identity, attributable)
 *     — recorded so the merge stamp + report GUI + EN-2 P-RATE rate bucket all key
 *     on a real human, not a generic host token.
 *
 *   - `markFeaturePrState` — at review/merge/close, advance `pr_state` (e.g.
 *     'merged') so WI→PR→merged is queryable (the report GUI + the Done criterion).
 *     Keyed by `(harness_slug, pr_url)` — the merge path knows the URL, not always
 *     the feature id. NB: PR-1's poll daemon ALSO updates pr_state / the extended
 *     P-042 columns; this is the merge-time write that doesn't depend on the daemon.
 *
 * PG-only + substrate-independent (mirrors completion-ref-writer). The `sql` seam
 * is injectable so the producer + the merge-resolution round-trip are unit-testable
 * with no real PG. Callers treat these as BEST-EFFORT: a producer failure must
 * never fail an already-opened PR / already-succeeded merge — wrap at the call site
 * (the fork-pr hook + the review route both do).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export interface FeaturePrOpenInput {
  /** Defaults to '' to match the table default + the audit writer convention. */
  workspaceId?: string;
  harnessSlug: string;
  /** The WI / feature id the PR ships — resolves the row to its feature. */
  featureId: string;
  /** Full PR URL on the host (the merge-resolution + report-GUI key). */
  prUrl: string;
  /** Numeric GitHub id of the HUMAN operator who authored the PR (gh user). */
  authorGithubUserId?: number | null;
  /** Epoch ms; defaults to Date.now(). */
  nowMs?: number;
  sql?: Sql;
}

/**
 * UPSERT the WI→PR row at PR-open. Idempotent per feature (PK is
 * (workspace_id, harness_slug, feature_id)): a re-open updates pr_url / pr_state
 * back to 'open' + refreshes updated_ts; opened_ts is preserved on conflict.
 * author_github_user_id is COALESCE'd so a later poll without identity can't wipe
 * the operator attribution recorded at open.
 */
export async function upsertFeaturePrOnOpen(input: FeaturePrOpenInput): Promise<void> {
  const sql = input.sql ?? getOrgPg().sql;
  const ws = input.workspaceId ?? '';
  const now = input.nowMs ?? Date.now();
  const author = input.authorGithubUserId ?? null;
  await sql`
    INSERT INTO harness_shared.harness_feature_prs
      (workspace_id, harness_slug, feature_id, pr_url, pr_state, opened_ts, updated_ts, author_github_user_id)
    VALUES (${ws}, ${input.harnessSlug}, ${input.featureId}, ${input.prUrl}, 'open', ${now}, ${now}, ${author})
    ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET
      pr_url = EXCLUDED.pr_url,
      pr_state = 'open',
      updated_ts = EXCLUDED.updated_ts,
      author_github_user_id = COALESCE(EXCLUDED.author_github_user_id, harness_shared.harness_feature_prs.author_github_user_id)
  `;
}

export interface FeaturePrStateInput {
  harnessSlug: string;
  /** Full PR URL — the merge/close path knows the URL, not always the feature id. */
  prUrl: string;
  /** Next state: 'merged' | 'closed' | 'open' | … (free text; matches the column). */
  prState: string;
  /** Epoch ms; defaults to Date.now(). */
  nowMs?: number;
  sql?: Sql;
}

/**
 * Advance a tracked PR's state (e.g. → 'merged' on merge). No-op if the row
 * doesn't exist (an UPDATE matching nothing). Keyed by (harness_slug, pr_url) so
 * the merge path — which has the URL — can flip the row without re-resolving the
 * feature id.
 */
export async function markFeaturePrState(input: FeaturePrStateInput): Promise<void> {
  const sql = input.sql ?? getOrgPg().sql;
  const now = input.nowMs ?? Date.now();
  await sql`
    UPDATE harness_shared.harness_feature_prs
       SET pr_state = ${input.prState}, updated_ts = ${now}
     WHERE harness_slug = ${input.harnessSlug} AND pr_url = ${input.prUrl}
  `;
}
