/**
 * Mockup-to-implementation validation: the comparison-provider adapter.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-005).
 *
 * This is the seam between Papercusp's contract (`contract.ts`, P-001) and a
 * third-party comparison engine. It supplies arguments, reads counts, and
 * normalises what comes back into a `CompareResult`. It performs no image
 * comparison of any kind: no pixel mathematics, computer vision, segmentation or
 * clustering (D-002). The only bytes it reads are a PNG's IHDR header, to learn
 * the dimensions the contract needs.
 *
 * ─── WHY THIS FILE IS SHAPED THE WAY IT IS ───────────────────────────────────
 *
 * D-010 was measured by RUNNING the installed engines (lost-pixel 3.22.0,
 * pixelmatch 5.3.0, odiff-bin 2.6.1) against the committed P-002 corpus, and it
 * found that the engine which actually runs in this repo today is unfit. It
 * imposes seven mandatory consequences on this adapter. Each is implemented
 * here, and each is cited at its implementation site:
 *
 *  1. SELECT pixelmatch explicitly. lost-pixel's `compareImages` dispatcher
 *     falls through to odiff unless a loaded `lostpixel.config.ts` sets
 *     `compareEngine: 'pixelmatch'`, and no config in this repo sets it. This
 *     adapter never calls the dispatcher at all — it calls the pixelmatch
 *     comparator directly, so engine identity is a property of the code rather
 *     than of ambient configuration.
 *  2. REFUSE unequal dimensions in the adapter, before any engine call. Both
 *     engines normalise a geometry error away (pixelmatch silently resizes to a
 *     max-box; odiff at `failOnLayoutDiff:false` compares only the overlap and
 *     returns `match:true`). This refusal cannot live in engine configuration.
 *  3. ALWAYS pass a difference path AND invoke at threshold 0. Without a
 *     difference path the pixelmatch path returns `isWithinThreshold: true`
 *     unconditionally — it fails OPEN (D-008 finding 4). And it writes the diff
 *     artifact only when its own verdict is above-threshold, so at any inherited
 *     non-zero threshold a difference our stricter policy would FAIL leaves a
 *     reviewer nothing to look at.
 *  4. TAKE THE DENOMINATOR from the reference image's own decoded dimensions.
 *     The engines disagree about the denominator in exactly the unequal-dimension
 *     case that matters most, so an engine percentage is never a ratio source.
 *  5. CATCH EVERYTHING the provider seam throws, whatever its type or message,
 *     and map it to `invalid` / `engine-error`. D-010 finding 13: broken inputs
 *     produce four distinct throw shapes across the two engines — one a
 *     `TypeError`, one an OCaml "internal error, uncaught exception" from the
 *     native binary — and lost-pixel's own `Error("Couldn't compare images")` is
 *     NEVER REACHED, so an adapter keying on that message catches nothing.
 *  6. TREAT meta.json AS A PARTIAL INDEX. `LOST_PIXEL_GENERATE_META` omits any
 *     shot that had no baseline (`checkDifferences` returns early, before the
 *     metadata write), so absence there is indistinguishable from "compared and
 *     identical". Reconcile against the expected shot set; never iterate its keys
 *     as the population.
 *  7. RECORD engine id and version on EVERY result, including refusals that never
 *     reached an engine. A result without them is uninterpretable.
 *
 * ─── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * `looks-same` region output. P-005 admits it "only if P-002 proves it necessary
 * and suitable"; D-011 records that P-002 does not, and that looks-same is
 * neither installed nor declared anywhere in this repo. Its two draws were
 * antialiasing handling and `diffBounds`/`diffClusters` region output; the first
 * is answered (both installed engines already suppress antialiasing by default —
 * D-010 findings 9 and 10), and the second would add a third engine's hidden
 * heuristics to a result the contract already carries a `diffRegions` field for.
 * So `diffRegions` stays unset by this adapter, and the field remains reserved
 * for an engine that produces regions natively. Papercusp never computes them.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  COMPARE_RESULT_SCHEMA_VERSION,
  computeVerdict,
  type CaptureEnvironment,
  type CompareResult,
  type EngineCounts,
  type EngineIdentity,
  type ImplementationTarget,
  type InvalidReason,
  type ReferenceIdentity,
  type ThresholdPolicy,
} from './contract';
import { readPngDimensionsSafe, type PngDimensions } from './png-header';

// ─── the engine seam ─────────────────────────────────────────────────────────

/**
 * The threshold the engine is ALWAYS invoked at (D-010 consequence 3).
 *
 * Zero is not a policy — the policy is applied afterwards by `computeVerdict`
 * over raw counts. Zero is what makes every non-zero difference "above
 * threshold" in the engine's own terms, which is the only way to guarantee the
 * difference artifact is written whenever there is anything to show.
 */
