/**
 * RNNoise spectral noise suppression — the `noiseSuppressionEngine: 'rnnoise'`
 * binding of @papercusp/audio-dsp's NoiseSuppressor seam (P-010 / D-013).
 *
 * Sited in the operator per D-010/D-013: clients stream raw 48 kHz PCM and the
 * operator owns mic-path DSP (it also spares the Rust pui a native dep). The
 * engine is @jitsi/rnnoise-wasm — WASM, zero native-ABI risk, BSD-licensed.
 *
 * Import note: the package's `index.js` uses extensionless ESM imports that
 * plain Node can't resolve (it targets bundlers), so we import the sync dist
 * module directly — verified to load + process under Node.
 *
 * RNNoise operates on 480-sample frames @ 48 kHz with float32 samples in
 * int16 RANGE (not [-1,1]); our 960-sample channel frames are processed as
 * two RNNoise frames. The returned per-frame voice probability is exposed for
 * diagnostics (a VAD gate already exists client-side — D-013).
 */
import type { NoiseSuppressor } from '@papercusp/audio-dsp';

export const RNNOISE_FRAME_SAMPLES = 480;

interface RnnWasmModule {
  _rnnoise_create(): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, outPtr: number, inPtr: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  /** Re-read per access — emscripten heap growth re-creates the view. */
  HEAPF32: Float32Array;
}

export interface RnnoiseSuppressor extends NoiseSuppressor {
  /** Voice probability [0,1] of the most recent processed sub-frame. */
  lastVoiceProb(): number;
}

export async function createRnnoiseSuppressor(): Promise<RnnoiseSuppressor> {
  const mod = (await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js')) as unknown as {
    default: () => RnnWasmModule;
  };
  const wasm = mod.default();
  const state = wasm._rnnoise_create();
  const inPtr = wasm._malloc(RNNOISE_FRAME_SAMPLES * 4);
  const outPtr = wasm._malloc(RNNOISE_FRAME_SAMPLES * 4);
  let voiceProb = 0;
  let destroyed = false;

  return {
    process(frame: Int16Array): Int16Array {
      if (destroyed || frame.length % RNNOISE_FRAME_SAMPLES !== 0) return frame;
      const out = new Int16Array(frame.length);
      for (let off = 0; off < frame.length; off += RNNOISE_FRAME_SAMPLES) {
        let heap = wasm.HEAPF32;
        const inBase = inPtr >> 2;
        for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) heap[inBase + i] = frame[off + i];
        voiceProb = wasm._rnnoise_process_frame(state, outPtr, inPtr);
        heap = wasm.HEAPF32; // growth-safe re-read
        const outBase = outPtr >> 2;
        for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) {
          const v = heap[outBase + i];
          out[off + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
        }
      }
      return out;
    },
    lastVoiceProb: () => voiceProb,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        wasm._free(inPtr);
        wasm._free(outPtr);
        wasm._rnnoise_destroy(state);
      } catch {
        /* wasm already torn down */
      }
    },
  };
}
