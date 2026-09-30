/**
 * The P-002 engine-proof harness.
 *
 * This drives the ACTUAL installed comparison engines against the corpus. It is
 * the rig that turns the plan's engine assumptions into measurements, and it is
 * deliberately thin: it materialises fixtures, invokes lost-pixel's own exported
 * comparators, and normalises what comes back. It computes no pixel differences
 * of its own.
 *
 * TWO INVOCATION RULES ARE BAKED IN HERE, AND BOTH ARE GATE-INTEGRITY FIXES
 * -------------------------------------------------------------------------
 * 1. ALWAYS pass a difference path. `compareImagesViaPixelmatch` only performs a
 *    real threshold check when `pixelDifference > 0 && differenceShotPath`; every
 *    other path returns `isWithinThreshold: true` unconditionally. Invoked without
 *    a difference path it reports a PASS for images that differ completely. It
 *    fails OPEN (D-008 finding 4).
 *
 * 2. ALWAYS invoke at threshold 0, then apply policy to the raw counts ourselves.
 *    Two independent reasons:
 *      - The engine's own verdict is not trustworthy (rule 1), so we recompute.
 *      - The pixelmatch path writes the difference artifact ONLY when its verdict
 *        is "above threshold". Invoked at the operator's 0.05, a diff our stricter
 *        policy would FAIL produces no artifact to show a reviewer. At threshold 0
 *        any non-zero difference is above threshold, so the artifact always exists
 *        whenever there is anything to look at.
 *
 * The denominator is taken from the REFERENCE image's own decoded dimensions, not
 * from either engine. The engines disagree about the denominator whenever
 * dimensions differ (odiff uses the baseline area, pixelmatch uses the max-box
 * area after its silent resize), which makes an engine-reported percentage
 * meaningless in exactly the case that matters most.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { SEPARATION_FLOOR } from '../policy-shape';
import { CORPUS_IMAGES, imageByKey } from './cases';
import { decodePngDimensions, encodePng, sha256 } from './synthesize';

// Compatibility export for calibration callers; the authority lives in the
// production-safe policy-shape module so policy.ts never imports test corpus.
export { SEPARATION_FLOOR };

const requireCjs = createRequire(import.meta.url);

/** The exact shape lost-pixel 3.22.0 returns from every comparator. */
export interface LostPixelComparison {
  pixelDifference: number;
  pixelDifferencePercentage: number;
  isWithinThreshold: boolean;
}

interface LostPixelCompareModule {
  checkThreshold(threshold: number, pixelsTotal: number, pixelDifference: number): boolean;
  compareImagesViaPixelmatch(
    threshold: number,
    baselineShotPath: string,
    currentShotPath: string,
    differenceShotPath?: string,
  ): Promise<LostPixelComparison>;
  compareImagesViaOdiff(
    threshold: number,
    baselineShotPath: string,
    currentShotPath: string,
    differenceShotPath: string,
  ): Promise<LostPixelComparison>;
}

/**
 * Deep-imported on purpose. `compareImages` — the dispatcher — reads lost-pixel's
 * global `config` singleton to choose an engine, which would make this harness
 * depend on a loaded lost-pixel project config. The two concrete comparators take
 * everything they need as arguments, so the proof pins engine behaviour rather
 * than configuration behaviour. Which engine the dispatcher would have CHOSEN is
 * asserted separately, from the config default.
 */
export const lostPixelCompare = requireCjs(
  'lost-pixel/dist/compare/compare.js',
) as LostPixelCompareModule;

export const ENGINES = ['pixelmatch', 'odiff'] as const;
export type EngineId = (typeof ENGINES)[number];

/**
 * lost-pixel dispatches to pixelmatch ONLY when `config.compareEngine === 'pixelmatch'`
 * and otherwise falls through to odiff. No `lostpixel.config.ts` in this repo sets
 * `compareEngine`, so odiff is what actually runs in CI today.
 */