export const ENGINE_INVOCATION_THRESHOLD = 0;

export interface ProviderRequest {
  readonly referenceImagePath: string;
  readonly actualImagePath: string;
  /** Required, never optional — see D-010 consequence 3 / D-008 finding 4. */
  readonly diffImagePath: string;
  readonly threshold: number;
}

/**
 * What a provider reports back. Note what is NOT here: any notion of pass/fail
 * that Papercusp would act on. `engineReportedWithinThreshold` and
 * `engineReportedPercentage` are recorded for forensics and drift detection
 * only (D-008); the verdict and the ratio are computed from `pixelDifference`
 * against our own denominator.
 */
export interface ProviderComparison {
  readonly pixelDifference: number;
  readonly engineReportedWithinThreshold?: boolean;
  readonly engineReportedPercentage?: number;
  readonly diffArtifactWritten?: boolean;
}

export interface ComparisonProvider {
  /** Stamped on every result this provider participates in (consequence 7). */
  readonly engine: EngineIdentity;
  compare(request: ProviderRequest): Promise<ProviderComparison>;
}

// ─── the image probe seam ────────────────────────────────────────────────────

export type ImageProbeResult =
  | { readonly exists: true; readonly dimensions: PngDimensions }
  | { readonly exists: true; readonly dimensions?: undefined; readonly detail: string }
  | { readonly exists: false; readonly detail: string };

export type ImageProbe = (imagePath: string) => ImageProbeResult;

/**
 * The real probe: read the file, parse its IHDR header, report.
 *
 * A missing file and an unreadable one are distinguished on purpose. "The
 * reference was never produced" and "the reference is corrupt" are different
 * failures with different owners, and collapsing them into one message is how a
 * capture pipeline bug gets filed against the ratification pipeline.
 */
