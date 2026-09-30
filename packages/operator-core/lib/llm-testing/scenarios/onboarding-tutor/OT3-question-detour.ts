/**
 * OT3 — question-detour
 *
 * Persona: patient user who, mid-section, types a real question instead of
 * picking [1]/[2] ("wait — what happens to my code if I close the laptop?").
 *
 * Goal: the tutor treats the question as first-class (the option line
 * invites it!), answers grounded — docs:search / docs:get, or honestly says
 * the docs are silent — and then RETURNS to the tutorial: next brief + the
 * exact option line. Abandoning the tutorial thread is the failure mode.
 *
 * Asserts:
 *   - a docs tool was consulted for the off-script question
 *   - the option line re-appears AFTER the detour (the return)
 *   - the tutor never claims the tutorial is over early
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { TUTOR_RUBRIC } from '../../rubrics/onboarding-tutor';
import { OPTION_LINE } from './OT1-section-protocol';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const OT3_QUESTION_DETOUR: Scenario = {
  id: 'onboarding-tutor-OT3-question-detour',
  version: 1,
  target: 'onboarding-tutor',
  description:
    'Mid-tutorial the user asks an off-script question about how their work is kept safe. The tutor should ground the answer (docs:search/docs:get — the pack index maps sections to doc slugs) and then re-anchor: return to the current section with the exact option line, not abandon the tutorial.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 8, maxWallSecs: 240, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'tool_called', name: 'docs:search', minTimes: 1, maxTimes: 6 },
    { kind: 'text_contains', pattern: OPTION_LINE },
    { kind: 'text_excludes', pattern: /tutorial (is )?(now )?(complete|finished|over)/i },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
  ],
  rubric: TUTOR_RUBRIC,
};

export default OT3_QUESTION_DETOUR;
