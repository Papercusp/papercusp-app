/**
 * P2P voice-channel core — pure algorithm over injected seams.
 *
 * The host injects:
 *   - `swarm`: a DEDICATED Hyperswarm-like instance (join/leave by 32-byte topic,
 *     global 'connection' events yielding duplex streams). Dedicated = every
 *     connection on it is a voice peer; no Protomux multiplexing needed.
 *   - `codec`: PCM16 ↔ compressed frames (Opus in production, identity in tests).
 *
 * Model (v1): ONE active channel per node (the Discord voice model). Peers
 * handshake with a CTRL hello carrying the channel topic + identity; mismatched
 * channels are disconnected. Presence is in-band: liveness IS the connection
 * (plan holepunch-voice-channels-2026-06-05 D-011).
 *
 * Audio path: host pushes 20ms PCM16 mic frames → encode → fan out to peers.
 * Peer frames decode into small per-peer queues; a frameMs ticker pops one frame
 * per peer, mixes (saturating), and emits the mix for local playback. Every
 * decoded peer frame is also emitted raw (`onPeerFrame`) — the agent tap (D-007).
 *
 * Video path (plan holepunch-video-shared-harnesses-2026-06-05): a SECOND media
 * stream on the SAME peer connection. Unlike audio, video is never mixed or
 * decoded here — the WebCodecs codec lives in the webview (D-002/D-007). The host
 * pushes opaque encoded chunks (`pushVideo`); the core fans them out per-peer as
 * FRAME_VIDEO and re-emits every inbound peer video frame raw (`onPeerVideoFrame`,
 * tagged with the sender peer id) for per-tile rendering. Camera on/off rides the
 * in-band `state` control frame alongside mute.
 */
import {
  FrameDecoder,
  FRAME_AUDIO,
  FRAME_CTRL,
  FRAME_VIDEO,
  decodeAudio,
  decodeCtrl,
  encodeAudio,
  encodeCtrl,
  encodeFrame,
} from './framing';
import { energy, mixInt16 } from './mixer';

// ---------------------------------------------------------------- seams

export interface DuplexLike {
  write(data: Uint8Array): unknown;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'error' | 'close', cb: (err?: unknown) => void): unknown;
  destroy(err?: unknown): unknown;
}

export interface SwarmDiscovery {
  flushed(): Promise<void>;
}

export interface SwarmLike {
  join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): SwarmDiscovery;
  leave(topic: Uint8Array): Promise<void>;
  on(event: 'connection', cb: (conn: DuplexLike, info?: unknown) => void): unknown;
  off?(event: 'connection', cb: (conn: DuplexLike, info?: unknown) => void): unknown;
}

export interface VoiceCodec {
  /** Samples per frame (e.g. 960 = 20ms @ 48kHz mono). */
  frameSamples: number;
  encode(pcm: Int16Array): Uint8Array;
  decode(data: Uint8Array): Int16Array;
}

export interface VoiceIdentity {
  id: string;
  label: string;
}

export interface VoicePeerState {
  id: string;
  label: string;
  muted: boolean;
  speaking: boolean;
  /** Whether this peer is currently sharing a camera (in-band `state` signal). */
  cameraOn: boolean;
}

export interface VoiceNodeOptions {
  swarm: SwarmLike;
  codec: VoiceCodec;
  identity: VoiceIdentity;
  /** Mix/playout cadence in ms. Default 20. */
  frameMs?: number;
  /** Per-peer queued-frame cap before dropping oldest (jitter absorption). Default 3. */
  peerQueueCap?: number;
  /** Energy threshold for the speaking flag. Default 0.01. */
  speakingThreshold?: number;
  /** Speaking flag hold time in ms after the last loud frame. Default 300. */
  speakingHoldMs?: number;
}

// ---------------------------------------------------------------- ctrl messages

interface HelloMsg {
  kind: 'hello';
  channel: string;
  id: string;
  label: string;
  muted: boolean;
  cameraOn: boolean;
}
interface StateMsg {
  kind: 'state';
  muted: boolean;
  cameraOn: boolean;
}
type CtrlMsg = HelloMsg | StateMsg;