export const filesystemImageProbe: ImageProbe = (imagePath) => {
  let buffer: Buffer;
  try {
    buffer = readFileSync(imagePath);
  } catch (error) {
    return {
      exists: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const outcome = readPngDimensionsSafe(buffer);
  return outcome.ok
    ? { exists: true, dimensions: outcome.dimensions }
    : { exists: true, detail: outcome.detail };
};

// ─── the adapter ─────────────────────────────────────────────────────────────

export interface ComparisonRequest {
  readonly reference: ReferenceIdentity;
  readonly target: ImplementationTarget;
  readonly environment: CaptureEnvironment;
  readonly policy: ThresholdPolicy;

  readonly referenceImagePath: string;
  readonly actualImagePath: string;
  /** Required. A comparison with nowhere to write its difference is not run. */
  readonly diffImagePath: string;

  /**
   * The dimensions the capture contract says both images must have, when the
   * caller knows them. D-005 refuses "a reference/capture dimension OR VIEWPORT
   * mismatch"; the image-vs-image half is always checked, and this is the half
   * only the capture adapter (P-004) can supply, because the relation between a
   * declared viewport and a produced image is that adapter's business, not this
   * one's. Omitted ⇒ only the image-vs-image check runs.
   */
  readonly expectedDimensions?: PngDimensions;

  readonly capturedAt: string;
  /** Wall-clock budget for the engine call. Omitted ⇒ no adapter-imposed budget. */
  readonly timeoutMs?: number;
  readonly advisoryNotes?: string;
}

export interface ComparisonDeps {
  readonly provider: ComparisonProvider;
  /** Defaults to `filesystemImageProbe`. Injected in tests for determinism. */
  readonly probe?: ImageProbe;
}

interface RefusalInput {
  readonly request: ComparisonRequest;
  readonly engine: EngineIdentity;
  readonly reason: InvalidReason;
  readonly detail: string;
  readonly counts?: EngineCounts;
  readonly diffRatio?: number;
}

/**
 * Build an `invalid` result.
 *
 * `engine` is a required argument rather than an optional flourish: consequence
 * 7 makes engine identity mandatory on EVERY result, and the refusal paths are
 * exactly the ones where it is easiest to forget, because no engine ran. A
 * refusal that cannot say which engine's contract it was refusing on behalf of
 * is not interpretable evidence.
 */
function refuse({ request, engine, reason, detail, counts, diffRatio }: RefusalInput): CompareResult {
  return {
    schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
    verdict: 'invalid',
    invalidReason: reason,
    detail,
    reference: request.reference,
    target: request.target,
    environment: request.environment,
    engine,
    policy: request.policy,
    ...(counts ? { counts } : {}),
    ...(diffRatio !== undefined ? { diffRatio } : {}),
    capturedAt: request.capturedAt,
    ...(request.advisoryNotes ? { advisoryNotes: request.advisoryNotes } : {}),
  };
}

function describeDimensions(d: PngDimensions): string {
  return `${d.width}x${d.height}`;
}

/** Marker for the adapter's own deadline, so it maps to `engine-timeout`, not `engine-error`. */
class EngineTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`engine call exceeded the ${timeoutMs}ms budget`);
    this.name = 'EngineTimeoutError';
  }
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EngineTimeoutError(timeoutMs)), timeoutMs);
        // Never hold the process open for a race we may not need to finish.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Describe an unknown thrown value without trusting it to be an `Error`.
 *
 * D-010 finding 13 measured four different throw shapes across the two engines,
 * including a non-`Error` and a native-binary message. Anything that reads
 * `error.message` directly, or matches on a known string, silently produces
 * `undefined` or misses. This never does either.
 */
export function describeThrown(error: unknown): string {
  try {
    if (typeof error === 'string') return `thrown string: ${error}`;
    if (error === undefined) return 'thrown undefined';
    if (error === null) return 'thrown null';

    if (error instanceof Error) {
      // `name` and `message` are ordinary properties and can be accessors that
      // throw. Reading them defensively is not paranoia: a describer that can
      // throw turns "catch everything" into "catch almost everything", which is
      // the same unhandled rejection consequence 5 exists to prevent — and the
      // failure would land in the catch block, where there is nothing left to
      // catch it. Found by this file's own hostile-object case.
      const name = readStringProperty(error, 'name') ?? 'Error';
      const message = readStringProperty(error, 'message');
      return message ? `${name}: ${message}` : name;
    }

    if (typeof error === 'object') {
      const message = readStringProperty(error, 'message');
      if (message) return `thrown object: ${message}`;
      try {
        return `thrown object: ${JSON.stringify(error)}`;
      } catch {
        return 'thrown object: <unserialisable>';
      }
    }

    return `thrown ${typeof error}: ${String(error)}`;
  } catch {
    return 'thrown value: <undescribable>';
  }
}

