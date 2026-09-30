'use client';

/**
 * Voicemode whisper STT capture loop — Silero VAD edition.
 *
 * Was: hand-rolled RMS+dBFS VAD with a 100ms timer, MediaRecorder
 * encoding opus chunks, false-positive-prone on keyboard/breathing/fan.
 *
 * Now: `@ricky0123/vad-web` Silero ONNX VAD. Speech detection uses an
 * actual neural model trained on speech vs. non-speech. `onSpeechEnd`
 * delivers the utterance audio as Float32Array @ 16kHz, which we wrap
 * as a WAV blob and ship to whisper.
 *
 * Wins:
 *   - 3-4× fewer false positives on background noise
 *   - Cleaner utterance boundaries (no truncated starts)
 *   - ~50 lines of code deleted from this file
 *   - Same `startWhisperCapture(baseUrl, listener)` interface — drop-in
 *     replacement for callers (voice-mode.ts).
 */

import { MicVAD } from '@ricky0123/vad-web';
import { transcribeChunk } from '@papercusp/operator-core/lib/voice-engines/whisper';
import { f32ToWav } from './f32-to-wav';
import { captureWindowEndingAt, type CaptureWindow } from './capture-window';

export interface WhisperListener {
  onPartial?: (text: string) => void;
  /**
   * `capture` is the WALL-CLOCK span the audio occupies — see capture-window.ts.
   * The self-echo guard (WI-954890) tests THIS, not the arrival time.
   */
  onFinal: (text: string, capture: CaptureWindow) => void;
}

// ── Silero VAD timing (WI-954890 — read the library, don't trust the comment) ──
//
// This file used to pass `redemptionFrames: 8` and `minSpeechFrames: 4`, with
// comments calling them "~500ms of silence before ending" and "~250ms minimum
// to count as speech". BOTH were wrong, and not by a little:
//
//   • The installed @ricky0123/vad-web takes MILLISECONDS — `redemptionMs`,
//     `minSpeechMs`, `preSpeechPadMs` (frame-processor.d.ts) — and DERIVES the
//     frame counts itself (`redemptionFrames = floor(redemptionMs/msPerFrame)`).
//     The frame-named options we were passing are not options at all: they were
//     silently ignored, so the VAD has been running on library defaults the
//     whole time. (`minSpeechFrames` is not even in the type; tsc flags it.)
//   • Those defaults are redemptionMs 1400 / minSpeechMs 400 / preSpeechPadMs
//     800 — so end-of-speech actually waits 1400ms, nearly 3× the "~500ms" the
//     comment claimed and by itself twice the old 700ms self-audio window.
//
// The values below are set to the library defaults ON PURPOSE: they pin what
// this path is ALREADY doing rather than quietly retuning the VAD inside an
// echo-guard fix. Whether 1400/400 are the right numbers is a separate tuning
// question and is filed as its own bug.
const VAD_MODEL = 'v5' as const;
const VAD_SAMPLE_RATE = 16_000;
/** Silence before onSpeechEnd fires — dead time between real audio and the transcript. */
const REDEMPTION_MS = 1_400;
/** Shorter segments are discarded as a misfire. */
const MIN_SPEECH_MS = 400;
/** Audio prepended to each segment; it makes the returned clip start EARLIER than the speech. */
const PRE_SPEECH_PAD_MS = 800;

export interface WhisperCapture {
  /** Stop the loop + release the mic. Idempotent. */
  stop(): void;
}


export async function startWhisperCapture(
  baseUrl: string,
  listener: WhisperListener,
): Promise<WhisperCapture> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const vad = await MicVAD.new({
    model: VAD_MODEL,            // Silero v5 — more accurate than legacy
    // Pin asset paths to absolute origin URLs so the loader resolves the
    // ONNX model + worklet from /silero_vad_v5.onnx and /vad.worklet…
    // regardless of the current page's path. Default `./` resolution
    // breaks on nested routes like /settings/voice → /settings/silero…
    baseAssetPath: '/',
    // ORT wasm/mjs lives at /vad-runtime/ — under Vite, importing .mjs from
    // publicDir root throws "should not be imported from source code".
    // setup-vad-runtime.sh mirrors the files into public/vad-runtime/.
    onnxWASMBasePath: '/vad-runtime/',
    positiveSpeechThreshold: 0.6, // raise = stricter (fewer false positives)
    negativeSpeechThreshold: 0.35,
    minSpeechMs: MIN_SPEECH_MS,
    redemptionMs: REDEMPTION_MS,
    preSpeechPadMs: PRE_SPEECH_PAD_MS,
    onSpeechEnd: async (audio: Float32Array) => {
      // WALL-CLOCK SPAN OF THIS AUDIO (WI-954890), taken BEFORE the await —
      // whisper's own latency (measured 588ms-3s on the shipped local server,
      // and it varies with machine load) must not leak into the window, which is precisely the mistake
      // the old dispatch-time cooldown made. `onSpeechEnd` fires only after the
      // redemption silence, so step back over it; the sample count gives the
      // duration, and it includes the pre-speech padding, so the window starts
      // a little before the speech did. Both effects land EARLY, which is the
      // safe direction: a window shifted late is what loses an overlap.
      const capture = captureWindowEndingAt(
        Date.now() - REDEMPTION_MS,
        (audio.length / VAD_SAMPLE_RATE) * 1000,
      );
      try {
        const blob = f32ToWav(audio);
        if (blob.size < 5_000) return; // sub-second drop
        const text = (await transcribeChunk(baseUrl, blob)).trim();
        if (text.length > 1) listener.onFinal(text, capture);
      } catch {
        /* network blip or whisper down — drop this utterance */
      }
    },
    onVADMisfire: () => {
      /* speech started but was too short — silently drop */
    },
  });

  await vad.start();

  return {
    stop(): void {
      try { vad.pause(); } catch { /* ignore */ }
      try { vad.destroy(); } catch { /* ignore */ }
    },
  };
}