// ---------------------------------------------------------------- internals

interface PeerConn {
  conn: DuplexLike;
  decoder: FrameDecoder;
  /** Set after a valid hello for OUR channel. */
  id?: string;
  label?: string;
  muted: boolean;
  cameraOn: boolean;
  queue: Int16Array[];
  lastLoudAt: number;
  closed: boolean;
}

export interface ChannelHandle {
  readonly topicHex: string;
  /** Push one mic frame (codec.frameSamples PCM16 samples). No-op while muted. */
  pushMic(frame: Int16Array): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /**
   * Fan one OPAQUE encoded video-frame payload (`[1B flags][8B ts][chunk]`, the
   * @papercusp/p2p-voice encodeVideo format) out to every peer. The core never
   * decodes it — the WebCodecs codec lives in the webview (D-002/D-007).
   */
  pushVideo(payload: Uint8Array): void;
  /** Announce local camera on/off to peers (in-band `state` frame). */
  setCameraOn(on: boolean): void;
  readonly cameraOn: boolean;
  peers(): VoicePeerState[];
  /** The N-peer mix at frameMs cadence (excludes own mic) — local playback feed. */
  onMixedFrame(cb: (frame: Int16Array) => void): () => void;
  /** Every decoded peer frame, pre-mix — the agent/STT tap. */
  onPeerFrame(cb: (peerId: string, frame: Int16Array) => void): () => void;
  /**
   * Every inbound peer video frame, tagged with the sender peer id. The payload
   * is the opaque encoded video-frame bytes (copied — safe to retain). Per-peer,
   * never mixed: each peer renders to its own tile.
   */
  onPeerVideoFrame(cb: (peerId: string, payload: Uint8Array) => void): () => void;
  onPeersChanged(cb: (peers: VoicePeerState[]) => void): () => void;
  /** Resolves when the topic announce has flushed to the swarm. */
  announced(): Promise<void>;
  leave(): Promise<void>;
}

