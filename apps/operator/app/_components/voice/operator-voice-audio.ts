/**
 * Browser audio DSP for the desktop operator-voice client
 * (universal-voice-interface-2026-06-05, P-008). The host owns the EL session
 * and exchanges RAW PCM with clients, so the desktop must do its own capture
 * conversion + playback decode (the EL WebRTC SDK used to hide both):
 *
 *   • mic  — getUserMedia float32 @ the device rate → mono → 16 kHz → PCM16 LE
 *            bytes for OPV_MIC (EL's `user_audio_chunk` format),
 *   • play — RESPONSE_AUDIO PCM16 LE bytes @ rate → Float32 for a Web-Audio
 *            buffer.
 *
 * This module is the PURE, fully-tested math (no Web-Audio / getUserMedia); the
 * `capture`/`player` glue in operator-voice-runtime wires it to the live
 * AudioContext (verified in the P-011 audio pass).
 */

/** EL input format: 16 kHz mono PCM16. */
export const MIC_TARGET_RATE = 16_000;

/** Interleaved float32 → mono float32 (average channels). */
export function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += samples[i * channels + c];
    out[i] = acc / channels;
  }
  return out;
}

/**
 * Linear-interpolation resample of mono float32. Identity when the rates match.
 * Mirrors the pui's `resample_linear` so both surfaces feed EL the same shape.
 */
export function resampleLinear(mono: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || mono.length === 0) return mono;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = mono[Math.min(i0, mono.length - 1)];
    const b = mono[Math.min(i0 + 1, mono.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** mono float32 [-1,1] → PCM16 LE bytes (clamped). */
export function float32ToPcm16le(mono: Float32Array): Uint8Array {
  const out = new Uint8Array(mono.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * One capture chunk → OPV_MIC bytes: interleaved float32 @ srcRate/channels →
 * mono → 16 kHz → PCM16 LE. The single conversion both the worklet path and a
 * test drive.
 */
export function captureChunkToMicBytes(samples: Float32Array, channels: number, srcRate: number): Uint8Array {
  const mono = toMono(samples, channels);
  const at16k = resampleLinear(mono, srcRate, MIC_TARGET_RATE);
  return float32ToPcm16le(at16k);
}

/** RESPONSE_AUDIO PCM16 LE bytes → Float32 [-1,1] for a Web-Audio buffer. */
export function pcm16leToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1; // whole samples only
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}
