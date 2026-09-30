/**
 * Deterministic synthetic raster kit for the design-compare validation corpus (P-002).
 *
 * WHY SYNTHESIS RATHER THAN COMMITTED BINARY BLOBS
 * ------------------------------------------------
 * P-002 asks for a *committed* validation corpus and *reproducible repository
 * tests*. Committing PNG blobs satisfies "committed" but not "reproducible": a
 * blob cannot say what it is a picture of, and it silently rots when the encoder
 * under it changes. So the corpus is committed as CODE plus a committed digest
 * manifest (`digests.json`). Every image is regenerated from this kit at test
 * time and its SHA-256 checked against the manifest. That inverts the usual
 * fragility: a change in `pngjs`, in Node's zlib, or in this kit stops being an
 * invisible drift and becomes a loud, located test failure — which is exactly the
 * per-class *dependency health* signal P-002 is asked to record.
 *
 * This module contains no image COMPARISON of any kind. It only paints and
 * encodes fixtures. Comparison stays entirely inside the third-party engines, per
 * the plan's standing constraint that Papercusp implements no pixel mathematics,
 * CV, segmentation or clustering.
 *
 * DETERMINISM RULES (every one of these is load-bearing for the digest check)
 *   - No `Math.random`, no clock, no locale, no environment reads.
 *   - Integer geometry only; no floating-point accumulation across pixels.
 *   - Alpha blending rounds with a single, explicitly specified rule.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * `pngjs` is CommonJS with no `exports` map, and operator-core is ESM. Named-import
 * interop through the CJS lexer works for this shape today but is not guaranteed
 * across bundler/transform changes, so the require seam is explicit and local.
 * Declared as a devDependency: the corpus is test-only.
 */
const requireCjs = createRequire(import.meta.url);

interface PngInstance {
  width: number;
  height: number;
  data: Buffer;
}

type PngStatic = (new (options: { width: number; height: number }) => PngInstance) & {
  sync: {
    read(buffer: Buffer): PngInstance;
    write(png: PngInstance): Buffer;
  };
};

const { PNG } = requireCjs('pngjs') as { PNG: PngStatic };

/** An 8-bit-per-channel opaque colour. */
export type RGB = readonly [number, number, number];

/** A mutable RGBA raster. Alpha is always written as fully opaque (255). */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number, fill: RGB): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`createRaster: width/height must be positive integers, got ${width}x${height}`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const raster: Raster = { width, height, data };
  fillRect(raster, 0, 0, width, height, fill);
  return raster;
}

/**
 * Blend `colour` onto the pixel at (x, y) with the given alpha.
 *
 * The rounding rule is fixed and explicit — `Math.round` on the blended channel —
 * because any per-platform variation here would move a digest. Out-of-bounds
 * writes are dropped rather than throwing, so a shape may legitimately overhang
 * the canvas the way a real clipped render does.
 */
export function blendPixel(raster: Raster, x: number, y: number, colour: RGB, alpha = 1): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  if (alpha <= 0) return;
  const index = (raster.width * y + x) * 4;
  const { data } = raster;
  if (alpha >= 1) {
    data[index] = colour[0];
    data[index + 1] = colour[1];
    data[index + 2] = colour[2];
    data[index + 3] = 255;
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    const existing = data[index + channel] ?? 0;
    data[index + channel] = Math.round(existing * (1 - alpha) + colour[channel]! * alpha);
  }
  data[index + 3] = 255;
}

export function fillRect(
  raster: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: RGB,
  alpha = 1,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      blendPixel(raster, column, row, colour, alpha);
    }
  }
}

/** A one-pixel outline. Used for card borders, where a 1px shift is a real regression. */
export function strokeRect(
  raster: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: RGB,
): void {
  fillRect(raster, x, y, width, 1, colour);
  fillRect(raster, x, y + height - 1, width, 1, colour);
  fillRect(raster, x, y, 1, height, colour);
  fillRect(raster, x + width - 1, y, 1, height, colour);
}

