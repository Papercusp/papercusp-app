/**
 * Mockup-to-implementation validation: the versioned compare-result contract.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-001).
 *
 * This module owns the SHAPE of comparison evidence and the POLICY evaluation
 * that turns raw engine counts into a verdict. It deliberately owns no image
 * comparison: no pixel mathematics, computer vision, segmentation or clustering
 * (D-002). Engines supply counts; this module decides what those counts mean.
 *
 * Two governing decisions are load-bearing here and are cited where they bite:
 *
 *  - D-008: the installed lost-pixel 3.22.0 comparator returns an
 *    `isWithinThreshold` boolean that FAILS OPEN — its pixelmatch path returns
 *    `true` unconditionally when no difference-image path is supplied, even for
 *    images that differ completely. Papercusp therefore recomputes the verdict
 *    from raw counts and treats the engine boolean as advisory only.
 *  - D-007: pixel comparison is only meaningful between commensurable images,
 *    so gating is scoped per reference class rather than applied universally.
 */

/** Bump when a field's meaning changes in a way stored evidence cannot satisfy. */
export const COMPARE_RESULT_SCHEMA_VERSION = 1 as const;

/**
 * How the ratified reference image was produced. This is not cosmetic metadata:
 * D-007 makes gateability a property of the class, because an image painted by a
 * model hallucinates fonts, spacing and content and can never be commensurable
 * with a real render.
 */
export const REFERENCE_CLASSES = [
  /** A real HTML render captured at a contracted environment (e.g. a Claude artifact). */
  'artifact-capture',
  /** A Figma node exported to an image with matching fonts and exact dimensions. */
  'figma-export',
  /** A model-generated raster mockup. Incommensurable with a real render. */
  'raster-mockup',
  /** A gateable reference DERIVED from an incommensurable one and approved (D-007). */
  'derived-reference',
] as const;
export type ReferenceClass = (typeof REFERENCE_CLASSES)[number];

/**
 * Whether a class may carry a deterministic gate at all. Calibration (P-002,
 * P-008) may DEMOTE a class from gateable to advisory, but never silently: the
 * policy records the decision and `explainUngateable` states it in the evidence.
 */
export type GateEligibility = 'gateable' | 'advisory-only';

export const VERDICTS = ['pass', 'fail', 'invalid'] as const;
export type CompareVerdict = (typeof VERDICTS)[number];

/**
 * Why a comparison could not produce a meaningful pass/fail. `invalid` is a
 * first-class outcome, never a silent pass: every one of these would otherwise
 * be a route to a green gate over evidence that does not exist.
 */