/** Read a string property without trusting the object not to fight back. */
function readStringProperty(source: object, key: string): string | undefined {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one comparison and normalise it into the contract.
 *
 * The ordering of the guards is load-bearing, not stylistic. Every precondition
 * that can be established WITHOUT an engine is established first, so a geometry
 * or missing-input error can never be laundered through an engine that would
 * have normalised it away.
 */
export async function compareAgainstReference(
  request: ComparisonRequest,
  deps: ComparisonDeps,
): Promise<CompareResult> {
  const { provider } = deps;
  const probe = deps.probe ?? filesystemImageProbe;
  // Read up-front so EVERY exit below — including the ones that never reach an
  // engine — can stamp it (consequence 7).
  const engine = provider.engine;

  if (!request.diffImagePath) {
    return refuse({
      request,
      engine,
      reason: 'unsupported-input',
      detail:
        'no difference-image path was supplied. The pixelmatch comparator returns ' +
        'isWithinThreshold:true unconditionally when invoked without one (D-008 finding 4), ' +
        'so a comparison without a difference path is refused rather than run.',
    });
  }

  if (request.policy.referenceClass !== request.reference.referenceClass) {
    return refuse({
      request,
      engine,
      reason: 'unsupported-input',
      detail:
        `policy ${request.policy.policyVersion} is calibrated for reference class ` +
        `'${request.policy.referenceClass}' but the reference is class ` +
        `'${request.reference.referenceClass}'. D-007 scopes gating per class; applying one ` +
        `class's threshold to another is how an advisory-only class acquires a gate it was ` +
        `never calibrated for.`,
    });
  }

  const referenceProbe = probe(request.referenceImagePath);
  if (!referenceProbe.exists) {
    return refuse({
      request,
      engine,
      reason: 'missing-reference',
      detail: `reference image is not readable at ${request.referenceImagePath}: ${referenceProbe.detail}`,
    });
  }
  if (!referenceProbe.dimensions) {
    return refuse({
      request,
      engine,
      reason: 'unsupported-input',
      detail: `reference image at ${request.referenceImagePath} is unreadable: ${referenceProbe.detail}`,
    });
  }

  const actualProbe = probe(request.actualImagePath);
  if (!actualProbe.exists) {
    return refuse({
      request,
      engine,
      reason: 'missing-capture',
      detail: `capture image is not readable at ${request.actualImagePath}: ${actualProbe.detail}`,
    });
  }
  if (!actualProbe.dimensions) {
    return refuse({
      request,
      engine,
      reason: 'unsupported-input',
      detail: `capture image at ${request.actualImagePath} is unreadable: ${actualProbe.detail}`,
    });
  }

  const referenceDimensions = referenceProbe.dimensions;
  const actualDimensions = actualProbe.dimensions;

  // D-010 consequence 2 / D-005. BEFORE any engine call, unconditionally.
  if (
    referenceDimensions.width !== actualDimensions.width ||
    referenceDimensions.height !== actualDimensions.height
  ) {
    return refuse({
      request,
      engine,
      reason: 'dimension-mismatch',
      detail:
        `reference is ${describeDimensions(referenceDimensions)} but the capture is ` +
        `${describeDimensions(actualDimensions)}. Neither installed engine reports this as a ` +
        `failure — pixelmatch silently resizes both to a max-box, and odiff at ` +
        `failOnLayoutDiff:false compares only the overlapping region and returns match:true — ` +
        `so the adapter refuses it before invocation (D-005, D-010 consequence 2).`,
    });
  }

  if (request.expectedDimensions) {
    const expected = request.expectedDimensions;
    if (
      expected.width !== referenceDimensions.width ||
      expected.height !== referenceDimensions.height
    ) {
      return refuse({
        request,
        engine,
        reason: 'environment-mismatch',
        detail:
          `the capture contract declares ${describeDimensions(expected)} but both images are ` +
          `${describeDimensions(referenceDimensions)}. The pair agrees with itself and disagrees ` +
          `with the environment it claims to have been produced at, so it is evidence about a ` +
          `different render (D-005).`,
      });
    }
  }

  // D-010 consequence 4. Our denominator, from the reference itself.
  const pixelsTotal = referenceDimensions.width * referenceDimensions.height;

  let comparison: ProviderComparison;
  try {
    comparison = await withDeadline(
      provider.compare({
        referenceImagePath: request.referenceImagePath,
        actualImagePath: request.actualImagePath,
        diffImagePath: request.diffImagePath,
        threshold: ENGINE_INVOCATION_THRESHOLD, // consequence 3
      }),
      request.timeoutMs,
    );
  } catch (error) {
    // D-010 consequence 5: EVERY throw, whatever its type or message.
    if (error instanceof EngineTimeoutError) {
      return refuse({
        request,
        engine,
        reason: 'engine-timeout',
        detail: `${engine.engine} ${engine.engineVersion}: ${error.message}`,
      });
    }
    return refuse({
      request,
      engine,
      reason: 'engine-error',
      detail: `${engine.engine} ${engine.engineVersion} threw during comparison — ${describeThrown(error)}`,
    });
  }

  const counts: EngineCounts = {
    pixelDifference: comparison.pixelDifference,
    pixelsTotal,
    ...(comparison.engineReportedWithinThreshold !== undefined
      ? { engineReportedWithinThreshold: comparison.engineReportedWithinThreshold }
      : {}),
  };

  const outcome = computeVerdict({ counts, policy: request.policy });

  const artifacts = {
    referenceImage: request.referenceImagePath,
    actualImage: request.actualImagePath,
    // Only claim a diff artifact that actually landed. Claiming one that does
    // not exist sends a reviewer to a 404 and, worse, reads as "I looked".
    ...(comparison.diffArtifactWritten ? { diffImage: request.diffImagePath } : {}),
  };

  return {
    schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
    verdict: outcome.verdict,
    ...(outcome.invalidReason ? { invalidReason: outcome.invalidReason } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    reference: request.reference,
    target: request.target,
    environment: request.environment,
    engine,
    policy: request.policy,
    counts,
    diffRatio: outcome.diffRatio,
    artifacts,
    capturedAt: request.capturedAt,
    ...(request.advisoryNotes ? { advisoryNotes: request.advisoryNotes } : {}),
  };
}

// ─── the lost-pixel / pixelmatch provider ────────────────────────────────────

/** The engine id stamped on every result this provider produces. */
export const PIXELMATCH_ENGINE_ID = 'lost-pixel/pixelmatch';

/**
 * The value a `lostpixel.config.ts` MUST carry for the dispatcher to choose
 * pixelmatch (D-010 consequence 1). This adapter bypasses the dispatcher, but
 * P-007 wires the existing CI Lost Pixel path, which does not — so the constant
 * and its assertion live here, beside the reason they exist.
 */
export const REQUIRED_LOST_PIXEL_COMPARE_ENGINE = 'pixelmatch';

/**
 * Fail loudly if a lost-pixel configuration would dispatch to the blind engine.
 *
 * `compareImages` reads lost-pixel's global config singleton and falls through
 * to odiff for ANY value other than `'pixelmatch'` — including `undefined`,
 * which is what every config in this repo currently has. An absent key is
 * therefore the dangerous case, not a neutral one, which is why this refuses it
 * explicitly rather than treating it as "unset, probably fine".
 */
export function assertCompareEngineSelected(config: { compareEngine?: string }): void {
  if (config.compareEngine !== REQUIRED_LOST_PIXEL_COMPARE_ENGINE) {
    throw new Error(
      `lost-pixel compareEngine is ${config.compareEngine === undefined ? 'unset' : `'${config.compareEngine}'`}; ` +
        `it must be '${REQUIRED_LOST_PIXEL_COMPARE_ENGINE}'. Unset dispatches to odiff, which at ` +
        `failOnLayoutDiff:false compares only the overlapping region and applies an unconfigurable ` +
        `colour tolerance that reports ZERO differing pixels for a whole-image shift of up to ` +
        `45/255 per channel (D-010 findings 9 and the D-008 finding 6 correction).`,
    );
  }
}

/** The exact shape lost-pixel 3.22.0's comparators return. */
export interface LostPixelComparison {
  pixelDifference: number;
  pixelDifferencePercentage: number;
  isWithinThreshold: boolean;
}

/**
 * The single lost-pixel entry point this adapter is allowed to use.
 *
 * The type names ONLY `compareImagesViaPixelmatch` on purpose. `compareImages`
 * (the config-reading dispatcher) and `compareImagesViaOdiff` are deliberately
 * not in this interface, so selecting the wrong engine is a type error rather
 * than a runtime surprise.
 */
export interface PixelmatchCompareModule {
  compareImagesViaPixelmatch(
    threshold: number,
    baselineShotPath: string,
    currentShotPath: string,
    differenceShotPath?: string,
  ): Promise<LostPixelComparison>;
}

export interface PixelmatchProviderOptions {
  /** Injected in tests. Defaults to a deep require of the installed lost-pixel. */
  readonly module?: PixelmatchCompareModule;
  /** Injected in tests. Defaults to the installed lost-pixel's package version. */
  readonly version?: string;
  /** Injected in tests. Defaults to a real `existsSync`. */
  readonly fileExists?: (filePath: string) => boolean;
  /** Injected in tests. Defaults to a real recursive `mkdirSync`. */
  readonly ensureDirectory?: (directory: string) => void;
}

function loadInstalledPixelmatchModule(): { module: PixelmatchCompareModule; version: string } {
  const requireCjs = createRequire(import.meta.url);
  // Deep-imported on purpose: lost-pixel's `compareImages` dispatcher reads a
  // global config singleton to choose an engine, which would make engine
  // selection depend on whichever project config happened to be loaded. The
  // concrete comparator takes everything it needs as arguments.
  const module = requireCjs('lost-pixel/dist/compare/compare.js') as PixelmatchCompareModule;
  const { version } = requireCjs('lost-pixel/package.json') as { version: string };
  return { module, version };
}

/**
 * Build the production provider: lost-pixel's pixelmatch comparator, directly.
 *
 * Resolution is EAGER. If lost-pixel is not installed this throws at
 * construction rather than at the first comparison, because a provider that
 * cannot name its engine version cannot satisfy consequence 7, and discovering
 * that mid-gate — after captures have been taken — is strictly worse than
 * discovering it at wiring time.
 */
export function createPixelmatchProvider(
  options: PixelmatchProviderOptions = {},
): ComparisonProvider {
  const resolved =
    options.module && options.version
      ? { module: options.module, version: options.version }
      : loadInstalledPixelmatchModule();
  const module = options.module ?? resolved.module;
  const version = options.version ?? resolved.version;

  const fileExists = options.fileExists ?? ((filePath: string): boolean => existsSync(filePath));
  const ensureDirectory =
    options.ensureDirectory ??
    ((directory: string): void => {
      mkdirSync(directory, { recursive: true });
    });

  return {
    engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: version },
    async compare(request: ProviderRequest): Promise<ProviderComparison> {
      if (!request.diffImagePath) {
        throw new Error(
          'createPixelmatchProvider: a difference-image path is mandatory; the comparator fails open without one (D-008 finding 4)',
        );
      }
      if (request.threshold !== ENGINE_INVOCATION_THRESHOLD) {
        throw new Error(
          `createPixelmatchProvider: the engine is always invoked at threshold ${ENGINE_INVOCATION_THRESHOLD}, ` +
            `not ${request.threshold}; the policy is applied to raw counts afterwards (D-010 consequence 3)`,
        );
      }
      ensureDirectory(path.dirname(request.diffImagePath));
      const raw = await module.compareImagesViaPixelmatch(
        ENGINE_INVOCATION_THRESHOLD,
        request.referenceImagePath,
        request.actualImagePath,
        request.diffImagePath,
      );
      return {
        pixelDifference: raw.pixelDifference,
        engineReportedWithinThreshold: raw.isWithinThreshold,
        engineReportedPercentage: raw.pixelDifferencePercentage,
        diffArtifactWritten: fileExists(request.diffImagePath),
      };
    },
  };
}

// ─── lost-pixel meta.json: a PARTIAL index ───────────────────────────────────

/** One `meta.json` entry. Exactly the three fields lost-pixel 3.22.0 writes. */
export interface LostPixelMetaEntry {
  readonly pixelDifference: number;
  readonly pixelDifferencePercentage: number;
  readonly isWithinThreshold: boolean;
}

export type LostPixelMetaIndex = Readonly<Record<string, LostPixelMetaEntry>>;

/**
 * The invalid reason an EXPECTED-but-ABSENT meta entry maps to.
 *
 * Absence means `checkDifferences` returned early, which it does when the shot
 * had no baseline — measured in D-010 finding 14: three shots submitted, two
 * entries written. The dangerous reading is the opposite one: an absent key
 * looks exactly like "compared and found identical" to anything that iterates
 * the index.
 */
export const META_ABSENT_INVALID_REASON: InvalidReason = 'missing-reference';

export class MetaIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaIndexError';
  }
}

