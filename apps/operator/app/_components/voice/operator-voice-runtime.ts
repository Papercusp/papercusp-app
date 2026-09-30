/**
 * Desktop operator-voice runtime (universal-voice-interface-2026-06-05, P-008).
 *
 * Wires the bus client (`desktop-operator-voice-client`) to the live browser
 * audio: it captures the mic (getUserMedia → AudioContext → the pure DSP →
 * OPV_MIC, ONLY while elected) and plays streamed RESPONSE_AUDIO (PCM → Web
 * Audio, ONLY while elected — Model A single playout). This replaces what the
 * ElevenLabs WebRTC SDK used to do internally now that the host owns the EL
 * session and exchanges raw PCM with clients.
 *
 * The transport/election logic (`desktop-operator-voice-client`) and the
 * capture/playback math (`operator-voice-audio`) are unit-tested; THIS module is
 * the AudioContext/getUserMedia glue around them — its live-audio behaviour is
 * the P-011 verification pass (it can't be exercised without a real mic +
 * speaker). Kept thin + declarative so that pass is the only thing it gates.
 */
import {
  connectDesktopOperatorVoice,
  type DesktopOperatorVoiceSession,
  type DesktopVoiceState,
} from './desktop-operator-voice-client';
import { captureChunkToMicBytes, pcm16leToFloat32 } from './operator-voice-audio';
import type { VoiceControlOp } from '@papercusp/operator-core/lib/voice-node/operator-voice-bus';

export interface OperatorVoiceRuntimeCallbacks {
  onInputTranscript?(text: string, final: boolean): void;
  onResponseTranscript?(text: string): void;
  onResponseTag?(tag: string, value: string): void;
  onState?(state: DesktopVoiceState, elected: boolean): void;
  onError?(err: unknown): void;
}

export interface OperatorVoiceRuntime {
  /** Drive a control (mute/PTT/set-mode/stop/force-host) on the shared session. */
  control(op: VoiceControlOp): void;
  /** Whether this surface is the elected player (renders audio + captures mic). */
  isElected(): boolean;
  /**
   * Deafen is LOCAL-only (Discord-parity, discord-shortcuts 2026-06-06):
   * this surface keeps receiving transcripts/state but silences its own
   * playout. It does NOT touch the election or the host — undeafening
   * resumes playout from the next response chunk.
   */
  setDeafened(deafened: boolean): void;
  isDeafened(): boolean;
  /** Detach + release mic + audio. The host re-elects/teardowns; others survive. */
  stop(): Promise<void>;
}

export interface StartDesktopOperatorVoiceOpts extends OperatorVoiceRuntimeCallbacks {
  /** This client's id — its voice-lease owner id (the desktop tab id). */
  clientId: string;
  label?: string;
  url?: string;
}

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!ctor) throw new Error('Web Audio not supported');
  return ctor;
}

