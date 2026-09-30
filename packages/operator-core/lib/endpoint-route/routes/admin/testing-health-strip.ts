/**
 * GET /api/admin/testing/health-strip?domainId=…
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-033.
 *
 * Test-related signals only (per D-033 amendment — operational health
 * like voice spend / lock queue belongs on per-domain admin pages):
 *
 *   lastSuiteDurationMs   — total wallclock of the most recent
 *                            current-branch run, summed across files.
 *   lastFailureFinishedAt — most recent fail/error timestamp.
 *   flakyFileCount        — files with >1 status flip in last 10 runs.
 *   totalFilesTracked     — files with at least one row in test_runs.
 *
 * Reads only — no writes. Falls back to zeros when the table is
 * empty or branch can't be resolved.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import '../../../testing-domains-registry';
import { getTestDomain } from '../../../testing-domains';
import { expandGlobs, inferWorkspaceRoot } from '../../../testing-domain-glob';
import { resolveGitContext } from '../../../testing-branch-resolve';

interface HealthStrip {
  domainId: string;
  branch: string | null;
  lastSuiteDurationMs: number | null;
  lastFailureFinishedAt: string | null;
  flakyFileCount: number;
  totalFilesTracked: number;
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return null;
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/health-strip',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId');
    if (!domainId) {
      return Response.json(
        { error: 'missing_query_param', param: 'domainId' },
        { status: 400 },
      );
    }
    const domain = getTestDomain(domainId);
    if (!domain) {
      return Response.json(
        { error: 'unknown_domain', domainId },
        { status: 404 },
      );
    }

    const root = inferWorkspaceRoot();
    const allGlobs = domain.sections.flatMap((s) => s.globs ?? []);
    const hits = allGlobs.length > 0 ? await expandGlobs(root, allGlobs) : [];
    const filePaths = hits.map((h) => h.path);

    const ctx = await resolveGitContext();
    const payload: HealthStrip = {
      domainId,
      branch: ctx.branch,
      lastSuiteDurationMs: null,
      lastFailureFinishedAt: null,
      flakyFileCount: 0,
      totalFilesTracked: 0,
    };
    if (filePaths.length === 0) return Response.json(payload);

    const { sql } = getOrgPg();
    const branchFilter = ctx.branch ?? '__none__';

    // Total files with at least one row on this branch.
    try {
      const tracked = await sql<{ n: string }[]>`
        SELECT COUNT(DISTINCT file_path)::text AS n
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${filePaths})
           AND source <> 'mutation-probe'
           AND (branch = ${branchFilter} OR source = 'admin-ui')
      `;
      payload.totalFilesTracked = Number(tracked[0]?.n ?? 0);
    } catch { /* fail-soft */ }

    // Sum of latest-per-file durations (proxy for last suite wallclock).
    try {
      const durRows = await sql<{ total_ms: string | null }[]>`
        SELECT COALESCE(SUM(d), 0)::text AS total_ms
          FROM (
            SELECT DISTINCT ON (file_path) duration_ms AS d
              FROM harness_shared.test_runs
             WHERE file_path = ANY(${filePaths})
               AND source <> 'mutation-probe'
               AND (branch = ${branchFilter} OR source = 'admin-ui')
             ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
          ) t
      `;
      const total = Number(durRows[0]?.total_ms ?? 0);
      payload.lastSuiteDurationMs = total > 0 ? total : null;
    } catch { /* fail-soft */ }

    // Most recent fail/error finished_at.
    try {
      const failRows = await sql<{ finished_at: Date | string | null }[]>`
        SELECT finished_at
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${filePaths})
           AND status IN ('fail', 'error')
           AND source <> 'mutation-probe'
           AND (branch = ${branchFilter} OR source = 'admin-ui')
         ORDER BY finished_at DESC NULLS LAST, id DESC
         LIMIT 1
      `;
      payload.lastFailureFinishedAt = toIso(failRows[0]?.finished_at);
    } catch { /* fail-soft */ }

    // Flaky files — those with >1 distinct status in the last 10 rows.
    try {
      const flakyRows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM (
          SELECT file_path
            FROM (
              SELECT file_path, status,
                     ROW_NUMBER() OVER (
                       PARTITION BY file_path
                       ORDER BY finished_at DESC NULLS LAST, id DESC
                     ) AS rn
                FROM harness_shared.test_runs
               WHERE file_path = ANY(${filePaths})
                 AND source <> 'mutation-probe'
            ) ranked
           WHERE rn <= 10
           GROUP BY file_path
          HAVING COUNT(DISTINCT status) > 1
        ) flaky
      `;
      payload.flakyFileCount = Number(flakyRows[0]?.n ?? 0);
    } catch { /* fail-soft */ }

    return Response.json(payload);
  },
});