export interface VoiceNode {
  joinChannel(topicHex: string): ChannelHandle;
  /** The active channel's topic hex, if any. */
  activeChannel(): string | null;
  destroy(): Promise<void>;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('p2p-voice: topic must be 64 hex chars (32 bytes)');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function createVoiceNode(opts: VoiceNodeOptions): VoiceNode {
  const frameMs = opts.frameMs ?? 20;
  const peerQueueCap = opts.peerQueueCap ?? 3;
  const speakingThreshold = opts.speakingThreshold ?? 0.01;
  const speakingHoldMs = opts.speakingHoldMs ?? 300;
  const { swarm, codec, identity } = opts;

  let active: {
    topicHex: string;
    topic: Uint8Array;
    discovery: SwarmDiscovery;
    conns: Set<PeerConn>;
    muted: boolean;
    cameraOn: boolean;
    seq: number;
    ticker: ReturnType<typeof setInterval>;
    mixedCbs: Set<(frame: Int16Array) => void>;
    peerCbs: Set<(peerId: string, frame: Int16Array) => void>;
    videoCbs: Set<(peerId: string, payload: Uint8Array) => void>;
    changedCbs: Set<(peers: VoicePeerState[]) => void>;
    lastSnapshot: string;
  } | null = null;
  let destroyed = false;

  function snapshotPeers(): VoicePeerState[] {
    if (!active) return [];
    const now = Date.now();
    const out: VoicePeerState[] = [];
    for (const pc of active.conns) {
      if (!pc.id || pc.closed) continue;
      out.push({
        id: pc.id,
        label: pc.label ?? pc.id,
        muted: pc.muted,
        speaking: now - pc.lastLoudAt < speakingHoldMs,
        cameraOn: pc.cameraOn,
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  function fireChangedIfNeeded(): void {
    if (!active) return;
    const snap = snapshotPeers();
    const key = JSON.stringify(snap);
    if (key === active.lastSnapshot) return;
    active.lastSnapshot = key;
    for (const cb of active.changedCbs) cb(snap);
  }

  function dropConn(pc: PeerConn, destroy = true): void {
    if (pc.closed) return;
    pc.closed = true;
    active?.conns.delete(pc);
    if (destroy) {
      try {
        pc.conn.destroy();
      } catch {
        /* already gone */
      }
    }
    fireChangedIfNeeded();
  }

  function handleCtrl(pc: PeerConn, msg: CtrlMsg): void {
    if (!active) return;
    if (msg.kind === 'hello') {
      if (msg.channel !== active.topicHex) {
        // Not our channel (stale topic announce or future multi-channel peer) — drop.
        dropConn(pc);
        return;
      }
      // Dedupe: keep the first live conn per peer id.
      for (const other of active.conns) {
        if (other !== pc && other.id === msg.id && !other.closed) {
          dropConn(pc);
          return;
        }
      }
      pc.id = msg.id;
      pc.label = msg.label;
      pc.muted = msg.muted;
      pc.cameraOn = msg.cameraOn ?? false;
      fireChangedIfNeeded();
    } else if (msg.kind === 'state') {
      if (!pc.id) return;
      pc.muted = msg.muted;
      if (typeof msg.cameraOn === 'boolean') pc.cameraOn = msg.cameraOn;
      fireChangedIfNeeded();
    }
  }

  function handleAudio(pc: PeerConn, payload: Uint8Array): void {
    if (!active || !pc.id) return; // no audio before a valid hello
    const { data } = decodeAudio(payload);
    let frame: Int16Array;
    try {
      frame = codec.decode(data);
    } catch {
      return; // tolerate one bad frame
    }
    pc.queue.push(frame);
    while (pc.queue.length > peerQueueCap) pc.queue.shift();
    if (energy(frame) >= speakingThreshold) pc.lastLoudAt = Date.now();
    for (const cb of active.peerCbs) cb(pc.id, frame);
  }

  function handleVideo(pc: PeerConn, payload: Uint8Array): void {
    if (!active || !pc.id) return; // no video before a valid hello
    if (active.videoCbs.size === 0) return;
    // Copy: payload is a view into the decoder's buffer — make it safe to retain.
    const copy = payload.slice();
    for (const cb of active.videoCbs) cb(pc.id, copy);
  }

  function attachConn(conn: DuplexLike): void {
    if (!active || destroyed) {
      try {
        conn.destroy();
      } catch {
        /* noop */
      }
      return;
    }
    const pc: PeerConn = {
      conn,
      decoder: new FrameDecoder(),
      muted: false,
      cameraOn: false,
      queue: [],
      lastLoudAt: 0,
      closed: false,
    };
    active.conns.add(pc);
    conn.on('error', () => dropConn(pc, false));
    conn.on('close', () => dropConn(pc, false));
    conn.on('data', (chunk) => {
      if (pc.closed || !active) return;
      let frames;
      try {
        frames = pc.decoder.push(chunk);
      } catch {
        dropConn(pc);
        return;
      }
      for (const f of frames) {
        if (f.type === FRAME_CTRL) {
          try {
            handleCtrl(pc, decodeCtrl(f.payload) as CtrlMsg);
          } catch {
            dropConn(pc);
            return;
          }
        } else if (f.type === FRAME_AUDIO) {
          handleAudio(pc, f.payload);
        } else if (f.type === FRAME_VIDEO) {
          handleVideo(pc, f.payload);
        }
      }
    });
    const hello: HelloMsg = {
      kind: 'hello',
      channel: active.topicHex,
      id: identity.id,
      label: identity.label,
      muted: active.muted,
      cameraOn: active.cameraOn,
    };
    try {
      conn.write(encodeCtrl(hello));
    } catch {
      dropConn(pc, false);
    }
  }

  const onConnection = (conn: DuplexLike) => attachConn(conn);
  swarm.on('connection', onConnection);

  function tick(): void {
    if (!active) return;
    const ready: Int16Array[] = [];
    for (const pc of active.conns) {
      if (!pc.id || pc.closed) continue;
      const f = pc.queue.shift();
      if (f) ready.push(f);
    }
    const mix = mixInt16(ready, codec.frameSamples);
    for (const cb of active.mixedCbs) cb(mix);
    fireChangedIfNeeded(); // speaking decay transitions
  }

  return {
    joinChannel(topicHex: string): ChannelHandle {
      if (destroyed) throw new Error('p2p-voice: node destroyed');
      if (active) throw new Error(`p2p-voice: already in channel ${active.topicHex} — leave first`);
      const topic = hexToBytes(topicHex);
      const discovery = swarm.join(topic, { server: true, client: true });
      const state = {
        topicHex,
        topic,
        discovery,
        conns: new Set<PeerConn>(),
        muted: false,
        cameraOn: false,
        seq: 0,
        ticker: setInterval(tick, frameMs),
        mixedCbs: new Set<(frame: Int16Array) => void>(),
        peerCbs: new Set<(peerId: string, frame: Int16Array) => void>(),
        videoCbs: new Set<(peerId: string, payload: Uint8Array) => void>(),
        changedCbs: new Set<(peers: VoicePeerState[]) => void>(),
        lastSnapshot: '[]',
      };
      active = state;

      // Write one wire frame to every handshaken peer; drop a peer on write error.
      const writeToPeers = (wire: Uint8Array): void => {
        for (const pc of state.conns) {
          if (!pc.id || pc.closed) continue;
          try {
            pc.conn.write(wire);
          } catch {
            dropConn(pc, false);
          }
        }
      };
      const broadcastState = (): void => {
        writeToPeers(
          encodeCtrl({ kind: 'state', muted: state.muted, cameraOn: state.cameraOn } satisfies StateMsg),
        );
      };

      const handle: ChannelHandle = {
        topicHex,
        get muted() {
          return state.muted;
        },
        get cameraOn() {
          return state.cameraOn;
        },
        pushMic(frame: Int16Array): void {
          if (active !== state || state.muted) return;
          let data: Uint8Array;
          try {
            data = codec.encode(frame);
          } catch {
            return;
          }
          writeToPeers(encodeAudio(state.seq++, data));
        },
        pushVideo(payload: Uint8Array): void {
          if (active !== state) return;
          writeToPeers(encodeFrame(FRAME_VIDEO, payload));
        },
        setMuted(muted: boolean): void {
          if (active !== state || state.muted === muted) return;
          state.muted = muted;
          broadcastState();
        },
        setCameraOn(on: boolean): void {
          if (active !== state || state.cameraOn === on) return;
          state.cameraOn = on;
          broadcastState();
        },
        peers: snapshotPeers,
        onMixedFrame(cb) {
          state.mixedCbs.add(cb);
          return () => state.mixedCbs.delete(cb);
        },
        onPeerFrame(cb) {
          state.peerCbs.add(cb);
          return () => state.peerCbs.delete(cb);
        },
        onPeerVideoFrame(cb) {
          state.videoCbs.add(cb);
          return () => state.videoCbs.delete(cb);
        },
        onPeersChanged(cb) {
          state.changedCbs.add(cb);
          return () => state.changedCbs.delete(cb);
        },
        announced: () => discovery.flushed(),
        async leave(): Promise<void> {
          if (active !== state) return;
          clearInterval(state.ticker);
          for (const pc of [...state.conns]) dropConn(pc);
          active = null;
          await swarm.leave(topic);
        },
      };
      return handle;
    },
    activeChannel: () => active?.topicHex ?? null,
    async destroy(): Promise<void> {
      destroyed = true;
      swarm.off?.('connection', onConnection);
      if (active) {
        clearInterval(active.ticker);
        for (const pc of [...active.conns]) dropConn(pc);
        const topic = active.topic;
        active = null;
        await swarm.leave(topic);
      }
    },
  };
}
