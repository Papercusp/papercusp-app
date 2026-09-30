/**
 * GET /api/admin/testing/memory/preflight — gate the Run buttons. Returns
 * { ok: true } when the suite is safe to run; { ok: false, reason } when
 * the embedder isn't resolvable or mem0 can't construct.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { memoryPreflight } from '../../../memory/suite/checks';

export default defineTool({
  method: 'GET',
  path: '/admin/testing/memory/preflight',
  auth: { trust: ['verified', 'trusted'] },
  async handler(): Promise<Response> {
    const reason = await memoryPreflight();
    if (reason) return Response.json({ ok: false, reason });
    return Response.json({ ok: true });
  },
});
