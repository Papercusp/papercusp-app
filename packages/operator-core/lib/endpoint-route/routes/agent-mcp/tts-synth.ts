/**
 * Canonical server-side TTS synthesis registry.
 *
 * ONE source of truth for "how to synthesize speech on provider X" — used by
 * every server voice route:
 *   - operator-tts.ts          (TUI PTT / p2p, base64 JSON, mp3|wav)
 *   - operator-tts-preview.ts  (settings preview + desktop synthViaAdapter)
 *
 * Previously each of those routes carried its OWN inline per-provider fetch
 * block, so the ElevenLabs model / OpenAI model+voice / Cartesia model
 * defaults drifted between them (voice-consolidation-2026-07-09, WI-3448 —
 * the owner). A THIRD copy lived in the client `voice-engines/*` adapter
 * framework, which was dead (only its own tests called it) and — because it
 * read server-only API keys — was never viable client-side anyway; it has
 * been removed. Add a provider HERE and every route gets it.
 *
 * API keys never leave the server: the cloud engines read their key from
 * `voice-credentials` and fetch the provider directly. `kokoro` is the local
 * (free, keyless) engine on `KOKORO_URL`. `browser` (speechSynthesis) is NOT
 * a server engine — callers resolve it to kokoro via `resolveTtsEngine`
 * (operator-voice-proxy-helpers) before reaching here.
 */
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import type { VoicePrefs } from '../../../voice-prefs';
import { encodeWavPcm16 } from '../../../voice-node/wav';
import { kokoroLocalSynthWav } from '../../../voice-node/kokoro-local';
import { KOKORO_URL } from './operator-voice-proxy-helpers';
// WI-3557: shared with the settings key-test probe (voice-engines/cartesia.ts)
// so the two never drift on which Cartesia-Version the two paths speak.
import { CARTESIA_API_VERSION } from '../../../voice-engines/cartesia';

const TTS_TIMEOUT_MS = 30_000;

export type Synth =
  | { ok: true; audio: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status: number };

/**
 * What audio container the caller wants back.
 *   - 'mp3'  (default): the cloud engines' native lossy stream — what the TUI
 *     PTT route + the browser/desktop voice session play directly. Cheapest,
 *     lowest first-byte latency.
 *   - 'wav':  a PCM16 RIFF/WAVE the in-process decoder accepts (decodeWavPcm16).
 *     The p2p voice-channel say-path (voiceAgentSay, voice-node/agent-peer.ts)
 *     needs this — it decodes → 48k frames → pushMicFrame. ElevenLabs has no
 *     WAV container, so we request raw LE PCM16 (`output_format=pcm_24000`) and
 *     wrap it into a WAV here; OpenAI/Cartesia/kokoro emit WAV natively.
 */
export interface SynthOptions {
  container?: 'mp3' | 'wav';
}

/**
 * Map an upstream provider's HTTP status onto the status we report.
 *
 * These used to ALL collapse to 502, which made a user-fixable credential
 * problem ("ElevenLabs rejected your key" / "you're out of credits") look
 * identical to an infrastructure outage ("the provider is down") — the exact
 * confusion hit on 2026-07-09, when a defunded EL account surfaced as a bare
 * `502` from the settings preview. Both the preview route and the TUI pass this
 * status straight to the user, so the classes must be distinguishable.
 *
 * 404 is deliberately NEVER produced here — it is reserved for "key not
 * configured", which keeps the preview route's `'no-key'` contract unambiguous
 * even when a provider itself answers 404.
 */
function upstreamStatus(providerStatus: number): number {
  if (providerStatus === 401 || providerStatus === 403) return 401; // credential rejected / no credits
  if (providerStatus === 429) return 429; // rate-limited / quota exhausted
  if (providerStatus >= 400 && providerStatus < 500) return 400; // bad voice / model / request
  return 502; // upstream 5xx, or anything we can't classify
}

/** Wrap raw little-endian PCM16 bytes into a RIFF/WAVE the WAV decoder accepts. */
function pcm16ToWav(raw: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const evenBytes = raw.byteLength - (raw.byteLength % 2); // PCM16 = 2 bytes/sample
  const samples = new Int16Array(raw, 0, evenBytes / 2);
  const wav = encodeWavPcm16(samples, sampleRate); // Uint8Array spanning a fresh ArrayBuffer @ offset 0
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
}

/**
 * Patch a RIFF/WAVE buffer's RIFF-size and data-chunk-size fields when they
 * carry ffmpeg libavformat's streaming "unknown length" placeholder
 * (0xFFFFFFFF) — EI-14136. Some upstream WAV encoders (notably kokoro-
 * fastapi's ffmpeg writer) stream the encode and never seek back to patch
 * the real lengths once the file is complete, even though by the time we
 * see the bytes here we already hold the ENTIRE buffer (`r.arrayBuffer()`
 * awaits the full body) and so know the true lengths. A seekable decoder
 * (GStreamer/WebKitGTK) tolerates the placeholder by clamping to the actual
 * byte length, but a stricter parser, a streaming consumer, or another
 * platform can legitimately reject it or compute an unknown/infinite
 * duration. Since we always hold the complete buffer here, no WAV this
 * server returns should ever declare an unknown length.
 *
 * A no-op (returns `buf` unchanged) for anything that isn't a RIFF/WAVE
 * container, or whose sizes are already correct — safe to call
 * unconditionally on every `audio/wav` response.
 */
