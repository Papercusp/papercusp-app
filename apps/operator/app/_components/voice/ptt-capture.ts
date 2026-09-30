'use client';

/**
 * Push-to-talk raw audio capture.
 *
 * PTT has explicit, user-controlled speech boundaries (press = start,
 * release = end), so unlike always-on it needs NO voice-activity
 * detection. This captures raw mono Float32 PCM via the Web Audio API for
 * the duration of the hold and returns the whole buffer on stop, to be
 * resampled to 16 kHz, WAV-encoded (f32-to-wav.ts) and shipped to the
 * local whisper server.
 *
 * Why not the Silero-VAD path (stt-voicemode.ts)? That loads
 * `@ricky0123/vad-web` → onnxruntime-web, whose threaded WASM needs
 * SharedArrayBuffer — absent on the Tauri WebKitGTK desktop webview
 * (`crossOriginIsolated` is false), so MicVAD can't initialize there. Raw
 * Web Audio capture has no such dependency and is verified working on
 * WebKitGTK.
 *
 * Why not MediaRecorder? WebKitGTK's MediaRecorder reports
 * `isTypeSupported() === false` for every audio mime (webm/opus/ogg/wav),
 * so it produces nothing usable. Web Audio + manual WAV encoding is the
 * only capture path that works across both Chromium and WebKitGTK.
 */

export interface PttRawCaptureResult {
  /** Captured mono PCM at `sampleRate`. Empty if nothing was captured. */
  samples: Float32Array;
  sampleRate: number;
  /** Peak absolute amplitude over the whole capture (0..1). */
  peak: number;
  /** Capture duration in seconds. */
  durationSec: number;
}

export interface PttRawCapture {
  /** Stop capture, release the mic, and return the accumulated audio. */
  stop(): PttRawCaptureResult;
}

// Safety cap so an indefinitely-held button can't grow the buffer without
// bound. 60s of 48kHz mono Float32 ≈ 11.5 MB — far beyond any real
// utterance; past it we stop accumulating (keep the earlier audio).
const MAX_CAPTURE_SEC = 60;
const SCRIPT_BUFFER = 4096;

export async function startPttRawCapture(): Promise<PttRawCapture> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });

  const Ctx: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext: typeof AudioContext })
      .AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('AudioContext unavailable');
  }
  const ctx = new Ctx();
  // WebKitGTK + Chrome's autoplay policy start an AudioContext 'suspended';
  // a suspended context never advances its clock so onaudioprocess never
  // fires and the capture is silent. resume() is permitted here without a
  // fresh gesture (the PTT keydown/pointerdown is the gesture).
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* best effort — may stay silent */ }
  }

  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it
  // needs no separately-loaded worklet module (the VAD worklet path had its
  // own asset-resolution pitfalls) and is fine for short, bounded PTT
  // captures. Verified firing on WebKitGTK.
  const node = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 1);

  const chunks: Float32Array[] = [];
  let total = 0;
  let peak = 0;
  const maxSamples = Math.floor(MAX_CAPTURE_SEC * sampleRate);

  node.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    // Copy — the inputBuffer is reused across callbacks.
    const copy = new Float32Array(input.length);
    copy.set(input);
    for (let i = 0; i < copy.length; i++) {
      const a = Math.abs(copy[i]);
      if (a > peak) peak = a;
    }
    if (total < maxSamples) {
      chunks.push(copy);
      total += copy.length;
    }
    // The output buffer is left zero-filled so the mic is never echoed to
    // the speakers.
  };

  src.connect(node);
  // Route through a muted gain node into the destination: a ScriptProcessor
  // only fires onaudioprocess while connected to a live graph sink, but a
  // gain of 0 guarantees nothing reaches the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  let stopped = false;

  return {
    stop(): PttRawCaptureResult {
      if (stopped) {
        return { samples: new Float32Array(0), sampleRate, peak, durationSec: 0 };
      }
      stopped = true;
      try { node.onaudioprocess = null; } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      try { mute.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { void ctx.close(); } catch { /* ignore */ }

      const samples = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { samples.set(c, off); off += c.length; }
      return { samples, sampleRate, peak, durationSec: total / sampleRate };
    },
  };
}

/**
 * Resample mono Float32 PCM to 16 kHz via linear interpolation. Whisper
 * works best at 16 kHz; the Web Audio capture runs at the device rate
 * (typically 44.1/48 kHz). Linear interpolation is more than adequate for
 * speech STT. Returns the input unchanged when it is already 16 kHz.
 */
export function resampleLinearTo16k(samples: Float32Array, srcRate: number): Float32Array {
  const DST = 16000;
  if (srcRate === DST || samples.length === 0) return samples;
  const ratio = srcRate / DST;
  const outLen = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const a = samples[i0] ?? 0;
    const b = i0 + 1 < samples.length ? samples[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Peak absolute amplitude (0..1) of a PCM buffer. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Whisper returns bracketed markers for non-speech audio
 * (`[BLANK_AUDIO]`, `[SILENCE]`, `[ Silence ]`, `(phone ringing)`, …) and
 * sometimes bare punctuation. Treat those — and the empty string — as "no
 * words were spoken" rather than a real transcript to dispatch.
 */
export function isBlankTranscript(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  // Whole string is a single bracketed/parenthesised marker.
  if (/^[[(][^\])]*[\])]$/.test(t)) return true;
  // No letters or digits at all (pure punctuation / whitespace).
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return false;
}

/**
 * Floor below which a captured PTT buffer is treated as a dead/muted mic
 * (it delivered essentially digital silence) rather than a working mic in a
 * quiet room. A live track always carries a noise floor well above this; a
 * muted/disconnected track delivers ~exact zeros. Kept low so a genuinely
 * quiet mic still gets transcribed (and falls through to "no transcript",
 * not the alarming "no audio / check mic" path).
 */
export const PTT_SILENCE_PEAK = 0.0005;
/** Minimum hold length to bother transcribing — filters accidental taps. */
export const PTT_MIN_DURATION_SEC = 0.18;

export type PttDisposition = 'no-audio' | 'transcribe';

/**
 * Decide what a finished PTT capture means: did the mic actually deliver
 * audio (→ transcribe it), or did capture fail / the track was silent
 * (→ surface the actionable "no audio / check mic" toast)?
 */
export function classifyPttResult(result: PttRawCaptureResult | null): PttDisposition {
  if (!result || result.samples.length === 0) return 'no-audio';
  if (result.durationSec < PTT_MIN_DURATION_SEC) return 'no-audio';
  if (result.peak < PTT_SILENCE_PEAK) return 'no-audio';
  return 'transcribe';
}
