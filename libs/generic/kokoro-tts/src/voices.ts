/**
 * Voice metadata (ported verbatim from kokoro-js@1.2.1) + the canonical HF
 * repo the style bins are fetched from. Style bins themselves are NOT
 * bundled (upstream ships all 27 ≈ 27MB in-package): the host fetches them
 * on first use and disk-caches them (see kokoro-tts.ts's `loadVoiceStyle`).
 */

export const KOKORO_HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_SAMPLE_RATE = 24_000;

export interface KokoroVoiceInfo {
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Female' | 'Male';
}

/** Upstream voice table, trimmed to id → {name, language, gender} (grades dropped). */
export const KOKORO_VOICES: Readonly<Record<string, KokoroVoiceInfo>> = Object.freeze({
  af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
  af_alloy: { name: 'Alloy', language: 'en-us', gender: 'Female' },
  af_aoede: { name: 'Aoede', language: 'en-us', gender: 'Female' },
  af_bella: { name: 'Bella', language: 'en-us', gender: 'Female' },
  af_jessica: { name: 'Jessica', language: 'en-us', gender: 'Female' },
  af_kore: { name: 'Kore', language: 'en-us', gender: 'Female' },
  af_nicole: { name: 'Nicole', language: 'en-us', gender: 'Female' },
  af_nova: { name: 'Nova', language: 'en-us', gender: 'Female' },
  af_river: { name: 'River', language: 'en-us', gender: 'Female' },
  af_sarah: { name: 'Sarah', language: 'en-us', gender: 'Female' },
  af_sky: { name: 'Sky', language: 'en-us', gender: 'Female' },
  am_adam: { name: 'Adam', language: 'en-us', gender: 'Male' },
  am_echo: { name: 'Echo', language: 'en-us', gender: 'Male' },
  am_eric: { name: 'Eric', language: 'en-us', gender: 'Male' },
  am_fenrir: { name: 'Fenrir', language: 'en-us', gender: 'Male' },
  am_liam: { name: 'Liam', language: 'en-us', gender: 'Male' },
  am_michael: { name: 'Michael', language: 'en-us', gender: 'Male' },
  am_onyx: { name: 'Onyx', language: 'en-us', gender: 'Male' },
  am_puck: { name: 'Puck', language: 'en-us', gender: 'Male' },
  am_santa: { name: 'Santa', language: 'en-us', gender: 'Male' },
  bf_emma: { name: 'Emma', language: 'en-gb', gender: 'Female' },
  bf_isabella: { name: 'Isabella', language: 'en-gb', gender: 'Female' },
  bm_george: { name: 'George', language: 'en-gb', gender: 'Male' },
  bm_lewis: { name: 'Lewis', language: 'en-gb', gender: 'Male' },
  bf_alice: { name: 'Alice', language: 'en-gb', gender: 'Female' },
  bf_lily: { name: 'Lily', language: 'en-gb', gender: 'Female' },
  bm_daniel: { name: 'Daniel', language: 'en-gb', gender: 'Male' },
  bm_fable: { name: 'Fable', language: 'en-gb', gender: 'Male' },
});

export function kokoroVoiceUrl(voice: string): string {
  return `https://huggingface.co/${KOKORO_HF_REPO}/resolve/main/voices/${voice}.bin`;
}
