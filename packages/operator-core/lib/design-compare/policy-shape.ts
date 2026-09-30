/**
 * The shape of the calibration artifact a threshold policy is derived from.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * This file holds types only, and exists so `report-cli.ts` (which MEASURES the
 * artifact) and `policy.ts` (which DERIVES thresholds from it) can agree on the
 * shape without importing each other. The measuring side must never import the
 * deriving side: a calibration that could read the threshold it sets would be
 * circular, and the cheapest way to make that impossible is for the dependency
 * edge not to exist.
 */
import type { CaptureEnvironment, ReferenceClass } from './contract';

/** Bump when a field's meaning changes such that an older artifact cannot be read. */
export const CALIBRATION_SCHEMA_VERSION = 1 as const;

/**
 * Minimum regression/noise separation required before a class may gate.
 *
 * This lives beside the shared calibration artifact shape, not in the
 * test-only corpus harness. `policy.ts` is production code bundled into the
 * desktop sidecar; importing this constant through corpus/harness pulled its
 * CommonJS `pngjs` devDependency into the runtime graph and made a packaged VM
 * fail at boot when that test dependency was absent.
 */
export const SEPARATION_FLOOR = 3;

/** One measured comparison. */
export interface CalibrationSample {
  readonly caseId: string;
  readonly diffRatio: number;
  readonly pixelsTotal: number;
  readonly comparisonMs: number;
}

export interface RuntimeStats {
  readonly n: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
}

export interface ClassCalibration {
  readonly referenceClass: ReferenceClass;
  /** Which legs of the cohort contributed to this class. */
  readonly cohorts: readonly string[];
  /**
   * Capture-to-capture variance of an UNCHANGED surface. The maximum is what
   * matters: a threshold below the worst observed noise fails correct work.
   *
   * REAL CAPTURES ONLY — see D-021. The synthetic corpus contributes nothing
   * here even for a class it also models, because capture noise is by
   * definition the variance between two CAPTURES of one target and the corpus
   * never captures anything. Its `faithful` pair models a fidelity difference,
   * which is a different quantity; pooling the two took the max of a modelled
   * 0.0025 and a measured 0.0, produced a floor ~2600x too high, and demoted
   * the one class that is genuinely gateable.
   */
  readonly noise: {
    readonly n: number;
    readonly maxDiffRatio: number | null;
    readonly samples: readonly CalibrationSample[];
  };
  /**
   * Difference between two genuinely different renders. The minimum is what
   * matters: a threshold above the smallest observed real difference passes a
   * regression.
   *
   * A pair measuring EXACTLY zero is excluded and recorded in
   * `indistinguishablePairs` instead. That is not convenience: a zero is not a
   * measurement of how small a real change can be, it is a measurement that the
   * two captures are the same image, and admitting it would define the
   * regression floor as 0 — the assertion that a real change can differ by no
   * pixels, which is false rather than merely inconvenient.
   */
  readonly regression: {
    readonly n: number;
    readonly minDiffRatio: number | null;
    readonly samples: readonly CalibrationSample[];
  };
  /**
   * Pairs of DIFFERENT surfaces whose captures were byte-identical (D-020).
   *
   * Loud rather than dropped. Each one is a live bypass: a reference ratified
   * against one of these surfaces passes against an implementation of the
   * other, at diff ratio zero, with the engine behaving perfectly.
   */
  readonly indistinguishablePairs: readonly string[];
  /**
   * The synthetic corpus leg, kept apart from the threshold inputs above.
   *
   * It answers a different question — does the ENGINE separate a faithful
   * implementation from a drifted one, and how long does a comparison take —
   * and it is the only leg available for classes this repo cannot capture.
   */
  readonly fidelityCorpus: {
    readonly faithfulMaxDiffRatio: number | null;
    readonly driftedMinDiffRatio: number | null;
    readonly samples: readonly CalibrationSample[];
  };
  readonly captureRuntime: RuntimeStats;
  readonly comparisonRuntime: RuntimeStats;
  /**
   * The smallest image the NOISE samples were measured on — not the smallest
   * image in the whole cohort. One differing pixel in it is the finest
   * distinction the noise measurement could have made, and is what the
   * derivation uses instead of treating an observed zero as a true zero.
   *
   * Scoped to the noise leg deliberately: taking it from the cohort at large
   * would let the 320x240 synthetic corpus set the precision floor for
   * 1280x800 real captures, inflating it ~13x for no reason connected to the
   * measurement it is supposed to bound.
   */
  readonly smallestPixelsTotal: number | null;
}

export interface CalibrationArtifact {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly generatedAt: string;
  readonly engine: { readonly engine: string; readonly engineVersion: string };
  readonly environment: CaptureEnvironment;
  readonly realSurface: {
    readonly source: string;
    readonly storiesCaptured: number;
    readonly refusals: readonly string[];
  };
  readonly classes: readonly ClassCalibration[];
  /** Scope limits a reader must see next to the numbers, not in a commit message. */
  readonly caveats: readonly string[];
  /**
   * The rendering host every sample was measured on (P-011, D-023), as
   * `render-host.ts`'s canonical string.
   *
   * D-021's SAME-HOST caveat is prose; this is the same fact in a form the gate
   * can act on. Optional on the type because calibrations minted before the
   * field existed do not carry one — and a calibration that cannot say where it
   * was measured enforces nowhere, which is the honest reading of missing
   * provenance rather than a defect to work around.
   */
  readonly measuredOnRenderHost?: string;
}
