/**
 * PRs tab routes (Phase 7 P-043).
 *
 *   GET  /api/harness/:slug/prs
 *        → PrsResponse: { prs: PrRowData[], pollingFailedAt? }
 *
 *   POST /api/harness/:slug/prs/:number/review
 *        body: { action: 'approve' | 'approve_and_merge' }
 *        → { ok: true } or { error: string }
 *
 * Auth: 'public' — loopback gate is the trust boundary (same as
 * sibling harness routes).
 *
 * Data source: live GitHub via PrHost (P-040). check_conclusion
 * is supplemented from pr_check_status_cache when the row exists.
 * In Phase 5a this moves to harness_feature_prs HYPERBEE; the
 * response shape is identical so the UI doesn't change.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveProject } from '../../../harness-core';
import { createGitHubPrHost } from '../../../pr-host/github';
import { runPrReviewTask } from '../../../pr-host/agent-reviewer';
import {
  resolveMergedPrFeatureId,
  stampCompletionRefOnMerge,
} from '../../../harness/completion-ref-writer';
import { markFeaturePrState } from '../../../harness/feature-pr-producer';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';

const execFileP = promisify(execFile);

/**
 * #5: harness projects frequently carry no `remote` in their metadata, so the
 * PR pane silently returned an empty list. Derive a `github.com/<owner>/<repo>`
 * remote (the format parseRemote expects) from the checkout's git origin so the
 * pane works for ANY harness whose project is a GitHub clone. Best-effort:
 * returns null when the path isn't a git repo or origin isn't a github remote.
 */
