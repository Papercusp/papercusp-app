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
import { createHash } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';
import { inspectElevenLabsApiKey, readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import { testElevenLabsConnection } from '../../../voice-engines/elevenlabs';
import { testOpenAiConnection } from '../../../voice-engines/openai';
import { testCartesiaConnection } from '../../../voice-engines/cartesia';
import { probeKokoroHealth, probeVoicemodeHealth } from './operator-voice-proxy-helpers';
import { isKokoroLocalProvisioned } from '../../../voice-node/kokoro-local';
import { getLocalVoiceProvisionStatus } from '../../../voice-node/local-voice-provision';
import { warmLocalWhisper } from '../../../voice-node/local-whisper-service';

type CloudProvider = 'elevenlabs' | 'openai' | 'cartesia';
type ConnectionTest = (apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** A provider's own answer for one key: `ok` only when the provider accepted it. */
export interface CloudKeyVerdict {
  ok: boolean;
  error: string | null;
  checkedAt: number;
}

/**
 * How long a provider verdict is reused (WI-10006372). The settings page polls this route
 * while a local-voice install runs, so a live provider call per request would hammer the
 * provider; one call per key per minute keeps the field truthful without that cost.
 */
export const CLOUD_KEY_VERDICT_TTL_MS = 60_000;

const cloudVerdictState = pinModuleState('@papercusp/operator-core.voice-engine-health.cloud-verdicts', () => ({
  // Keyed by provider; the fingerprint detects a key change so a new key is re-tested at once.
  byProvider: new Map<CloudProvider, CloudKeyVerdict & { fingerprint: string }>(),
}));

/** Test seam: forget every cached provider verdict. */
export function resetCloudKeyVerdictsForTests(): void {
  cloudVerdictState.byProvider.clear();
}

/**
 * Ask the PROVIDER whether it accepts this key, reusing a fresh verdict for the same key.
 * A key that is merely present or well-formed is not a working engine: a configured
 * ElevenLabs key the provider rejected with 401 used to read `elevenlabs: true` here.
 */
async function verifyCloudKey(provider: CloudProvider, apiKey: string, test: ConnectionTest): Promise<CloudKeyVerdict> {
  const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  const cached = cloudVerdictState.byProvider.get(provider);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.checkedAt < CLOUD_KEY_VERDICT_TTL_MS) {
    return { ok: cached.ok, error: cached.error, checkedAt: cached.checkedAt };
  }
  const result = await test(apiKey).catch((err: unknown) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  const verdict: CloudKeyVerdict = {
    ok: result.ok,
    error: result.ok ? null : `${provider} connection test failed: ${result.error}`,
    checkedAt: Date.now(),
  };
  cloudVerdictState.byProvider.set(provider, { ...verdict, fingerprint });
  return verdict;
}

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-voice-engine-health',
  auth: 'loopback',
  async handler() {
    // Keep legacy-invalid values visible to the health surface; ordinary
    // outbound callers receive null from the safe default instead.
    const elKeyRead = readElevenLabsKey({ allowInvalid: true }).catch(() => null);
    const oaKeyRead = readOpenAiKey().catch(() => null);
    const caKeyRead = readCartesiaKey().catch(() => null);
    const [
      kokoroHttp,
      voicemodeHttp,
      kokoroLocal,
      provision,
      managedWhisper,
      elKey,
      oaKey,
      caKey,
      elVerdict,
      oaVerdict,
      caVerdict,
    ] = await Promise.all([
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
      elKeyRead,
      oaKeyRead,
      caKeyRead,
      // Provider verdicts run concurrently with the local probes. A malformed ElevenLabs
      // key is never sent to the provider; its shape error is reported instead.
      elKeyRead.then((k) =>
        k && inspectElevenLabsApiKey(k).healthy ? verifyCloudKey('elevenlabs', k, testElevenLabsConnection) : null,
      ),
      oaKeyRead.then((k) => (k ? verifyCloudKey('openai', k, testOpenAiConnection) : null)),
      caKeyRead.then((k) => (k ? verifyCloudKey('cartesia', k, testCartesiaConnection) : null)),
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
      // Cloud engines: `<provider>` is true ONLY when the provider itself accepted the key
      // (its connection test, cached CLOUD_KEY_VERDICT_TTL_MS). `<provider>Configured` is
      // key presence; `<provider>Error` says why an engine is not usable (WI-10006372).
      elevenlabs: elVerdict?.ok === true,
      elevenlabsConfigured: elevenLabsStatus.configured,
      elevenlabsError: elevenLabsStatus.error ?? elVerdict?.error ?? null,
      openai: oaVerdict?.ok === true,
      openaiConfigured: !!oaKey,
      openaiError: oaVerdict?.error ?? null,
      cartesia: caVerdict?.ok === true,
      cartesiaConfigured: !!caKey,
      cartesiaError: caVerdict?.error ?? null,
      probedAt: Date.now(),
    });
  },
});
