/**
 * Voice agent peer (holepunch-voice-channels-2026-06-05 P-011/P-012, D-007).
 *
 * The agent is NOT an SFU bot — it's this local node listening and speaking:
 *   LISTEN: per-peer decoded frames → energy-gated utterance segmentation →
 *           Whisper STT (the same voicemode endpoint the D-006 proxy routes
 *           use) → transcript events for any consumer.
 *   SPEAK:  voiceAgentSay(text) → synthesize() (the shipped TTS dispatch,
 *           P-012 reuse) → WAV decode → 48k PCM frames → pushMicFrame into the
 *           channel — the agent speaks on this node's track.
 *
 * The converse-brain hookup (transcript → operator-converse turn → say) is the
 * explicit remaining P-011 slice — the converse SSE surface is under active
 * rework (voice-mode production readiness) and is integrated once it settles.
 * Transcript consumers subscribe via onTranscript() meanwhile.
 */
import { energy } from '@papercusp/p2p-voice';
import { loadVoicePrefs } from '../voice-prefs';
import { synthesize } from '../endpoint-route/routes/agent-mcp/operator-tts';
import { fetchWhisperWithRecovery, warmLocalWhisper } from './local-whisper-service';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './codec';
import { onPeerFrame, pushMicFrame, voiceStatus } from './manager';
import { decodeWavPcm16, encodeWavPcm16, resamplePcm16 } from './wav';

export interface VoiceTranscript {
  peerId: string;
  text: string;
  /** Utterance length in seconds (48k). */
  seconds: number;
  at: number;
}

// Segmentation knobs (frames are 20ms):
const SPEECH_THRESHOLD = 0.01; // matches the core's speaking detector
const MIN_SPEECH_FRAMES = 5; //  ≥100ms of speech to open an utterance
const END_SILENCE_FRAMES = 30; // 600ms of silence closes it
const MAX_UTTERANCE_FRAMES = 750; // 15s hard cap

interface PeerSeg {
  frames: Int16Array[];
  speechFrames: number;
  silenceRun: number;
  open: boolean;
}

let enabled = false;
let unsub: (() => void) | null = null;
const segs = new Map<string, PeerSeg>();
const transcriptCbs = new Set<(t: VoiceTranscript) => void>();
let inflightStt = 0;

// Half-duplex echo gate (WI-4501, owner report "it keeps saying omid"): while THIS node's
// agent is speaking, inbound peer frames are overwhelmingly the agent's OWN TTS bleeding
// from a listener's speakers back into their mic — the webview's echoCancellation has no
// reference for natively-played audio (Linux Chromium especially), so it cancels nothing.
// whisper-base then transcribes the bleed (hallucinating names on noisy fragments) and the
// brain replies to itself in a loop. agentSpeaking was TRACKED (manager P-011) and displayed
// but gated nothing — this is the missing consumer. Speech heard during playback plus a
// short tail (speaker/jitter/segmenter latency) is dropped and open segments discarded.
// Deliberate cost: no barge-in — interrupting the agent mid-sentence goes unheard until an
// AEC-grade reference signal exists.
const ECHO_TAIL_MS = 750;
let echoGuardUntil = 0;

export function onTranscript(cb: (t: VoiceTranscript) => void): () => void {
  transcriptCbs.add(cb);
  return () => transcriptCbs.delete(cb);
}

export function voiceAgentEnabled(): boolean {
  return enabled;
}

export function enableVoiceAgent(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    // Bring a whisper endpoint up NOW, so the first utterance doesn't pay for it (and the STT
    // path itself never probes). Fire-and-forget: a failure just leaves the external-URL
    // fallback in place, which surfaces the usual "whisper unreachable" error.
    void warmLocalWhisper().catch(() => {});
    unsub = onPeerFrame(handleFrame);
  } else {
    unsub?.();
    unsub = null;
    segs.clear();
  }
}

