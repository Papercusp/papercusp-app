/**
 * Operator-voice session bus — the typed message schema for ONE shared
 * ElevenLabs/operator voice session that desktop + tui both attach to as full
 * clients (plan universal-voice-interface-2026-06-05, P-001).
 *
 * Layered over the existing voice-node `[4B len BE][1B type][payload]` framing
 * (`@papercusp/p2p-voice`'s `encodeFrame`/`FrameDecoder`) and carried on the
 * SAME local-audio-socket + desktop-voice-ws byte-pipe (D-004). We do NOT touch
 * the generic `framing.ts` — these are just type bytes passed to `encodeFrame`,
 * so the domain-free framing lib stays domain-free and we don't contend with the
 * concurrently-edited video path.
 *
 * Frame-type byte allocation (agreed with the holepunch-video agent, D-006):
 *   0x01 CTRL / 0x02 MIC / 0x03 MIX — existing P2P voice-node
 *   0x04 VIDEO                       — holepunch-video
 *   0x05–0x0F                        — reserved for video/P2P growth
 *   0x10–0x1F                        — operator-voice session (THIS module)
 *
 * Direction:
 *   client → host (inbound):  HELLO, MIC, CONTROL
 *   host → clients (outbound): INPUT_TRANSCRIPT, RESPONSE_AUDIO,
 *                              RESPONSE_TRANSCRIPT, RESPONSE_TAG, SESSION_STATE
 *
 * The host (the voice service) owns the single EL WebSocket; every attached
 * client receives the full input + response stream and may drive controls, but
 * only the lease-elected player renders RESPONSE_AUDIO (Model A, D-001).
 */
import { encodeFrame, type VoiceFrame } from '@papercusp/p2p-voice';

// ── Frame type bytes (0x10–0x1F block) ────────────────────────────────────
// inbound (client → host)
export const OPV_HELLO = 0x10;
export const OPV_MIC = 0x11;
export const OPV_CONTROL = 0x12;
// outbound (host → clients)
export const OPV_INPUT_TRANSCRIPT = 0x13;
export const OPV_RESPONSE_AUDIO = 0x14;
export const OPV_RESPONSE_TRANSCRIPT = 0x15;
export const OPV_RESPONSE_TAG = 0x16;
export const OPV_SESSION_STATE = 0x17;

export const OPV_TYPE_MIN = 0x10;
export const OPV_TYPE_MAX = 0x1f;

/** True for a type byte in the operator-voice block — lets the socket route. */
export function isOpVoiceFrameType(t: number): boolean {
  return t >= OPV_TYPE_MIN && t <= OPV_TYPE_MAX;
}

// ── Message types ─────────────────────────────────────────────────────────

export type VoiceClientKind = 'desktop' | 'tui' | 'mobile';

/** A client attaching to the session — `clientId` is its voice-lease owner id. */
export interface HelloMsg {
  kind: 'hello';
  clientId: string;
  clientKind: VoiceClientKind;
  label?: string;
}

/** One mic chunk from a client — raw PCM16 LE mono @16 kHz (EL input format). */
export interface MicMsg {
  kind: 'mic';
  pcm16le: Uint8Array;
}

/**
 * A control the host applies ONCE to the single session, then broadcasts the
 * effect as SESSION_STATE. `force-host` takes over hosting/playout (force lease).
 */
export type VoiceControlOp =
  | { op: 'mute'; muted: boolean }
  | { op: 'ptt'; down: boolean }
  | { op: 'start' }
  | { op: 'stop' }
  | { op: 'set-mode'; mode: string }
  | { op: 'force-host' };

export interface ControlMsg {
  kind: 'control';
  control: VoiceControlOp;
}

/** EL's STT of what the user said. `final` distinguishes partial vs settled. */
export interface InputTranscriptMsg {
  kind: 'input_transcript';
  text: string;
  final: boolean;
}

export type ResponseAudioFormat = 'pcm_s16le' | 'encoded';

/** One chunk of agent response audio. `sampleRate` is meaningful for pcm. */
export interface ResponseAudioMsg {
  kind: 'response_audio';
  format: ResponseAudioFormat;
  sampleRate: number;
  audio: Uint8Array;
}

/** The agent's spoken utterance text (raw — may carry tags; clients strip). */
export interface ResponseTranscriptMsg {
  kind: 'response_transcript';
  text: string;
}

/** A control tag extracted from an agent utterance (e.g. `set_mode`). */
export interface ResponseTagMsg {
  kind: 'response_tag';
  tag: string;
  value: string;
}

export type VoiceSessionStatus =
  | 'off'
  | 'connecting'
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'ended'
  | 'error';

/**
 * Full session snapshot broadcast to every client. `playerId` is the
 * lease-elected client that renders audio + captures mic (Model A); a client
 * compares it to its own `clientId` to decide whether to play / capture.
 */
export interface SessionStateMsg {
  kind: 'session_state';
  status: VoiceSessionStatus;
  muted: boolean;
  mode: string;
  playerId: string | null;
  conversationId: string | null;
  audioFormat?: ResponseAudioFormat;
  sampleRate?: number;
  reason?: string;
}

export type OpVoiceMessage =
  | HelloMsg
  | MicMsg
  | ControlMsg
  | InputTranscriptMsg
  | ResponseAudioMsg
  | ResponseTranscriptMsg
  | ResponseTagMsg
  | SessionStateMsg;

// ── Encoders (return a full framed buffer ready for the socket) ───────────

