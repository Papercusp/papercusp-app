/**
 * pr-host/pr-review-report-store — PG persistence for the agent
 * reviewer's report (PR-2 step 2 + step 4).
 *
 * Three concerns, all raw-SQL (mirrors auto-approve.ts `writeAudit` +
 * completion-ref-writer.ts — these PR tables are read/written by hand,
 * not through a drizzle model):
 *
 *   - `storeReviewReport`        — UPSERT the report into
 *     `harness_shared.pr_review_reports`, keyed by (workspace, harness,
 *     pr_number, head_sha) so a re-review of the SAME diff is idempotent
 *     and a NEW head_sha is a fresh row (per-diff audit history).
 *   - `readLatestReviewReport`   — newest report for a PR (the GUI/daemon
 *     read path).
 *   - `loadFeatureContextForPr`  — resolve the linked WI (PR-4's
 *     harness_feature_prs) + its title/summary for the review prompt.
 *   - `writeAgentReviewAudit`    — record the review event in
 *     `harness_shared.auto_review_audit` (model + diff sha in `detail`)
 *     so a recommendation is traceable (who/what reviewed, on what diff).
 *
 * Every write is best-effort + non-throwing where the PR action must not
 * depend on it (the audit), and `sql` is injectable so callers/tests can
 * pass a transaction or a fake.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { coerceJson } from '../pg-jsonb';
import {
  type PrReviewReport,
  type StoredPrReviewReport,
  type PrReviewChecksObserved,
  type PrReviewRecommendation,
} from './pr-review-report-types';

/** The work-item / feature context the reviewer reads for "does this PR
 *  satisfy its WI?" judgment. Resolved via PR-4's harness_feature_prs. */
export interface FeatureContext {
  feature_id: string;
  title: string | null;
  summary: string | null;
}

function sqlOf(injected?: Sql): Sql {
  return injected ?? getOrgPg().sql;
}

export interface StoreReviewReportArgs {
  workspaceId: string;
  harnessSlug: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  featureId: string | null;
  report: PrReviewReport;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsdCents: number;
  nowIso?: string;
  sql?: Sql;
}

/**
 * UPSERT a review report. Idempotent on (workspace_id, harness_slug,
 * pr_number, head_sha): re-reviewing the same diff overwrites the row
 * (the recommendation/summary refresh, reviewed_at advances); a new
 * head_sha inserts a new row so per-diff history is preserved.
 */
export async function storeReviewReport(args: StoreReviewReportArgs): Promise<void> {
  const sql = sqlOf(args.sql);
  const { report } = args;
  await sql`
    INSERT INTO harness_shared.pr_review_reports
      (workspace_id, harness_slug, pr_number, pr_url, head_sha, feature_id,
       recommendation, summary, rationale, risks, checks_observed,
       model, tokens_in, tokens_out, cost_usd_cents, reviewed_at)
    VALUES (
      ${args.workspaceId}, ${args.harnessSlug}, ${args.prNumber}, ${args.prUrl},
      ${args.headSha}, ${args.featureId},
      ${report.recommendation}, ${report.summary}, ${report.rationale},
      ${JSON.stringify(report.risks)}::text::jsonb,
      ${JSON.stringify(report.checksObserved)}::text::jsonb,
      ${args.model}, ${args.tokensIn}, ${args.tokensOut}, ${args.costUsdCents},
      ${args.nowIso ?? new Date().toISOString()}
    )
    ON CONFLICT (workspace_id, harness_slug, pr_number, head_sha) DO UPDATE SET
      pr_url         = EXCLUDED.pr_url,
      feature_id     = EXCLUDED.feature_id,
      recommendation = EXCLUDED.recommendation,
      summary        = EXCLUDED.summary,
      rationale      = EXCLUDED.rationale,
      risks          = EXCLUDED.risks,
      checks_observed = EXCLUDED.checks_observed,
      model          = EXCLUDED.model,
      tokens_in      = EXCLUDED.tokens_in,
      tokens_out     = EXCLUDED.tokens_out,
      cost_usd_cents = EXCLUDED.cost_usd_cents,
      reviewed_at    = EXCLUDED.reviewed_at
  `;
}

interface PrReviewReportDbRow {
  workspace_id: string;
  harness_slug: string;
  pr_number: number;
  pr_url: string;
  head_sha: string;
  feature_id: string | null;
  recommendation: string;
  summary: string;
  rationale: string;
  risks: unknown;
  checks_observed: unknown;
  model: string;
  tokens_in: number | string;
  tokens_out: number | string;
  cost_usd_cents: number | string;
  reviewed_at: string | Date;
}

