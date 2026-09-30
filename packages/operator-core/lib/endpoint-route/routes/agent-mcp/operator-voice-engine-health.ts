/**
 * GET /api/agent-mcp/operator-voice-engine-health — live engine reachability
 * probe for the settings "Re-detect engines" button (WI-3663).
 *
 * The button used to be a no-op: it only re-fetched prefs and toasted, and its
 * comment referenced the client `voice-engines.ts` detection cache that was
 * DELETED with the dead adapter framework (WI-3448). This route makes "re-detect"
 * mean something: it actually probes the two LOCAL engines for reachability
 * (kokoro TTS on :8880, voicemode Whisper STT on :2022) and reports which cloud
 * providers have a key configured — all server-side, so no key reaches the
 * browser. `auth: 'loopback'`.
 *
 * Local probes run concurrently (each ~2s-capped); a down engine reads `false`,
 * never throws.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { inspectElevenLabsApiKey, readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import { probeKokoroHealth, probeVoicemodeHealth } from './operator-voice-proxy-helpers';
import { isKokoroLocalProvisioned } from '../../../voice-node/kokoro-local';
import { getLocalVoiceProvisionStatus } from '../../../voice-node/local-voice-provision';
import { warmLocalWhisper } from '../../../voice-node/local-whisper-service';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-voice-engine-health',
  auth: 'loopback',
  async handler() {
    const [kokoroHttp, voicemodeHttp, kokoroLocal, provision, managedWhisper, elKey, oaKey, caKey] = await Promise.all([
      probeKokoroHealth(),
      probeVoicemodeHealth(),
      isKokoroLocalProvisioned().catch(() => false),
      getLocalVoiceProvisionStatus().catch(() => null),
      // Capability health must answer whether Whisper can serve NOW, not merely whether a
      // binary/model marker exists on disk. This is a bounded lifecycle warm: an external
      // endpoint is adopted, otherwise the provisioned managed child is health-gated once and
      // cached by local-whisper-service. Failures remain data so the health route never kills boot.
      warmLocalWhisper().catch((error) => ({
        ok: false as const,
        reason: 'warm-threw' as const,
        detail: error instanceof Error ? error.message : String(error),
      })),
      // Keep legacy-invalid values visible to the health surface; ordinary
      // outbound callers receive null from the safe default instead.
      readElevenLabsKey({ allowInvalid: true }).catch(() => null),
      readOpenAiKey()
        .then((k) => !!k)
        .catch(() => false),
      readCartesiaKey()
        .then((k) => !!k)
        .catch(() => false),
    ]);
    const elevenLabsStatus = inspectElevenLabsApiKey(elKey);
    const whisperProvisioned = !!(provision?.whisperBinary.done && provision?.whisperModel.done);
    const whisperReady = voicemodeHttp || managedWhisper.ok;
    return Response.json({
      // Local engines: usable RIGHT NOW — an HTTP server answering, or a provisioned local
      // fallback the routes reach without one (P-009: in-process kokoro-js; the operator-
      // managed whisper-server child spawns on demand from the provisioned cache).
      kokoro: kokoroHttp || kokoroLocal,
      voicemode: whisperReady,
      // The P-009 install surface (settings "Install local voice"): per-leg provisioned
      // state + the in-flight installer status, for the button/progress UI.
      localVoice: {
        kokoroProvisioned: kokoroLocal,
        whisperProvisioned,
        whisper: managedWhisper.ok
          ? { ok: true, source: managedWhisper.source ?? 'managed' }
          : {
              ok: false,
              reason: managedWhisper.reason ?? (whisperProvisioned ? 'unhealthy' : 'not-provisioned'),
              detail: managedWhisper.detail,
            },
        installer: provision,
      },
      // Cloud engines: local key shape is healthy; reachability is only tested on explicit
      // "Test connection". Invalid legacy keys remain visible as unhealthy.
      elevenlabs: elevenLabsStatus.healthy,
      elevenlabsConfigured: elevenLabsStatus.configured,
      elevenlabsError: elevenLabsStatus.error,
      openai: oaKey,
      cartesia: caKey,
      probedAt: Date.now(),
    });
  },
});
