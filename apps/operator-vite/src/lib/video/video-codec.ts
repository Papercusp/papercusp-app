/**
 * WebCodecs video codec seam — plan holepunch-video-shared-harnesses-2026-06-05
 * (P-004, D-002/D-007).
 *
 * The desktop is a Tauri webview, so camera frames are encoded with the browser's
 * `VideoEncoder` and peer frames decoded with `VideoDecoder`. The operator NEVER
 * runs a video codec — it only relays the opaque encoded chunks (D-007). Keep the
 * encoder/decoder behind this seam so a native encoder can swap in later.
 *
 * Portability: the shipping desktop webview is WebKitGTK, whose WebCodecs support
 * varies by version. Everything here is capability-guarded — `webCodecsSupported()`
 * gates use, and the grid degrades to audio-only avatars when it returns false
 * (D-005). Live efficacy on the real webview + a camera is the P-010 hardware verify.
 *
 * No `@types/dom-webcodecs` dependency: we declare the minimal WebCodecs surface
 * we touch locally; the browser provides the real globals at runtime. The pure
 * helpers (capability guard, keyframe gate, chunk conversion, config) are
 * dependency-free and unit-tested; the `create*` factories are browser-only.
 */
import type { VideoFrameMeta } from '@papercusp/p2p-voice';

/** One encoded video frame: WebCodecs chunk metadata + the opaque bytes. */
export interface EncodedVideoFrame extends VideoFrameMeta {
  data: Uint8Array;
}

export interface VideoEncodeConfig {
  /** WebCodecs codec string, e.g. 'vp8' or 'avc1.42E01E' (H.264 baseline). */
  codec: string;
  width: number;
  height: number;
  framerate: number;
  /** Target bitrate in bits/sec. */
  bitrate: number;
}

/**
 * Conservative default: 360p @ 15fps VP9 ~0.5 Mbps — the D-005 starting point.
 *
 * Codec = VP9 (`vp09.00.10.08`), NOT VP8/H.264: a live probe on the ship-target
 * WebKitGTK 2.52 webview (plan D-012) found VP8 and H.264 *encode* fine but
 * *fail to decode* (`EncodingError: Decode error`) — only VP9 round-trips
 * cleanly (encode + decode both work). VP8/H.264 would have produced black peer
 * tiles. The codec lives behind this seam, so a future platform can override it.
 */
export const DEFAULT_VIDEO_CONFIG: VideoEncodeConfig = {
  codec: 'vp09.00.10.08',
  width: 640,
  height: 360,
  framerate: 15,
  bitrate: 500_000,
};

// ----------------------------------------------------- minimal WebCodecs surface
// (local, dependency-free — only what we use)

/** A WebCodecs EncodedVideoChunk (the encoder's output / decoder's input). */
export interface EncodedChunkLike {
  type: 'key' | 'delta';
  timestamp: number;
  byteLength: number;
  copyTo(dst: Uint8Array): void;
}

/** A WebCodecs VideoFrame (capture output / decoder output). Closeable to free GPU memory. */
export interface VideoFrameLike {
  readonly timestamp: number;
  close(): void;
}

interface VideoEncoderLike {
  configure(config: Record<string, unknown>): void;
  encode(frame: VideoFrameLike, opts?: { keyFrame?: boolean }): void;
  close(): void;
  readonly encodeQueueSize: number;
}
interface VideoDecoderLike {
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  close(): void;
}
interface WebCodecsGlobals {
  VideoEncoder?: new (init: { output: (c: EncodedChunkLike) => void; error: (e: unknown) => void }) => VideoEncoderLike;
  VideoDecoder?: new (init: { output: (f: VideoFrameLike) => void; error: (e: unknown) => void }) => VideoDecoderLike;
  EncodedVideoChunk?: new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown;
}

// ----------------------------------------------------- pure helpers (unit-tested)

/** True when the runtime exposes the WebCodecs video classes we need. */
export function webCodecsSupported(g: WebCodecsGlobals = globalThis as unknown as WebCodecsGlobals): boolean {
  return (
    typeof g.VideoEncoder === 'function' &&
    typeof g.VideoDecoder === 'function' &&
    typeof g.EncodedVideoChunk === 'function'
  );
}

/** Copy a WebCodecs chunk into our wire-ready EncodedVideoFrame. */
export function encodedChunkToFrame(chunk: EncodedChunkLike): EncodedVideoFrame {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { key: chunk.type === 'key', timestamp: chunk.timestamp, data };
}

