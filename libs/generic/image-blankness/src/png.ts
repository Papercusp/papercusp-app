/**
 * Minimal, dependency-free PNG reader — just enough to get RGB pixels out of the
 * kind of file a screenshot tool writes.
 *
 * Scope is deliberately narrow: 8/16-bit greyscale, RGB, greyscale+alpha and RGBA,
 * plus 1/2/4/8-bit palette (an all-one-colour capture is exactly what an optimiser
 * turns into a tiny indexed PNG, so refusing palette would blind the detector to its
 * own primary case). Interlaced (Adam7) files are refused rather than half-decoded.
 *
 * Everything that is not understood returns `null` — the caller reports that as
 * "undecodable" and never as "blank". A detector that guesses is worse than one that
 * abstains, because the only action taken on a `blank` verdict is a rejection.
 */

import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface DecodedPng {
  width: number;
  height: number;
  /** Packed RGB, 3 bytes per pixel, alpha already composited over black. */
  rgb: Uint8Array;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** Channels carried per pixel for each PNG colour type (palette carries one index). */
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverse the per-scanline filter PNG applies before compression. Operates in place on
 * a copy, one scanline at a time, exactly as the spec describes — `bpp` is the filter's
 * byte-distance to the pixel on the left (1 for sub-byte depths).
 */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array | null {
  const expected = height * (stride + 1);
  if (raw.length < expected) return null;
  const out = new Uint8Array(height * stride);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const inOff = y * (stride + 1) + 1;
    const outOff = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[inOff + i];
      const a = i >= bpp ? out[outOff + i - bpp] : 0;
      const b = prior[i];
      const c = i >= bpp ? prior[i - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          return null;
      }
      out[outOff + i] = value & 0xff;
    }
    prior = out.subarray(outOff, outOff + stride);
  }
  return out;
}

/** Read one sample of `bitDepth` bits at sample index `i` from a scanline. */
function readSample(line: Uint8Array, i: number, bitDepth: number): number {
  if (bitDepth === 8) return line[i];
  if (bitDepth === 16) return line[i * 2]; // high byte is plenty for a blankness read
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(i / perByte)];
  const shift = 8 - bitDepth * ((i % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * Bit depths each colour type may legally use (PNG spec §11.2.2, table 11.1). Encoded as a
 * table rather than an inline condition because getting it wrong is silent in BOTH
 * directions: too strict and a legal PNG reports `undecodable`, too loose and a malformed
 * header walks off the end of a scanline.
 */
const ALLOWED_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  0: [1, 2, 4, 8, 16], // grayscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // palette
  4: [8, 16], // grayscale + alpha
  6: [8, 16], // truecolour + alpha
});

/**
 * Scale a raw sample to the 0-255 range its colour value is judged in.
 *
 * REQUIRED for sub-byte depths, and the direction of the bug it fixes matters: a 1-bit
 * grayscale sample is 0 or 1, so WITHOUT this a bilevel image carrying real content has an
 * adjacent-pixel luma delta of 1 — far under the 8 that counts as an edge — and the whole
 * frame is judged `blank`. That is a FALSE BLANK, the one verdict callers act on by
 * rejecting evidence, so it is the most expensive direction to be wrong in.
 *
 * A no-op at depth 8 (already 0-255) and at 16 (readSample returns the high byte).
 * Palette INDICES are deliberately not passed through here — they address PLTE entries and
 * are not intensities.
 */
function scaleSample(value: number, bitDepth: number): number {
  if (bitDepth >= 8) return value;
  const max = (1 << bitDepth) - 1;
  return Math.round((value * 255) / max);
}

/**
 * Decode a PNG to packed RGB, or return null when the file is not a PNG this reader
 * understands (interlaced, truncated, corrupt, or an unsupported depth/colour-type).
 */
export function decodePng(bytes: Uint8Array): DecodedPng | null {
  if (!hasPngSignature(bytes)) return null;

  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return null; // truncated chunk
    if (type === 'IHDR') {
      if (length < 13) return null;
      header = {
        width: readUint32(bytes, dataStart),
        height: readUint32(bytes, dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header || idatParts.length === 0) return null;
  const { width, height, bitDepth, colorType, interlace } = header;
  if (width <= 0 || height <= 0 || interlace !== 0) return null;

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) return null;
  // Grayscale (type 0) at depths 1/2/4 is legal and is EXACTLY what a blank screen capture
  // looks like: ImageMagick's `import ... png:-` picks its encoding by content, emitting
  // 1-bit grayscale for a uniform frame and 8-bit truecolour once anything paints (measured
  // 2026-08-23: a blank 1024x768 grab is 233 bytes, color_type 0 / bit_depth 1). Restricting
  // sub-byte depths to palette images therefore made this decoder blind to precisely the
  // input the blankness guard exists to judge — it answered `undecodable`, which by design
  // resolves AWAY from `blank`, so the guard failed open on a genuinely blank capture.
  if (!ALLOWED_BIT_DEPTHS[colorType]?.includes(bitDepth)) return null;
  if (colorType === 3 && !palette) return null;

  // Guard against a hostile/absurd header claiming a multi-gigapixel image.
  if (width * height > 64_000_000) return null;

  let inflated: Uint8Array;
  try {
    inflated = inflateSync(Buffer.concat(idatParts.map((p) => Buffer.from(p))));
  } catch {
    return null;
  }

  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const lines = unfilter(inflated, height, stride, bpp);
  if (!lines) return null;

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      let r: number;
      let g: number;
      let b: number;
      let alpha = 255;
      if (colorType === 3) {
        const index = readSample(line, x, bitDepth);
        const p = index * 3;
        if (!palette || p + 2 >= palette.length) return null;
        r = palette[p];
        g = palette[p + 1];
        b = palette[p + 2];
      } else if (colorType === 0) {
        r = g = b = scaleSample(readSample(line, x, bitDepth), bitDepth);
      } else if (colorType === 4) {
        r = g = b = scaleSample(readSample(line, x * 2, bitDepth), bitDepth);
        alpha = scaleSample(readSample(line, x * 2 + 1, bitDepth), bitDepth);
      } else if (colorType === 2) {
        r = scaleSample(readSample(line, x * 3, bitDepth), bitDepth);
        g = scaleSample(readSample(line, x * 3 + 1, bitDepth), bitDepth);
        b = scaleSample(readSample(line, x * 3 + 2, bitDepth), bitDepth);
      } else {
        r = scaleSample(readSample(line, x * 4, bitDepth), bitDepth);
        g = scaleSample(readSample(line, x * 4 + 1, bitDepth), bitDepth);
        b = scaleSample(readSample(line, x * 4 + 2, bitDepth), bitDepth);
        alpha = scaleSample(readSample(line, x * 4 + 3, bitDepth), bitDepth);
      }
      // Composite over black: a fully transparent capture is a blank capture.
      const o = (y * width + x) * 3;
      rgb[o] = alpha === 255 ? r : Math.round((r * alpha) / 255);
      rgb[o + 1] = alpha === 255 ? g : Math.round((g * alpha) / 255);
      rgb[o + 2] = alpha === 255 ? b : Math.round((b * alpha) / 255);
    }
  }

  return { width, height, rgb };
}