function handleFrame(peerId: string, frame: Int16Array): void {
  if (voiceStatus().agentSpeaking) {
    echoGuardUntil = Date.now() + ECHO_TAIL_MS;
    if (segs.size > 0) segs.clear(); // a segment opened by our own voice must never reach STT
    return;
  }
  if (Date.now() < echoGuardUntil) return;
  let seg = segs.get(peerId);
  if (!seg) {
    seg = { frames: [], speechFrames: 0, silenceRun: 0, open: false };
    segs.set(peerId, seg);
  }
  const loud = energy(frame) >= SPEECH_THRESHOLD;
  if (!seg.open) {
    if (loud) {
      seg.frames.push(frame);
      seg.speechFrames++;
      if (seg.speechFrames >= MIN_SPEECH_FRAMES) seg.open = true;
    } else {
      // brief noise that never opened an utterance — reset
      seg.frames.length = 0;
      seg.speechFrames = 0;
    }
    return;
  }
  seg.frames.push(frame);
  seg.silenceRun = loud ? 0 : seg.silenceRun + 1;
  if (seg.silenceRun >= END_SILENCE_FRAMES || seg.frames.length >= MAX_UTTERANCE_FRAMES) {
    const frames = seg.frames.splice(0);
    segs.delete(peerId);
    void finishUtterance(peerId, frames);
  }
}

async function finishUtterance(peerId: string, frames: Int16Array[]): Promise<void> {
  if (inflightStt >= 2) return; // backpressure: drop rather than queue unbounded
  inflightStt++;
  try {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const f of frames) {
      pcm.set(f, off);
      off += f.length;
    }
    const text = await transcribePcm48k(pcm);
    if (!text) return;
    const t: VoiceTranscript = { peerId, text, seconds: total / VOICE_SAMPLE_RATE, at: Date.now() };
    for (const cb of transcriptCbs) cb(t);
  } catch (err) {
    console.error('[voice-agent] stt failed:', err instanceof Error ? err.message : err);
  } finally {
    inflightStt--;
  }
}

/** Whisper via the same voicemode endpoint the D-006 routes proxy (P-012); falls back to the
 *  operator-managed provisioned whisper-server when no external one answers (P-009 hop 3). */
export async function transcribePcm48k(pcm: Int16Array): Promise<string> {
  const wav = encodeWavPcm16(resamplePcm16(pcm, VOICE_SAMPLE_RATE, 16_000), 16_000);
  const r = await fetchWhisperWithRecovery(
    (sttBase) => {
      // Build a fresh FormData for each attempt. Undici may consume a multipart body while the
      // first request is in flight; reusing it would make the recovery retry send an empty body.
      const form = new FormData();
      form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model', 'whisper-1');
      return fetch(`${sttBase}/v1/audio/transcriptions`, { method: 'POST', body: form });
    },
  );
  if (!r.ok) throw new Error(`whisper ${r.status}`);
  const body = (await r.json()) as { text?: string };
  return (body.text ?? '').trim();
}

/**
 * Speak into the active channel as this node (D-007): TTS via the shipped
 * synthesize() dispatch → WAV → 48k PCM → 20ms frames → pushMicFrame.
 * Returns the number of frames spoken (0 = not in a channel / TTS off).
 */
export async function voiceAgentSay(text: string): Promise<number> {
  if (!voiceStatus().channel) return 0;
  const prefs = await loadVoicePrefs();
  const engine = prefs.ttsEngine === 'browser' ? 'kokoro' : prefs.ttsEngine;
  // Ask for a WAV container so the single decodeWavPcm16 path below handles
  // every server engine — synthesize wraps ElevenLabs' raw PCM into WAV and
  // requests WAV from OpenAI/Cartesia; kokoro is WAV natively. mp3-only
  // engines (none today) would still trip the guard below.
  const synth = await synthesize(engine, text, undefined, prefs, { container: 'wav' });
  if (!synth.ok || !synth.audio) return 0;
  if (!(synth.contentType ?? '').includes('wav')) {
    console.error(`[voice-agent] unsupported TTS content-type ${synth.contentType} for engine ${engine} — channel say-path needs WAV/PCM`);
    return 0;
  }
  const decoded = decodeWavPcm16(new Uint8Array(synth.audio));
  const pcm = resamplePcm16(decoded.samples, decoded.sampleRate, VOICE_SAMPLE_RATE);
  let frames = 0;
  for (let off = 0; off + VOICE_FRAME_SAMPLES <= pcm.length; off += VOICE_FRAME_SAMPLES) {
    pushMicFrame(pcm.subarray(off, off + VOICE_FRAME_SAMPLES) as Int16Array);
    frames++;
    // pace at real time so peers' jitter buffers don't drop the burst
    await new Promise((r) => setTimeout(r, 18));
  }
  return frames;
}