function rowToStored(row: PrReviewReportDbRow): StoredPrReviewReport {
  return {
    workspace_id: row.workspace_id,
    harness_slug: row.harness_slug,
    pr_number: Number(row.pr_number),
    pr_url: row.pr_url,
    head_sha: row.head_sha,
    feature_id: row.feature_id ?? null,
    recommendation: row.recommendation as PrReviewRecommendation,
    summary: row.summary,
    rationale: row.rationale,
    // jsonb columns read back as a raw STRING under prepare:false clients
    // (testcontainer) but as a parsed value under prod getOrgPg — decode
    // defensively across both (pg-jsonb runbook, EI-607).
    risks: coerceJson<string[]>(row.risks) ?? [],
    checks_observed:
      coerceJson<PrReviewChecksObserved>(row.checks_observed) ??
      ({} as PrReviewChecksObserved),
    model: row.model,
    tokens_in: Number(row.tokens_in ?? 0),
    tokens_out: Number(row.tokens_out ?? 0),
    cost_usd_cents: Number(row.cost_usd_cents ?? 0),
    reviewed_at:
      row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at),
  };
}

/**
 * The newest review report for a PR (any head_sha). The PR-3 GUI shows
 * this; PR-1's daemon reads its `recommendation`. Returns null when no
 * report exists yet.
 */
export async function readLatestReviewReport(opts: {
  harnessSlug: string;
  prNumber: number;
  workspaceId?: string;
  sql?: Sql;
}): Promise<StoredPrReviewReport | null> {
  const sql = sqlOf(opts.sql);
  const rows = await sql<PrReviewReportDbRow[]>`
    SELECT * FROM harness_shared.pr_review_reports
     WHERE harness_slug = ${opts.harnessSlug}
       AND pr_number = ${opts.prNumber}
       ${opts.workspaceId !== undefined ? sql`AND workspace_id = ${opts.workspaceId}` : sql``}
     ORDER BY reviewed_at DESC
     LIMIT 1
  `;
  return rows[0] ? rowToStored(rows[0]) : null;
}

/**
 * Resolve the work-item context for a PR: the linked feature id (from
 * PR-4's harness_feature_prs by pr_url, or a caller-supplied body
 * feature id) + the feature's title/summary from
 * harness_features_consolidated. Returns null when the PR isn't linked
 * to a WI yet — the reviewer then reviews without WI context (and the
 * report's feature_id stays null).
 */
export async function loadFeatureContextForPr(opts: {
  harnessSlug: string;
  prUrl: string;
  bodyFeatureId?: string | null;
  workspaceId?: string;
  sql?: Sql;
}): Promise<FeatureContext | null> {
  const sql = sqlOf(opts.sql);
  let featureId = opts.bodyFeatureId ?? null;
  if (!featureId && opts.prUrl) {
    const linked = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_feature_prs
       WHERE harness_slug = ${opts.harnessSlug} AND pr_url = ${opts.prUrl}
       LIMIT 1
    `;
    featureId = linked[0]?.feature_id ?? null;
  }
  if (!featureId) return null;
  const feat = await sql<{ title: string | null; summary: string | null }[]>`
    SELECT title, summary FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${opts.harnessSlug} AND feature_id = ${featureId}
     LIMIT 1
  `;
  return {
    feature_id: featureId,
    title: feat[0]?.title ?? null,
    summary: feat[0]?.summary ?? null,
  };
}

/** auto_review_audit actions PR-2 adds (migration 319 extends the CHECK). */
export type AgentReviewAuditAction = 'agent_review' | 'agent_review_error';

export interface WriteAgentReviewAuditArgs {
  workspaceId: string;
  harnessSlug: string;
  prNumber: number;
  prUrl: string;
  authorGithubId: number;
  reviewerGithubId: number;
  action: AgentReviewAuditAction;
  /** Free-text / JSON detail — we stamp model + head_sha + recommendation
   *  so the recommendation is traceable to who/what reviewed which diff. */
  detail: string;
  sql?: Sql;
}

/**
 * Record the review event in auto_review_audit. Best-effort + never
 * throws (mirrors auto-approve's writeAudit) — a failed audit must not
 * sink the review.
 */
export async function writeAgentReviewAudit(args: WriteAgentReviewAuditArgs): Promise<void> {
  try {
    const sql = sqlOf(args.sql);
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, harness_slug, pr_number, pr_url, author_github_id, reviewer_github_id, action, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.workspaceId,
        args.harnessSlug,
        args.prNumber,
        args.prUrl,
        args.authorGithubId,
        args.reviewerGithubId,
        args.action,
        args.detail,
      ],
    );
  } catch {
    // Audit failure is non-fatal; the review itself still stands.
  }
}
