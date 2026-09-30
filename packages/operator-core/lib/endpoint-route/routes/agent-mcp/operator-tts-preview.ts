/**
 * POST /api/agent-mcp/operator-tts-preview — per-engine TTS preview synthesis.
 *
 * Short (200-char) samples for the settings voice picker + the desktop
 * chrome's per-utterance `synthViaAdapter` path. Per-provider synthesis is the
 * shared `synthesize()` registry (./tts-synth) — the SAME code path the
 * full-reply `operator-tts` route uses. (This route used to carry its own
 * inline per-provider fetch block, which had drifted from operator-tts:
 * it hardcoded openai `tts-1`/`nova` and cartesia `sonic-2` instead of reading
 * the user's prefs. Consolidated 2026-07-09, WI-3448.) `auth: 'loopback'`.
 */
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveTtsEngine } from './operator-voice-proxy-helpers';
import { kokoroTtsAvailable } from '../../../voice-node/kokoro-local';
import { synthesize } from './tts-synth';

const SAMPLE_TEXT = 'This is a sample of the operator voice.';
const PREVIEW_MAX_CHARS = 200;

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-tts-preview',
  auth: 'loopback',
  async handler(req) {
    let body: { engine?: unknown; text?: unknown; voiceId?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body OK */ }

    const text = (typeof body.text === 'string' ? body.text : '').slice(0, PREVIEW_MAX_CHARS) || SAMPLE_TEXT;
    const prefs = await loadVoicePrefs();

    // Resolve to a server engine (browser→kokoro when healthy; unsupported→400),
    // then hand off to the shared synth registry. voiceId/model defaults come
    // from prefs inside synthesize().
    const resolved = await resolveTtsEngine(body.engine, prefs, () => kokoroTtsAvailable());
    if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });

    const voiceId = typeof body.voiceId === 'string' && body.voiceId ? body.voiceId : undefined;
    const synth = await synthesize(resolved.engine, text, voiceId, prefs);
    if (!synth.ok) {
      // Preserve the prior contract: a missing cloud key reads as 404 'no-key'.
      return new Response(synth.status === 404 ? 'no-key' : synth.error, { status: synth.status });
    }
    return new Response(synth.audio, { headers: { 'content-type': synth.contentType } });
  },
});
