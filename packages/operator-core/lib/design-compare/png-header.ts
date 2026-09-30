/**
 * PNG header reading — dimensions only, no decode.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-005).
 *
 * The adapter has to know a reference image's dimensions for two ratified
 * reasons, and it has to know them BEFORE any engine is invoked:
 *
 *  - D-005 / D-010 consequence 2: unequal dimensions are refused in the ADAPTER.
 *    lost-pixel's pixelmatch path silently resizes both images to a max-box and
 *    compares anyway; odiff with `failOnLayoutDiff:false` compares only the
 *    OVERLAPPING region and reports a clean match. Both normalise a geometry
 *    error away, so the refusal cannot live in engine configuration.
 *  - D-010 consequence 4: the denominator is the reference image's own decoded
 *    dimensions, never an engine percentage, because the two engines disagree
 *    about the denominator in exactly the unequal-dimension case that matters.
 *
 * This reads the IHDR chunk and stops. It is byte-field parsing of a header, not
 * image decoding: no pixel is ever examined, which keeps it inside D-002's
 * boundary ("Papercusp must contain no pixel math, CV, segmentation or
 * clustering implementation") by a wide margin.
 *
 * It deliberately does NOT use `pngjs`. pngjs is an operator-core devDependency
 * — it exists for the P-002 corpus, which is test-land — and production code may
 * not depend on a devDependency. The corpus's own `decodePngDimensions` performs
 * a FULL pngjs decode; `png-header.test.ts` asserts the two agree on every
 * committed corpus image, so this parser is cross-validated against a real
 * decoder rather than merely believed.
 */

/** `\x89PNG\r\n\x1a\n` — the 8-byte signature every PNG opens with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** signature (8) + chunk length (4) + chunk type (4) + width (4) + height (4). */
const MINIMUM_HEADER_BYTES = 24;

const IHDR_TYPE_OFFSET = 12;
const WIDTH_OFFSET = 16;
const HEIGHT_OFFSET = 20;

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

/** Thrown when bytes are not a PNG we can read dimensions from. */
export class PngHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngHeaderError';
  }
}

/**
 * Read `width` and `height` from a PNG's IHDR chunk.
 *
 * Throws `PngHeaderError` rather than returning a sentinel: a caller that cannot
 * establish the reference's dimensions must refuse the comparison, and a `0` or
 * `null` slipped into a denominator is precisely how a meaningless ratio reaches
 * a gate. `readPngDimensionsSafe` is the non-throwing form for probe seams.
 */
export function readPngDimensions(buffer: Buffer): PngDimensions {
  if (buffer.length < MINIMUM_HEADER_BYTES) {
    throw new PngHeaderError(
      `not a readable PNG: ${buffer.length} byte(s), need at least ${MINIMUM_HEADER_BYTES} for the IHDR header`,
    );
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new PngHeaderError('not a readable PNG: signature mismatch');
  }
  const chunkType = buffer.subarray(IHDR_TYPE_OFFSET, IHDR_TYPE_OFFSET + 4).toString('latin1');
  if (chunkType !== 'IHDR') {
    throw new PngHeaderError(
      `not a readable PNG: first chunk is '${chunkType}', expected 'IHDR' (PNG requires IHDR first)`,
    );
  }
  const width = buffer.readUInt32BE(WIDTH_OFFSET);
  const height = buffer.readUInt32BE(HEIGHT_OFFSET);
  if (width <= 0 || height <= 0) {
    throw new PngHeaderError(
      `not a readable PNG: IHDR declares a degenerate size ${width}x${height}`,
    );
  }
  return { width, height };
}

export type PngDimensionsOutcome =
  | { readonly ok: true; readonly dimensions: PngDimensions }
  | { readonly ok: false; readonly detail: string };

/** Non-throwing `readPngDimensions`, for probe seams that report rather than raise. */
export function readPngDimensionsSafe(buffer: Buffer): PngDimensionsOutcome {
  try {
    return { ok: true, dimensions: readPngDimensions(buffer) };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