function patchWavStreamingSizes(buf: ArrayBuffer): ArrayBuffer {
  if (buf.byteLength < 12) return buf; // too short to hold a RIFF/WAVE header
  const view = new DataView(buf);
  const tag4 = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (tag4(0) !== 'RIFF' || tag4(8) !== 'WAVE') return buf; // not a RIFF/WAVE container
  if (view.getUint32(4, true) === 0xffffffff) {
    view.setUint32(4, buf.byteLength - 8, true);
  }
  // Walk the sub-chunks to find "data" — kokoro-fastapi's ffmpeg writer emits
  // a LIST/INFO chunk before it, so it is not necessarily the first chunk.
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const chunkId = tag4(offset);
    const sizeOffset = offset + 4;
    const declaredSize = view.getUint32(sizeOffset, true);
    if (chunkId === 'data') {
      if (declaredSize === 0xffffffff) {
        view.setUint32(sizeOffset, buf.byteLength - (offset + 8), true);
      }
      return buf;
    }
    if (declaredSize === 0xffffffff) return buf; // can't safely skip an unknown-length non-data chunk
    offset += 8 + declaredSize + (declaredSize % 2); // chunks are word-aligned (padded to even)
  }
  return buf;
}

/**
 * Synthesize `text` on `engine`, reading per-provider model/voice defaults
 * from `prefs` (so a single settings change re-tunes every route). `engine`
 * must already be a resolved server engine (kokoro|elevenlabs|openai|cartesia).
 * Exported for unit tests (fetch stubbed).
 */
export async function synthesize(
  engine: string,
  text: string,
  voiceId: string | undefined,
  prefs: VoicePrefs,
  opts?: SynthOptions,
): Promise<Synth> {
  const wantWav = opts?.container === 'wav';
  /**
   * Shared non-ok / empty-body guard. Returns a failure Synth when the response
   * is unusable, else null. Every provider branch goes through this so a new
   * engine cannot reintroduce a bespoke (mis)classification.
   */
  const guard = (r: Response): Synth | null => {
    if (!r.ok) return { ok: false, error: `${engine} ${r.status}`, status: upstreamStatus(r.status) };
    if (!r.body) return { ok: false, error: `${engine} ${r.status} (empty body)`, status: 502 };
    return null;
  };
  const upstream = async (r: Response, contentType: string): Promise<Synth> => {
    const bad = guard(r);
    if (bad) return bad;
    const audio = await r.arrayBuffer();
    return { ok: true, audio: contentType === 'audio/wav' ? patchWavStreamingSizes(audio) : audio, contentType };
  };
  try {
    switch (engine) {
      case 'kokoro': {
        // kokoro emits WAV natively → already channel-ready, container is moot.
        // An external kokoro server (KOKORO_URL — e.g. the dev box's GPU kokoro-fastapi)
        // takes precedence; when it's UNREACHABLE (no server at all — the public-user case)
        // fall back to the in-process kokoro-js engine when provisioned (P-009, plan D-009).
        // A server that answers-but-errors keeps its honest upstream classification — the
        // fallback is only for "no server", never a mask over a broken one.
        let r: Response;
        try {
          r = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'kokoro',
              input: text,
              voice: voiceId ?? 'af_bella',
              response_format: 'wav',
            }),
            signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
          });
        } catch (e) {
          const local = await kokoroLocalSynthWav(text, voiceId);
          if (local.ok) return { ok: true, audio: local.audio, contentType: local.contentType };
          return { ok: false, error: `kokoro unreachable: ${(e as Error).message} (local fallback: ${local.error})`, status: 502 };
        }
        return upstream(r, 'audio/wav');
      }
      case 'elevenlabs': {
        const key = await readElevenLabsKey();
        if (!key) return { ok: false, error: 'elevenlabs key not configured', status: 404 };
        const voice = voiceId ?? prefs.elevenlabsVoiceId;
        if (wantWav) {
          // No WAV container exists on the EL API — request raw PCM16 @ 24kHz
          // (a clean 2× upsample to the 48k channel rate) and wrap it ourselves.
          const r = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=2&output_format=pcm_24000`,
            {
              method: 'POST',
              headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/pcm' },
              body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
              signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
            },
          );
          const bad = guard(r);
          if (bad) return bad;
          return { ok: true, audio: pcm16ToWav(await r.arrayBuffer(), 24_000), contentType: 'audio/wav' };
        }
        const r = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=2`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
            signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
          },
        );
        return upstream(r, 'audio/mpeg');
      }
      case 'openai': {
        const key = await readOpenAiKey();
        if (!key) return { ok: false, error: 'openai key not configured', status: 404 };
        const r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: wantWav ? 'audio/wav' : 'audio/mpeg',
          },
          body: JSON.stringify({
            model: prefs.openaiModel,
            input: text,
            voice: voiceId ?? prefs.openaiVoice,
            response_format: wantWav ? 'wav' : 'mp3',
          }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        return upstream(r, wantWav ? 'audio/wav' : 'audio/mpeg');
      }
      case 'cartesia': {
        const key = await readCartesiaKey();
        if (!key) return { ok: false, error: 'cartesia key not configured', status: 404 };
        const r = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'X-API-Key': key,
            'Cartesia-Version': CARTESIA_API_VERSION,
            'content-type': 'application/json',
            accept: wantWav ? 'audio/wav' : 'audio/mpeg',
          },
          body: JSON.stringify({
            model_id: prefs.cartesiaModel,
            transcript: text,
            voice: { mode: 'id', id: voiceId ?? prefs.cartesiaVoiceId },
            output_format: wantWav
              ? { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
              : { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
          }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        return upstream(r, wantWav ? 'audio/wav' : 'audio/mpeg');
      }
      default:
        return { ok: false, error: `unsupported engine '${engine}'`, status: 400 };
    }
  } catch (e) {
    return { ok: false, error: `${engine} unreachable: ${(e as Error).message}`, status: 502 };
  }
}
