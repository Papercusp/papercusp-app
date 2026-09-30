/**
 * GET /api/admin/testing/test-runs/:runId — snapshot of a detached test run.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getAdminTestRunSnapshot } from '../../../admin-test-runs-store';

export default defineTool({
  method: 'GET',
  path: '/admin/testing/test-runs/:runId',
  auth: { trust: ['verified', 'trusted'] },
  handler(_req, ctx): Response {
    const runId = ctx.params.runId;
    if (!runId) return new Response('missing runId', { status: 400 });
    const snapshot = getAdminTestRunSnapshot(runId);
    if (!snapshot) return new Response('unknown runId', { status: 404 });
    return Response.json(snapshot);
  },
});