/** Parse a `meta.json` body, rejecting anything that is not the expected shape. */
export function parseMetaIndex(text: string): LostPixelMetaIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MetaIndexError(`meta.json is not valid JSON: ${describeThrown(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MetaIndexError('meta.json is not an object keyed by shot id');
  }
  const index: Record<string, LostPixelMetaEntry> = {};
  for (const [shotId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new MetaIndexError(`meta.json entry '${shotId}' is not an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.pixelDifference !== 'number' || !Number.isFinite(entry.pixelDifference)) {
      throw new MetaIndexError(
        `meta.json entry '${shotId}' has a non-numeric pixelDifference (${String(entry.pixelDifference)})`,
      );
    }
    index[shotId] = {
      pixelDifference: entry.pixelDifference,
      pixelDifferencePercentage:
        typeof entry.pixelDifferencePercentage === 'number' ? entry.pixelDifferencePercentage : Number.NaN,
      isWithinThreshold: entry.isWithinThreshold === true,
    };
  }
  return index;
}

export interface MetaReconciliation {
  /** Expected shots that the index actually carries. */
  readonly present: readonly { readonly shotId: string; readonly entry: LostPixelMetaEntry }[];
  /** Expected shots the index omits — each an `invalid`, never a pass. */
  readonly absent: readonly string[];
  /** Shots the index carries that nobody expected. A wiring fault, reported not ignored. */
  readonly unexpected: readonly string[];
}

