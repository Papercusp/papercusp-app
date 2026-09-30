/**
 * POST /api/agent-mcp/voice-utterance-log — voice utterance audit log.
 * Ported from app/api/agent-mcp/voice-utterance-log/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { logVoiceUtterance, type VoiceUtteranceLogInput } from '../../../voice-utterance-log';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/voice-utterance-log',
  auth: 'loopback',
  async handler(req) {
    let body: VoiceUtteranceLogInput;
    try {
      body = (await req.json()) as VoiceUtteranceLogInput;
    } catch {
      return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
    }
    const result = await logVoiceUtterance(body);
    if (!result.ok) {
      return Response.json(result, { status: 500 });
    }
    return Response.json(result);
  },
});