export const LOST_PIXEL_DEFAULT_ENGINE: EngineId = 'odiff';

export function engineVersions(): Record<EngineId | 'lost-pixel' | 'pngjs', string> {
  const read = (name: string): string =>
    (requireCjs(`${name}/package.json`) as { version: string }).version;
  return {
    'lost-pixel': read('lost-pixel'),
    pixelmatch: read('pixelmatch'),
    odiff: read('odiff-bin'),
    pngjs: read('pngjs'),
  };
}

export interface MaterialisedCorpus {
  readonly dir: string;
  readonly paths: ReadonlyMap<string, string>;
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * Render every corpus image to `dir` and return its path and content digest.
 * Regenerating rather than reading committed blobs is what makes the digest
 * assertion meaningful — see the header of `synthesize.ts`.
 */
export function materialiseCorpus(dir: string): MaterialisedCorpus {
  const paths = new Map<string, string>();
  const digests = new Map<string, string>();
  for (const image of CORPUS_IMAGES) {
    const target = path.join(dir, `${image.key}.png`);
    mkdirSync(path.dirname(target), { recursive: true });
    const buffer = encodePng(image.render());
    writeFileSync(target, buffer);
    paths.set(image.key, target);
    digests.set(image.key, sha256(buffer));
  }
  return { dir, paths, digests };
}

export interface MeasuredComparison {
  readonly engine: EngineId;
  /** Raw differing-pixel count as the engine reported it. */
  readonly pixelDifference: number;
  /** Denominator taken from the reference image itself, never from the engine. */
  readonly pixelsTotal: number;
  /** `pixelDifference / pixelsTotal`, recomputed by us under our own denominator. */
  readonly diffRatio: number;
  /** What the engine claimed. Advisory only — never a verdict source. */
  readonly engineReportedWithinThreshold: boolean;
  /** What the engine claimed the percentage was. Recorded to expose divergence. */
  readonly engineReportedPercentage: number;
  /** Whether a difference artifact actually landed on disk. */
  readonly diffArtifactWritten: boolean;
  readonly elapsedMs: number;
}

export interface CompareOptions {
  /**
   * Threshold handed to the engine. Defaults to 0 so the engine always treats any
   * difference as above-threshold and therefore always writes the artifact. Only
   * the engine-behaviour proofs override this.
   */
  readonly threshold?: number;
  /**
   * Set false ONLY to demonstrate the fail-open hazard. Production callers must
   * never omit the difference path.
   */
  readonly withDiffPath?: boolean;
}

export async function compareWithEngine(
  engine: EngineId,
  referencePath: string,
  candidatePath: string,
  diffPath: string,
  options: CompareOptions = {},
): Promise<MeasuredComparison> {
  const threshold = options.threshold ?? 0;
  const withDiffPath = options.withDiffPath ?? true;
  const { readFileSync, existsSync, rmSync } = await import('node:fs');

  if (existsSync(diffPath)) rmSync(diffPath);
  mkdirSync(path.dirname(diffPath), { recursive: true });

  const referenceDimensions = decodePngDimensions(readFileSync(referencePath));
  const pixelsTotal = referenceDimensions.width * referenceDimensions.height;

  const startedAt = process.hrtime.bigint();
  const raw =
    engine === 'pixelmatch'
      ? await lostPixelCompare.compareImagesViaPixelmatch(
          threshold,
          referencePath,
          candidatePath,
          withDiffPath ? diffPath : undefined,
        )
      : await lostPixelCompare.compareImagesViaOdiff(
          threshold,
          referencePath,
          candidatePath,
          diffPath,
        );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    engine,
    pixelDifference: raw.pixelDifference,
    pixelsTotal,
    diffRatio: raw.pixelDifference / pixelsTotal,
    engineReportedWithinThreshold: raw.isWithinThreshold,
    engineReportedPercentage: raw.pixelDifferencePercentage,
    diffArtifactWritten: existsSync(diffPath),
    elapsedMs,
  };
}

