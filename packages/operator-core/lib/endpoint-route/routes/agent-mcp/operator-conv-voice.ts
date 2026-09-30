/**
 * GET/POST /api/agent-mcp/operator-conv-voice — conv-AI voice read/set.
 * Ported from app/api/agent-mcp/operator-conv-voice/route.ts. `auth: 'public'`.
 */
import { readConvVoice, setConvVoice } from '../../../conv-voice';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-conv-voice',
  auth: 'public',
  async handler() {
    const result = await readConvVoice();
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    const { ok: _ok, ...rest } = result;
    return Response.json(rest);
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-conv-voice',
  auth: 'loopback',
  async handler(req) {
    let body: { voiceId?: string; modelId?: string } = {};
    try { body = await req.json(); } catch { /* tolerate empty */ }
    const voiceId = (body.voiceId ?? '').trim();
    if (!voiceId) {
      return Response.json({ error: 'voiceId required' }, { status: 400 });
    }
    const result = await setConvVoice({ voiceId, modelId: body.modelId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true, voiceId: result.voiceId, voiceName: result.voiceName, modelId: result.modelId });
  },
});

export default [get, post];