/**
 * Decoder gate: a fresh receiver (or one that just joined mid-stream) must drop
 * delta frames until it has seen a keyframe, or the decoder errors on an
 * undecodable reference. Forward only from the first keyframe onward.
 */
export class KeyframeGate {
  private seenKey = false;
  /** Returns whether this frame should be forwarded to the decoder. */
  accept(key: boolean): boolean {
    if (key) this.seenKey = true;
    return this.seenKey;
  }
  /** Call on reconnect / decoder reset so we wait for a fresh keyframe again. */
  reset(): void {
    this.seenKey = false;
  }
  get ready(): boolean {
    return this.seenKey;
  }
}

// ----------------------------------------------------- browser-only factories
// (verified live on the desktop webview — P-010)

export interface CameraEncoder {
  /** Encode one captured frame. The frame is closed after submission. */
  encode(frame: VideoFrameLike): void;
  /** Force the NEXT encoded frame to be a keyframe (e.g. a new peer joined). */
  requestKeyframe(): void;
  /** Live-adjust encoder params (D-005 adaptation); reconfigures + forces a keyframe. */
  reconfigure(partial: Partial<VideoEncodeConfig>): void;
  close(): void;
}

/**
 * Wrap a WebCodecs VideoEncoder. Caller supplies captured VideoFrames (from a
 * camera/screen track) via `encode`; encoded chunks are delivered to `onFrame`
 * ready for the wire. Browser-only — throws if WebCodecs is unavailable.
 */
export function createCameraEncoder(opts: {
  config?: VideoEncodeConfig;
  onFrame: (frame: EncodedVideoFrame) => void;
  onError?: (err: unknown) => void;
}): CameraEncoder {
  const g = globalThis as unknown as WebCodecsGlobals;
  if (!g.VideoEncoder) throw new Error('video-codec: VideoEncoder unavailable (WebCodecs unsupported)');
  let config = { ...DEFAULT_VIDEO_CONFIG, ...opts.config };
  let forceKey = true; // first frame is always a keyframe
  const encoder = new g.VideoEncoder({
    output: (chunk) => opts.onFrame(encodedChunkToFrame(chunk)),
    error: (e) => opts.onError?.(e),
  });
  const configure = () =>
    encoder.configure({
      codec: config.codec,
      width: config.width,
      height: config.height,
      framerate: config.framerate,
      bitrate: config.bitrate,
      latencyMode: 'realtime',
    });
  configure();
  return {
    encode(frame) {
      try {
        encoder.encode(frame, { keyFrame: forceKey });
        forceKey = false;
      } finally {
        frame.close();
      }
    },
    requestKeyframe() {
      forceKey = true;
    },
    reconfigure(partial) {
      config = { ...config, ...partial };
      configure();
      forceKey = true;
    },
    close() {
      try {
        encoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export interface PeerDecoder {
  /** Feed one inbound encoded frame; rendered frames arrive on `onFrame`. */
  decode(frame: EncodedVideoFrame): void;
  /** Reset after a reconnect so we re-wait for a keyframe. */
  reset(): void;
  close(): void;
}

/**
 * Wrap a WebCodecs VideoDecoder for ONE peer. Drops deltas until the first
 * keyframe (KeyframeGate); decoded VideoFrames are delivered to `onFrame` for
 * canvas rendering. Browser-only.
 */
export function createPeerDecoder(opts: {
  codec?: string;
  onFrame: (frame: VideoFrameLike) => void;
  onError?: (err: unknown) => void;
}): PeerDecoder {
  const g = globalThis as unknown as WebCodecsGlobals;
  if (!g.VideoDecoder || !g.EncodedVideoChunk)
    throw new Error('video-codec: VideoDecoder unavailable (WebCodecs unsupported)');
  const codec = opts.codec ?? DEFAULT_VIDEO_CONFIG.codec;
  const gate = new KeyframeGate();
  let configured = false;
  const decoder = new g.VideoDecoder({
    output: (frame) => opts.onFrame(frame),
    error: (e) => opts.onError?.(e),
  });
  const EncodedVideoChunk = g.EncodedVideoChunk;
  return {
    decode(frame) {
      if (!gate.accept(frame.key)) return; // wait for the first keyframe
      if (!configured) {
        decoder.configure({ codec });
        configured = true;
      }
      decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data }));
    },
    reset() {
      gate.reset();
    },
    close() {
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}
