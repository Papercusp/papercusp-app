/**
 * Desktop video client — plan holepunch-video-shared-harnesses-2026-06-05 (P-005).
 *
 * Owns the WebSocket to the operator's desktop voice bridge and the per-peer
 * video demux. Transport only: the component (P-006) owns getUserMedia + the
 * WebCodecs encoder (feeding `sendCamFrame`) and the canvas tiles (rendering the
 * `onPeerFrame` VideoFrames). Audio I/O (mic/mix AudioWorklet) is the separate
 * holepunch-voice P-015 desktop slice; this client carries join/leave + the
 * status stream (peers/speaking/cameraOn — what the grid + active-speaker
 * highlight need) + the video path.
 *
 * The WebSocket + decoder factory are injectable so the message routing is
 * unit-tested without a live socket or WebCodecs; the live camera→tile path is
 * the P-010 hardware verify.
 */
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  CTRL,
  MIX,
  VID,
  DEFAULT_DESKTOP_VOICE_WS_URL,
  buildCamFrame,
  buildCamera,
  buildJoinVideo,
  buildLeave,
  buildMute,
  buildVideoRecv,
} from './desktop-video-protocol';
import { VideoDemux } from './video-demux';
import { createPeerDecoder, type EncodedVideoFrame, type PeerDecoder, type VideoFrameLike } from './video-codec';

/** Minimal WebSocket surface (satisfied by the browser WebSocket). */
export interface WsLike {
  readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', cb: (ev: { data?: unknown }) => void): void;
}

const WS_OPEN = 1;

export interface VoicePeerStatus {
  id: string;
  label: string;
  muted: boolean;
  speaking: boolean;
  cameraOn: boolean;
}
export interface VoiceSessionStatus {
  channel: { id: string; name?: string } | null;
  muted: boolean;
  peers: VoicePeerStatus[];
  identity?: { id: string; label: string };
  agentSpeaking?: boolean;
}

export interface DesktopVideoSession {
  /** Send one locally-encoded video frame to peers (camera or screen). */
  sendCamFrame(frame: EncodedVideoFrame): void;
  /** Announce local camera on/off to peers. */
  setCameraOn(on: boolean): void;
  setMuted(muted: boolean): void;
  /** Peers we are currently decoding video for. */
  videoPeers(): string[];
  /** Leave the channel + tear down the socket and all decoders. */
  close(): void;
}

export interface ConnectDesktopVideoOpts {
  /** WS URL; defaults to the operator desktop voice bridge on :3076. */
  url?: string;
  /** Shared-harness slug → the deterministic per-harness video channel (D-003). */
  harness: string;
  /** Status pushes (peers/speaking/cameraOn/muted). */
  onStatus?: (status: VoiceSessionStatus) => void;
  /** A decoded tile frame for a peer (render to that peer's canvas). */
  onPeerFrame?: (peerId: string, frame: VideoFrameLike) => void;
  onError?: (err: unknown) => void;
  // --- test/override seams ---
  wsFactory?: (url: string) => WsLike;
  decoderFactory?: (onFrame: (f: VideoFrameLike) => void) => PeerDecoder;
}

function toU8(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // text frames are unused on this socket
}

export function connectDesktopVideo(opts: ConnectDesktopVideoOpts): DesktopVideoSession {
  const url = opts.url ?? DEFAULT_DESKTOP_VOICE_WS_URL;
  const wsFactory = opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
  const decoderFactory =
    opts.decoderFactory ?? ((onFrame) => createPeerDecoder({ onFrame, onError: opts.onError }));

  const demux = new VideoDemux((peerId) => decoderFactory((f) => opts.onPeerFrame?.(peerId, f)));
  const decoder = new FrameDecoder();
  const td = new TextDecoder();

  const ws = wsFactory(url);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    safeSend(buildJoinVideo(opts.harness));
    safeSend(buildVideoRecv(true)); // opt into receiving peer video
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
      if (f.type === CTRL) {
        try {
          const msg = JSON.parse(td.decode(f.payload)) as { ev?: string; status?: VoiceSessionStatus };
          if (msg.ev === 'status' && msg.status) {
            opts.onStatus?.(msg.status);
            demux.syncPeers(msg.status.peers.map((p) => p.id));
          }
        } catch {
          /* ignore malformed ctrl */
        }
      } else if (f.type === VID) {
        demux.onVid(f.payload);
      }
      // MIX (audio) is the P-015 slice — ignored here.
    }
  });

  function safeSend(data: Uint8Array): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(data);
    } catch (e) {
      opts.onError?.(e);
    }
  }

  return {
    sendCamFrame(frame) {
      safeSend(buildCamFrame({ key: frame.key, timestamp: frame.timestamp }, frame.data));
    },
    setCameraOn(on) {
      safeSend(buildCamera(on));
    },
    setMuted(muted) {
      safeSend(buildMute(muted));
    },
    videoPeers: () => demux.peers(),
    close() {
      safeSend(buildLeave());
      demux.close();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export { MIX };