async function gitOriginRemote(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', projectPath, 'config', '--get', 'remote.origin.url'],
      { timeout: 3000 },
    );
    const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(stdout.trim());
    return m ? `github.com/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}
import {
  tryAutoApprove,
  type AutoApproveContext,
} from '../../../pr-host/auto-approve';
import { tryAutoMerge, type AutoMergeContext } from '../../../pr-host/auto-merge';
import { isPrAuthorRevoked } from '../../../pr-host/contribution-admission';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getOrgPg } from '@papercusp/db-org';
import type { PrRowData, PrRowReport } from '../../../pr-host/pr-row-data';

/** Flat runtime shape that github.ts actually returns (predates types.ts restructure). */
interface FlatPr {
  remote: string;
  number: number;
  title: string;
  body: string;
  state: string;
  head_sha: string;
  base_branch: string;
  head_branch: string;
  author_github_id: number;
  author_login: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  review_decision: string;
  check_conclusion: string | null;
}

// ─── GET /harness/:slug/prs ───────────────────────────────────────

/** One harness's PR listing, Response-free (hive-pr-rollup P-004). */
export type HarnessPrListing =
  | { ok: true; prs: PrRowData[] }
  | { ok: false; reason: 'unknown_project' }
  | { ok: false; reason: 'no_remote' }
  | { ok: false; reason: 'poll_failed'; pollingFailedAt: string };

/**
 * List one harness's open PRs (hive-pr-rollup P-004) — the GET handler's body,
 * extracted so the hive-scoped aggregate fans out without duplicating the
 * PrHost wiring or the git-origin remote derivation (#5). `host` is passed in
 * so a fan-out shares ONE PrHost across members.
 */
export async function listHarnessPrs(
  slug: string,
  host: NonNullable<Awaited<ReturnType<typeof createGitHubPrHost>>>,
): Promise<HarnessPrListing> {
  const project = await resolveProject(slug);
  if (!project) return { ok: false, reason: 'unknown_project' };

  // Read remote from project metadata; fall back to the checkout's git origin
  // (#5) so a harness with no `remote` field still lists PRs.
  let remote = (project as unknown as { remote?: string }).remote ?? '';
  if (!remote) {
    const projectPath = (project as unknown as { path?: string }).path ?? '';
    if (projectPath) remote = (await gitOriginRemote(projectPath)) ?? '';
  }
  if (!remote) return { ok: false, reason: 'no_remote' };

  const result = await host.listOpenPrs({ remote });
  if (!result.ok) {
    return { ok: false, reason: 'poll_failed', pollingFailedAt: new Date().toISOString() };
  }

  // Supplement check_conclusion from pr_check_status_cache.
  let checkCache: Map<string, string> = new Map();
  try {
    const { sql } = getOrgPg();
    const rows = await sql.unsafe<{ head_sha: string; conclusion: string }[]>(
      `SELECT head_sha, conclusion
       FROM harness_shared.pr_check_status_cache
       WHERE workspace_id = $1 AND harness_slug = $2
         AND check_name != '__pr_open__'
       ORDER BY fetched_at DESC`,
      ['', slug],
    );
    for (const row of rows) {
      if (!checkCache.has(row.head_sha)) {
        checkCache.set(row.head_sha, row.conclusion);
      }
    }
  } catch {
    // Cache miss is fine — UI renders without check detail.
  }

  const headShaByNumber = new Map<number, string>();
  const prs: PrRowData[] = (result.data as unknown as FlatPr[]).map((pr) => {
    headShaByNumber.set(pr.number, pr.head_sha);
    return {
      remote: pr.remote,
      number: pr.number,
      title: pr.title,
      author_login: pr.author_login,
      author_github_id: pr.author_github_id,
      html_url: pr.html_url,
      state: pr.state as PrRowData['state'],
      review_decision: pr.review_decision as PrRowData['review_decision'],
      check_conclusion: checkCache.get(pr.head_sha) ?? pr.check_conclusion,
      // trusted + reviewerRoleEnabled are resolved client-side in PrsTab.
      trusted: false,
      reviewerRoleEnabled: false,
    };
  });

  // PR-3: attach the agent review report (PR-2) + the linked WI (PR-4) so the
  // report GUI renders on this surface. Best-effort — missing tables (PR-2/PR-4
  // not yet migrated) degrade to no report / no WI, never an error.
  await attachReportsAndWi(slug, prs, headShaByNumber);

  return { ok: true, prs };
}

// ─── PR-3: report + WI enrichment (best-effort) ───────────────────

export interface ReportDbRow {
  pr_number: number | string;
  head_sha: string;
  feature_id: string | null;
  recommendation: string;
  summary: string;
  rationale: string;
  risks: unknown;
  checks_observed: unknown;
  model: string | null;
  reviewed_at: string | Date;
}

/** jsonb arrives parsed from postgres.js; tolerate a TEXT fallback. Pure — tested. */
export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** jsonb→object, tolerating a TEXT fallback + non-objects. Pure — tested. */
export function asChecksObserved(v: unknown): PrRowReport['checksObserved'] {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      obj = {};
    }
  }
  if (obj === null || typeof obj !== 'object') obj = {};
  return obj as PrRowReport['checksObserved'];
}

/**
 * Map a stored `pr_review_reports` row → the GUI `PrRowReport`. PURE (no I/O) so
 * it's unit-tested as the drift-sensitive seam against PR-2's stored shape: if
 * PR-2's columns change, this test goes RED before the GUI silently renders an
 * empty/wrong report. `currentHeadSha` is the PR's live head (for staleness).
 */
export function mapReportRow(r: ReportDbRow, currentHeadSha: string): PrRowReport {
  return {
    recommendation: r.recommendation as PrRowReport['recommendation'],
    summary: r.summary,
    rationale: r.rationale,
    risks: asStringArray(r.risks),
    checksObserved: asChecksObserved(r.checks_observed),
    headSha: r.head_sha,
    stale: !!r.head_sha && !!currentHeadSha && r.head_sha !== currentHeadSha,
    model: r.model ?? '',
    reviewedAt: r.reviewed_at instanceof Date ? r.reviewed_at.toISOString() : String(r.reviewed_at),
  };
}

/**
 * Attach the latest agent report + the linked WI to each row, in place.
 * Scoped by harness_slug only (mirrors PR-2's `readLatestReviewReport` /
 * `loadFeatureContextForPr` read path). Two queries total; each wrapped so
 * a missing table is a no-op (the producer/migration may not have landed).
 */
export async function attachReportsAndWi(
  slug: string,
  prs: PrRowData[],
  headShaByNumber: Map<number, string>,
): Promise<void> {
  if (prs.length === 0) return;

  // Latest report per PR number.
  try {
    const { sql } = getOrgPg();
    const rows = await sql.unsafe<ReportDbRow[]>(
      `SELECT DISTINCT ON (pr_number)
              pr_number, head_sha, feature_id, recommendation, summary, rationale,
              risks, checks_observed, model, reviewed_at
         FROM harness_shared.pr_review_reports
        WHERE harness_slug = $1
        ORDER BY pr_number, reviewed_at DESC`,
      [slug],
    );
    const byNumber = new Map<number, ReportDbRow>();
    for (const r of rows) byNumber.set(Number(r.pr_number), r);
    for (const pr of prs) {
      const r = byNumber.get(pr.number);
      if (!r) continue;
      pr.report = mapReportRow(r, headShaByNumber.get(pr.number) ?? '');
      if (r.feature_id) pr.featureId = r.feature_id;
    }
  } catch {
    // pr_review_reports table absent (PR-2 not migrated) → no reports.
  }

  // WI link from the PR-4 producer, independent of whether a report exists.
  try {
    const { sql } = getOrgPg();
    const rows = await sql.unsafe<{ pr_url: string; feature_id: string }[]>(
      `SELECT pr_url, feature_id
         FROM harness_shared.harness_feature_prs
        WHERE harness_slug = $1`,
      [slug],
    );
    const byUrl = new Map<string, string>();
    for (const r of rows) if (r.pr_url && r.feature_id) byUrl.set(r.pr_url, r.feature_id);
    for (const pr of prs) {
      if (pr.featureId) continue;
      const fid = byUrl.get(pr.html_url);
      if (fid) pr.featureId = fid;
    }
  } catch {
    // harness_feature_prs read failed → no WI links.
  }
}

/** Per-member fan-out concurrency for the hive-scoped listing (P-005). */
const HIVE_PR_FANOUT_CONCURRENCY = 4;

/**
 * Resolve the hive member slugs to aggregate for `slug` (P-005): the lite
 * payload's precomputed hive groups (formal `hive_slug` + legacy fallback —
 * hive-groups precedence). A slug in no group, or alone in its group,
 * resolves to just itself (the scope param degrades to a no-op).
 */
export async function resolveHivePrScope(slug: string): Promise<string[]> {
  try {
    const { buildProjectsLitePayload } = await import('../../../harness/projects-lite');
    const { hives } = await buildProjectsLitePayload();
    const group = hives.find((g) => g.members.some((m) => m.slug === slug));
    if (!group) return [slug];
    return group.members.map((m) => m.slug);
  } catch {
    return [slug];
  }
}

/**
 * Fan `lister` out over the hive's members with bounded concurrency (P-005),
 * tagging each row with its `member_slug` and collecting PER-MEMBER failures
 * (`pollingFailedAt`/`noRemote` per slug, not one global flag — one broken
 * member must not read as a hive-wide outage). Pure over the injected lister;
 * exported for tests.
 */
export async function aggregateHivePrs(
  members: readonly string[],
  lister: (slug: string) => Promise<HarnessPrListing>,
  concurrency = HIVE_PR_FANOUT_CONCURRENCY,
): Promise<{
  prs: PrRowData[];
  memberErrors: Record<string, { pollingFailedAt?: string; noRemote?: boolean }>;
}> {
  const prs: PrRowData[] = [];
  const memberErrors: Record<string, { pollingFailedAt?: string; noRemote?: boolean }> = {};
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, members.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= members.length) return;
      const member = members[i];
      const r = await lister(member);
      if (r.ok) {
        for (const pr of r.prs) prs.push({ ...pr, member_slug: member });
      } else if (r.reason === 'no_remote') {
        memberErrors[member] = { noRemote: true };
      } else if (r.reason === 'poll_failed') {
        memberErrors[member] = { pollingFailedAt: r.pollingFailedAt };
      }
      // unknown_project: a registry/grouping race — skip silently.
    }
  });
  await Promise.all(workers);
  prs.sort(
    (a, b) => (a.member_slug ?? '').localeCompare(b.member_slug ?? '') || b.number - a.number,
  );
  return { prs, memberErrors };
}

const listPrs = defineTool({
  method: 'GET',
  path: '/harness/:slug/prs',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const scope = new URL(req.url).searchParams.get('scope');

    const host = await createGitHubPrHost();
    if (!host) {
      // Preserve the single-harness contract: unknown slug is still a 404
      // even when GitHub auth is missing.
      if (scope !== 'hive' && !(await resolveProject(slug))) {
        return Response.json({ error: 'unknown project' }, { status: 404 });
      }
      return Response.json({ prs: [], pollingFailedAt: new Date().toISOString() });
    }

    // ── Hive scope (hive-pr-rollup P-005): aggregate across the hive's members ──
    if (scope === 'hive') {
      const members = await resolveHivePrScope(slug);
      const { prs, memberErrors } = await aggregateHivePrs(members, (m) =>
        listHarnessPrs(m, host),
      );
      return Response.json({ prs, scope: 'hive', members, memberErrors });
    }

    // ── Single-harness scope (the original contract, unchanged) ──
    const r = await listHarnessPrs(slug, host);
    if (!r.ok) {
      if (r.reason === 'unknown_project') {
        return Response.json({ error: 'unknown project' }, { status: 404 });
      }
      if (r.reason === 'no_remote') {
        // Explicit signal so the UI shows an actionable message rather than a
        // silent empty "no PRs" pane (which read as "broken").
        return Response.json({ prs: [], noRemote: true });
      }
      return Response.json({ prs: [], pollingFailedAt: r.pollingFailedAt });
    }
    return Response.json({ prs: r.prs });
  },
});

// ─── POST /harness/:slug/prs/:number/review ───────────────────────

const reviewPr = defineTool({
  method: 'POST',
  path: '/harness/:slug/prs/:number/review',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const prNumber = parseInt(ctx.params.number as string, 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      return Response.json({ error: 'invalid pr number' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      reviewer_github_id?: number;
      reviewer_login?: string;
      /** Phase 2 D-001: a feature-context review supplies the feature id so the
       *  completion_ref stamp resolves without the (substrate-gated)
       *  harness_feature_prs fallback. */
      feature_id?: string;
    };
    const action = body.action;
    if (action !== 'approve' && action !== 'approve_and_merge') {
      return Response.json(
        { error: 'action must be "approve" or "approve_and_merge"' },
        { status: 400 },
      );
    }

    const host = await createGitHubPrHost();
    if (!host) {
      return Response.json(
        { error: 'GitHub not authenticated — run `gh auth login`' },
        { status: 503 },
      );
    }

    const remote = (project as unknown as { remote?: string }).remote ?? '';
    if (!remote) {
      return Response.json({ error: 'no remote configured for this harness' }, { status: 422 });
    }

    // Fetch the PR to get current state.
    const prResult = await host.getPr({ remote, number: prNumber });
    if (!prResult.ok) {
      return Response.json({ error: prResult.error.message }, { status: 502 });
    }
    const pr = prResult.data;

    // PR-4 (c): attribute the review to the HUMAN operator (the gh user), not a
    // placeholder id, so every auto_review_audit row names a real, accountable
    // human (the same identity the producer records as PR author + the EN-2 P-RATE
    // bucket). The caller may still override via the body (e.g. a multi-user hive).
    let reviewerGithubId = body.reviewer_github_id ?? 0;
    let reviewerLogin = body.reviewer_login ?? 'papercusp';
    if (body.reviewer_github_id === undefined) {
      const operator = await resolveLocalGithubIdentity();
      if (operator.kind === 'ok') {
        reviewerGithubId = operator.githubUserId;
        reviewerLogin = operator.githubLogin;
      }
    }

    const flatPr = pr as unknown as FlatPr;

    // PR-5 contribution-admission: even a MANUAL approve/merge must not admit a
    // REVOKED contributor's code. A manual action bypasses the trust gate, so
    // revocation is the only thing standing between a revoked contributor and
    // canonical — refuse explicitly (don't silently no-op into {ok:true}).
    const authorRevoked = await isPrAuthorRevoked({
      workspaceId: activeWorkspaceId(),
      harnessSlug: slug,
      githubUserId: flatPr.author_github_id,
    });
    if (authorRevoked) {
      return Response.json(
        {
          error: `PR #${prNumber} author @${flatPr.author_login} is a revoked contributor on this hive — contribution admission denied.`,
          revoked: true,
        },
        { status: 403 },
      );
    }

    const approveCtx: AutoApproveContext = {
      harnessSlug: slug,
      reviewerGithubId,
      reviewerLogin,
      trustedAuthorIds: new Set([flatPr.author_github_id]), // manual action bypasses trust gate
      reviewerRoleEnabled: true,
      autoReview: true,
      authorRevoked,
    };

    const approveResult = await tryAutoApprove(host, pr, approveCtx);
    if (approveResult.action === 'error') {
      return Response.json({ error: approveResult.detail ?? 'approve failed' }, { status: 502 });
    }

    if (action === 'approve_and_merge') {
      // Re-fetch so review_decision reflects the approval we just posted.
      const refreshed = await host.getPr({ remote, number: prNumber });
      const prForMerge = refreshed.ok ? refreshed.data : pr;

      const mergeCtx: AutoMergeContext = {
        harnessSlug: slug,
        reviewerGithubId,
        reviewerLogin,
        autoMerge: true,
        mergeMethod: 'squash',
        authorRevoked,
      };
      const mergeResult = await tryAutoMerge(host, prForMerge, mergeCtx);
      if (mergeResult.action === 'error') {
        return Response.json({ error: mergeResult.detail }, { status: 502 });
      }
      // Phase 2 (D-001): on an ACTUAL merge, stamp completion_ref +
      // status='shipped' so the verifier daemon + the tier-B "shipped ✓" stat
      // activate. Only the 'merged' variant carries a mergeCommitSha — a skipped
      // merge (disabled / checks-failing / not-approved) has nothing to stamp.
      // Best-effort: the merge already succeeded, so a stamp failure must never
      // fail the response.
      if (mergeResult.action === 'merged') {
        try {
          const featureId = await resolveMergedPrFeatureId({
            harnessSlug: slug,
            prUrl: flatPr.html_url,
            bodyFeatureId: body.feature_id,
          });
          await stampCompletionRefOnMerge({
            harnessSlug: slug,
            featureId,
            remote,
            branch: flatPr.base_branch,
            mergeCommitSha: mergeResult.mergeCommitSha,
            prUrl: flatPr.html_url,
            prNumber,
          });
          // PR-4 (b): advance the WI→PR row to 'merged' so WI→PR→merged is
          // queryable for the report GUI (and so a re-poll doesn't see it as open).
          await markFeaturePrState({
            harnessSlug: slug,
            prUrl: flatPr.html_url,
            prState: 'merged',
          });
        } catch {
          // best-effort; the merge already succeeded.
        }
      }
    }

    return Response.json({ ok: true });
  },
});

