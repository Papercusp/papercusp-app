/**
 * Per-connection wire framing for voice peers — the house `[4B len BE][1B type][payload]`
 * shape (mirrors @papercusp/ipc-framing), symmetric in both directions.
 *
 * Types:
 *   0x01 CTRL  — UTF-8 JSON control message (hello / state)
 *   0x02 AUDIO — `[4B seq BE][codec payload…]`
 *   0x04 VIDEO — `[1B flags][8B timestamp f64 BE][encoded chunk…]` (WebCodecs
 *                keyframe/delta; opaque to the operator, decoded in the webview —
 *                plan holepunch-video-shared-harnesses-2026-06-05 D-001/D-007)
 */

export const FRAME_CTRL = 0x01;
export const FRAME_AUDIO = 0x02;
export const FRAME_VIDEO = 0x04;

/**
 * Refuse absurd frames. CTRL/AUDIO are tens of bytes, but a VIDEO keyframe
 * (esp. a screen-share frame) can be hundreds of KB — one FrameDecoder per
 * connection carries all three types, so the cap must fit the largest video
 * frame. 4 MiB comfortably holds a 1080p screen-share keyframe.
 */
export const MAX_FRAME_BYTES = 4 << 20; // 4 MiB

export interface VoiceFrame {
  type: number;
  payload: Uint8Array;
}

/** 1B flags + 8B f64 timestamp. */
const VIDEO_HEADER_BYTES = 9;
const VIDEO_FLAG_KEYFRAME = 0x01;

export interface VideoFrameMeta {
  /** True for an encoder keyframe (standalone-decodable); false for a delta. */
  key: boolean;
  /** Presentation timestamp in microseconds (WebCodecs EncodedVideoChunk.timestamp). */
  timestamp: number;
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out[4] = type & 0xff;
  out.set(payload, 5);
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function encodeCtrl(msg: unknown): Uint8Array {
  return encodeFrame(FRAME_CTRL, te.encode(JSON.stringify(msg)));
}

export function decodeCtrl(payload: Uint8Array): unknown {
  return JSON.parse(td.decode(payload));
}

export function encodeAudio(seq: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + data.length);
  new DataView(payload.buffer).setUint32(0, seq >>> 0, false);
  payload.set(data, 4);
  return encodeFrame(FRAME_AUDIO, payload);
}

export function decodeAudio(payload: Uint8Array): { seq: number; data: Uint8Array } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { seq: view.getUint32(0, false), data: payload.subarray(4) };
}

/**
 * The video-frame PAYLOAD only — `[1B flags][8B ts][chunk]`, WITHOUT a frame-type
 * wrapper. This is the unit that travels end-to-end: the operator relays it
 * opaquely (D-007), and each transport hop wraps it in its own type byte —
 * FRAME_VIDEO on the swarm, CAM/VID on the local voice socket. `meta.key` lets a
 * fresh receiver skip deltas until the first keyframe. Decode with decodeVideo.
 */
export function encodeVideoPayload(meta: VideoFrameMeta, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(VIDEO_HEADER_BYTES + data.length);
  const view = new DataView(payload.buffer);
  payload[0] = meta.key ? VIDEO_FLAG_KEYFRAME : 0;
  view.setFloat64(1, meta.timestamp, false);
  payload.set(data, VIDEO_HEADER_BYTES);
  return payload;
}

/** One encoded video chunk → a complete FRAME_VIDEO swarm frame. */
export function encodeVideo(meta: VideoFrameMeta, data: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_VIDEO, encodeVideoPayload(meta, data));
}

export function decodeVideo(payload: Uint8Array): VideoFrameMeta & { data: Uint8Array } {
  if (payload.length < VIDEO_HEADER_BYTES) {
    return { key: false, timestamp: 0, data: new Uint8Array(0) };
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    key: (payload[0] & VIDEO_FLAG_KEYFRAME) !== 0,
    timestamp: view.getFloat64(1, false),
    data: payload.subarray(VIDEO_HEADER_BYTES),
  };
}

/** Incremental decoder — feed arbitrary chunk boundaries, get whole frames out. */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): VoiceFrame[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const frames: VoiceFrame[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(0, false);
      if (len > MAX_FRAME_BYTES) throw new Error(`p2p-voice: frame too large (${len})`);
      if (this.buf.length < 5 + len) break;
      frames.push({ type: this.buf[4], payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return frames;
  }
}
