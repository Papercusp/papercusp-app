/**
 * Harness activity feed — list endpoint for Phase 8 P-073b.
 *
 *   GET /api/harness/:slug/activity
 *   query: ?limit=N (default 20, capped at 100)
 *
 * Reads the last N events for one harness, aggregated from
 * harness_features_consolidated + auto_review_audit + contributors +
 * claim_audit. Pure read; no writes. Per `loadHarnessActivity`'s
 * defensive design, missing tables yield empty arrays — fresh installs
 * before dogfood ensure ran still respond 200.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-073b.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessActivity } from '../../../harness-activity/load';

const list = defineTool({
  method: 'GET',
  path: '/harness/:slug/activity',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    const limit = Math.max(
      1,
      Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 20),
    );
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      params: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, params as never)) as unknown as T[];
    };
    const events = await loadHarnessActivity({
      workspace_id: workspaceId,
      harness_slug: slug,
      limit,
      runQuery,
    });
    return Response.json({ events });
  },
});

export default [list];