// ─── POST /harness/:slug/prs/:number/agent-review ─────────────────
// On-demand agent re-review (PR-system follow-up #2): run PR-2's agent-reviewer
// for this PR NOW, instead of waiting for the daemon's next poll. Produces +
// stores a fresh `pr_review_reports` row (which the PRs tab then re-reads); the
// GUI's "Re-review" action on a stale-report row POSTs here. It ONLY produces a
// recommendation — it never approves/merges (that stays in the gated review route
// above + the daemon's auto-flow). Safe to call repeatedly: the store UPSERTs per
// head_sha.

const reReviewPr = defineTool({
  method: 'POST',
  path: '/harness/:slug/prs/:number/agent-review',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const prNumber = parseInt(ctx.params.number as string, 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      return Response.json({ error: 'invalid pr number' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const host = await createGitHubPrHost();
    if (!host) {
      return Response.json(
        { error: 'GitHub not authenticated — run `gh auth login`' },
        { status: 503 },
      );
    }

    const remote = (project as unknown as { remote?: string }).remote ?? '';
    if (!remote) {
      return Response.json({ error: 'no remote configured for this harness' }, { status: 422 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      reviewer_github_id?: number;
      feature_id?: string;
    };

    // Attribute the review to the HUMAN operator (mirror the manual review route,
    // PR-4 (c)); the caller may override via the body for a multi-user hive.
    let reviewerGithubId = body.reviewer_github_id ?? 0;
    if (body.reviewer_github_id === undefined) {
      const operator = await resolveLocalGithubIdentity();
      if (operator.kind === 'ok') reviewerGithubId = operator.githubUserId;
    }

    const result = await runPrReviewTask({
      payload: { remote, number: prNumber },
      workspaceId: activeWorkspaceId(),
      harnessSlug: slug,
      reviewerGithubId,
      bodyFeatureId: body.feature_id ?? null,
      host,
    });
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({
      ok: true,
      recommendation: result.review.recommendation,
      report: result.review.report,
      featureId: result.review.featureId,
    });
  },
});

export default [listPrs, reviewPr, reReviewPr];
