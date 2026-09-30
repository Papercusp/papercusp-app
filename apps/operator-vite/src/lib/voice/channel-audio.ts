/**
 * Pure capture/playback math for the desktop voice-channel surface
 * (holepunch-voice-channels-2026-06-05 P-015, D-014).
 *
 * The channel media contract (D-010): clients exchange raw PCM16-LE mono
 * **48 kHz** with their local operator voice node — the operator owns the codec.
 * This module converts browser capture chunks to that wire shape and MIX frames
 * back to Web-Audio floats, reusing the unit-tested primitives from the
 * operator-voice surface (`@/app/_components/voice/operator-voice-audio`) —
 * same math, different target rate (that path feeds ElevenLabs at 16 kHz).
 *
 * Pure (no Web-Audio / getUserMedia) → fully unit-tested. The AudioContext glue
 * lives in `desktop-voice-channel-runtime.ts`.
 */
import {
  toMono,
  resampleLinear,
  float32ToPcm16le,
  pcm16leToFloat32,
} from '@/app/_components/voice/operator-voice-audio';

/** The channel wire rate (mirror of operator-core voice-node codec.ts). */
export const CHANNEL_SAMPLE_RATE = 48_000;
/** One 20 ms channel frame, in samples (the operator reframes any chunking). */
export const CHANNEL_FRAME_SAMPLES = 960;

/**
 * One capture chunk → channel MIC bytes: interleaved float32 @ srcRate/channels
 * → mono → 48 kHz → PCM16 LE. The single conversion both the worklet path and a
 * test drive.
 */
export function captureChunkToChannelBytes(
  samples: Float32Array,
  channels: number,
  srcRate: number,
): Uint8Array {
  const mono = toMono(samples, channels);
  const at48k = resampleLinear(mono, srcRate, CHANNEL_SAMPLE_RATE);
  return float32ToPcm16le(at48k);
}

/** RMS level of a float32 chunk, 0..1 — feeds the mic meter (pui parity). */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(acc / samples.length));
}

/** MIX-frame PCM16 LE bytes → Float32 [-1,1] for a Web-Audio buffer. */
export { pcm16leToFloat32 };
