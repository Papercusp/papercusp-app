/**
 * A5 — tradeoff-explanation
 *
 * Persona: patient admin who asks "what are the tradeoffs?" after architect
 *          proposes an approach.
 *
 * Architect should enumerate real tradeoffs (cost, risk, scope) rather than
 * only promoting the proposal. A response with zero mention of downsides /
 * risks / alternatives is a failure.
 *
 * The deterministic assert checks that the word "tradeoff" or equivalent
 * language appears. The rubric's helpfulness + tone axes are the judge signal.
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A5_TRADEOFF_EXPLANATION: Scenario = {
  id: 'architect-A5-tradeoff-explanation',
  version: 1,
  target: 'architect',
  description:
    'After architect proposes an approach, the user asks explicitly "what are the tradeoffs?" Architect must enumerate real downsides / risks / alternatives — not just restate the benefits.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'tradeoff-language-present',
      eval: (run) => {
        const text = run.turns.map((t) => t.assistantText).join(' ').toLowerCase();
        const hasTradeoff = /(trade.?off|downside|risk|caveat|cost of|however|alternative|instead|drawback|con:)/i.test(text);
        if (!hasTradeoff) {
          return [{
            assertKind: 'custom:tradeoff-language-present',
            severity: 'error',
            claim: 'Architect response had no tradeoff / downside / risk language after user explicitly asked.',
            suggestion: 'Architect must enumerate real costs and risks, not just benefits.',
          }];
        }
        return [];
      },
    },
    { kind: 'control_tag_present', tag: 'sleep', maxCount: 0 },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A5_TRADEOFF_EXPLANATION;