export async function startDesktopOperatorVoice(
  opts: StartDesktopOperatorVoiceOpts,
): Promise<OperatorVoiceRuntime> {
  const AC = audioContextCtor();

  // ── playout: gapless scheduled PCM (only while elected) ────────────────────
  const playCtx = new AC();
  let nextStartAt = 0;
  let deafened = false;
  // Sources currently scheduled/playing — tracked so deafen (and the
  // lose-player/barge-in reset) can cut audio NOW instead of letting the
  // queued tail drain.
  const liveNodes = new Set<AudioBufferSourceNode>();
  function scheduleNode(buf: AudioBuffer): void {
    const node = playCtx.createBufferSource();
    node.buffer = buf;
    node.connect(playCtx.destination);
    liveNodes.add(node);
    node.onended = () => liveNodes.delete(node);
    const startAt = Math.max(playCtx.currentTime, nextStartAt);
    node.start(startAt);
    nextStartAt = startAt + buf.duration;
  }
  function resetPlayout(): void {
    nextStartAt = 0;
    for (const node of liveNodes) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    liveNodes.clear();
  }
  function playPcm(bytes: Uint8Array, sampleRate: number): void {
    const f32 = pcm16leToFloat32(bytes);
    if (f32.length === 0) return;
    const buf = playCtx.createBuffer(1, f32.length, sampleRate || 16_000);
    buf.getChannelData(0).set(f32);
    scheduleNode(buf);
  }
  async function playEncoded(bytes: Uint8Array): Promise<void> {
    try {
      // copy into a fresh, exclusively-owned ArrayBuffer (decodeAudioData
      // detaches it, and the type must be ArrayBuffer not ArrayBufferLike).
      const ab = new Uint8Array(bytes).buffer as ArrayBuffer;
      const buf = await playCtx.decodeAudioData(ab);
      scheduleNode(buf);
    } catch (e) {
      opts.onError?.(e);
    }
  }

  // ── the session bus client ─────────────────────────────────────────────────
  // The client owns port discovery now, so every caller gets walked-port
  // resolution unless it pins an explicit URL.
  const session: DesktopOperatorVoiceSession = await connectDesktopOperatorVoice({
    clientId: opts.clientId,
    label: opts.label,
    url: opts.url,
    onInputTranscript: opts.onInputTranscript,
    onResponseTranscript: opts.onResponseTranscript,
    onResponseTag: opts.onResponseTag,
    onResponseAudio: (audio, format, sampleRate, elected) => {
      if (!elected) return; // single playout (Model A) — non-elected = display only
      if (deafened) return; // local deafen — display only until undeafened
      if (format === 'encoded') void playEncoded(audio);
      else playPcm(audio, sampleRate);
    },
    onState: (state, elected) => {
      // Drop any queued playout when we lose the player role, or on barge-in
      // (the host flips status to 'listening' when the user speaks).
      if (!elected || state.status === 'listening') resetPlayout();
      opts.onState?.(state, elected);
    },
    onError: opts.onError,
  });

  // ── mic capture: getUserMedia → DSP → OPV_MIC (only while elected, P-007) ───
  let micStream: MediaStream | null = null;
  let micCtx: AudioContext | null = null;
  let micNode: ScriptProcessorNode | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    micCtx = new AC();
    micSource = micCtx.createMediaStreamSource(micStream);
    // ScriptProcessor is deprecated in favour of AudioWorklet; it's used here
    // because it needs no separate worklet module and is reliable in the Tauri
    // webview. Swapping to an AudioWorklet is a P-011-era refinement.
    micNode = micCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = (ev: AudioProcessingEvent) => {
      // Only the elected player opens the wire (single mic capture); the host
      // also drops non-player mic, but gating here avoids sending at all.
      if (!session.isElected()) return;
      const ch0 = ev.inputBuffer.getChannelData(0);
      // copy out of the reused callback buffer before the DSP touches it
      const bytes = captureChunkToMicBytes(new Float32Array(ch0), 1, micCtx!.sampleRate);
      session.sendMic(bytes);
    };
    micSource.connect(micNode);
    micNode.connect(micCtx.destination); // some engines only run the processor when connected
  } catch (e) {
    // Non-fatal: we can still receive + display the shared session, just not
    // talk from this surface.
    opts.onError?.(e);
  }

  return {
    control: (op) => session.control(op),
    isElected: () => session.isElected(),
    setDeafened: (d: boolean) => {
      deafened = d;
      // Drop anything already scheduled so deafen takes effect immediately
      // rather than after the queued chunks drain.
      if (d) resetPlayout();
    },
    isDeafened: () => deafened,
    async stop() {
      try {
        session.close();
      } catch {
        /* already closed */
      }
      try {
        micSource?.disconnect();
        micNode?.disconnect();
      } catch {
        /* gone */
      }
      try {
        micStream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* gone */
      }
      try {
        await micCtx?.close();
      } catch {
        /* gone */
      }
      try {
        await playCtx.close();
      } catch {
        /* gone */
      }
    },
  };
}
