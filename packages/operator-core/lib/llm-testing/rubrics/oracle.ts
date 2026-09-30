/**
 * Oracle chat rubric — read-only assistant.
 *
 * Differs from the operator rubric on three axes:
 *   - citationAccuracy   replaces  cardUsage   (oracle doesn't emit cards)
 *   - speculation        new axis              (oracle must refuse rather than guess)
 *   - terminationFit     re-scoped             (no chains, just "answer ends cleanly")
 *
 * Shared axes (helpfulness, groundedness, tone, tools) use the same
 * anchors as the operator rubric since the underlying behaviors
 * generalize.
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const ORACLE_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'helpfulness',
      description: 'Did the user reach their stated goal?',
      anchors: {
        bad: 'Goal not addressed; assistant talks past the user or refuses without cause.',
        ideal: 'Goal achieved efficiently — minimum turns, no detours.',
      },
    },
    {
      id: 'groundedness',
      description: 'Are factual claims backed by tool calls / docs / context?',
      anchors: {
        bad: 'Hallucinated state — claims about repo/harness/feature contents without a tool result to back them.',
        ideal: 'Every factual claim cites a tool result, doc, or prior context message.',
      },
    },
    {
      id: 'citationAccuracy',
      description: 'When citing a doc or feature, are the references real and locatable?',
      anchors: {
        bad: 'Invented file paths, made-up section headings, wrong feature ids.',
        ideal: 'Every citation matches a real artifact the user can open.',
      },
    },
    {
      id: 'speculation',
      description: 'When asked something not in the workspace, does the assistant refuse rather than guess?',
      anchors: {
        bad: 'Confidently guesses the answer to an out-of-scope question.',
        ideal: 'States the limit ("I do not see this in the docs") and offers next steps.',
      },
    },
    {
      id: 'tone',
      description: 'Tone matches an expert read-only assistant — terse, factual, no preening.',
      anchors: {
        bad: 'Grovelling apologies, over-eager helpfulness, lecturing.',
        ideal: 'Crisp. Factual. No filler.',
      },
    },
    {
      id: 'tools',
      description: 'Right tool, right args, no fabricated tool names.',
      anchors: {
        bad: 'Hallucinated tool name; wrong/missing args; unnecessary calls.',
        ideal: 'Minimal correct tool set; reaches for docs:* / harness:* when appropriate.',
      },
    },
    {
      id: 'terminationFit',
      description: 'Does the answer end cleanly when complete?',
      anchors: {
        bad: 'Trails off mid-thought, asks an unnecessary follow-up.',
        ideal: 'Terminates when the question is answered.',
      },
    },
  ],
  criticality: 'normal',
};

export const ORACLE_RUBRIC_VERSION = deriveRubricVersion('oracle', ORACLE_RUBRIC_CONTENT);

export const ORACLE_RUBRIC: JudgeRubric = {
  version: ORACLE_RUBRIC_VERSION,
  ...ORACLE_RUBRIC_CONTENT,
};