const te = new TextEncoder();
const td = new TextDecoder();

function json(type: number, msg: unknown): Uint8Array {
  return encodeFrame(type, te.encode(JSON.stringify(msg)));
}

export function encodeHello(m: Omit<HelloMsg, 'kind'>): Uint8Array {
  return json(OPV_HELLO, { clientId: m.clientId, clientKind: m.clientKind, label: m.label });
}

export function encodeMic(pcm16le: Uint8Array): Uint8Array {
  return encodeFrame(OPV_MIC, pcm16le);
}

export function encodeControl(control: VoiceControlOp): Uint8Array {
  return json(OPV_CONTROL, control);
}

export function encodeInputTranscript(m: Omit<InputTranscriptMsg, 'kind'>): Uint8Array {
  return json(OPV_INPUT_TRANSCRIPT, { text: m.text, final: m.final });
}

const AUDIO_FMT_PCM = 0x00;
const AUDIO_FMT_ENCODED = 0x01;

export function encodeResponseAudio(m: Omit<ResponseAudioMsg, 'kind'>): Uint8Array {
  const payload = new Uint8Array(5 + m.audio.length);
  payload[0] = m.format === 'encoded' ? AUDIO_FMT_ENCODED : AUDIO_FMT_PCM;
  new DataView(payload.buffer).setUint32(1, m.sampleRate >>> 0, false);
  payload.set(m.audio, 5);
  return encodeFrame(OPV_RESPONSE_AUDIO, payload);
}

export function encodeResponseTranscript(m: Omit<ResponseTranscriptMsg, 'kind'>): Uint8Array {
  return json(OPV_RESPONSE_TRANSCRIPT, { text: m.text });
}

export function encodeResponseTag(m: Omit<ResponseTagMsg, 'kind'>): Uint8Array {
  return json(OPV_RESPONSE_TAG, { tag: m.tag, value: m.value });
}

export function encodeSessionState(m: Omit<SessionStateMsg, 'kind'>): Uint8Array {
  return json(OPV_SESSION_STATE, m);
}

// ── Decoder ───────────────────────────────────────────────────────────────

function parseJson(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(td.decode(payload));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const b = (v: unknown): boolean => v === true;
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function decodeControl(o: Record<string, unknown>): VoiceControlOp | null {
  switch (o.op) {
    case 'mute':
      return { op: 'mute', muted: b(o.muted) };
    case 'ptt':
      return { op: 'ptt', down: b(o.down) };
    case 'start':
      return { op: 'start' };
    case 'stop':
      return { op: 'stop' };
    case 'set-mode':
      return { op: 'set-mode', mode: s(o.mode) };
    case 'force-host':
      return { op: 'force-host' };
    default:
      return null;
  }
}

/**
 * Decode one decoded `VoiceFrame` (from the shared `FrameDecoder`) into a typed
 * operator-voice message. Returns null for non-opvoice types or malformed
 * payloads — tolerant by design so a peer's protocol addition never wedges us.
 */
export function decodeOpVoiceFrame(frame: VoiceFrame): OpVoiceMessage | null {
  switch (frame.type) {
    case OPV_HELLO: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      const clientKind = o.clientKind;
      if (clientKind !== 'desktop' && clientKind !== 'tui' && clientKind !== 'mobile') return null;
      return { kind: 'hello', clientId: s(o.clientId), clientKind, label: o.label ? s(o.label) : undefined };
    }
    case OPV_MIC:
      // Raw PCM bytes — copy out of the decoder's shared buffer subarray so the
      // caller owns a stable view.
      return { kind: 'mic', pcm16le: frame.payload.slice() };
    case OPV_CONTROL: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      const control = decodeControl(o);
      return control ? { kind: 'control', control } : null;
    }
    case OPV_INPUT_TRANSCRIPT: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      return { kind: 'input_transcript', text: s(o.text), final: b(o.final) };
    }
    case OPV_RESPONSE_AUDIO: {
      if (frame.payload.length < 5) return null;
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      return {
        kind: 'response_audio',
        format: frame.payload[0] === AUDIO_FMT_ENCODED ? 'encoded' : 'pcm_s16le',
        sampleRate: view.getUint32(1, false),
        audio: frame.payload.subarray(5).slice(),
      };
    }
    case OPV_RESPONSE_TRANSCRIPT: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      return { kind: 'response_transcript', text: s(o.text) };
    }
    case OPV_RESPONSE_TAG: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      return { kind: 'response_tag', tag: s(o.tag), value: s(o.value) };
    }
    case OPV_SESSION_STATE: {
      const o = parseJson(frame.payload);
      if (!o) return null;
      const status = o.status;
      const known: VoiceSessionStatus[] = ['off', 'connecting', 'idle', 'listening', 'speaking', 'ended', 'error'];
      return {
        kind: 'session_state',
        status: (known as unknown[]).includes(status) ? (status as VoiceSessionStatus) : 'idle',
        muted: b(o.muted),
        mode: s(o.mode),
        playerId: o.playerId == null ? null : s(o.playerId),
        conversationId: o.conversationId == null ? null : s(o.conversationId),
        audioFormat: o.audioFormat === 'encoded' || o.audioFormat === 'pcm_s16le' ? o.audioFormat : undefined,
        sampleRate: o.sampleRate == null ? undefined : n(o.sampleRate),
        reason: o.reason == null ? undefined : s(o.reason),
      };
    }
    default:
      return null;
  }
}