/**
 * Reconcile a `meta.json` index against the shot set that was actually expected.
 *
 * D-010 consequence 6. The EXPECTED SET is the population; the index is only
 * evidence about part of it. Iterating `Object.keys(meta)` as the population is
 * the specific bug this function exists to make impossible: every shot whose
 * baseline was missing simply disappears from the run, and a caller counting
 * "how many compared cleanly" counts them as successes it never performed.
 */
export function reconcileMetaIndex(
  expectedShotIds: readonly string[],
  meta: LostPixelMetaIndex | null,
): MetaReconciliation {
  const index = meta ?? {};
  const expected = new Set(expectedShotIds);
  const present: { shotId: string; entry: LostPixelMetaEntry }[] = [];
  const absent: string[] = [];

  for (const shotId of expectedShotIds) {
    const entry = index[shotId];
    if (entry === undefined) absent.push(shotId);
    else present.push({ shotId, entry });
  }

  const unexpected = Object.keys(index).filter((shotId) => !expected.has(shotId));
  return { present, absent, unexpected };
}

/**
 * Turn one meta entry into contract counts.
 *
 * `pixelsTotal` is a REQUIRED argument, and there is no overload that derives it
 * from the index: meta.json carries no dimensions (D-010 finding 14), so a total
 * could only be recovered by dividing the count by the percentage — which is
 * undefined at zero difference, and which would be taking the denominator from
 * the engine, the exact thing consequence 4 forbids.
 */
