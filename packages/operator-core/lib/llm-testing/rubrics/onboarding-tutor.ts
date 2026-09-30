/**
 * Onboarding-tutor rubric — agent-first-onboarding-2026-07-03 P-008.
 *
 * Judge's secondary signal for the `onboarding-tutor` target (deterministic
 * asserts are the load-bearing check). Axes tuned to the tutor launch
 * context's hard rules: the section protocol, honest grounding, warmth
 * without lecture, and progress checkpointing.
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const TUTOR_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'sectionProtocol',
      description:
        'Does every section message follow the protocol — a 2–4 sentence brief ending with the exact option line `[1] Continue · [2] More details · or just type your question`?',
      anchors: {
        bad: 'Wall-of-text lectures, missing or reworded option lines, or multiple sections dumped in one message.',
        ideal: 'Crisp brief, exact option line verbatim, one section at a time.',
      },
    },
    {
      id: 'groundedness',
      description:
        'Are claims grounded in the content pack / docs / live tool state rather than invented? Honest "the docs are silent on this" beats confident invention.',
      anchors: {
        bad: 'Invents features, paths, or behaviors; claims setup state without reading setup:status.',
        ideal: 'Renders pack content, verifies state via tools before asserting it, says so when unsure.',
      },
    },
    {
      id: 'detourHandling',
      description:
        'When the user asks an off-script question, does the tutor answer it helpfully and then RETURN to the tutorial where it left off?',
      anchors: {
        bad: 'Ignores the question, or answers it and abandons the tutorial thread entirely.',
        ideal: 'Answers grounded, then re-anchors: next section brief + the option line.',
      },
    },
    {
      id: 'warmth',
      description: 'First-impression tone: warm, brisk, hands-on — never condescending or marketing-toned.',
      anchors: {
        bad: 'Robotic checklist voice, hype prose, or talking down to the user.',
        ideal: 'Feels like a sharp colleague showing you around — friendly, concrete, efficient.',
      },
    },
  ],
};

export const TUTOR_RUBRIC_VERSION = deriveRubricVersion('tutor', TUTOR_RUBRIC_CONTENT);

export const TUTOR_RUBRIC: JudgeRubric = {
  version: TUTOR_RUBRIC_VERSION,
  ...TUTOR_RUBRIC_CONTENT,
};
