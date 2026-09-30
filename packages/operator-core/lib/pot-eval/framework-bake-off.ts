/**
 * framework-bake-off.ts — the flag-variant A/B over the hive-eval scored corpus
 * (plan-implementation-framework-2026-06-15 P-007, "framework bake-off harness").
 *
 * Measures whether a framework BET (a flag — papercusp-touch-set-exclusion /
 * -compiled-briefs / -workitem-amend / -deferred-expansion) BEATS the lazy baseline:
 * run the SAME scored scenarios with the flag OFF (baseline A) and ON (treatment B),
 * score both with hive-eval's UN-GAMEABLE gate, and diff. The prompt-ablation pattern
 * (baseline-vs-variant twin runs over a frozen corpus) applied to a feature flag.
 *
 * This module is the PURE orchestration + delta — hermetically unit-testable via the
 * injected `BakeoffDeps` (no PG, no flags API, no real runs). The LIVE binding wires
 * the deps to the existing machinery (DO NOT rebuild — recon P-007):
 *   • deps.runBattery → hive-eval/battery.ts `runHiveScenarioBattery` → per-scenario
 *     `computeHiveScore` (scoring.ts) mapped to ArmScore {composite, gatePassed}.
 *   • deps.getFlag/setFlag → @papercusp/flags/server `getFlag` + the flags override
 *     setter (the `flags:set` path) to toggle the bet flag around the two arms.
 *   • persistence (a hive_eval_bakeoff_deltas row) is the activation follow-on.
 * It does NOT reuse the impartial-benchmark-suite / external-bench (third-party grader,
 * spine-on/off pairing) — that is a separate, arms-length eval (dedupe per recon).
 *
 * Impartiality floor (D-006): a treatment that RAISES the composite by gaming speed
 * while DROPPING the un-gameable gate-pass rate is a REGRESSION, not a win.
 */

export interface ArmScore {
  scenarioId: string;
  /** The hive-eval composite (outcome-quality already gates efficiency/speed credit). */
  composite: number;
  /** Did the un-gameable outcome gate pass (acceptance test + planted-bug + no fabrication)? */
  gatePassed: boolean;
}

export interface BakeoffArm {
  arm: 'baseline' | 'treatment';
  flagOn: boolean;
  scores: ArmScore[];
  meanComposite: number;
  gatePassRate: number;
}

export type BakeoffVerdict = 'improved' | 'regressed' | 'neutral' | 'inconclusive';

export interface BakeoffDelta {
  deltaMeanComposite: number;
  deltaGatePassRate: number;
  verdict: BakeoffVerdict;
}

export interface BakeoffResult {
  flagKey: string;
  baseline: BakeoffArm;
  treatment: BakeoffArm;
  delta: BakeoffDelta;
}

export interface BakeoffThresholds {
  /** Min mean-composite improvement to call it "improved" (vs noise). Default 0.02. */
  minImprovement?: number;
}

export interface BakeoffDeps {
  /** Run the scored scenario battery once, returning a per-scenario ArmScore. Injected. `arm` lets
   *  the live runner scope a per-arm instanceId so the two arms' runs never collide on the
   *  deterministic run_id (instance×scenario×repeat). */
  runBattery: (opts: { scenarioIds?: string[]; repeats?: number; arm?: 'baseline' | 'treatment' }) => Promise<ArmScore[]>;
  /** Read the current value of a flag (to restore it afterward). Injected. */
  getFlag: (key: string) => Promise<boolean>;
  /** Override a flag on/off for the duration of one arm. Injected. */
  setFlag: (key: string, value: boolean) => Promise<void>;
}

export interface BakeoffInput {
  /** The bet flag under test (e.g. 'papercusp-touch-set-exclusion'). */
  flagKey: string;
  scenarioIds?: string[];
  /** N runs per arm — variance control (agent runs are high-variance). */
  repeats?: number;
  thresholds?: BakeoffThresholds;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Summarize one arm's per-scenario scores into mean composite + gate-pass rate. Pure. */
export function summarizeArm(arm: 'baseline' | 'treatment', flagOn: boolean, scores: ArmScore[]): BakeoffArm {
  const n = scores.length;
  const meanComposite = n === 0 ? 0 : round(scores.reduce((s, x) => s + x.composite, 0) / n);
  const gatePassRate = n === 0 ? 0 : round(scores.filter((x) => x.gatePassed).length / n);
  return { arm, flagOn, scores, meanComposite, gatePassRate };
}

/**
 * Diff treatment vs baseline into a verdict. The un-gameable floor comes FIRST: any drop
 * in the gate-pass rate is a regression regardless of composite (you cannot win by gaming
 * speed while breaking correctness). Pure.
 */
export function computeBakeoffDelta(
  baseline: BakeoffArm,
  treatment: BakeoffArm,
  thresholds?: BakeoffThresholds,
): BakeoffDelta {
  const minImp = thresholds?.minImprovement ?? 0.02;
  const deltaMeanComposite = round(treatment.meanComposite - baseline.meanComposite);
  const deltaGatePassRate = round(treatment.gatePassRate - baseline.gatePassRate);

  let verdict: BakeoffVerdict;
  if (baseline.scores.length === 0 || treatment.scores.length === 0) {
    verdict = 'inconclusive';
  } else if (deltaGatePassRate < 0) {
    verdict = 'regressed'; // the un-gameable floor
  } else if (deltaMeanComposite >= minImp) {
    verdict = 'improved';
  } else if (deltaMeanComposite <= -minImp) {
    verdict = 'regressed';
  } else {
    verdict = 'neutral';
  }
  return { deltaMeanComposite, deltaGatePassRate, verdict };
}

/**
 * Run the flag-variant A/B: flag OFF (baseline) then ON (treatment) over the same corpus,
 * diff, and ALWAYS restore the flag to its original value (even on error). The orchestration
 * is deterministic given the injected battery; the battery's runs are the non-deterministic
 * activity (per the durable-execution rule — we replay the decision, not the runs).
 */
export async function runFrameworkBakeOff(input: BakeoffInput, deps: BakeoffDeps): Promise<BakeoffResult> {
  const original = await deps.getFlag(input.flagKey);
  try {
    await deps.setFlag(input.flagKey, false);
    const baselineScores = await deps.runBattery({ scenarioIds: input.scenarioIds, repeats: input.repeats, arm: 'baseline' });
    await deps.setFlag(input.flagKey, true);
    const treatmentScores = await deps.runBattery({ scenarioIds: input.scenarioIds, repeats: input.repeats, arm: 'treatment' });

    const baseline = summarizeArm('baseline', false, baselineScores);
    const treatment = summarizeArm('treatment', true, treatmentScores);
    const delta = computeBakeoffDelta(baseline, treatment, input.thresholds);
    return { flagKey: input.flagKey, baseline, treatment, delta };
  } finally {
    await deps.setFlag(input.flagKey, original);
  }
}
