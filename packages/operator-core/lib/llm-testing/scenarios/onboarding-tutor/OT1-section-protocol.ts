/**
 * OT1 — section-protocol
 *
 * Persona: patient new user starting the tutorial (first-run mode).
 *
 * Goal: the tutor opens warmly, gives a section BRIEF (2–4 sentences), and
 * ends the message with EXACTLY the option line — the tutorial's engine.
 *
 * Asserts:
 *   - the exact option line appears verbatim
 *   - setup:status is re-read before trusting the handoff snapshot
 *     (verify-before-claim: the launch context says the snapshot is stale)
 *   - no control tags (the tutor is a plain conversational session)
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import { TUTOR_RUBRIC } from '../../rubrics/onboarding-tutor';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const OPTION_LINE = '[1] Continue · [2] More details · or just type your question';

export const OT1_SECTION_PROTOCOL: Scenario = {
  id: 'onboarding-tutor-OT1-section-protocol',
  version: 1,
  target: 'onboarding-tutor',
  description:
    'A new user says hi and is ready to start. The tutor should verify setup state (setup:status), open the first section with a 2–4 sentence brief, and end with the exact option line — never a lecture, never a reworded menu.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'text_contains', pattern: OPTION_LINE },
    { kind: 'tool_called', name: 'setup:status', minTimes: 1, maxTimes: 4 },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
    { kind: 'control_tag_present', tag: 'spawn', maxCount: 0 },
  ],
  rubric: TUTOR_RUBRIC,
};

export default OT1_SECTION_PROTOCOL;
