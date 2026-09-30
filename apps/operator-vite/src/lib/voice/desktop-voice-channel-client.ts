/**
 * Desktop voice-channel client — plan holepunch-voice-channels-2026-06-05
 * (P-015, D-014). The CHANNEL-AUDIO sibling of `lib/video/desktop-video-client`:
 * that module carries join/status + the video path and explicitly leaves MIC/MIX
 * to this slice.
 *
 * Owns the WebSocket to the operator's desktop voice bridge (desktop-voice-ws —
 * a byte-pipe onto the local voice unix socket) and speaks the channel-audio
 * protocol over it:
 *   CTRL 0x01 up   — join / leave / mute / status / channels / create
 *   MIC  0x02 up   — raw PCM16-LE mono 48 kHz capture bytes (any chunking;
 *                    the operator reframes to exact 20 ms frames)
 *   CTRL 0x01 down — {ev:'status'} / {ev:'channels'} / {ev:'error'}
 *   MIX  0x03 down — one mixed 20 ms PCM16-LE frame (1920 bytes), 50/s in-channel
 *
 * Transport + protocol only: the WebSocket is injectable so the routing is
 * unit-tested without a live socket. The getUserMedia capture / Web-Audio
 * playback glue lives in `desktop-voice-channel-runtime` (live-audio verify).
 */
import { FrameDecoder } from '@papercusp/p2p-voice';
import type { WsLike, VoiceSessionStatus } from '../video/desktop-video-client';
import {
  CTRL,
  MIC,
  MIX,
  DEFAULT_DESKTOP_VOICE_WS_URL,
  buildCtrl,
  buildJoin,
  buildLeave,
  buildMute,
} from '../video/desktop-video-protocol';
import { encodeFrame } from '@papercusp/p2p-voice';

const WS_OPEN = 1;

/** A registry channel row (mirror of the operator's `{ev:'channels'}` payload). */
export interface VoiceChannelRow {
  id: string;
  name: string;
  topicHex?: string;
  createdAt?: string;
}

export interface DesktopVoiceChannelSession {
  /** Join a channel by id or name (the operator resolves either). */
  join(channelIdOrName: string): void;
  leave(): void;
  setMuted(muted: boolean): void;
  /** Ask the operator to re-send the channel list ({ev:'channels'}). */
  refreshChannels(): void;
  /** Create a channel; the operator replies with the updated list. */
  createChannel(name: string): void;
  /** Stream capture bytes (PCM16-LE mono 48 kHz, any chunking) while in-channel. */
  sendMic(pcm16le: Uint8Array): void;
  /** Whether the WS is currently open. */
  isOpen(): boolean;
  /** Leave + tear down the socket. */
  close(): void;
}

export interface ConnectDesktopVoiceChannelOpts {
  /** WS URL; defaults to the operator desktop voice bridge on :3076. Resolve a
   *  walked port first via `resolveDesktopVoiceWsUrl()` (runtime-config). */
  url?: string;
  /** Status pushes — channel / muted / peers (speaking) / agentSpeaking. */
  onStatus?: (status: VoiceSessionStatus) => void;
  /** Channel-registry pushes (response to refresh/create). */
  onChannels?: (channels: VoiceChannelRow[]) => void;
  /** One mixed 20 ms 48 kHz PCM16-LE frame for local playback. */
  onMix?: (pcm16le: Uint8Array) => void;
  /** Socket opened (join/refresh are safe to send). */
  onOpen?: () => void;
  /** Socket closed (operator gone / bridge torn down). */
  onClose?: () => void;
  onError?: (err: unknown) => void;
  // --- test/override seam ---
  wsFactory?: (url: string) => WsLike;
}

function toU8(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // text frames are unused on this socket
}

export function connectDesktopVoiceChannel(
  opts: ConnectDesktopVoiceChannelOpts,
): DesktopVoiceChannelSession {
  const url = opts.url ?? DEFAULT_DESKTOP_VOICE_WS_URL;
  const wsFactory = opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);

  const ws = wsFactory(url);
  ws.binaryType = 'arraybuffer';
  const decoder = new FrameDecoder();
  const td = new TextDecoder();

  function safeSend(data: Uint8Array): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(data);
    } catch (e) {
      opts.onError?.(e);
    }
  }

  ws.addEventListener('open', () => {
    // Prime both surfaces: the current status + the channel registry.
    safeSend(buildCtrl({ op: 'status' }));
    safeSend(buildCtrl({ op: 'channels' }));
    opts.onOpen?.();
  });
  ws.addEventListener('error', (e) => opts.onError?.(e));
  ws.addEventListener('close', () => opts.onClose?.());
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
      if (f.type === CTRL) {
        try {
          const msg = JSON.parse(td.decode(f.payload)) as {
            ev?: string;
            status?: VoiceSessionStatus;
            channels?: VoiceChannelRow[];
            message?: string;
          };
          if (msg.ev === 'status' && msg.status) opts.onStatus?.(msg.status);
          else if (msg.ev === 'channels' && Array.isArray(msg.channels)) opts.onChannels?.(msg.channels);
          else if (msg.ev === 'error') opts.onError?.(new Error(msg.message ?? 'voice error'));
        } catch {
          /* ignore malformed ctrl */
        }
      } else if (f.type === MIX) {
        opts.onMix?.(f.payload);
      }
      // VID (video) is the desktop-video-client's slice — ignored here.
    }
  });

  return {
    join(channelIdOrName) {
      safeSend(buildJoin(channelIdOrName));
    },
    leave() {
      safeSend(buildLeave());
    },
    setMuted(muted) {
      safeSend(buildMute(muted));
    },
    refreshChannels() {
      safeSend(buildCtrl({ op: 'channels' }));
    },
    createChannel(name) {
      safeSend(buildCtrl({ op: 'create', name }));
    },
    sendMic(pcm16le) {
      safeSend(encodeFrame(MIC, pcm16le));
    },
    isOpen: () => ws.readyState === WS_OPEN,
    close() {
      safeSend(buildLeave());
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
