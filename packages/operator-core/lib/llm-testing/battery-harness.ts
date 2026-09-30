/**
 * The LLM scenario battery on the verification-harness contract (EVL P-006, R-11).
 *
 * Every scenario in a `llm-test` run is one phase. The battery already never aborts on a failed
 * scenario; running it through the contract adds what a re-run needs: a structured per-scenario
 * result {phase, status, reasonCode, evidenceDir}, one retained evidence dir per run with a
 * greppable HARNESS_RESULT line naming the first failure, and `--parallel` as the contract's
 * bounded concurrency instead of hand-rolled batches.
 */
import {
  defaultEvidenceRoot,
  formatSummaryLine,
  type HarnessContract,
  type HarnessRunResult,
  type PhaseOutcome,
  runHarness,
} from '@papercusp/verification-harness';
import type { ScenarioOutcome } from './run-exit-code';

export const LLM_BATTERY_HARNESS = 'llm-scenario-battery';

/** `LLM_TEST_EVIDENCE_ROOT` wins; otherwise the shared verification-harness default root. */
export function llmBatteryEvidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_TEST_EVIDENCE_ROOT?.trim() || defaultEvidenceRoot(LLM_BATTERY_HARNESS, env);
}

export interface BatteryScenario {
  id: string;
  target: string;
  description: string;
}

export function llmBatteryContract(scenarios: readonly BatteryScenario[]): HarnessContract {
  return {
    name: LLM_BATTERY_HARNESS,
    phases: scenarios.map((s) => ({ id: s.id, description: `[${s.target}] ${s.description.slice(0, 160)}` })),
  };
}

/** A scenario that measured nothing (claim busy) is not a pass: the phase fails with that reason. */
export function scenarioPhaseOutcome(outcome: ScenarioOutcome): PhaseOutcome {
  if (outcome === 'executed') return { ok: true };
  if (outcome === 'skipped') return { ok: false, reasonCode: 'claim-busy', step: 'claim' };
  return { ok: false, reasonCode: 'scenario-failed', step: 'run-scenario' };
}

export async function runScenarioBattery<S extends BatteryScenario>(args: {
  scenarios: readonly S[];
  concurrency: number;
  /** Runs one scenario; `evidenceDir` is that scenario's own phase dir in this run. */
  runScenario: (scenario: S, evidenceDir: string) => Promise<ScenarioOutcome>;
  evidenceRoot?: string;
}): Promise<{ outcomes: ScenarioOutcome[]; harness: HarnessRunResult; summaryLine: string }> {
  const byId = new Map(args.scenarios.map((s) => [s.id, s]));
  const outcomeOf = new Map<string, ScenarioOutcome>();
  const harness = await runHarness({
    contract: llmBatteryContract(args.scenarios),
    evidenceRoot: args.evidenceRoot ?? llmBatteryEvidenceRoot(),
    concurrency: args.concurrency,
    runPhase: async (ctx) => {
      ctx.markStep('run-scenario');
      const outcome = await args.runScenario(byId.get(ctx.phase)!, ctx.evidenceDir);
      outcomeOf.set(ctx.phase, outcome);
      return scenarioPhaseOutcome(outcome);
    },
  });
  // A scenario whose runner threw never reported an outcome: that is a failure, never a pass.
  const outcomes = args.scenarios.map((s) => outcomeOf.get(s.id) ?? 'failed');
  return { outcomes, harness, summaryLine: formatSummaryLine(harness) };
}
