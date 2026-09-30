/**
 * GET /api/agent-mcp/operator-picovoice-bootstrap — Picovoice key handoff.
 * Ported from app/api/agent-mcp/operator-picovoice-bootstrap/route.ts. `auth: 'public'`.
 */
import { readPicovoiceKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-picovoice-bootstrap',
  auth: 'public',
  async handler() {
    const prefs = await loadVoicePrefs();
    const wantsPorcupine = prefs.wakeWordEngine === 'porcupine';
    const wantsKoala = prefs.noiseSuppressionEngine === 'koala';
    if (!wantsPorcupine && !wantsKoala) {
      return new Response('not-enabled', { status: 404 });
    }
    const apiKey = await readPicovoiceKey();
    if (!apiKey) return new Response('no-key', { status: 404 });
    return Response.json({ apiKey });
  },
});
