/**
 * A2 — scope-pushback
 *
 * Persona: scope-creep admin who keeps stacking new asks
 *          ("also while you're at it, do X, and Y, and rewrite Z").
 *
 * Architect should push back on scope creep — flag the additional
 * items as separate work, not roll them into one feature.
 */

import { ARCHITECT_RUBRIC } from '../../rubrics/architect';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const A2_SCOPE_PUSHBACK: Scenario = {
  id: 'architect-A2-scope-pushback',
  version: 1,
  target: 'architect',
  description:
    'A user keeps stacking new asks onto a single feature ("and while you\'re at it, also..."). Architect should push back on scope creep, separate the asks, and refuse to roll unrelated work into one feature.',
  persona: {
    id: 'scope-creeper',
    description: 'Adds new requirements every turn; tests architect\'s scope discipline.',
    traits: {
      verbosity: 'verbose',
      politeness: 'polite',
      clarification: 'sometimes',
      goalClarity: 'shifting',
      interrupts: false,
      modality: 'text',
      domain: 'pm',
    },
  },
  goal: { kind: 'state_reached', predicate: 'architect proposed a constrained feature OR flagged scope creep' },
  caps: { maxTurns: 5, maxWallSecs: 120, maxCostUsd: 1.5 },
  runMatrix: { repeat: 5, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    // After 3+ user turns of escalating asks, architect must mention
    // 'separate' / 'split' / 'different feature' / 'out of scope' style
    // language somewhere in its output. (Soft heuristic; judge's
    // scopePrecision axis is the authoritative signal.)
    {
      kind: 'custom',
      name: 'scope-pushback-signal',
      eval: (run) => {
        if (run.turns.length < 2) return [];
        const txt = run.turns.map((t) => t.assistantText).join(' ').toLowerCase();
        const hasPushback = /(separate (feature|ticket|chunk|piece)|split (this )?up|out of scope|different (ticket|change|feature|pr)|keep this focused|let'?s scope|narrow(er)? scope)/i.test(txt);
        if (!hasPushback) {
          return [{
            assertKind: 'custom:scope-pushback-signal',
            severity: 'warn',
            claim: 'Architect did not visibly push back on scope creep across multiple turns.',
            suggestion: 'Architect should call out scope creep explicitly — separate the asks rather than rolling them up.',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ARCHITECT_RUBRIC,
};

export default A2_SCOPE_PUSHBACK;