export function metaEntryToCounts(entry: LostPixelMetaEntry, pixelsTotal: number): EngineCounts {
  return {
    pixelDifference: entry.pixelDifference,
    pixelsTotal,
    engineReportedWithinThreshold: entry.isWithinThreshold,
  };
}

export interface MetaAbsenceRefusal {
  readonly reference: ReferenceIdentity;
  readonly target: ImplementationTarget;
  readonly environment: CaptureEnvironment;
  readonly policy: ThresholdPolicy;
  readonly engine: EngineIdentity;
  readonly capturedAt: string;
  readonly shotId: string;
}

/** The `invalid` result an expected-but-absent shot becomes. Never a pass. */
export function resultForAbsentMetaShot(input: MetaAbsenceRefusal): CompareResult {
  return {
    schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
    verdict: 'invalid',
    invalidReason: META_ABSENT_INVALID_REASON,
    detail:
      `shot '${input.shotId}' was expected but is absent from meta.json. lost-pixel records ` +
      `metadata only AFTER a baseline is found, so an absent entry means no baseline existed — ` +
      `it does not mean the shot compared cleanly (D-010 finding 14).`,
    reference: input.reference,
    target: input.target,
    environment: input.environment,
    engine: input.engine,
    policy: input.policy,
    capturedAt: input.capturedAt,
  };
}
