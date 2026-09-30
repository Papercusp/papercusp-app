/**
 * GET /api/agent-mcp/operator-elevenlabs-voices — the account's ElevenLabs
 * voice library, fetched SERVER-SIDE (the key never leaves the box).
 *
 * Replaces the settings page's dead client-side `fetch(api.elevenlabs.io/v1/voices,
 * { 'xi-api-key': <masked> })` — operator-credentials only ever hands the browser
 * a MASKED key, so that direct fetch always 401'd and the "Default voice" picker
 * was permanently stuck on the single hardcoded fallback (WI-3662). Same
 * server-proxy discipline as operator-elevenlabs-test / operator-conv-voice.
 *
 * `auth: 'loopback'`. Returns `{ voices: [{ id, name, lang? }] }` — empty array
 * (never an error) when no key is configured or ElevenLabs is unreachable, so the
 * client cleanly falls back to its default list.
 */
import { readElevenLabsKey } from '../../../voice-credentials';
import { fetchElevenLabsVoices } from '../../../voice-engines/elevenlabs';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-elevenlabs-voices',
  auth: 'loopback',
  async handler() {
    const key = await readElevenLabsKey();
    if (!key) return Response.json({ voices: [] });
    const voices = await fetchElevenLabsVoices(key);
    return Response.json({ voices });
  },
});
