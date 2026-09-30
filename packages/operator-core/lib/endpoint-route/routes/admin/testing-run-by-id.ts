/**
 * GET  /api/admin/testing/run/:runId  — poll a single run snapshot.
 * POST /api/admin/testing/run/:runId/cancel — request cancellation.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getRunAsync, cancelRunAsync } from '../../../testing-run-store';

export const get = defineTool({
  method: 'GET',
  path: '/admin/testing/run/:runId',
  auth: { trust: ['verified', 'trusted'] },
  async handler(_req, ctx): Promise<Response> {
    const runId = ctx.params.runId;
    if (!runId) return new Response('missing runId', { status: 400 });
    const snap = await getRunAsync(runId);
    if (!snap) return new Response('unknown runId', { status: 404 });
    return Response.json(snap);
  },
});

export const cancel = defineTool({
  method: 'POST',
  path: '/admin/testing/run/:runId/cancel',
  auth: { trust: ['verified', 'trusted'] },
  async handler(_req, ctx): Promise<Response> {
    const runId = ctx.params.runId;
    if (!runId) return new Response('missing runId', { status: 400 });
    const ok = await cancelRunAsync(runId);
    if (!ok) {
      return Response.json({ ok: false, reason: 'not_running_or_unknown' }, { status: 404 });
    }
    return Response.json({ ok: true });
  },
});

export default [get, cancel];