/**
 * A run of evenly-pitched glyph stems, standing in for a line of text.
 *
 * Real text is the dominant source of *legitimate* pixel noise between two
 * renders of the same design: the glyph interiors agree and the glyph EDGES
 * disagree, because rasterisers antialias differently. `edgeAlpha` models exactly
 * that — it controls only the trailing edge column and row of each stem, so two
 * runs that differ only in `edgeAlpha` differ only on glyph edges, which is the
 * noise profile a commensurable reference class has to tolerate.
 *
 * `pitch` models something categorically different: when it changes, glyphs land
 * in different PLACES. That is what an AI-painted mockup does to text it
 * hallucinates, and it is why that class cannot be compared pixelwise.
 */
export interface GlyphRunOptions {
  readonly x: number;
  readonly y: number;
  readonly glyphCount: number;
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly pitch: number;
  readonly colour: RGB;
  /** Alpha applied to the trailing edge column/row of every stem. Antialiasing model. */
  readonly edgeAlpha: number;
}

export function drawGlyphRun(raster: Raster, options: GlyphRunOptions): void {
  const { x, y, glyphCount, glyphWidth, glyphHeight, pitch, colour, edgeAlpha } = options;
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const originX = x + glyph * pitch;
    // Solid core: every pixel except the trailing edge column and row.
    fillRect(raster, originX, y, glyphWidth - 1, glyphHeight - 1, colour);
    // Trailing edge column and row, softened. This is the only part that moves
    // when a rasteriser antialiases differently.
    fillRect(raster, originX + glyphWidth - 1, y, 1, glyphHeight, colour, edgeAlpha);
    fillRect(raster, originX, y + glyphHeight - 1, glyphWidth - 1, 1, colour, edgeAlpha);
  }
}

/**
 * A vertical gradient wash across the whole canvas.
 *
 * Models the global tint an image-generation model applies to a "white"
 * background: not visible to a reviewer, but every pixel differs from a real
 * render's true white. Present only in the raster-mockup class.
 */
export function applyVerticalWash(raster: Raster, top: RGB, bottom: RGB): void {
  const lastRow = Math.max(1, raster.height - 1);
  for (let row = 0; row < raster.height; row += 1) {
    const mix = row / lastRow;
    const colour: RGB = [
      Math.round(top[0] * (1 - mix) + bottom[0] * mix),
      Math.round(top[1] * (1 - mix) + bottom[1] * mix),
      Math.round(top[2] * (1 - mix) + bottom[2] * mix),
    ];
    // A wash sits UNDER the artwork in a real render, so it is applied at low
    // alpha over everything already painted rather than replacing it.
    fillRect(raster, 0, row, raster.width, 1, colour, 0.18);
  }
}

export function encodePng(raster: Raster): Buffer {
  const png = new PNG({ width: raster.width, height: raster.height });
  raster.data.forEach((value, index) => {
    png.data[index] = value;
  });
  return PNG.sync.write(png);
}

/** Decode just enough to assert dimensions in tests; never used for comparison. */
export function decodePngDimensions(buffer: Buffer): { width: number; height: number } {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Digest the RAW RGBA pixels rather than the encoded PNG bytes.
 *
 * This is the committed identity of a corpus image, and it is deliberately NOT a
 * digest of the file. PNG encoding runs through zlib, whose output can legitimately
 * differ across Node and pngjs versions without a single pixel changing — so a
 * committed digest of the FILE would fail on another machine for a reason that has
 * nothing to do with the corpus. A digest of the pixel buffer is stable under any
 * encoder change and still catches every change to the drawing code, which is the
 * only thing the pin is there to protect.
 */
export function rasterDigest(raster: Raster): string {
  return createHash('sha256')
    .update(`${raster.width}x${raster.height}:`)
    .update(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength))
    .digest('hex');
}
