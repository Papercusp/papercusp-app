/**
 * GET /api/agent-mcp/operator-stt-bootstrap — cloud-STT key handoff (Deepgram).
 * Ported from app/api/agent-mcp/operator-stt-bootstrap/route.ts. `auth: 'public'`.
 */
import { readDeepgramKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-stt-bootstrap',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const engine = url.searchParams.get('engine');
    const prefs = await loadVoicePrefs();
    if (!prefs.webSpeechLeakAcked) {
      return new Response('not-acked', { status: 404 });
    }
    if (engine === 'deepgram' && prefs.sttEngine === 'deepgram') {
      const k = await readDeepgramKey();
      if (!k) return new Response('no-key', { status: 404 });
      return Response.json({ apiKey: k });
    }
    return new Response('unsupported', { status: 404 });
  },
});
