/**
 * S02 — multistep-investigation
 *
 * Persona: patient admin
 * Goal: list open issues by severity and tell me which to fix first.
 *
 * This scenario is the **framework self-validation gate** (plan §12 Phase 1):
 *   - Must FAIL against current operator code, catching V8 F1
 *     ("brain narrated intent without <continue/>") as a terminationFit
 *     finding referencing the offending turn.
 *   - Must PASS against a hand-patched operator that emits <continue/>
 *     after the "Checking..." narration.
 *
 * Covers: B3 (continue chain), B5 (chain reset on user input), B15
 * (search:* recall), B16 (harness tools), B28 (premature termination).
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S02_MULTISTEP_INVESTIGATION: Scenario = {
  id: 'op-S02-multistep-investigation',
  version: 1,
  target: 'operator',
  description:
    'A patient admin asks the operator to list open issues across the sheets harness, group them by severity, and recommend which to fix first. The operator should call work_items:list, then either continue narrating with <continue/> tags or terminate cleanly. Narrating intent ("Checking...") without continuing or stopping is a terminationFit failure (V8 F1).',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 10, maxWallSecs: 180, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    {
      kind: 'tool_called',
      name: 'work_items:list',
      minTimes: 1,
    },
    { kind: 'continue_chain_within_cap', maxTurns: 5, maxSecs: 300 },
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S02_MULTISTEP_INVESTIGATION;
