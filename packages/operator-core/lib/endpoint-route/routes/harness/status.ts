/**
 * GET /api/harness/:slug/status — dashboard snapshot for one harness.
 *
 * Delegates to getHarnessStatusFull in harness-core so the route and any
 * future callers share a single implementation (includes discord_channel_url,
 * cost aggregates, liveness, checkpoints, etc.).
 */
import { getHarnessStatusFull } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/status',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const phase = phasePhaseLabel(url.searchParams.get('phase') ?? undefined);
    // P-008: drop the 20.6MB `features` array (no live consumer renders it here;
    // per-feature UI uses featuresConsolidated.*). `counts` still carries the totals.
    const payload = await getHarnessStatusFull(ctx.params.slug as string, phase, {
      includeFeatures: false,
    });
    if (!payload) return Response.json({ error: 'unknown project' }, { status: 404 });
    return Response.json(payload);
  },
});
