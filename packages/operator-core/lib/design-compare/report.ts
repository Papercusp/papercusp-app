/**
 * The report-only evidence report, and the reason it cannot become a gate.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * D-006 puts this whole system in report mode before it puts it in enforcing
 * mode. The weak way to implement that is a `gating: boolean` flag somebody
 * flips; the failure mode is that the flag gets flipped somewhere nobody is
 * looking, and CI starts blocking on a threshold that was never validated.
 *
 * So report-only is STRUCTURAL here, in three specific ways:
 *
 *   1. `gating` is the literal type `false`, not `boolean`. A report claiming to
 *      gate does not typecheck.
 *   2. Nothing in this module reads or writes a process exit code, and nothing
 *      returns a pass/fail boolean a caller could branch a build on. The only
 *      outputs are a data structure and a string. `report.test.ts` pins that by
 *      reading this file's own source.
 *   3. The enforcement decision lives entirely in
 *      `agent-tools/work_items/design-evidence-gate.ts` behind
 *      DESIGN_EVIDENCE_GATE_ENFORCING (P-007, D-006). This module does not
 *      import it, so CI's report path has no route to it at all.
 *
 * WHAT THE REPORT IS FOR, beyond visibility: it re-runs the calibration's own
 * falsification on every CI pass. A shipped threshold makes two predictions —
 * that an unchanged surface passes it, and that a real change fails it. The
 * report checks both and puts the violations in `selfCheck`. A threshold that
 * stops separating noise from change is exactly the drift no static test
 * catches, because the code is unchanged and the SURFACE moved underneath it.
 */
import {
  computeVerdict,
  type CompareVerdict,
  type InvalidReason,
  type ReferenceClass,
} from './contract';
import { CURRENT_POLICY_VERSION, explainPolicy, resolvePolicy } from './policy';
import type { CalibrationArtifact, CalibrationSample } from './policy-shape';

export const REPORT_SCHEMA_VERSION = 1 as const;

/** Which prediction a case tests. */
export type ReportLeg = 'noise' | 'regression';

export interface ReportedCase {
  readonly caseId: string;
  readonly referenceClass: ReferenceClass;
  readonly leg: ReportLeg;
  readonly diffRatio: number;
  readonly verdict: CompareVerdict;
  readonly invalidReason?: InvalidReason;
  readonly detail?: string;
  readonly comparisonMs: number;
  /**
   * Did this case behave as the policy predicts? A noise case should pass and a
   * regression case should fail. `null` when the class is advisory-only, where
   * neither prediction is made and an `invalid` verdict is the correct answer.
   */
  readonly asPredicted: boolean | null;
}

export interface ReportedClass {
  readonly referenceClass: ReferenceClass;
  readonly eligibility: 'gateable' | 'advisory-only';
  readonly maxDiffRatio: number;
  /** null when the class has no noise measurement — never a placeholder number. */
  readonly effectiveNoise: number | null;
  readonly regressionFloor: number | null;
  readonly separation: number | null;
  readonly explainUngateable?: string;
  readonly captureRuntimeP50Ms: number | null;
  readonly comparisonRuntimeP50Ms: number | null;
}

export interface DesignEvidenceReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  /** LITERAL `false`. See the module doc: this is a type, not a setting. */
  readonly gating: false;
  readonly policyVersion: string;
  readonly engine: { readonly engine: string; readonly engineVersion: string };
  readonly classes: readonly ReportedClass[];
  readonly cases: readonly ReportedCase[];
  readonly summary: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly invalid: number;
    readonly gateableClasses: number;
    readonly advisoryOnlyClasses: number;
    /**
     * How many cases the policy made a prediction about, and how many held.
     *
     * These exist because `pass`/`fail` alone MISLEAD here. A regression case
     * is SUPPOSED to fail — that is the threshold working — so a summary line
     * reading "12 pass · 4 fail" invites a CI reader to believe four things are
     * broken when nothing is. `predictionsHeld === predictionsMade` is the
     * number that actually means "everything is fine".
     */
    readonly predictionsMade: number;
    readonly predictionsHeld: number;
  };
  /** The two ways a shipped threshold can be wrong, measured rather than assumed. */
  readonly selfCheck: {
    readonly noiseThatFailed: readonly string[];
    readonly regressionsThatPassed: readonly string[];
    readonly consistent: boolean;
  };
  readonly caveats: readonly string[];
}

