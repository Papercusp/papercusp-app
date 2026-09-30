/**
 * Desktop voice-channel runtime (holepunch-voice-channels-2026-06-05 P-015,
 * D-014 item 2 — the live-audio half).
 *
 * Wires the channel client (`desktop-voice-channel-client`) to real browser
 * audio:
 *   • capture — getUserMedia → AudioWorklet (ScriptProcessor fallback) →
 *     48 kHz PCM16 LE MIC frames, sent only while in a channel and not muted;
 *   • playback — MIX frames → gapless scheduled Web-Audio buffers (the same
 *     pattern as `operator-voice-runtime`, at the 48 kHz channel rate);
 *   • a mic-level meter (throttled RMS) for the UI (pui parity).
 *
 * One SINGLETON per page: audio I/O is inherently single (one mic, one
 * playout), and the panel mounts in more than one place (left-sidebar Voice
 * tab + the workbench voice pane) — both subscribe to this one runtime, so two
 * mounts never double-capture or double-play. Pinned on globalThis so dev HMR
 * re-imports don't re-open a second mic.
 *
 * The transport (client) and conversion math (channel-audio) are unit-tested;
 * THIS module is the AudioContext/getUserMedia glue around them — its
 * live-audio behaviour is the supervised desktop verify (live Tauri + mic),
 * per D-014. Kept thin + declarative so that pass is the only thing it gates.
 */
import type { VoiceSessionStatus } from '../video/desktop-video-client';
import {
  connectDesktopVoiceChannel,
  type DesktopVoiceChannelSession,
  type VoiceChannelRow,
} from './desktop-voice-channel-client';
import { captureChunkToChannelBytes, pcm16leToFloat32, rmsLevel, CHANNEL_SAMPLE_RATE } from './channel-audio';
import { resolveDesktopVoiceWsUrl } from './resolve-voice-ws-url';

export interface VoiceChannelState {
  /** WS to the operator's voice bridge is open. */
  connected: boolean;
  /** Last operator status push (channel / muted / peers / agentSpeaking). */
  status: VoiceSessionStatus | null;
  channels: VoiceChannelRow[];
  /** Mic RMS 0..1, throttled to ~10 Hz; 0 while capture is off. */
  micLevel: number;
  /** getUserMedia failed → receive-only (still hears the channel). */
  micError: string | null;
  lastError: string | null;
}

export interface VoiceChannelRuntime {
  state(): VoiceChannelState;
  subscribe(cb: (s: VoiceChannelState) => void): () => void;
  /** Connect the WS (idempotent). Resolves once the connect attempt is made. */
  ensureStarted(): Promise<void>;
  join(channelIdOrName: string): void;
  leave(): void;
  setMuted(muted: boolean): void;
  refreshChannels(): void;
  createChannel(name: string): void;
  /** Tear down the WS + mic + playback. */
  stop(): Promise<void>;
}

const METER_INTERVAL_MS = 100;

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!ctor) throw new Error('Web Audio not supported');
  return ctor;
}

/** Inline AudioWorklet module: batches capture floats to the main thread. */
const CAPTURE_WORKLET_SRC = `
class PcChannelCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.buf.push(ch.slice(0));
      this.len += ch.length;
      if (this.len >= 2048) {
        const out = new Float32Array(this.len);
        let off = 0;
        for (const b of this.buf) { out.set(b, off); off += b.length; }
        this.buf = []; this.len = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('pc-channel-capture', PcChannelCapture);
`;