/**
 * The calibration statistic behind D-007.
 *
 * A gate is only usable when a faithful implementation's diff sits far enough
 * below a real regression's diff that a threshold can be placed between them and
 * survive real-world noise. `separation` is how many times larger the regression's
 * diff is than the noise floor. Below `SEPARATION_FLOOR` there is no honest place
 * to put a threshold, and a gate placed there would either pass regressions or
 * fail correct work — the second of which is worse, because it is the failure mode
 * agents learn to mask around.
 *
 * A faithful diff of exactly zero means the noise floor is unmeasurable rather
 * than infinitely good, so it is reported as `Infinity` separation only when the
 * regression is itself non-zero, and as `NaN` when neither differs at all.
 */
export interface ClassCalibration {
  readonly referenceClass: string;
  readonly engine: EngineId;
  readonly faithfulRatio: number;
  readonly driftedRatio: number;
  readonly separation: number;
  readonly gateable: boolean;
}

export function calibrate(
  referenceClass: string,
  engine: EngineId,
  faithfulRatio: number,
  driftedRatio: number,
): ClassCalibration {
  let separation: number;
  if (faithfulRatio === 0 && driftedRatio === 0) separation = Number.NaN;
  else if (faithfulRatio === 0) separation = Number.POSITIVE_INFINITY;
  else separation = driftedRatio / faithfulRatio;
  return {
    referenceClass,
    engine,
    faithfulRatio,
    driftedRatio,
    separation,
    gateable: Number.isFinite(separation)
      ? separation >= SEPARATION_FLOOR
      : separation === Number.POSITIVE_INFINITY,
  };
}

/**
 * Invoke `pixelmatch` DIRECTLY, with options stated explicitly.
 *
 * lost-pixel's comparator signature accepts only a threshold and three paths, so
 * the options that actually decide what counts as a difference — pixelmatch's
 * `includeAA`, odiff's colour tolerance — are unreachable through it. This seam
 * exists to measure how much those hidden defaults suppress, which is the
 * evidence for whether a versioned policy can be expressed through lost-pixel at
 * all.
 *
 * This is still the third-party engine doing the comparison. Papercusp supplies
 * arguments and reads counts; it computes no pixel differences.
 */
export interface DirectPixelmatchOptions {
  /** Colour-distance threshold, 0..1. pixelmatch's own default is 0.1. */
  readonly threshold?: number;
  /** When false (pixelmatch's default), antialiasing-detected pixels are SKIPPED. */
  readonly includeAA?: boolean;
}

export interface DirectPixelmatchResult {
  readonly pixelDifference: number;
  readonly pixelsTotal: number;
  readonly diffRatio: number;
}

export function comparePixelmatchDirect(
  referencePath: string,
  candidatePath: string,
  options: DirectPixelmatchOptions = {},
): DirectPixelmatchResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pixelmatch = requireCjs('pixelmatch') as (
    a: Buffer,
    b: Buffer,
    output: Buffer | null,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ) => number;
  const { PNG } = requireCjs('pngjs') as {
    PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = requireCjs('node:fs') as { readFileSync(p: string): Buffer };

  const reference = PNG.sync.read(readFileSync(referencePath));
  const candidate = PNG.sync.read(readFileSync(candidatePath));
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `comparePixelmatchDirect: dimension mismatch ${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`,
    );
  }
  const pixelsTotal = reference.width * reference.height;
  const pixelDifference = pixelmatch(
    reference.data,
    candidate.data,
    null,
    reference.width,
    reference.height,
    { threshold: options.threshold ?? 0, includeAA: options.includeAA ?? false },
  );
  return { pixelDifference, pixelsTotal, diffRatio: pixelDifference / pixelsTotal };
}

export function pairDiffPath(dir: string, engine: EngineId, id: string): string {
  return path.join(dir, 'diff', engine, `${id.replace(/\//g, '_')}.png`);
}

export { imageByKey };