export const INVALID_REASONS = [
  'missing-reference',
  'missing-capture',
  'dimension-mismatch',
  'environment-mismatch',
  // D-020 class 4. The capture is of a surface this reference does not require.
  // It is listed beside the other preconditions because it fails the same way:
  // the engine would happily measure it and return a number, and for the
  // indistinguishable-capture case that number is 0 — a perfect score for
  // building the wrong thing.
  'target-mismatch',
  'capture-failed',
  'engine-error',
  'engine-timeout',
  'stale-evidence',
  'unsupported-input',
  'ungateable-reference-class',
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The environment a comparison is contracted at. Every field participates in
 * identity: a capture taken at a different theme or font set is not evidence
 * about this reference, it is evidence about a different render.
 */
export interface CaptureEnvironment {
  readonly viewport: Viewport;
  readonly deviceScaleFactor: number;
  readonly browser: string;
  readonly theme: string;
  readonly fontSet: string;
  /** Data fixture / story args identifier, when the surface takes one. */
  readonly fixture?: string;
  /** Interaction state (e.g. 'default', 'hover', 'error'), when required. */
  readonly state?: string;
}

/** Immutable identity of a ratified reference. Revising one mints a new revision. */
export interface ReferenceIdentity {
  readonly referenceId: string;
  /** Monotonic per referenceId. Evidence is bound to an exact revision. */
  readonly revision: number;
  readonly referenceClass: ReferenceClass;
  /** Content hash of the reference image bytes — the immutability check. */
  readonly contentSha256: string;
}

export interface ImplementationTarget {
  /** Storybook story id, route path, or component id. */
  readonly targetId: string;
  readonly targetKind: 'storybook-story' | 'page-route' | 'component';
  /** Revision of the implementation this capture was taken from. */
  readonly implementationRevision: string;
}

/**
 * There is deliberately NO `IgnoredRegion` type and no `ignoredRegions` field
 * in this contract (EI-21414614584540571). An earlier revision accepted region
 * masks from callers and PERSISTED them onto stored evidence — while no
 * engine, adapter or verb ever read a region's geometry. Stored evidence
 * therefore asserted an exclusion that never happened: a false statement in
 * the one table this subsystem cannot afford one in.
 *
 * The field was REMOVED rather than wired through, because real masking is a
 * design decision, not a fix: it needs engine support (the pixelmatch
 * comparator takes two image paths, a diff path and a threshold — nothing
 * else), non-empty justification/authority validation, and an area cap (a
 * mask covering the whole image is not a mask). D-002 keeps pixel
 * manipulation out of Papercusp, so masking cannot be faked here by painting
 * over the images either. `compare_render` REFUSES a request that still
 * supplies `ignoredRegions`, so a caller learns masking does not exist
 * instead of believing it was applied. See mask-not-a-bypass.test.ts.
 */

/**
 * A versioned, per-reference-class threshold policy. D-005 forbids inheriting
 * the 5% build-regression threshold as a fidelity default, so there is no
 * default value here at all — a policy must be supplied.
 */
export interface ThresholdPolicy {
  readonly policyVersion: string;
  readonly referenceClass: ReferenceClass;
  readonly eligibility: GateEligibility;
  /**
   * Maximum differing-pixel RATIO that still passes, in [0, 1].
   * Only meaningful when eligibility is 'gateable'.
   */
  readonly maxDiffRatio: number;
  /** How this number was derived — calibration run id, corpus id, or similar. */
  readonly derivedFrom: string;
}

/** Raw counts as reported by the engine. Papercusp interprets, never computes, these. */
export interface EngineCounts {
  readonly pixelDifference: number;
  readonly pixelsTotal: number;
  /**
   * The engine's own convenience boolean. ADVISORY ONLY — see D-008: the
   * installed pixelmatch path fails open. Recorded for forensics and drift
   * detection, never consulted for the verdict.
   */
  readonly engineReportedWithinThreshold?: boolean;
}

export interface EngineIdentity {
  /** e.g. 'lost-pixel/odiff', 'lost-pixel/pixelmatch', 'looks-same'. */
  readonly engine: string;
  readonly engineVersion: string;
}

export interface ComparisonArtifacts {
  readonly referenceImage: string;
  readonly actualImage: string;
  readonly diffImage?: string;
  readonly overlayImage?: string;
}

/** Engine-produced localized regions. Papercusp never computes these (D-002). */
export interface DiffRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CompareResult {
  readonly schemaVersion: typeof COMPARE_RESULT_SCHEMA_VERSION;
  readonly verdict: CompareVerdict;
  /** Present exactly when verdict is 'invalid'. */
  readonly invalidReason?: InvalidReason;
  /** Human-readable detail. Required for 'invalid' so refusals are actionable. */
  readonly detail?: string;

  readonly reference: ReferenceIdentity;
  readonly target: ImplementationTarget;
  readonly environment: CaptureEnvironment;

  readonly engine: EngineIdentity;
  readonly policy: ThresholdPolicy;
  /** Absent when the comparison never reached the engine (an invalid precondition). */
  readonly counts?: EngineCounts;
  /** Computed by Papercusp from counts, not read from the engine. */
  readonly diffRatio?: number;
  readonly diffRegions?: readonly DiffRegion[];

  readonly artifacts?: ComparisonArtifacts;
  /** Structural/browser proof and its explicitly labelled review; never a pixel score. */
  readonly renderObservation?: import('./render-matrix').RenderMatrixObservation;

  /**
   * The rendering host the implementation capture was produced on (P-011,
   * D-023), as `render-host.ts`'s canonical string.
   *
   * Carried rather than measured here because `compare_render` receives an
   * image path, not a browser: only the capture path has a page to measure. It
   * is optional on the type because a reference may be an upload or a Figma
   * export that no host ever rendered — but absence is NOT an exemption. For a
   * reference whose own provenance records a host, evidence that reports none
   * fails the gate as insufficient rather than passing it, or omitting the
   * field would be a one-line way to turn a refusal into a notice.
   */
  readonly renderHost?: string;

  readonly capturedAt: string;
  /**
   * Advisory semantic explanation (D-004). Never affects the verdict; present
   * only to help a human or agent understand a failure.
   */
  readonly advisoryNotes?: string;
}

/** What a completion attempt claims to be true. Evidence must match all of it. */
export interface EvidenceExpectation {
  readonly referenceId: string;
  readonly referenceRevision: number;
  readonly implementationRevision: string;
  readonly engineVersion: string;
  readonly policyVersion: string;
  readonly environment: CaptureEnvironment;
}

// ─── policy evaluation ────────────────────────────────────────────────────────

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * Exact environment identity. Deliberately strict and deliberately NOT tolerant:
 * a near-match is a different render, and treating it as evidence is how a gate
 * silently starts approving the wrong thing.
 */
export function environmentsMatch(a: CaptureEnvironment, b: CaptureEnvironment): boolean {
  return (
    sameViewport(a.viewport, b.viewport) &&
    a.deviceScaleFactor === b.deviceScaleFactor &&
    a.browser === b.browser &&
    a.theme === b.theme &&
    a.fontSet === b.fontSet &&
    (a.fixture ?? null) === (b.fixture ?? null) &&
    (a.state ?? null) === (b.state ?? null)
  );
}

/**
 * One-line human rendering of a capture environment.
 *
 * Lives here, beside `environmentsMatch`, because both the comparison path and
 * the ratification path have to say "these two environments differ" to a human.
 * It was previously private to the verbs module, which meant the second caller
 * either imported across a module cycle or wrote a near-identical renderer —
 * two spellings of the same environment, drifting apart, in the exact messages
 * someone reads while debugging an environment mismatch.
 */
export function describeEnvironment(env: CaptureEnvironment): string {
  return (
    `${env.viewport.width}x${env.viewport.height}@${env.deviceScaleFactor} ` +
    `${env.browser}/${env.theme}/${env.fontSet}` +
    `${env.fixture ? `/fixture:${env.fixture}` : ''}${env.state ? `/state:${env.state}` : ''}`
  );
}

export interface VerdictInput {
  readonly counts: EngineCounts;
  readonly policy: ThresholdPolicy;
}

export interface VerdictOutcome {
  readonly verdict: CompareVerdict;
  readonly diffRatio: number;
  readonly invalidReason?: InvalidReason;
  readonly detail?: string;
}

/**
 * Compute the verdict from raw counts under the policy.
 *
 * This is the single place a pass is decided, and it never reads
 * `engineReportedWithinThreshold` (D-008). It is policy arithmetic over counts
 * the engine already produced — not image comparison — which is what keeps it
 * inside D-002's boundary.
 */
export function computeVerdict({ counts, policy }: VerdictInput): VerdictOutcome {
  if (!Number.isFinite(counts.pixelsTotal) || counts.pixelsTotal <= 0) {
    return {
      verdict: 'invalid',
      diffRatio: Number.NaN,
      invalidReason: 'engine-error',
      detail: `engine reported a non-positive total pixel count (${counts.pixelsTotal}); no ratio can be derived from it`,
    };
  }
  if (!Number.isFinite(counts.pixelDifference) || counts.pixelDifference < 0) {
    return {
      verdict: 'invalid',
      diffRatio: Number.NaN,
      invalidReason: 'engine-error',
      detail: `engine reported an invalid differing-pixel count (${counts.pixelDifference})`,
    };
  }

  const diffRatio = counts.pixelDifference / counts.pixelsTotal;

  if (policy.eligibility === 'advisory-only') {
    return {
      verdict: 'invalid',
      diffRatio,
      invalidReason: 'ungateable-reference-class',
      detail:
        `reference class '${policy.referenceClass}' is advisory-only under policy ` +
        `${policy.policyVersion}: its images are not commensurable with a real render, so a ` +
        `pixel ratio (${diffRatio.toFixed(6)}) carries no pass/fail meaning. Ratify a derived ` +
        `gateable reference instead (D-007).`,
    };
  }

  if (!Number.isFinite(policy.maxDiffRatio) || policy.maxDiffRatio < 0 || policy.maxDiffRatio > 1) {
    return {
      verdict: 'invalid',
      diffRatio,
      invalidReason: 'unsupported-input',
      detail: `policy ${policy.policyVersion} has an out-of-range maxDiffRatio (${policy.maxDiffRatio}); expected a ratio in [0, 1]`,
    };
  }

  return diffRatio <= policy.maxDiffRatio
    ? { verdict: 'pass', diffRatio }
    : {
        verdict: 'fail',
        diffRatio,
        detail:
          `diff ratio ${diffRatio.toFixed(6)} exceeds ${policy.maxDiffRatio} ` +
          `(policy ${policy.policyVersion}, class ${policy.referenceClass})`,
      };
}

export interface StalenessOutcome {
  readonly current: boolean;
  /** Every dimension that failed, so a refusal can name all of them at once. */
  readonly mismatches: readonly string[];
}

/**
 * Is this evidence current for the completion attempt being made?
 *
 * Requirement 8: evidence is current only when reference revision, implementation
 * revision, engine version, policy version and capture environment ALL match.
 */
export function isEvidenceCurrent(
  result: CompareResult,
  expected: EvidenceExpectation,
): StalenessOutcome {
  const mismatches: string[] = [];

  if (result.reference.referenceId !== expected.referenceId) {
    mismatches.push(
      `reference id (evidence ${result.reference.referenceId}, expected ${expected.referenceId})`,
    );
  }
  if (result.reference.revision !== expected.referenceRevision) {
    mismatches.push(
      `reference revision (evidence ${result.reference.revision}, expected ${expected.referenceRevision})`,
    );
  }
  if (result.target.implementationRevision !== expected.implementationRevision) {
    mismatches.push(
      `implementation revision (evidence ${result.target.implementationRevision}, expected ${expected.implementationRevision})`,
    );
  }
  if (result.engine.engineVersion !== expected.engineVersion) {
    mismatches.push(
      `engine version (evidence ${result.engine.engineVersion}, expected ${expected.engineVersion})`,
    );
  }
  if (result.policy.policyVersion !== expected.policyVersion) {
    mismatches.push(
      `policy version (evidence ${result.policy.policyVersion}, expected ${expected.policyVersion})`,
    );
  }
  if (!environmentsMatch(result.environment, expected.environment)) {
    mismatches.push('capture environment');
  }

  return { current: mismatches.length === 0, mismatches };
}

export interface GateDecision {
  readonly satisfied: boolean;
  /** Actionable refusal text. Empty exactly when satisfied. */
  readonly refusals: readonly string[];
}

/**
 * Does this evidence set satisfy a completion attempt?
 *
 * Requirement 9: completion is refused, with actionable detail, when evidence is
 * missing, stale, invalid or failing — for ANY required case. The required cases
 * are the (viewport, state) pairs the contract declares, and every one of them
 * must be independently satisfied; a single passing case never covers the rest.
 */
export function evaluateGate(
  results: readonly CompareResult[],
  expectations: readonly EvidenceExpectation[],
): GateDecision {
  const refusals: string[] = [];

  if (expectations.length === 0) {
    return {
      satisfied: false,
      refusals: ['no required comparison cases were declared, so there is nothing to verify'],
    };
  }

  for (const expected of expectations) {
    const describeCase =
      `${expected.referenceId}@${expected.referenceRevision} ` +
      `${expected.environment.viewport.width}x${expected.environment.viewport.height} ` +
      `${expected.environment.theme}/${expected.environment.state ?? 'default'}`;

    const candidates = results.filter(
      (r) =>
        r.reference.referenceId === expected.referenceId &&
        environmentsMatch(r.environment, expected.environment),
    );

    if (candidates.length === 0) {
      refusals.push(`${describeCase}: no comparison evidence found`);
      continue;
    }

    const currentOnes = candidates.filter((r) => isEvidenceCurrent(r, expected).current);
    if (currentOnes.length === 0) {
      const closest = isEvidenceCurrent(candidates[0]!, expected);
      refusals.push(
        `${describeCase}: evidence is stale — ${closest.mismatches.join('; ')}`,
      );
      continue;
    }

    const failing = currentOnes.filter((r) => r.verdict !== 'pass');
    if (failing.length === currentOnes.length) {
      const worst = failing[0]!;
      refusals.push(
        `${describeCase}: ${worst.verdict}${worst.invalidReason ? ` (${worst.invalidReason})` : ''}` +
          `${worst.detail ? ` — ${worst.detail}` : ''}`,
      );
    }
  }

  return { satisfied: refusals.length === 0, refusals };
}
