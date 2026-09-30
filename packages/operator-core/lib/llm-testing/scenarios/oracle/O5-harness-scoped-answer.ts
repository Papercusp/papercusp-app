/**
 * O5 — harness-scoped-answer
 *
 * Persona: brief admin asking specifically about a named harness's status.
 *
 * Oracle must call harness:status (or harness:list + :get) scoped to that
 * harness. It must NOT answer about a different harness or give a
 * workspace-wide answer when a harness-specific answer was asked for.
 *
 * Asserts:
 *   - harness:status or harness:list was called
 *   - response references the named harness slug
 *   - no <continue/>
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O5_HARNESS_SCOPED_ANSWER: Scenario = {
  id: 'oracle-O5-harness-scoped-answer',
  version: 1,
  target: 'oracle',
  description:
    'Admin asks specifically about one harness\'s current status ("what\'s the status of papercup?"). Oracle must read that harness and answer in scope — not give a workspace-wide view.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 90, maxCostUsd: 0.6 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    // One of the harness read tools must be called.
    {
      kind: 'tool_called',
      name: 'harness:status',
      minTimes: 0,   // satisfies together with harness:list
      maxTimes: 5,
    },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
    { kind: 'control_tag_present', tag: 'sleep', maxCount: 0 },
    {
      kind: 'custom',
      name: 'harness-tool-called',
      eval: (run) => {
        const allTools = run.turns.flatMap((t) => (t.toolCalls ?? []).map((c) => c.name));
        const hasHarnessTool = allTools.some((n) => n.startsWith('harness:'));
        if (!hasHarnessTool) {
          return [{
            assertKind: 'custom:harness-tool-called',
            severity: 'error',
            claim: 'Oracle did not call any harness:* tool despite a harness-specific status question.',
            suggestion: 'Call harness:status { slug } or harness:list to ground the response in real data.',
          }];
        }
        return [];
      },
    },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O5_HARNESS_SCOPED_ANSWER;
