/**
 * Test-support: a minimal PNG encoder, so anything that consumes this detector can
 * build a genuinely blank or genuinely content-bearing fixture without a dependency
 * and without hand-committing binary files. Every image it produces is a real PNG a
 * viewer could open.
 *
 * Exported as its own entry point (`@papercusp/image-blankness/testing`) to keep the
 * encoder out of the main module — production callers only ever read images.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface EncodePngOptions {
  /** PNG colour type: 0 grey, 2 RGB (default), 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType?: number;
  bitDepth?: number;
  /** RGB triples, required for colour type 3. */
  palette?: number[][];
  /** Per-scanline filter byte — 0 (None) or 2 (Up) are implemented. */
  filter?: number;
}

/** Encode raw samples (in the layout the colour type expects) as a PNG. */
export function encodePng(
  width: number,
  height: number,
  samples: Uint8Array,
  opts: EncodePngOptions = {},
): Uint8Array {
  const colorType = opts.colorType ?? 2;
  const bitDepth = opts.bitDepth ?? 8;
  const channels = CHANNELS_BY_COLOR_TYPE[colorType] ?? 3;
  const samplesPerRow = width * channels;
  const filter = opts.filter ?? 0;

  // Sub-byte depths (1/2/4) PACK several samples into each byte. `samples` is always one
  // ENTRY per sample regardless of depth — the caller passes logical values and this packs
  // them — so a 1-bit grayscale image can be produced here at all. Without packing, the
  // IHDR would claim 1 bit per pixel while the data carried 8, and every decoder would read
  // garbage from the second pixel on.
  const stride = Math.ceil((samplesPerRow * bitDepth) / 8);
  const packRow = (y: number): Uint8Array => {
    const row = new Uint8Array(stride);
    if (bitDepth === 8) {
      for (let i = 0; i < samplesPerRow; i += 1) row[i] = samples[y * samplesPerRow + i];
      return row;
    }
    const perByte = 8 / bitDepth;
    const max = (1 << bitDepth) - 1;
    for (let i = 0; i < samplesPerRow; i += 1) {
      const value = samples[y * samplesPerRow + i] & max;
      const shift = 8 - bitDepth * ((i % perByte) + 1);
      row[Math.floor(i / perByte)] |= value << shift;
    }
    return row;
  };

  const raw = Buffer.alloc(height * (stride + 1));
  // Annotated: the initializer narrows to Uint8Array<ArrayBuffer>, while packRow's declared
  // return is Uint8Array<ArrayBufferLike>, and the reassignment below would not typecheck.
  let previous: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = packRow(y);
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      // The Up filter is defined over the PACKED bytes, not the logical samples.
      raw[y * (stride + 1) + 1 + i] = filter === 2 ? (row[i] - previous[i]) & 0xff : row[i];
    }
    previous = row;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;

  const parts: Buffer[] = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (colorType === 3) parts.push(chunk('PLTE', Uint8Array.from((opts.palette ?? [[0, 0, 0]]).flat())));
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)));
  return Uint8Array.from(Buffer.concat(parts));
}

/** Build packed RGB samples from a per-pixel function. */
export function rgbSamples(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y);
      const o = (y * width + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/**
 * A capture of a window that never painted: the dark vertical gradient a failed Tauri
 * grab actually produces, not a flat fill — the harder and more realistic case.
 */
export function blankPng(width = 1280, height = 800): Uint8Array {
  return encodePng(width, height, rgbSamples(width, height, (_x, y) => [y % 40, y % 40, (y % 40) + 8]));
}

/** A capture that plainly rendered: a dark panel carrying rows of glyph-like runs. */
export function contentPng(width = 1280, height = 800): Uint8Array {
  return encodePng(
    width,
    height,
    rgbSamples(width, height, (x, y) => {
      const onTextRow = y % 24 >= 8 && y % 24 < 16;
      const inGlyph = onTextRow && x > 40 && x < width - 40 && x % 7 < 3;
      return inGlyph ? [235, 235, 240] : [24, 26, 32];
    }),
  );
}
