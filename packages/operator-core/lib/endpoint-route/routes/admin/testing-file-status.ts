/**
 * GET /api/admin/testing/file-status?domainId=…
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-009.
 *
 * Returns the most recent test_runs row per file in the named domain,
 * scoped by the developer's current branch per D-010:
 *   WHERE (branch = currentBranch() OR source = 'admin-ui')
 *
 * Falls back to "any source" when the file has no row on the current
 * branch, with a `stale: true` flag the SPA renders as a "stale" badge.
 *
 * The route walks the domain's globs (same matcher as the domain-detail
 * route), pulls every matching file path, then issues a single PG
 * query that returns the latest row per file_path (DISTINCT ON).
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import '../../../testing-domains-registry';
import { getTestDomain } from '../../../testing-domains';
import { expandGlobs, inferWorkspaceRoot } from '../../../testing-domain-glob';
import { resolveGitContext } from '../../../testing-branch-resolve';

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return null;
}

interface FileStatus {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running';
  durationMs: number | null;
  finishedAt: string | null;
  source: 'ci' | 'local' | 'admin-ui';
  branch: string | null;
  stale: boolean; // true when no current-branch row existed; falling back
}

interface FileStatusResponse {
  domainId: string;
  branch: string | null;
  commit: string | null;
  statuses: Record<string, FileStatus>;
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/file-status',
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
    const statuses: Record<string, FileStatus> = {};

    if (filePaths.length === 0) {
      return Response.json({
        domainId,
        branch: ctx.branch,
        commit: ctx.commit,
        statuses,
      } satisfies FileStatusResponse);
    }

    const { sql } = getOrgPg();

    // First pass — most recent row on the developer's current branch
    // (or any admin-ui run, since those reflect the dev's intent).
    if (ctx.branch) {
      const rows = await sql<{
        file_path: string;
        status: string;
        duration_ms: string | null;
        finished_at: Date | string | null;
        source: string;
        branch: string | null;
      }[]>`
        SELECT DISTINCT ON (file_path)
               file_path, status, duration_ms, finished_at, source, branch
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${filePaths})
           AND source <> 'mutation-probe'
           AND (branch = ${ctx.branch} OR source = 'admin-ui')
         ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
      `;
      for (const r of rows) {
        statuses[r.file_path] = {
          filePath: r.file_path,
          status: r.status as FileStatus['status'],
          durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
          finishedAt: toIso(r.finished_at),
          source: r.source as FileStatus['source'],
          branch: r.branch,
          stale: false,
        };
      }
    }

    // Second pass — fill any missing files with the latest row from
    // ANY branch, flagged stale.
    const missing = filePaths.filter((p) => !(p in statuses));
    if (missing.length > 0) {
      const rows = await sql<{
        file_path: string;
        status: string;
        duration_ms: string | null;
        finished_at: Date | string | null;
        source: string;
        branch: string | null;
      }[]>`
        SELECT DISTINCT ON (file_path)
               file_path, status, duration_ms, finished_at, source, branch
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${missing})
           AND source <> 'mutation-probe'
         ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
      `;
      for (const r of rows) {
        statuses[r.file_path] = {
          filePath: r.file_path,
          status: r.status as FileStatus['status'],
          durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
          finishedAt: toIso(r.finished_at),
          source: r.source as FileStatus['source'],
          branch: r.branch,
          stale: true,
        };
      }
    }

    return Response.json({
      domainId,
      branch: ctx.branch,
      commit: ctx.commit,
      statuses,
    } satisfies FileStatusResponse);
  },
});
