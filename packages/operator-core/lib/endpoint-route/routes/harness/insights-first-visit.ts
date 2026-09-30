/**
 * Insights first-visit gate — Phase 8 P-074 endpoints.
 *
 *   GET  /api/harness/:slug/insights-first-visit  → { force_route: boolean, seen_at_ts: number | null }
 *   POST /api/harness/:slug/insights-first-visit  → { ok: true } (marks seen NOW)
 *
 * Used by client-side wrapper to decide whether to redirect a new
 * contributor to /harness/:slug/insights on first nav, and to dismiss
 * the gate when they leave the page.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 P-074.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import {
  getInsightsFirstVisit,
  markInsightsSeen,
} from '../../../harness-insights/first-visit';
import { getSessionUserOrDefault } from '../../../auth';

async function viewerId(): Promise<string> {
  try {
    const user = await getSessionUserOrDefault();
    const idAny = (user as { id?: string | number | null; github_user_id?: string | number | null });
    if (idAny.github_user_id != null) return String(idAny.github_user_id);
    if (idAny.id != null) return String(idAny.id);
    return 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function makeRunQuery() {
  const { sql } = getOrgPg();
  return async <T,>(query: string, paramsArr: unknown[]): Promise<T[]> => {
    return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
  };
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/insights-first-visit',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const user_id = await viewerId();
    const runQuery = makeRunQuery();
    const seen_at_ts = await getInsightsFirstVisit({
      workspace_id: workspaceId,
      harness_slug: slug,
      user_id,
      runQuery,
    });
    return Response.json({
      force_route: seen_at_ts === null,
      seen_at_ts,
    });
  },
});

const mark = defineTool({
  method: 'POST',
  path: '/harness/:slug/insights-first-visit',
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const user_id = await viewerId();
    const runQuery = makeRunQuery();
    await markInsightsSeen({
      workspace_id: workspaceId,
      harness_slug: slug,
      user_id,
      runQuery,
    });
    return Response.json({ ok: true });
  },
});

export default [get, mark];
