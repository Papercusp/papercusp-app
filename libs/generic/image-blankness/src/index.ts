/**
 * Blank-capture detection for screenshot evidence.
 *
 * The problem this exists for: a screenshot tool can write a perfectly valid image
 * file, print its path and exit 0, while the window it grabbed never painted — an
 * unmapped window, a headless X display, a software-GL stack. The result is a file
 * that LOOKS like proof (an image path, on disk, produced by a real capture command)
 * and proves nothing. Any pipeline that accepts "an image exists" as evidence of "a UI
 * was seen" inherits that hole; this module is the cheap, local test that closes it.
 *
 * The metric is adjacent-pixel DETAIL, not uniformity. A failed grab is not always a
 * flat fill — the observed case was a smooth dark gradient, which has ~800 distinct
 * colours and would sail past any distinct-colour test, yet has essentially zero
 * high-frequency content. Real rendered UI is full of it: every glyph, border and icon
 * edge puts a large delta between horizontally adjacent pixels.
 *
 * That detail is measured PER ROW and the frame judged by its densest one, because a
 * whole-frame average answers the wrong question. Measured against 400 real captures
 * from one host, the frames a global average ranks lowest are not failures at all: a
 * small terminal window on a black desktop, or an app that painted only its menu bar.
 * Both composited fine — which is the only thing this module claims to detect — yet
 * both average out near a genuinely dead gradient. Their content is simply *local*.
 * Asking "is there ANY band of this frame carrying rendered content?" separates the two
 * populations by ~40x where the global average separated them by 2x.
 *
 * Note what this deliberately does NOT judge: whether the app rendered what you wanted.
 * A window showing nothing but its own chrome is `has-content` here, because the
 * capture pipeline demonstrably worked. Judging the app's state is the caller's job
 * (and the DOM's) — this only answers "are these pixels real?".
 *
 * Direction of failure matters and is deliberate: the only action a caller takes on
 * `blank` is a rejection, so every uncertainty resolves AWAY from `blank`. An image
 * that cannot be decoded is `undecodable`; one too small to judge is `inconclusive`;
 * neither is ever reported as blank.
 */

import { decodePng } from './png.js';

export type BlanknessVerdict =
  /** Confidently empty: decoded fine, carries no perceptible visual content. */
  | 'blank'
  /** Confidently non-empty: decoded fine, carries real detail. */
  | 'has-content'
  /** Not a format this detector reads (or corrupt/truncated) — judge by other means. */
  | 'undecodable'
  /** Decoded, but too small a sample to make a confident call. */
  | 'inconclusive';

export interface BlanknessThresholds {
  /**
   * The frame carries content if its DENSEST row has at least this fraction of its
   * horizontally-adjacent pixel pairs separated by an edge. Per-row, not whole-frame:
   * see the module comment for why the average is the wrong question.
   */
  minPeakRowDetail: number;
  /** Luma difference (0-255) between adjacent pixels that counts as an edge. */
  detailLumaDelta: number;
  /** Images smaller than this many pixels are reported `inconclusive`, never `blank`. */
  minJudgeableArea: number;
}

/**
 * Calibrated against 400 real captures from one workstation, not chosen by feel.
 *
 * The two populations do not overlap, and they are not close. Every genuinely dead
 * capture in that corpus — the failed Tauri grabs, the unpainted console windows —
 * scores EXACTLY 0.00000: a gradient or a flat fill has no sharp step anywhere, by
 * definition. The sparsest frame that really did composite (a boot screen: one logo
 * and a progress bar on black) scores 0.00938. The floor sits between them, an order
 * of magnitude clear of both.
 *
 * Read literally, `minPeakRowDetail: 0.001` says: across a 1280-wide frame, not one
 * row anywhere contains even two adjacent pixels with a visible step between them.
 * Nothing was drawn. Anything at all — a single window border, one glyph — clears it.
 */
export const DEFAULT_BLANKNESS_THRESHOLDS: Readonly<BlanknessThresholds> = Object.freeze({
  minPeakRowDetail: 0.001,
  detailLumaDelta: 8,
  minJudgeableArea: 4096,
});

let configuredThresholds: BlanknessThresholds = { ...DEFAULT_BLANKNESS_THRESHOLDS };

/**
 * Host seam: override the defaults process-wide. Callers that want a one-off override
 * should pass thresholds to {@link analyzeImageBlankness} instead of reconfiguring.
 */
export function configureImageBlankness(overrides: Partial<BlanknessThresholds>): BlanknessThresholds {
  configuredThresholds = { ...configuredThresholds, ...overrides };
  return { ...configuredThresholds };
}

/** Reset the process-wide thresholds to the shipped defaults. */
export function resetImageBlanknessConfig(): void {
  configuredThresholds = { ...DEFAULT_BLANKNESS_THRESHOLDS };
}

