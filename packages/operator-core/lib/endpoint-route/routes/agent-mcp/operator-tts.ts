/**
 * POST /api/agent-mcp/operator-tts — full-reply TTS synthesis for non-browser
 * clients (the TUI's PTT path — voice-mode-tui-port-2026-06-05 D-006).
 *
 * Body: `{ text: string, engine?, voiceId? }` → `{ ok, engine, contentType,
 * audioBase64 }`. Unlike `operator-tts-preview` (200-char samples for the
 * settings page), this speaks whole replies (4000-char cap) and returns
 * base64 JSON instead of raw bytes — the TUI's IPC `sys:http` bridge is
 * binary-unsafe (UTF-8 string frames). Engine + voice default from the
 * operator's voice prefs (D-003); `'browser'` (speechSynthesis — meaningless
 * outside a browser) falls back to kokoro when kokoro's health check passes.
 *
 * Per-provider synthesis is the shared `synthesize()` registry (./tts-synth) —
 * the ONE server-side implementation, also used by operator-tts-preview and
 * re-exported here for the in-process callers (voice-node/agent-peer, sentinel
 * proactive sweep, tests). Keys stay server-side. `auth: 'loopback'`.
 */
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';
import {
  MAX_TEXT_CHARS,
  resolveTtsEngine,
} from './operator-voice-proxy-helpers';
import { kokoroTtsAvailable } from '../../../voice-node/kokoro-local';
import { synthesize } from './tts-synth';

// Re-export the canonical synth so existing `from './operator-tts'` importers
// (voice-node/agent-peer.ts, sentinel-proactive-sweep-deps.ts, the voice-io /
// elevenlabs-live tests) keep resolving without a churn of import rewrites.
export { synthesize, type Synth, type SynthOptions } from './tts-synth';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-tts',
  auth: 'loopback',
  async handler(req) {
    let body: { text?: unknown; engine?: unknown; voiceId?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return Response.json({ ok: false, error: 'text (string) required' }, { status: 400 });
    }
    const prefs = await loadVoicePrefs();
    // Resolve engine + apply the browser→kokoro health-gated fallback (D-006):
    // 'browser' (speechSynthesis) is meaningless in a terminal, so it maps to
    // local kokoro only when kokoro can synthesize here — an HTTP kokoro server
    // OR the provisioned in-process engine (P-009) — else a clean error.
    const resolved = await resolveTtsEngine(body.engine, prefs, () => kokoroTtsAvailable());
    if (!resolved.ok) {
      return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
    }
    const engine = resolved.engine;
    const voiceId = typeof body.voiceId === 'string' && body.voiceId ? body.voiceId : undefined;

    const synth = await synthesize(engine, text.slice(0, MAX_TEXT_CHARS), voiceId, prefs);
    if (!synth.ok) {
      return Response.json({ ok: false, error: synth.error, engine }, { status: synth.status });
    }
    return Response.json({
      ok: true,
      engine,
      contentType: synth.contentType,
      audioBase64: Buffer.from(synth.audio).toString('base64'),
    });
  },
});
