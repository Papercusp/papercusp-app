'use client';

/**
 * Energy-gated continuous capture for always-on voice on runtimes where
 * Silero VAD can't run.
 *
 * The Silero path (stt-voicemode.ts) needs onnxruntime-web's threaded WASM →
 * SharedArrayBuffer, which is absent on the Tauri WebKitGTK desktop webview
 * (and the bundled ORT assets are threaded-only). Without it, always-on
 * previously fell through to Web-Speech wake-word listening, which WebKitGTK
 * also lacks — so always-on never actually listened.
 *
 * This module segments speech by short-time RMS energy with an adaptive noise
 * floor (so it works across mic gains / rooms without hand-tuned thresholds),
 * buffers each utterance, resamples to 16 kHz, and hands it to the caller to
 * WAV-encode + ship to the local whisper server. Energy VAD is cruder than
 * Silero (the trade Silero was adopted to avoid), so the defaults lean
 * conservative: better to miss a borderline utterance than to transcribe a
 * keyboard clack.
 */

import { resampleLinearTo16k } from './ptt-capture';
import { captureWindowEndingAt, type CaptureWindow } from './capture-window';

export interface EnergyVadCapture {
  /** Stop the loop + release the mic. Idempotent. */
  stop(): void;
}

export interface EnergyVadCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  /**
   * A finished speech segment, mono Float32 @ 16 kHz, ready for whisper.
   *
   * `capture` is the WALL-CLOCK span the audio actually occupies. It is not a
   * diagnostic: the self-echo guard (WI-954890) is a test against this window,
   * because the moment the transcript finally arrives says nothing about
   * whether the microphone was hearing our own playout when it recorded.
   */
  onUtterance: (pcm16k: Float32Array, capture: CaptureWindow) => void;
}

// ── Pure segmentation state machine (deterministic → unit-testable) ──────

export interface VadParams {
  /** EMA rate at which the noise floor tracks ambient RMS during silence. */
  floorAttack: number;
  /** Speech start threshold = noiseFloor * triggerMult. */
  triggerMult: number;
  /** Speech end threshold = noiseFloor * releaseMult (hysteresis: < trigger). */
  releaseMult: number;
  /** Lower bound on the noise floor so a dead-silent mic still needs real signal. */
  absoluteFloor: number;
  /** Consecutive above-trigger frames required to confirm speech start. */
  startFrames: number;
  /** Consecutive below-release frames required to confirm speech end. */
  hangoverFrames: number;
  /** Hard cap on utterance length (frames) so an open mic can't grow forever. */
  maxUtteranceFrames: number;
}

// Frame ≈ 4096 samples / ~44.1kHz ≈ 93ms, so these counts are in ~93ms units.
export const DEFAULT_VAD_PARAMS: VadParams = {
  floorAttack: 0.05,
  triggerMult: 3.0,
  releaseMult: 1.8,
  absoluteFloor: 0.005,
  // 3 sustained frames (~280ms) to start — real speech easily clears this,
  // but transient clicks/taps/keystrokes (1 frame) don't, which is the main
  // false-trigger source for energy VAD.
  startFrames: 3,
  hangoverFrames: 8,     // ~750ms of silence to end
  maxUtteranceFrames: 320, // ~30s safety cap
};

export type VadEvent =
  | { type: 'none' }
  | { type: 'start' }
  | { type: 'end'; dropTrailingFrames: number };

export class EnergyVadSegmenter {
  private p: VadParams;
  private noiseFloor: number;
  private speaking = false;
  private speechRun = 0;
  private silenceRun = 0;
  private uttFrames = 0;

  constructor(params: Partial<VadParams> = {}) {
    this.p = { ...DEFAULT_VAD_PARAMS, ...params };
    this.noiseFloor = this.p.absoluteFloor;
  }

  get isSpeaking(): boolean { return this.speaking; }
  /** Current speech-start threshold (for tests / diagnostics). */
  get triggerThreshold(): number { return this.noiseFloor * this.p.triggerMult; }

