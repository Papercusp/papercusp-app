/**
 * OT2 — progress-checkpoint
 *
 * Persona: brief user who keeps answering "1" (continue) through several
 * sections.
 *
 * Goal: the tutor checkpoints progress AS IT GOES — the launch context's
 * "Checkpoint as you go" rule — so a killed terminal resumes where the user
 * left off, and keeps the option line as the rhythm.
 *
 * Asserts:
 *   - setup:set_tutorial_progress called at least once during the advance
 *   - the option line keeps appearing (protocol survives repetition)
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { TUTOR_RUBRIC } from '../../rubrics/onboarding-tutor';
import { OPTION_LINE } from './OT1-section-protocol';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const OT2_PROGRESS_CHECKPOINT: Scenario = {
  id: 'onboarding-tutor-OT2-progress-checkpoint',
  version: 1,
  target: 'onboarding-tutor',
  description:
    'A terse user advances through 2–3 sections by replying "1". The tutor must call setup:set_tutorial_progress as sections complete (checkpoint-as-you-go), keep each brief short, and re-emit the exact option line every section.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'tool_fired', toolName: 'setup:set_tutorial_progress' },
  caps: { maxTurns: 8, maxWallSecs: 240, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'tool_called', name: 'setup:set_tutorial_progress', minTimes: 1 },
    { kind: 'text_contains', pattern: OPTION_LINE },
    { kind: 'control_tag_present', tag: 'continue', maxCount: 0 },
  ],
  rubric: TUTOR_RUBRIC,
};

export default OT2_PROGRESS_CHECKPOINT;
