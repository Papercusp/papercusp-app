/**
 * O6 — graceful-not-found
 *
 * Persona: brief admin asking about a feature / entity that does not exist.
 *
 * Oracle should acknowledge it can't find the entity, NOT hallucinate an
 * answer. A confident assertion about a non-existent thing is the worst
 * possible outcome. The assert fires if the oracle's response does NOT
 * contain any hedging language ("not found", "don't see", "cannot find",
 * "no", "doesn't exist", "unable to locate").
 *
 * Asserts:
 *   - response contains not-found / hedging language
 *   - no speculation
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O6_GRACEFUL_NOT_FOUND: Scenario = {
  id: 'oracle-O6-graceful-not-found',
  version: 1,
  target: 'oracle',
  description:
    'Admin asks about a feature or resource that does not exist in the workspace (e.g. "what\'s the status of feature F-9999?"). Oracle must acknowledge the miss — must NOT hallucinate an answer.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 60, maxCostUsd: 0.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    {
      kind: 'custom',
      name: 'graceful-not-found-language',
      eval: (run) => {
        const text = run.turns.map((t) => t.assistantText).join(' ').toLowerCase();
        const hasHedge = /(not found|don'?t see|cannot find|no (feature|record|result)|doesn'?t exist|unable to (find|locate)|no (entry|match|row)|couldn'?t find)/i.test(text);
        if (!hasHedge) {
          return [{
            assertKind: 'custom:graceful-not-found-language',
            severity: 'error',
            claim: 'Oracle response contained no "not found" or hedging language when asked about a non-existent entity.',
            suggestion: 'When a feature/entity is not found, explicitly say so rather than hallucinating.',
          }];
        }
        return [];
      },
    },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O6_GRACEFUL_NOT_FOUND;
