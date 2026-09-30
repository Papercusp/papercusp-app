/**
 * POST /api/agent-mcp/operator-openai-test — OpenAI TTS connection test.
 * Ported from app/api/agent-mcp/operator-openai-test/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { readOpenAiKey } from '../../../voice-credentials';
import { testOpenAiConnection } from '../../../voice-engines/openai';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-openai-test',
  auth: 'loopback',
  async handler(req) {
    let body: { apiKey?: unknown } = {};
    try { body = await req.json(); } catch { /* fall through */ }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
      ? body.apiKey
      : await readOpenAiKey();
    if (!apiKey) {
      return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
    }
    const result = await testOpenAiConnection(apiKey);
    return Response.json(result);
  },
});
