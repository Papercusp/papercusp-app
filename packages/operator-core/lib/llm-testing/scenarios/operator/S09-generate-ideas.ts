/**
 * S09 — generate-ideas
 *
 * Persona: idle admin who clicks the "Generate Ideas" button (or
 * hits Cmd+Shift+I).
 *
 * The runner fires a `generate_ideas` trigger as the FIRST turn —
 * no prior user message. Operator should respond with a productive
 * scan-and-suggest output: at least one tool call (docs:* / search:*
 * / harness:* / issues:*) and substantive text.
 *
 * Covers: B10 (generate-ideas trigger).
 *
 * Implementation note: the framework's runner exposes `pendingTrigger`
 * which the OperatorTarget threads as the first turn's trigger. The
 * scenario's `triggers` field declares `on: 'after_turn', param: 0`
 * so the runner fires it before sim-user gets a say.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S09_GENERATE_IDEAS: Scenario = {
  id: 'op-S09-generate-ideas',
  version: 1,
  target: 'operator',
  description:
    'Admin clicks the Generate Ideas button (or fires Cmd+Shift+I) with no prior context. The operator should produce a useful proactive suggestion: scan the harness, surface 2-3 things to look at, do not say "I don\'t know" or repeat the user back.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  // Production `generateIdeas` (OperatorConversationProvider) fires
  // runGeneration('user_says_ready') — there's no distinct wire
  // trigger. We mirror that here so the operator receives exactly
  // what the Generate Ideas button sends.
  triggers: [{ on: 'after_turn', fire: 'user_says_ready', param: 0 }],
  asserts: [
    // Must NOT say "I don't know" / "I can't help" type refusals.
    { kind: 'text_excludes', pattern: /i (don'?t know|can'?t help)/i, turnIdx: 0 },
    // Must produce substantive first turn (≥ 60 chars of assistant text).
    {
      kind: 'custom',
      name: 'substantive-first-turn',
      eval: (run) => {
        const t0 = run.turns[0];
        if (!t0) return [{
          assertKind: 'custom:substantive-first-turn',
          severity: 'error',
          claim: 'No first turn was produced for the generate_ideas trigger.',
        }];
        if (t0.assistantText.trim().length < 60) {
          return [{
            assertKind: 'custom:substantive-first-turn',
            severity: 'error',
            evidenceTurnIdx: 0,
            claim: `Generate-ideas response was too short (${t0.assistantText.trim().length} chars) — likely a refusal or stub.`,
          }];
        }
        return [];
      },
    },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S09_GENERATE_IDEAS;
