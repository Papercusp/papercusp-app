/**
 * Bootstrap-progress read endpoint — Phase 5b P-066 data source.
 *
 *   GET /api/harness/:slug/bootstrap-progress
 *   query: ?idle_ms=N (default 30000, capped at 5min)
 *
 * Returns:
 *   { progress: BootstrapProgressSnapshot | null }
 *
 * The snapshot drives BootstrapProgressIndicator. Null when the
 * substrate hasn't booted / no merge activity has been recorded for
 * the harness yet — the indicator renders nothing in that case.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 */

import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { getBootstrapProgress } from '../../../sync/hyperbee/bootstrap-progress';

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/bootstrap-progress',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const rawIdle = Number.parseInt(
      url.searchParams.get('idle_ms') ?? '30000',
      10,
    );
    const idleMs = Math.max(
      1_000,
      Math.min(5 * 60 * 1_000, Number.isFinite(rawIdle) ? rawIdle : 30_000),
    );
    const progress = getBootstrapProgress(workspaceId, slug, { idleMs });
    return Response.json({ progress });
  },
});

export default [get];
