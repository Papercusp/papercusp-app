/**
 * Streaming IVF demuxer (`hive-frame-desktops-live-view-2026-06-06` P-012).
 *
 * ffmpeg's `-f ivf` output is the simplest container that gives us exact
 * encoded-frame boundaries from a pipe: a 32-byte file header, then per frame
 * a 12-byte header (u32le size + u64le pts) and the raw VP8/VP9 payload.
 * This parser is push-based (feed arbitrary chunk boundaries, get whole
 * frames) and pure — the capture source owns the process; tests drive bytes.
 */

export interface IvfHeader {
  fourcc: string;
  width: number;
  height: number;
  /** pts units per second = den / num. */
  timebaseDen: number;
  timebaseNum: number;
}

export interface IvfFrame {
  data: Uint8Array;
  /** Presentation time in MICROSECONDS (the video-channel wire convention —
   *  the browser side ships WebCodecs chunk timestamps, which are µs). */
  timestampUs: number;
}

const FILE_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 12;

export interface IvfStreamParser {
  /** Feed bytes; returns every COMPLETE frame they finish. */
  push(chunk: Uint8Array): IvfFrame[];
  header(): IvfHeader | null;
}

export function createIvfStreamParser(): IvfStreamParser {
  let buf = new Uint8Array(0);
  let header: IvfHeader | null = null;

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  };

  return {
    header: () => header,
    push(chunk: Uint8Array): IvfFrame[] {
      append(chunk);
      const out: IvfFrame[] = [];
      if (!header) {
        if (buf.length < FILE_HEADER_BYTES) return out;
        const dv = new DataView(buf.buffer, buf.byteOffset, FILE_HEADER_BYTES);
        const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
        if (magic !== 'DKIF') throw new Error(`ivf: bad magic '${magic}' (not an IVF stream)`);
        header = {
          fourcc: String.fromCharCode(buf[8], buf[9], buf[10], buf[11]),
          width: dv.getUint16(12, true),
          height: dv.getUint16(14, true),
          timebaseDen: dv.getUint32(16, true),
          timebaseNum: dv.getUint32(20, true),
        };
        buf = buf.subarray(FILE_HEADER_BYTES);
      }
      for (;;) {
        if (buf.length < FRAME_HEADER_BYTES) break;
        const dv = new DataView(buf.buffer, buf.byteOffset, FRAME_HEADER_BYTES);
        const size = dv.getUint32(0, true);
        if (buf.length < FRAME_HEADER_BYTES + size) break;
        // u64le pts — frame counts stay far below 2^53, plain math is exact.
        const ptsLo = dv.getUint32(4, true);
        const ptsHi = dv.getUint32(8, true);
        const pts = ptsHi * 0x1_0000_0000 + ptsLo;
        const unitsPerSecond = header.timebaseDen / (header.timebaseNum || 1);
        const timestampUs = Math.round((pts / (unitsPerSecond || 1)) * 1_000_000);
        // Copy the frame out — `buf` is re-sliced and must not alias consumers.
        out.push({ data: buf.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size), timestampUs });
        buf = buf.subarray(FRAME_HEADER_BYTES + size);
      }
      return out;
    },
  };
}

/** Build a synthetic IVF byte stream — test helper (also used by fixtures). */
export function buildIvf(
  frames: Array<{ data: Uint8Array; pts: number }>,
  opts: { fourcc?: string; width?: number; height?: number; den?: number; num?: number } = {},
): Uint8Array {
  const den = opts.den ?? 15;
  const num = opts.num ?? 1;
  const head = new Uint8Array(FILE_HEADER_BYTES);
  const dv = new DataView(head.buffer);
  head.set([0x44, 0x4b, 0x49, 0x46], 0); // DKIF
  dv.setUint16(4, 0, true); // version
  dv.setUint16(6, FILE_HEADER_BYTES, true);
  const fourcc = opts.fourcc ?? 'VP90';
  for (let i = 0; i < 4; i++) head[8 + i] = fourcc.charCodeAt(i);
  dv.setUint16(12, opts.width ?? 1920, true);
  dv.setUint16(14, opts.height ?? 1080, true);
  dv.setUint32(16, den, true);
  dv.setUint32(20, num, true);
  dv.setUint32(24, frames.length, true);
  const parts: Uint8Array[] = [head];
  for (const f of frames) {
    const fh = new Uint8Array(FRAME_HEADER_BYTES);
    const fdv = new DataView(fh.buffer);
    fdv.setUint32(0, f.data.length, true);
    fdv.setUint32(4, f.pts >>> 0, true);
    fdv.setUint32(8, Math.floor(f.pts / 0x1_0000_0000), true);
    parts.push(fh, f.data);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
