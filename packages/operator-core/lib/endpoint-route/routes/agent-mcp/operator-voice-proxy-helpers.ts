/**
 * Pure, network-free helpers shared by the TUI voice proxy routes
 * (`operator-stt.ts` + `operator-tts.ts`, voice-mode-tui-port-2026-06-05
 * D-006). Extracted so the validation / size-cap / engine-resolution logic
 * is unit-testable without standing up the upstream voicemode / kokoro /
 * cloud services. See `operator-voice-proxy.test.ts`.
 */
import type { VoicePrefs, TtsEngineKind } from '../../../voice-prefs';
import { isTtsEngineUnavailable, releaseUnavailableMessage } from '../../../voice-release-availability';

/** Voicemode whisper base URL (OpenAI-compatible /v1/audio/transcriptions). */
export const VOICEMODE_URL = process.env.VOICEMODE_URL ?? 'http://localhost:2022';
/** Kokoro local TTS base URL (OpenAI-compatible /v1/audio/speech). */
export const KOKORO_URL = process.env.KOKORO_URL ?? 'http://127.0.0.1:8880';

/** STT input cap. ~15MB ≈ 8 min of 16k mono PCM16 — comfortably above any PTT utterance. */
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
/** Smaller than a 44-byte WAV header = nothing transcribable; reject early. */
export const MIN_AUDIO_BYTES = 44;
/** Whole replies, not previews — but still bounded (≈ several minutes of speech). */
export const MAX_TEXT_CHARS = 4000;

/** Engines that synthesize audio server-side (browser speechSynthesis is NOT one of them). */
export const SERVER_TTS_ENGINES = ['kokoro', 'elevenlabs', 'openai', 'cartesia'] as const;
export type ServerTtsEngine = (typeof SERVER_TTS_ENGINES)[number];

export function isServerTtsEngine(engine: string): engine is ServerTtsEngine {
  return (SERVER_TTS_ENGINES as readonly string[]).includes(engine);
}

export type AudioValidation =
  | { ok: true; audio: Buffer }
  | { ok: false; error: string; status: number };

/**
 * Decode + validate a base64 audio payload from an STT request body.
 *   - missing / non-string / empty            → 400
 * "audioBase64 (string) required"
 *   - decodes to fewer than a WAV header       → 400 "audio too short to
 * transcribe"
 *   - decodes to more than {@link MAX_AUDIO_BYTES} → 413 "audio exceeds the
 * 15MB cap"
 *
 * `Buffer.from(_, 'base64')` is lenient (it silently drops invalid chars), so
 * a malformed payload manifests as an out-of-range byte length rather than a
 * throw — both the too-short and too-large branches cover that.
 */
export function decodeAudioBase64(audioBase64: unknown): AudioValidation {
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return { ok: false, error: 'audioBase64 (string) required', status: 400 };
  }
  const audio = Buffer.from(audioBase64, 'base64');
  if (audio.length < MIN_AUDIO_BYTES) {
    return { ok: false, error: 'audio too short to transcribe', status: 400 };
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    return { ok: false, error: 'audio exceeds the 15MB cap', status: 413 };
  }
  return { ok: true, audio };
}

/** Normalize the STT `format` field; only wav/webm are supported, default wav. */
export function normalizeAudioFormat(format: unknown): 'wav' | 'webm' {
  return format === 'webm' ? 'webm' : 'wav';
}

export type ResolvedEngine =
  | { ok: true; engine: ServerTtsEngine }
  | { ok: false; error: string; status: number };

/**
 * Resolve the effective TTS engine for a server-side (terminal) synth request.
 *
 * Precedence: an explicit, non-empty `requestedEngine` wins; otherwise the
 * operator voice prefs' `ttsEngine` (D-003 — prefs reused as-is).
 *
 * Special case (D-006): the resolved engine `'browser'` means the browser's
 * `speechSynthesis`, which is meaningless server-side. It falls back to
 * `kokoro` **iff** kokoro's health check passes; otherwise it returns a clean
 * `{ ok:false, error:'no server-side tts engine available' }`. `kokoroHealthy`
 * is injected so this stays a pure decision (the route supplies a real probe;
 * tests supply a stub). An unknown/unsupported engine is a 400.
 */
export async function resolveTtsEngine(
  requestedEngine: unknown,
  prefs: Pick<VoicePrefs, 'ttsEngine'>,
  kokoroHealthy: () => Promise<boolean>,
): Promise<ResolvedEngine> {
  const requested =
    typeof requestedEngine === 'string' && requestedEngine ? requestedEngine : undefined;
  const engine: TtsEngineKind = (requested as TtsEngineKind) ?? prefs.ttsEngine;

  if (engine === 'browser') {
    // speechSynthesis can't run in a terminal — fall back to local kokoro
    // when it's reachable, else fail cleanly (no server-side engine).
    if (await kokoroHealthy()) return { ok: true, engine: 'kokoro' };
    return { ok: false, error: 'no server-side tts engine available', status: 503 };
  }
  if (!isServerTtsEngine(engine)) {
    return { ok: false, error: `unsupported engine '${engine}'`, status: 400 };
  }
  // Release scope (voice-final-public-release-2026-10-01#D-005): refuse, never
  // substitute — a silent fallback would speak with an engine the user did not pick.
  if (isTtsEngineUnavailable(engine)) {
    return { ok: false, error: releaseUnavailableMessage(engine), status: 400 };
  }
  return { ok: true, engine };
}

/** Probe kokoro's `/health`. Returns false on any error/timeout. */
export async function probeKokoroHealth(baseUrl = KOKORO_URL): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Probe voicemode's local Whisper server.
 *
 * ⚠ This used to GET `/v1/models` on the premise (stated in the old comment) that whisper
 * "has no dedicated /health". That premise is FALSE and the probe was broken in the
 * always-report-DOWN direction: whisper.cpp's server implements `/health` (200) and does NOT
 * implement `/v1/models` (404) — it is only OpenAI-shaped on the `--inference-path`
 * (/v1/audio/transcriptions) it is launched with. So a perfectly healthy, actively-transcribing
 * whisper reported `voicemode: false` in the engine-health route and the settings UI
 * (verified live 2026-07-13: /health → 200, /v1/models → 404, transcription → 200 with text).
 *
 * Hit `/health` — the endpoint that actually exists. Returns false on any error/timeout.
 */
export async function probeVoicemodeHealth(baseUrl = VOICEMODE_URL): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
