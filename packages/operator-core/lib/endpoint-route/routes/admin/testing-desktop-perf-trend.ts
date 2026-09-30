/**
 * GET /api/admin/testing/desktop-perf-trend — the last-N persisted
 * desktop-performance runs (desktop-performance-suite-2026-07-20 P-010),
 * each enriched with per-measure deltas vs the previous run, for the admin
 * testing trend panel and regression review.
 *
 * ?limit=<n> (default 20, capped 1..200). Workspace-scoped via ?ws= (the
 * useWorkspaceId convention), then PAPERCUSP_WORKSPACE_ID, then 'default'.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readDesktopPerfTrend } from '../../../system-health/desktop-perf-runs';

export default defineTool({
  method: 'GET',
  path: '/admin/testing/desktop-perf-trend',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const url = new URL(req.url);
    const ws = url.searchParams.get('ws');
    const workspaceId = ws && ws.length > 0 ? ws : (process.env.PAPERCUSP_WORKSPACE_ID ?? 'default');
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const trend = await readDesktopPerfTrend(workspaceId, limit);
    return Response.json({ trend });
  },
});