  /** Feed one frame's RMS; returns the segmentation transition (if any). */
  push(rms: number): VadEvent {
    const onThresh = this.noiseFloor * this.p.triggerMult;

    if (!this.speaking) {
      if (rms >= onThresh) {
        this.speechRun++;
        if (this.speechRun >= this.p.startFrames) {
          this.speaking = true;
          this.silenceRun = 0;
          this.uttFrames = this.speechRun; // trigger frames count toward the utterance
          this.speechRun = 0;
          return { type: 'start' };
        }
      } else {
        this.speechRun = 0;
        // Track ambient noise only on genuinely-quiet frames so speech
        // doesn't inflate the floor.
        this.noiseFloor = Math.max(
          this.p.absoluteFloor,
          this.noiseFloor + this.p.floorAttack * (rms - this.noiseFloor),
        );
      }
      return { type: 'none' };
    }

    // speaking
    this.uttFrames++;
    const offThresh = this.noiseFloor * this.p.releaseMult;
    if (rms < offThresh) {
      this.silenceRun++;
      if (this.silenceRun >= this.p.hangoverFrames) {
        const drop = this.silenceRun;
        this.resetUtterance();
        return { type: 'end', dropTrailingFrames: drop };
      }
    } else {
      this.silenceRun = 0;
    }
    if (this.uttFrames >= this.p.maxUtteranceFrames) {
      this.resetUtterance();
      return { type: 'end', dropTrailingFrames: 0 };
    }
    return { type: 'none' };
  }

  private resetUtterance(): void {
    this.speaking = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.uttFrames = 0;
  }
}

/** RMS of a PCM frame. */
export function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Concatenate frames into one buffer. */
export function mergeFrames(frames: Float32Array[]): Float32Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}

const SCRIPT_BUFFER = 4096;
// Keep enough pre-trigger frames to recover the start-detection frames (so
// the leading audio that confirmed speech isn't clipped) plus a little onset.
const PREROLL_FRAMES = 3;

export async function startEnergyVadCapture(
  callbacks: EnergyVadCallbacks,
  params: Partial<VadParams> = {},
): Promise<EnergyVadCapture> {
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
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* best effort */ }
  }

  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 1);
  const seg = new EnergyVadSegmenter(params);

  let preroll: Float32Array[] = [];
  let collecting: Float32Array[] | null = null;

  node.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    const frame = new Float32Array(input.length);
    frame.set(input);
    const ev = seg.push(frameRms(frame));

    if (ev.type === 'start') {
      collecting = [...preroll, frame];
      preroll = [];
      callbacks.onSpeechStart?.();
    } else if (collecting) {
      collecting.push(frame);
      if (ev.type === 'end') {
        const frames = collecting;
        collecting = null;
        callbacks.onSpeechEnd?.();
        const kept = ev.dropTrailingFrames > 0
          ? frames.slice(0, Math.max(1, frames.length - ev.dropTrailingFrames))
          : frames;
        const pcm16k = resampleLinearTo16k(mergeFrames(kept), sampleRate);
        // WALL-CLOCK SPAN OF THE KEPT AUDIO (WI-954890). `end` fires only after
        // hangoverFrames of silence, so "now" is already ~683ms past the audio
        // — and the dropped trailing frames are exactly that silence. Walk back
        // over them, plus one frame for the buffer we are being handed now, to
        // land on the instant the kept audio ended; the kept frame count gives
        // the duration. Rounding lands EARLY on purpose: a window shifted late
        // is what loses an overlap, a window shifted early only over-guards.
        const frameMs = (frame.length / sampleRate) * 1000;
        const endedAtMs = Date.now() - (ev.dropTrailingFrames + 1) * frameMs;
        const capture = captureWindowEndingAt(endedAtMs, kept.length * frameMs);
        try { callbacks.onUtterance(pcm16k, capture); } catch { /* caller's problem */ }
      }
    } else {
      // idle, not collecting — maintain the preroll ring
      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
    }
  };

  src.connect(node);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { node.onaudioprocess = null; } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      try { mute.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { void ctx.close(); } catch { /* ignore */ }
    },
  };
}
