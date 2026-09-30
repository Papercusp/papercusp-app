/**
 * S07 — passive-mode
 *
 * Persona: brief admin who has disabled proactive ticks.
 * Goal: ask a question, see a clean single-turn answer with no
 *       auto-fire, no <continue/> chain.
 *
 * Covers: B8 (passive mode suppresses V8 auto-fire + continue).
 *
 * NB: this scenario depends on the workspace's voice-prefs setting
 *     proactiveTicksEnabled=false. With the default isolated workspace,
 *     no voice-prefs row exists → default `proactiveTicksEnabled ?? true`
 *     means active mode. To exercise passive faithfully, this scenario
 *     should be re-run against a `realWorkspace: true` workspace where
 *     the admin has flipped the toggle. Marked as such, with a note.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S07_PASSIVE_MODE: Scenario = {
  id: 'op-S07-passive-mode',
  version: 1,
  target: 'operator',
  description:
    'Admin in passive mode (proactiveTicksEnabled=false) asks a question. The operator should answer in a single turn — no <continue/> chain, no V8 terminal auto-fire.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 60, maxCostUsd: 0.6 },
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  realWorkspace: true,
  asserts: [
    { kind: 'auto_fire_did_not_happen' },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S07_PASSIVE_MODE;
