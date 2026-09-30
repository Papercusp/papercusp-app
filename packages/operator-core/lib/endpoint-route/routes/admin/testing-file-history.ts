/**
 * GET /api/admin/testing/file-history?filePath=…&limit=20
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-018.
 *
 * Returns the last N test_runs rows for one file_path, newest first.
 * The SPA opens this in a sheet when the user clicks the status chip.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return null;
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/file-history',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const url = new URL(req.url);
    const filePath = url.searchParams.get('filePath');
    if (!filePath) {
      return Response.json(
        { error: 'missing_query_param', param: 'filePath' },
        { status: 400 },
      );
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 200);

    const { sql } = getOrgPg();

    const rows = await sql<{
      id: string;
      status: string;
      duration_ms: string | null;
      started_at: Date | string | null;
      finished_at: Date | string | null;
      output_tail: string | null;
      source: string;
      branch: string | null;
      commit_sha: string | null;
    }[]>`
      SELECT id, status, duration_ms, started_at, finished_at, output_tail,
             source, branch, commit_sha
        FROM harness_shared.test_runs
       WHERE file_path = ${filePath}
         AND source <> 'mutation-probe'
       ORDER BY finished_at DESC NULLS LAST, id DESC
       LIMIT ${limit}
    `;

    return Response.json({
      filePath,
      rows: rows.map((r) => ({
        id: String(r.id),
        status: r.status,
        durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
        startedAt: toIso(r.started_at),
        finishedAt: toIso(r.finished_at),
        outputTail: r.output_tail,
        source: r.source,
        branch: r.branch,
        commitSha: r.commit_sha,
      })),
    });
  },
});