function judge(
  sample: CalibrationSample,
  referenceClass: ReferenceClass,
  leg: ReportLeg,
): ReportedCase {
  const policy = resolvePolicy({ referenceClass });
  // The engine already produced these counts; reconstructing the differing-pixel
  // count from the stored ratio keeps the report a re-INTERPRETATION of recorded
  // evidence rather than a second measurement of the image (D-002).
  const outcome = computeVerdict({
    counts: {
      pixelDifference: Math.round(sample.diffRatio * sample.pixelsTotal),
      pixelsTotal: sample.pixelsTotal,
    },
    policy,
  });

  const asPredicted =
    policy.eligibility === 'advisory-only'
      ? null
      : leg === 'noise'
        ? outcome.verdict === 'pass'
        : outcome.verdict === 'fail';

  return {
    caseId: sample.caseId,
    referenceClass,
    leg,
    diffRatio: sample.diffRatio,
    verdict: outcome.verdict,
    ...(outcome.invalidReason ? { invalidReason: outcome.invalidReason } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    comparisonMs: sample.comparisonMs,
    asPredicted,
  };
}

/**
 * Turn a measured calibration into a report under the CURRENT derived policy.
 *
 * Note the asymmetry with `report-cli.ts --mode=calibrate`: that mode consults
 * no policy at all, because it produces the measurement a policy is derived
 * FROM. This function consults the policy, because it is asking whether the
 * shipped threshold still holds against a fresh measurement of the same cohort.
 * Running the two against each other is the whole point.
 */
export function buildReport(measurement: CalibrationArtifact): DesignEvidenceReport {
  const cases: ReportedCase[] = [];
  const classes: ReportedClass[] = [];

  for (const measured of measurement.classes) {
    const derivation = explainPolicy(measured.referenceClass);
    if (derivation === undefined) {
      // A class the fresh measurement speaks for but the shipped policy does
      // not. Recorded as an advisory row rather than skipped: a class silently
      // missing from a report reads as "nothing to say about it".
      classes.push({
        referenceClass: measured.referenceClass,
        eligibility: 'advisory-only',
        maxDiffRatio: 0,
        effectiveNoise: null,
        regressionFloor: measured.regression.minDiffRatio,
        separation: null,
        explainUngateable:
          `class '${measured.referenceClass}' was measured but is not calibrated in policy ` +
          `${CURRENT_POLICY_VERSION}; re-run calibration to mint a policy that covers it`,
        captureRuntimeP50Ms: measured.captureRuntime.p50Ms,
        comparisonRuntimeP50Ms: measured.comparisonRuntime.p50Ms,
      });
      continue;
    }

    classes.push({
      referenceClass: measured.referenceClass,
      eligibility: derivation.policy.eligibility,
      maxDiffRatio: derivation.policy.maxDiffRatio,
      effectiveNoise: derivation.effectiveNoise,
      regressionFloor: derivation.regressionFloor,
      separation: derivation.separation,
      ...(derivation.explainUngateable
        ? { explainUngateable: derivation.explainUngateable }
        : {}),
      captureRuntimeP50Ms: measured.captureRuntime.p50Ms,
      comparisonRuntimeP50Ms: measured.comparisonRuntime.p50Ms,
    });

    for (const sample of measured.noise.samples) {
      cases.push(judge(sample, measured.referenceClass, 'noise'));
    }
    for (const sample of measured.regression.samples) {
      cases.push(judge(sample, measured.referenceClass, 'regression'));
    }
  }

  const noiseThatFailed = cases
    .filter((c) => c.leg === 'noise' && c.asPredicted === false)
    .map((c) => c.caseId);
  const regressionsThatPassed = cases
    .filter((c) => c.leg === 'regression' && c.asPredicted === false)
    .map((c) => c.caseId);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    gating: false,
    policyVersion: CURRENT_POLICY_VERSION,
    engine: measurement.engine,
    classes,
    cases,
    summary: {
      total: cases.length,
      pass: cases.filter((c) => c.verdict === 'pass').length,
      fail: cases.filter((c) => c.verdict === 'fail').length,
      invalid: cases.filter((c) => c.verdict === 'invalid').length,
      gateableClasses: classes.filter((c) => c.eligibility === 'gateable').length,
      advisoryOnlyClasses: classes.filter((c) => c.eligibility === 'advisory-only').length,
      predictionsMade: cases.filter((c) => c.asPredicted !== null).length,
      predictionsHeld: cases.filter((c) => c.asPredicted === true).length,
    },
    selfCheck: {
      noiseThatFailed,
      regressionsThatPassed,
      consistent: noiseThatFailed.length === 0 && regressionsThatPassed.length === 0,
    },
    caveats: measurement.caveats,
  };
}

/** A CI-log rendering. Returns a string; deliberately decides nothing. */
export function formatReportSummary(report: DesignEvidenceReport): string {
  const lines: string[] = [
    `design evidence report (REPORT-ONLY — this run gates nothing)`,
    `  policy ${report.policyVersion} · engine ${report.engine.engine}@${report.engine.engineVersion}`,
    `  predictions held: ${report.summary.predictionsHeld}/${report.summary.predictionsMade}` +
      ' (this is the line that means "fine")',
    `  raw verdicts: ${report.summary.pass} pass · ${report.summary.fail} fail · ` +
      `${report.summary.invalid} invalid of ${report.summary.total} — a regression case is` +
      ' SUPPOSED to fail, so these do not count problems',
    `  classes: ${report.summary.gateableClasses} gateable · ${report.summary.advisoryOnlyClasses} advisory-only`,
  ];
  for (const cls of report.classes) {
    lines.push(
      `  · ${cls.referenceClass} [${cls.eligibility}] maxDiffRatio=${cls.maxDiffRatio} ` +
        `noise=${cls.effectiveNoise ?? 'unmeasured'} ` +
        `regression=${cls.regressionFloor ?? 'n/a'} ` +
        `separation=${cls.separation === null ? 'n/a' : `${cls.separation.toFixed(1)}x`}` +
        (cls.captureRuntimeP50Ms === null ? '' : ` capture-p50=${cls.captureRuntimeP50Ms}ms`),
    );
    if (cls.explainUngateable) lines.push(`      ungateable: ${cls.explainUngateable}`);
  }
  if (report.selfCheck.consistent) {
    lines.push('  self-check: the shipped threshold still separates noise from change.');
  } else {
    lines.push(
      '  SELF-CHECK VIOLATION — the shipped threshold no longer matches the surface:',
      ...report.selfCheck.noiseThatFailed.map((id) => `      unchanged surface FAILED: ${id}`),
      ...report.selfCheck.regressionsThatPassed.map((id) => `      real change PASSED: ${id}`),
      '  Re-calibrate and mint a new policy version; do not widen the threshold in place.',
    );
  }
  return lines.join('\n');
}