export interface BlanknessReport {
  verdict: BlanknessVerdict;
  /** One line, safe to show a human or fold into an error message. */
  reason: string;
  width?: number;
  height?: number;
  /** Distinct colours in the frame, quantised to 5 bits per channel (capped). */
  distinctColors?: number;
  /** Share of pixels held by the single most common quantised colour. */
  dominantFraction?: number;
  /** Share of ALL adjacent pixel pairs separated by a perceptible edge. */
  detailFraction?: number;
  /** Share of adjacent pairs in the DENSEST single row — the metric the verdict uses. */
  peakRowDetail?: number;
  /** Row index carrying `peakRowDetail`, so a caller can point at what it found. */
  peakRowIndex?: number;
}

/** Cap on the colour histogram — past this the image is self-evidently not flat. */
const COLOR_HISTOGRAM_CAP = 4096;

function luma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * Judge whether an image carries visual content. Accepts raw file bytes; currently
 * decodes PNG and reports everything else `undecodable`.
 */
export function analyzeImageBlankness(
  bytes: Uint8Array,
  overrides?: Partial<BlanknessThresholds>,
): BlanknessReport {
  const cfg: BlanknessThresholds = { ...configuredThresholds, ...overrides };

  if (!bytes || bytes.length === 0) {
    return { verdict: 'undecodable', reason: 'empty file (0 bytes)' };
  }

  const decoded = decodePng(bytes);
  if (!decoded) {
    return {
      verdict: 'undecodable',
      reason: 'not a PNG this detector reads (interlaced, corrupt, or another format) — judged by other means',
    };
  }

  const { width, height, rgb } = decoded;
  const area = width * height;
  if (area < cfg.minJudgeableArea) {
    return {
      verdict: 'inconclusive',
      reason: `image is ${width}x${height} (${area}px) — below the ${cfg.minJudgeableArea}px floor for a confident call`,
      width,
      height,
    };
  }

  // Every row is scanned rather than sampled. The decode already touched every pixel,
  // so the extra pass is cheap — and sampling would risk stepping straight over a
  // content band only a few pixels tall, which is the one mistake that turns into a
  // false `blank` and therefore a wrongly rejected close.
  const histogram = new Map<number, number>();
  let histogramCapped = false;
  let adjacentPairs = 0;
  let detailPairs = 0;
  let peakRowDetail = 0;
  let peakRowIndex = 0;

  for (let y = 0; y < height; y += 1) {
    let previousLuma = -1;
    let rowDetail = 0;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];

      if (!histogramCapped) {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const seen = histogram.get(key);
        if (seen === undefined && histogram.size >= COLOR_HISTOGRAM_CAP) histogramCapped = true;
        else histogram.set(key, (seen ?? 0) + 1);
      }

      const l = luma(r, g, b);
      if (previousLuma >= 0 && Math.abs(l - previousLuma) >= cfg.detailLumaDelta) rowDetail += 1;
      previousLuma = l;
    }
    if (width > 1) {
      adjacentPairs += width - 1;
      detailPairs += rowDetail;
      const fraction = rowDetail / (width - 1);
      if (fraction > peakRowDetail) {
        peakRowDetail = fraction;
        peakRowIndex = y;
      }
    }
  }

  const detailFraction = adjacentPairs > 0 ? detailPairs / adjacentPairs : 0;
  const distinctColors = histogramCapped ? COLOR_HISTOGRAM_CAP : histogram.size;
  let dominantCount = 0;
  for (const count of histogram.values()) if (count > dominantCount) dominantCount = count;
  // Once the histogram is capped this is the most common of the first COLOR_HISTOGRAM_CAP
  // colours rather than of all of them — a fine approximation, since an image with that
  // many distinct colours has no meaningful dominant one anyway.
  const dominantFraction = dominantCount / (width * height);

  const stats = { width, height, distinctColors, dominantFraction, detailFraction, peakRowDetail, peakRowIndex };

  if (adjacentPairs === 0) {
    return { verdict: 'inconclusive', reason: 'no adjacent pixel pairs to compare', ...stats };
  }

  if (peakRowDetail < cfg.minPeakRowDetail) {
    const shape =
      distinctColors <= 2
        ? `a flat ${distinctColors === 1 ? 'single-colour' : 'two-colour'} fill`
        : 'a smooth gradient / empty background';
    return {
      verdict: 'blank',
      reason:
        `${width}x${height} capture carries no rendered content anywhere — ${shape} ` +
        `(its densest row is only ${(peakRowDetail * 100).toFixed(3)}% edges, floor ` +
        `${(cfg.minPeakRowDetail * 100).toFixed(3)}%). The window did not paint.`,
      ...stats,
    };
  }

  return {
    verdict: 'has-content',
    reason:
      `${width}x${height} capture carries rendered content ` +
      `(row ${peakRowIndex} is ${(peakRowDetail * 100).toFixed(1)}% edges; ${distinctColors} distinct colours)`,
    ...stats,
  };
}

export { decodePng } from './png.js';
export type { DecodedPng } from './png.js';
