/**
 * POST /api/admin/testing/test-runs/:runId/cancel — abort a detached test run.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { cancelAdminTestRun } from '../../../admin-test-runs-store';

export default defineTool({
  method: 'POST',
  path: '/admin/testing/test-runs/:runId/cancel',
  auth: { trust: ['verified', 'trusted'] },
  handler(_req, ctx): Response {
    const runId = ctx.params.runId;
    if (!runId) return new Response('missing runId', { status: 400 });
    const snapshot = cancelAdminTestRun(runId);
    if (!snapshot) return new Response('unknown runId', { status: 404 });
    return Response.json({ ok: true, snapshot });
  },
});