function createRuntime(): VoiceChannelRuntime {
  let session: DesktopVoiceChannelSession | null = null;
  let starting: Promise<void> | null = null;

  const state: VoiceChannelState = {
    connected: false,
    status: null,
    channels: [],
    micLevel: 0,
    micError: null,
    lastError: null,
  };
  const subs = new Set<(s: VoiceChannelState) => void>();
  function notify(): void {
    for (const cb of subs) cb({ ...state });
  }

  // ── playback: gapless scheduled 48 kHz PCM ─────────────────────────────────
  let playCtx: AudioContext | null = null;
  let nextStartAt = 0;
  function playMix(pcm16le: Uint8Array): void {
    if (!playCtx) {
      try {
        playCtx = new (audioContextCtor())();
      } catch (e) {
        state.lastError = e instanceof Error ? e.message : String(e);
        notify();
        return;
      }
    }
    const f32 = pcm16leToFloat32(pcm16le);
    if (f32.length === 0) return;
    const buf = playCtx.createBuffer(1, f32.length, CHANNEL_SAMPLE_RATE);
    buf.getChannelData(0).set(f32);
    const node = playCtx.createBufferSource();
    node.buffer = buf;
    node.connect(playCtx.destination);
    // 60 ms cushion when we fall behind, so a hiccup doesn't cascade clicks.
    const startAt = nextStartAt > playCtx.currentTime ? nextStartAt : playCtx.currentTime + 0.06;
    node.start(startAt);
    nextStartAt = startAt + buf.duration;
  }

  // ── capture: getUserMedia → worklet/ScriptProcessor → MIC frames ──────────
  let micStream: MediaStream | null = null;
  let micCtx: AudioContext | null = null;
  let micCleanup: (() => void) | null = null;
  let lastMeterAt = 0;

  function onCaptureChunk(chunk: Float32Array, srcRate: number): void {
    const now = Date.now();
    if (now - lastMeterAt >= METER_INTERVAL_MS) {
      lastMeterAt = now;
      state.micLevel = rmsLevel(chunk);
      notify();
    }
    const inChannel = state.status?.channel != null;
    const muted = state.status?.muted === true;
    if (!session || !inChannel || muted) return;
    session.sendMic(captureChunkToChannelBytes(chunk, 1, srcRate));
  }

  async function startCapture(): Promise<void> {
    if (micStream) return;
    try {
      // The browser's own AEC/NS run at capture; the operator-side DSP
      // (P-010) covers raw-capture clients like the pui.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      micCtx = new (audioContextCtor())();
      const source = micCtx.createMediaStreamSource(micStream);
      const rate = micCtx.sampleRate;
      try {
        // Preferred: AudioWorklet (D-014) via an inline blob module.
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SRC], { type: 'application/javascript' }));
        await micCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const worklet = new AudioWorkletNode(micCtx, 'pc-channel-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => onCaptureChunk(ev.data, rate);
        source.connect(worklet);
        micCleanup = () => {
          worklet.port.onmessage = null;
          try {
            source.disconnect();
            worklet.disconnect();
          } catch {
            /* gone */
          }
        };
      } catch {
        // Fallback: ScriptProcessor (deprecated but dependable in WebKitGTK).
        const node = micCtx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (ev: AudioProcessingEvent) =>
          onCaptureChunk(new Float32Array(ev.inputBuffer.getChannelData(0)), rate);
        source.connect(node);
        node.connect(micCtx.destination); // some engines only run the processor when connected
        micCleanup = () => {
          node.onaudioprocess = null;
          try {
            source.disconnect();
            node.disconnect();
          } catch {
            /* gone */
          }
        };
      }
      state.micError = null;
      notify();
    } catch (e) {
      // Non-fatal: receive-only (the channel still plays back).
      state.micError = e instanceof Error ? e.message : 'microphone unavailable';
      notify();
    }
  }

  function stopCapture(): void {
    micCleanup?.();
    micCleanup = null;
    try {
      micStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* gone */
    }
    micStream = null;
    void micCtx?.close().catch(() => {});
    micCtx = null;
    state.micLevel = 0;
    notify();
  }

  // ── session lifecycle ───────────────────────────────────────────────────────
  async function ensureStarted(): Promise<void> {
    if (session?.isOpen()) return;
    if (starting) return starting;
    starting = (async () => {
      const url = await resolveDesktopVoiceWsUrl();
      session = connectDesktopVoiceChannel({
        url,
        onOpen: () => {
          state.connected = true;
          notify();
        },
        onClose: () => {
          state.connected = false;
          stopCapture();
          notify();
        },
        onStatus: (s) => {
          const wasIn = state.status?.channel != null;
          state.status = s;
          const nowIn = s.channel != null;
          if (nowIn && !wasIn) void startCapture();
          if (!nowIn && wasIn) stopCapture();
          notify();
        },
        onChannels: (rows) => {
          state.channels = rows;
          notify();
        },
        onMix: playMix,
        onError: (e) => {
          state.lastError = e instanceof Error ? e.message : String(e);
          notify();
        },
      });
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  return {
    state: () => ({ ...state }),
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    ensureStarted,
    join(ch) {
      void ensureStarted().then(() => session?.join(ch));
    },
    leave() {
      session?.leave();
    },
    setMuted(muted) {
      session?.setMuted(muted);
    },
    refreshChannels() {
      void ensureStarted().then(() => session?.refreshChannels());
    },
    createChannel(name) {
      void ensureStarted().then(() => session?.createChannel(name));
    },
    async stop() {
      stopCapture();
      try {
        session?.close();
      } catch {
        /* already closed */
      }
      session = null;
      state.connected = false;
      state.status = null;
      nextStartAt = 0;
      try {
        await playCtx?.close();
      } catch {
        /* gone */
      }
      playCtx = null;
      notify();
    },
  };
}

type RuntimeGlobals = typeof globalThis & { __papercuspVoiceChannelRuntime?: VoiceChannelRuntime };

/** The page-singleton runtime (HMR-safe). */
export function getVoiceChannelRuntime(): VoiceChannelRuntime {
  const g = globalThis as RuntimeGlobals;
  g.__papercuspVoiceChannelRuntime ??= createRuntime();
  return g.__papercuspVoiceChannelRuntime;
}
