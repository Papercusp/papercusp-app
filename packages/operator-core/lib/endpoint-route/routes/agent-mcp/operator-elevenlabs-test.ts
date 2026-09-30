/**
 * POST /api/agent-mcp/operator-elevenlabs-test — ElevenLabs connection test.
 * Ported from app/api/agent-mcp/operator-elevenlabs-test/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { readElevenLabsKey } from '../../../voice-credentials';
import { testElevenLabsConnection } from '../../../voice-engines/elevenlabs';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-elevenlabs-test',
  auth: 'loopback',
  async handler(req) {
    let body: { apiKey?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body is fine */
    }
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey.length > 0
        ? body.apiKey
        : // The explicit test endpoint should explain a stored legacy-invalid key;
          // it is a diagnostic reader, not an outbound call without validation.
          await readElevenLabsKey({ allowInvalid: true });
    if (!apiKey) {
      return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
    }
    const result = await testElevenLabsConnection(apiKey);
    return Response.json(result);
  },
});
