/**
 * POST /api/agent-mcp/operator-cartesia-test — Cartesia TTS connection test.
 * Ported from app/api/agent-mcp/operator-cartesia-test/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { readCartesiaKey } from '../../../voice-credentials';
import { testCartesiaConnection } from '../../../voice-engines/cartesia';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-cartesia-test',
  auth: 'loopback',
  async handler(req) {
    let body: { apiKey?: unknown } = {};
    try { body = await req.json(); } catch { /* fall through */ }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
      ? body.apiKey
      : await readCartesiaKey();
    if (!apiKey) {
      return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
    }
    const result = await testCartesiaConnection(apiKey);
    return Response.json(result);
  },
});
