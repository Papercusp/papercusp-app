/**
 * Desktop operator-voice client — universal-voice-interface-2026-06-05 (P-008).
 *
 * Attaches the Tauri webview to the ONE shared EL/operator voice session over
 * the desktop-voice-ws byte-pipe, using the operator-voice bus (0x10–0x1F
 * frames). The desktop is now a full CLIENT of the host-owned session rather
 * than starting its own ElevenLabs WebRTC session:
 *   • on open it sends HELLO (attach as a `desktop` client) + `start` (host),
 *   • it surfaces the shared input + response transcript + session state,
 *   • it can drive controls (mute/PTT/set-mode/stop/force-host),
 *   • it streams mic chunks ONLY while it is the elected player (single mic,
 *     P-007), and the caller renders RESPONSE_AUDIO ONLY while elected (single
 *     playout, Model A / P-006) — non-elected clients receive the same frames
 *     but stay display-only.
 *
 * Transport + protocol only: the WebSocket is injectable so the routing +
 * election logic is component-tested without a live socket. The live
 * getUserMedia capture (feeding `sendMic`) + Web-Audio playback (consuming
 * `onResponseAudio`) live in `operator-voice-runtime` and are the P-011 slice.
 */
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  decodeOpVoiceFrame,
  isOpVoiceFrameType,
  encodeHello,
  encodeMic,
  encodeControl,
  type ResponseAudioFormat,
  type SessionStateMsg,
  type VoiceControlOp,
} from '@papercusp/operator-core/lib/voice-node/operator-voice-bus';
import {
  DEFAULT_DESKTOP_VOICE_WS_URL,
  resolveDesktopVoiceWsUrl,
  type FetchLike,
} from './resolve-desktop-voice-ws-url';

/**
 * The operator's desktop voice bridge (desktop-voice-ws) listens on
 * DESKTOP_VOICE_WS_PORT (default 3076) with an 8-port walk on EADDRINUSE.
 * Deterministic discovery of a walked port rides the webview runtime-config
 * surface; until that lands the common default is correct (the walk only
 * triggers when 3076 is taken). Mirrors `desktop-video-protocol`'s default.
 */
export { DEFAULT_DESKTOP_VOICE_WS_URL } from './resolve-desktop-voice-ws-url';

/** Minimal WebSocket surface (satisfied by the browser WebSocket). */
export interface WsLike {
  readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', cb: (ev: { data?: unknown }) => void): void;
}

const WS_OPEN = 1;

export type DesktopVoiceState = Omit<SessionStateMsg, 'kind'>;

export interface DesktopOperatorVoiceCallbacks {
  /** EL's STT of what the user said. `final` distinguishes partial vs settled. */
  onInputTranscript?(text: string, final: boolean): void;
  /** The agent's spoken utterance (raw — may carry tags; the UI strips). */
  onResponseTranscript?(text: string): void;
  /**
   * One chunk of response audio. `elected` is whether THIS client is the
   * lease-elected player — only the elected client should render it (Model A).
   */
  onResponseAudio?(audio: Uint8Array, format: ResponseAudioFormat, sampleRate: number, elected: boolean): void;
  /** A control tag extracted from an agent utterance (e.g. set_mode). */
  onResponseTag?(tag: string, value: string): void;
  /** Full session snapshot + whether this client is now the elected player. */
  onState?(state: DesktopVoiceState, elected: boolean): void;
  onError?(err: unknown): void;
}

export interface DesktopOperatorVoiceSession {
  /** Stream one mic chunk (PCM16 LE mono @16 kHz) — no-op unless elected. */
  sendMic(pcm16le: Uint8Array): void;
  /** Apply a control to the single session (the host applies it once). */
  control(op: VoiceControlOp): void;
  /** Whether this client currently renders audio + captures the mic. */
  isElected(): boolean;
  /** The current elected player's id (any attached client), or null. */
  playerId(): string | null;
  /** Detach this surface (the host re-elects or tears down; others survive). */
  close(): void;
}

export interface ConnectDesktopOperatorVoiceOpts extends DesktopOperatorVoiceCallbacks {
  /** This client's id — its voice-lease owner id (e.g. the desktop tab id). */
  clientId: string;
  label?: string;
  /** WS URL; otherwise resolve the live bridge from /api/desktop/voice-config. */
  url?: string;
  /** Test seam for runtime-config discovery. */
  fetchImpl?: FetchLike;
  /** Test/override seam. */
  wsFactory?: (url: string) => WsLike;
}

function toU8(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function connectDesktopOperatorVoice(
  opts: ConnectDesktopOperatorVoiceOpts,
): Promise<DesktopOperatorVoiceSession> {
  return connectDesktopOperatorVoiceResolved(opts);
}

async function connectDesktopOperatorVoiceResolved(
  opts: ConnectDesktopOperatorVoiceOpts,
): Promise<DesktopOperatorVoiceSession> {
  const url = opts.url ?? (await resolveDesktopVoiceWsUrl(opts.fetchImpl));
  const wsFactory = opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);

  const ws = wsFactory(url);
  ws.binaryType = 'arraybuffer';
  const decoder = new FrameDecoder();
  let elected = false;
  let playerId: string | null = null;

  function safeSend(data: Uint8Array): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(data);
    } catch (e) {
      opts.onError?.(e);
    }
  }

  ws.addEventListener('open', () => {
    safeSend(encodeHello({ clientId: opts.clientId, clientKind: 'desktop', label: opts.label }));
    // Open/host the session (the host elects us player if it's the opener; a
    // plain start never steals an existing host — we just attach + observe).
    safeSend(encodeControl({ op: 'start' }));
  });
  ws.addEventListener('error', (e) => opts.onError?.(e));
  ws.addEventListener('message', (ev) => {
    const bytes = toU8(ev.data);
    if (!bytes) return;
    let frames;
    try {
      frames = decoder.push(bytes);
    } catch (e) {
      opts.onError?.(e);
      return;
    }
    for (const f of frames) {
      if (!isOpVoiceFrameType(f.type)) continue; // P2P-channel / status frames
      const m = decodeOpVoiceFrame(f);
      if (!m) continue;
      switch (m.kind) {
        case 'input_transcript':
          opts.onInputTranscript?.(m.text, m.final);
          break;
        case 'response_transcript':
          opts.onResponseTranscript?.(m.text);
          break;
        case 'response_audio':
          opts.onResponseAudio?.(m.audio, m.format, m.sampleRate, elected);
          break;
        case 'response_tag':
          opts.onResponseTag?.(m.tag, m.value);
          break;
        case 'session_state':
          playerId = m.playerId;
          elected = m.playerId !== null && m.playerId === opts.clientId;
          opts.onState?.(m, elected);
          break;
        default:
          break; // client→host kinds never arrive inbound
      }
    }
  });

  return {
    sendMic(pcm16le) {
      if (elected) safeSend(encodeMic(pcm16le));
    },
    control(op) {
      safeSend(encodeControl(op));
    },
    isElected: () => elected,
    playerId: () => playerId,
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
