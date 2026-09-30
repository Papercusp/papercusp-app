/**
 * WHETHER a design-evidence verdict may REFUSE, as opposed to report (P-011, D-023).
 *
 * Separate from the verdict itself on purpose. `gate.ts` answers "does this
 * surface have current passing evidence for every required case" — a question
 * about the work. This answers "is the threshold that verdict used measured for
 * the machine it was measured on" — a question about the INSTRUMENT. Collapsing
 * them would make a calibration limit look like a property of someone's code.
 *
 * ─── THE RULE, AND WHY IT IS SHAPED THIS WAY ─────────────────────────────────
 *
 * D-021: every noise sample behind the shipped 3.3816e-5 threshold is
 * same-host, and "a threshold derived from same-host noise, enforced across
 * hosts, fails correct work on the first runner whose fonts differ."
 *
 * So enforcement is decided from two facts the completing agent does not
 * control at completion time — the host recorded on the REFERENCE when it was
 * ratified, and the host the CALIBRATION was measured on:
 *
 *   reference host unknown        -> report-only. A reference nobody captured
 *                                   (upload, Figma export) or one ratified
 *                                   before this field existed. This is also
 *                                   exactly P-011's "newly ratified design work
 *                                   only", falling out of a measured property
 *                                   instead of a date comparison.
 *   reference host != calibration -> report-only. The threshold says nothing
 *                                   about this machine.
 *   otherwise                     -> ENFORCEABLE.
 *
 * The evidence's own host is deliberately NOT part of this decision. It is
 * checked per-case inside the gate, as a coverage condition, because putting it
 * here would hand out a bypass: "evidence reports no host" would become
 * "reference is not enforceable", and omitting one field on a comparison would
 * silently turn a refusal into a notice. For an enforceable reference, evidence
 * whose host is missing or different is INSUFFICIENT EVIDENCE — a failure with
 * a remedy — never an exemption.
 *
 * ─── WHY REPORT-ONLY IS NOT SILENT ───────────────────────────────────────────
 *
 * A gate that quietly stops enforcing is the failure this module exists to
 * prevent, arriving by a different door, so every not-enforceable outcome
 * carries the reason and is rendered into the report a human reads. "The gate
 * did not enforce" must never be indistinguishable from "the gate passed".
 */
import { CALIBRATION } from './policy';

export const NOT_ENFORCEABLE_REASONS = [
  /** The reference was never captured on a known host — an upload, or pre-cutover. */
  'reference-host-unknown',
  /** The threshold was measured somewhere else, so it does not speak for this host. */
  'uncalibrated-host',
] as const;

/**
 * A runtime array rather than a bare type union, so the documentation guard can
 * DERIVE this vocabulary instead of restating it — the same reason
 * `DESIGN_GATE_FAILURE_REASONS` is one.
 *
 * This is a vocabulary an operator meets while being told their work was NOT
 * refused, which is the moment they are least likely to go looking for an
 * explanation and most likely to conclude the gate is broken. A reason the page
 * does not carry is one they meet for the first time in that message.
 */
export type NotEnforceableReason = (typeof NOT_ENFORCEABLE_REASONS)[number];

export type EnforceabilityOutcome =
  | { readonly enforceable: true; readonly renderHost: string }
  | {
      readonly enforceable: false;
      readonly reason: NotEnforceableReason;
      readonly detail: string;
    };

/**
 * The host the committed calibration was measured on, or `null` when the
 * artifact does not record one.
 *
 * `null` means no class may be enforced anywhere. That is the correct reading of
 * a calibration that cannot say where it was taken, and it is deliberately not a
 * fallback to "assume it was here" — an unrecorded provenance is missing
 * information, and the permissive reading of missing information is how a
 * threshold escapes the domain it was measured in.
 */
export function calibrationRenderHost(
  calibration: { readonly measuredOnRenderHost?: string } = CALIBRATION,
): string | null {
  return calibration.measuredOnRenderHost ?? null;
}

/**
 * Decide whether a ratified reference's verdict may refuse a completion.
 *
 * Takes the reference's recorded host rather than the whole reference so the
 * rule is exercisable from a test without building a ratification.
 */
export function evaluateEnforceability(
  referenceRenderHost: string | undefined,
  calibrationHost: string | null = calibrationRenderHost(),
): EnforceabilityOutcome {
  if (!referenceRenderHost) {
    return {
      enforceable: false,
      reason: 'reference-host-unknown',
      detail:
        'this reference records no rendering host, so there is no machine whose measured noise ' +
        'floor could justify refusing work. References ratified from a capture record one; ' +
        'uploads and Figma exports never will, and neither will anything ratified before the ' +
        'field existed.',
    };
  }
  if (calibrationHost === null) {
    return {
      enforceable: false,
      reason: 'uncalibrated-host',
      detail:
        'the committed threshold calibration does not record which machine it was measured on, ' +
        'so no threshold it derives can be shown to apply to any particular host.',
    };
  }
  if (referenceRenderHost !== calibrationHost) {
    return {
      enforceable: false,
      reason: 'uncalibrated-host',
      detail:
        `this reference was captured on '${referenceRenderHost}', and the threshold was measured ` +
        `on '${calibrationHost}'. Host-to-host variance is unmeasured (D-021), and the derived ` +
        'tolerance is roughly 34 pixels of a 1280x800 render — far tighter than the difference ' +
        'a different font package makes. Re-calibrate on this host to enforce here.',
    };
  }
  return { enforceable: true, renderHost: referenceRenderHost };
}

/** One line for the report, so a non-enforcing gate says so out loud. */
export function describeEnforceability(outcome: EnforceabilityOutcome): string {
  if (outcome.enforceable) {
    return `enforceable: reference and threshold calibration share rendering host '${outcome.renderHost}'.`;
  }
  return `NOT ENFORCED (${outcome.reason}): ${outcome.detail}`;
}
