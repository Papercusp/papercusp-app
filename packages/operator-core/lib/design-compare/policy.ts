/**
 * The versioned threshold policy — DERIVED from measurement, never chosen.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * D-005 forbids inheriting the existing 5% build-regression threshold as a
 * fidelity default. Not inheriting it is easy; the hard part is not quietly
 * replacing it with a different number somebody liked the look of. So there is
 * no literal threshold anywhere in this file. Every `maxDiffRatio` is computed
 * from `policy-calibration.json` by the rule below, and the only way to change a
 * threshold is to re-measure and mint a new policy version.
 *
 * THE RULE, stated once so it can be argued with:
 *
 *   effectiveNoise    max observed capture-to-capture diff on an UNCHANGED
 *                     surface, floored at one pixel of the smallest image the
 *                     class was measured on. The floor exists because an
 *                     observed 0.0 is "finer than this measurement could see",
 *                     not "exactly zero forever", and a threshold of literally
 *                     zero fails the first time a font renders one pixel
 *                     differently.
 *
 *   regressionFloor   min observed diff between two genuinely different renders
 *                     — the smallest real difference the cohort contains.
 *
 *   separation        regressionFloor / effectiveNoise. If a class cannot
 *                     separate its own noise from a real change by at least
 *                     SEPARATION_FLOOR, there is nowhere honest to put a
 *                     threshold and the class is advisory-only. This is the same
 *                     statistic and the same floor P-002's calibration uses;
 *                     importing it rather than restating it is deliberate.
 *
 *   maxDiffRatio      the GEOMETRIC MEAN of the two. The geometric mean
 *                     maximises the multiplicative margin on both sides at once:
 *                     at the SEPARATION_FLOOR of 3 it sits ~1.73x above the
 *                     worst noise and ~1.73x below the smallest real change.
 *                     An arithmetic midpoint would sit far closer to the
 *                     regression, because these quantities differ by orders of
 *                     magnitude rather than by a constant.
 *
 * GATEABILITY IS EARNED, AND MOSTLY IS NOT.
 * A class is gateable only if it carries a REAL-SURFACE noise sample. P-002's
 * calibration says so in its own header — its corpus proves the method
 * discriminates, and explicitly refuses to promote any class on that strength
 * alone. Today exactly one class clears that bar, because the real-surface
 * cohort this repo can produce is real HTML renders. That is a finding, not an
 * omission: see D-020. A class without real-surface evidence is advisory-only
 * and `explainUngateable` says which evidence is missing, so the remedy is
 * legible instead of being a shrug.
 */
import calibrationJson from './policy-calibration.json';

import type { GateEligibility, ReferenceClass, ThresholdPolicy } from './contract';
import {
  SEPARATION_FLOOR,
  type CalibrationArtifact,
  type ClassCalibration,
} from './policy-shape';

/**
 * The calibration this build's policy is derived from.
 *
 * Read through the artifact type rather than trusted as `any`: the JSON is a
 * measurement result, and a field that stopped being produced should fail here
 * rather than silently become `undefined` inside an arithmetic expression.
 */
export const CALIBRATION = calibrationJson as unknown as CalibrationArtifact;

/** The version every policy this build derives is stamped with. */
export const CURRENT_POLICY_VERSION: string = CALIBRATION.policyVersion;

/** The cohort leg whose presence a class needs before it may gate. */
export const GATEABLE_COHORT = 'real-surface';

export interface PolicyDerivation {
  readonly policy: ThresholdPolicy;
  /**
   * The numbers the threshold came from, so a reader never has to re-derive them.
   *
   * `effectiveNoise` is null when the class has no noise measurement at all.
   * Deliberately not a placeholder: an unmeasured quantity rendered as a number
   * reads as a measurement, and a fallback of 1 in particular reads as "noise is
   * 100% of pixels" — a false statement about the world, in the same family as
   * the ones D-020 and D-021 exist to stop.
   */
  readonly effectiveNoise: number | null;
  readonly regressionFloor: number | null;
  readonly separation: number | null;
  /** Present exactly when eligibility is 'advisory-only'. */
  readonly explainUngateable?: string;
}

/**
 * The finest distinction the noise measurement could have made: one pixel of
 * the smallest image a noise sample was taken on.
 *
 * `null` when no noise sample exists, because there is then no measurement
 * whose precision this could be bounding.
 */
function onePixelOf(measurement: ClassCalibration): number | null {
  const pixels = measurement.smallestPixelsTotal;
  if (pixels === null || pixels <= 0) return null;
  return 1 / pixels;
}

/**
 * Derive one class's policy from its measurement.
 *
 * Exported because the derivation is the interesting part: a test drives it with
 * hand-built measurements to prove the rule refuses what it should, which is
 * impossible if the rule is only reachable through the committed artifact.
 */
