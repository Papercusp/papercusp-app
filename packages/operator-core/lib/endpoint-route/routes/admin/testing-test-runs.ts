/**
 * POST /api/admin/testing/test-runs — start a detached admin test suite run
 * and return the run id. Results are polled through sibling routes so the
 * suite can survive navigating the active Tauri webview away from /admin/testing.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { startAdminTestRun } from '../../../admin-test-runs-store';
import { isAdminTestSuiteId } from '../../../admin-test-suites';
import type { AdminTestSuiteId } from '../../../admin-test-suites-shared';

export default defineTool({
  method: 'POST',
  path: '/admin/testing/test-runs',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null) as { suiteId?: unknown; returnHref?: unknown; tauriPid?: unknown } | null;
    const rawSuiteId = typeof body?.suiteId === 'string' ? body.suiteId : '';
    const returnHref = typeof body?.returnHref === 'string' && body.returnHref.length > 0 ? body.returnHref : null;
    // Pin the run to one Tauri instance on multi-desktop boxes (the owner's
    // seat + agents' Xvfb instances) — unpinned discovery picks an arbitrary window.
    const tauriPid = typeof body?.tauriPid === 'number' && Number.isInteger(body.tauriPid) && body.tauriPid > 0 ? body.tauriPid : null;
    const selection = rawSuiteId === 'all-safe' || isAdminTestSuiteId(rawSuiteId)
      ? rawSuiteId as AdminTestSuiteId | 'all-safe'
      : null;
    if (!selection) {
      return new Response('suiteId must be one of the registered suite ids or all-safe', { status: 400 });
    }
    const snapshot = startAdminTestRun(selection, returnHref, tauriPid);
    return Response.json({ runId: snapshot.runId, snapshot });
  },
});
