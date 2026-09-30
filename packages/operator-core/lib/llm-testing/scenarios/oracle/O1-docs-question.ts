/**
 * O1 — docs-question
 *
 * Persona: brief admin who asks a question that should be answered
 * from the Papercup docs (e.g. "how does the endpoint system work?").
 *
 * Goal: oracle calls a docs:* tool, returns a grounded answer.
 *
 * Asserts:
 *   - docs:* tool was called at least once
 *   - response includes a citation-like reference (e.g. /docs/...)
 *   - no <continue/> / <sleep/> / <spawn/> (oracle doesn't use them)
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { ORACLE_RUBRIC } from '../../rubrics/oracle';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const O1_DOCS_QUESTION: Scenario = {
  id: 'oracle-O1-docs-question',
  version: 1,
  target: 'oracle',
  description:
    'A brief admin asks an architectural question that should be answered from the Papercup docs. Oracle should call docs:search or docs:get, return a grounded answer with a slug-style citation, and stop.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 90, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'tool_called', name: 'docs:search', minTimes: 1, maxTimes: 5 },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
    { kind: 'control_tag_present', tag: 'sleep', maxCount: 0 },
  ],
  rubric: ORACLE_RUBRIC,
};

export default O1_DOCS_QUESTION;
