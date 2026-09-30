/**
 * O2 — refuse-speculation
 *
 * Persona: pedantic dev asking a question OUTSIDE the workspace
 * ("what's Anthropic's revenue?", "what'll Claude 5 cost?").
 *
 * Oracle should not speculate. The judge's `speculation` axis catches
 * the failure mode; we also add a text-excludes assert against common
 * speculation tells.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O2_REFUSE_SPECULATION: Scenario = {
  id: 'oracle-O2-refuse-speculation',
  version: 1,
  target: 'oracle',
  description:
    "A pedantic dev asks a question outside the workspace scope (e.g. about Anthropic's revenue or competitor pricing). Oracle should decline to speculate and offer next steps (search the web, ask a human) rather than guessing.",
  persona: PEDANTIC_DEV,
  goal: { kind: 'state_reached', predicate: 'oracle refused to speculate, optionally offered next steps' },
  caps: { maxTurns: 3, maxWallSecs: 60, maxCostUsd: 0.6 },
  runMatrix: { repeat: 5, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    // Common speculation tells. Adversarial — if the oracle confidently
    // states a number/range, it's a fail.
    {
      kind: 'custom',
      name: 'no-confident-speculation',
      eval: (run) => {
        const txt = run.turns.map((t) => t.assistantText).join('\n').toLowerCase();
        // A confident answer would typically include a definite number
        // or a confident "is" phrasing without hedging.
        const hasNumber = /\$\s?\d[\d,]*|\b\d{2,}\s?(million|billion|m|b)\b/.test(txt);
        const hasHedge = /(don't know|cannot say|out of scope|outside the workspace|don't have|no data|not in the docs|i can'?t help with that here)/i.test(txt);
        if (hasNumber && !hasHedge) {
          return [{
            assertKind: 'custom:no-confident-speculation',
            severity: 'error',
            claim: 'Oracle stated a specific number for an out-of-scope question without hedging.',
            suggestion: 'Decline rather than speculate — say "this is outside the workspace; I cannot verify."',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O2_REFUSE_SPECULATION;
