/**
 * GET /api/admin/llm-tests/scenarios — list every scenario known to the
 * framework, read from the in-process registry.
 *
 * Ported from app/api/admin/llm-tests/scenarios/route.ts. `auth: 'public'`.
 */
import { SCENARIOS } from '../../../llm-testing/scenarios';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/llm-tests/scenarios',
  auth: { trust: ['verified', 'trusted'] },
  handler() {
    const scenarios = SCENARIOS.map((s) => ({
      id: s.id,
      version: s.version,
      target: s.target,
      description: s.description,
      persona: typeof s.persona === 'string' ? s.persona : 'inline',
      runMatrix: s.runMatrix ?? null,
      realWorkspace: !!s.realWorkspace,
      transport: s.transport ?? 'http-sse',
      rubricVersion: s.rubric.version,
      assertCount: s.asserts.length,
      caps: s.caps,
    }));
    return Response.json({ scenarios });
  },
});