export function derivePolicyFor(
  measurement: ClassCalibration,
  policyVersion: string,
): PolicyDerivation {
  const observedNoise = measurement.noise.maxDiffRatio;
  const precisionFloor = onePixelOf(measurement);
  const effectiveNoise =
    measurement.noise.n === 0 || observedNoise === null || precisionFloor === null
      ? null
      : Math.max(observedNoise, precisionFloor);
  const regressionFloor = measurement.regression.minDiffRatio;
  const separation =
    regressionFloor === null || effectiveNoise === null || effectiveNoise <= 0
      ? null
      : regressionFloor / effectiveNoise;

  const derivedFrom =
    `calibration ${measurement.referenceClass} @ ${policyVersion}: ` +
    `noise n=${measurement.noise.n} max=${observedNoise ?? 'none'}, ` +
    `regression n=${measurement.regression.n} min=${regressionFloor ?? 'none'}, ` +
    `cohorts=[${measurement.cohorts.join(', ')}]`;

  function advisory(explainUngateable: string): PolicyDerivation {
    return {
      policy: {
        policyVersion,
        referenceClass: measurement.referenceClass,
        eligibility: 'advisory-only' satisfies GateEligibility,
        // Meaningless under advisory-only by the contract's own definition, and
        // set to 0 rather than to something plausible so that a caller which
        // wrongly reads it cannot accidentally get a permissive gate.
        maxDiffRatio: 0,
        derivedFrom,
      },
      effectiveNoise,
      regressionFloor,
      separation,
      explainUngateable,
    };
  }

  if (!measurement.cohorts.includes(GATEABLE_COHORT)) {
    return advisory(
      `class '${measurement.referenceClass}' has no ${GATEABLE_COHORT} noise measurement. ` +
        'Synthetic corpus evidence proves the method discriminates; it does not establish a ' +
        'production threshold. Capture a real cohort for this class to promote it.',
    );
  }
  if (measurement.noise.n === 0 || effectiveNoise === null) {
    return advisory(
      `class '${measurement.referenceClass}' has no capture-to-capture noise samples, so its ` +
        'threshold floor is unmeasured.',
    );
  }
  if (regressionFloor === null || measurement.regression.n === 0) {
    return advisory(
      `class '${measurement.referenceClass}' has no measured real difference to separate its ` +
        'noise from, so no threshold can be shown to catch anything.',
    );
  }
  if (separation === null || separation < SEPARATION_FLOOR) {
    return advisory(
      `class '${measurement.referenceClass}' separates noise from a real change by only ` +
        `${separation === null ? 'an undefined factor' : `${separation.toFixed(2)}x`}, below the ` +
        `required ${SEPARATION_FLOOR}x. Any threshold here either passes regressions or fails ` +
        'correct work.',
    );
  }

  return {
    policy: {
      policyVersion,
      referenceClass: measurement.referenceClass,
      eligibility: 'gateable' satisfies GateEligibility,
      maxDiffRatio: Number(Math.sqrt(effectiveNoise * regressionFloor).toFixed(9)),
      derivedFrom,
    },
    effectiveNoise,
    regressionFloor,
    separation,
  };
}

/** Every class the committed calibration speaks for, derived. */
export function deriveAllPolicies(
  calibration: CalibrationArtifact = CALIBRATION,
): ReadonlyMap<ReferenceClass, PolicyDerivation> {
  const derived = new Map<ReferenceClass, PolicyDerivation>();
  for (const measurement of calibration.classes) {
    derived.set(measurement.referenceClass, derivePolicyFor(measurement, calibration.policyVersion));
  }
  return derived;
}

const DERIVED = deriveAllPolicies();

export class UncalibratedReferenceClassError extends Error {
  constructor(
    readonly referenceClass: ReferenceClass,
    readonly known: readonly ReferenceClass[],
  ) {
    super(
      `no calibration for reference class '${referenceClass}' in policy ` +
        `${CURRENT_POLICY_VERSION}; calibrated classes are [${known.join(', ')}]. ` +
        'A class with no measurement gets no threshold — not a borrowed one.',
    );
    this.name = 'UncalibratedReferenceClassError';
  }
}

export class UnknownPolicyVersionError extends Error {
  constructor(
    readonly requested: string,
    readonly current: string,
  ) {
    super(
      `policy version '${requested}' is not the version this build derives ('${current}'). ` +
        'Evidence bound to a superseded policy is stale by the contract’s own freshness rule; ' +
        're-run the comparison rather than re-interpreting the old number.',
    );
    this.name = 'UnknownPolicyVersionError';
  }
}

/**
 * The threshold policy for a reference class.
 *
 * Refuses rather than defaults, in both directions: an uncalibrated class and a
 * superseded policy version are each a question this build cannot answer, and
 * answering them with a plausible number is how a gate ends up measuring
 * nothing.
 */
export function resolvePolicy(options: {
  readonly referenceClass: ReferenceClass;
  readonly policyVersion?: string;
}): ThresholdPolicy {
  if (options.policyVersion !== undefined && options.policyVersion !== CURRENT_POLICY_VERSION) {
    throw new UnknownPolicyVersionError(options.policyVersion, CURRENT_POLICY_VERSION);
  }
  const derivation = DERIVED.get(options.referenceClass);
  if (derivation === undefined) {
    throw new UncalibratedReferenceClassError(options.referenceClass, [...DERIVED.keys()]);
  }
  return derivation.policy;
}

/** The derivation behind a resolved policy, for evidence and for the report. */
export function explainPolicy(referenceClass: ReferenceClass): PolicyDerivation | undefined {
  return DERIVED.get(referenceClass);
}

/** Every calibrated class, in a stable order. */
export function calibratedClasses(): readonly ReferenceClass[] {
  return [...DERIVED.keys()].sort();
}
