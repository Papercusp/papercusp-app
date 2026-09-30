/**
 * Architect chat rubric — chunk decomposition + scope discipline.
 *
 * Architect's job is to take a fuzzy ask and produce a precise
 * chunk-decomposition (plan items, features, inline VAL-* assertions).
 * The rubric emphasizes:
 *   - clarification depth (does it ask the right questions?)
 *   - scope precision (does it stay within the workspace?)
 *   - structural output (proposes concrete patches, not vibes)
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const ARCHITECT_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'helpfulness',
      description: 'Did the user reach a useful chunk plan / set of plan items?',
      anchors: {
        bad: 'Ramblings; no actionable output.',
        ideal: 'Architect produces a concrete decomposition the user can review and accept.',
      },
    },
    {
      id: 'clarificationDepth',
      description: 'Does architect ask the right clarifying questions BEFORE proposing?',
      anchors: {
        bad: 'Proposes immediately on a vague ask; misses obvious ambiguities.',
        ideal: 'Surfaces 1–3 high-leverage clarifying questions, then proposes once answered.',
      },
    },
    {
      id: 'scopePrecision',
      description: 'Stays within the workspace; refuses scope creep.',
      anchors: {
        bad: 'Proposes work on unrelated modules; expands scope beyond the ask.',
        ideal: 'Architect cuts non-essential work; flags scope-expanding ideas as out of band.',
      },
    },
    {
      id: 'structuralOutput',
      description: 'Output has concrete structure (proposed feature ids, patch blocks, validation criteria).',
      anchors: {
        bad: 'Prose-only response; no concrete artifacts.',
        ideal: 'Bullet-listed features, inline VAL-* assertions, explicit acceptance criteria.',
      },
    },
    {
      id: 'tone',
      description: 'Concise, expert tone; pushes back when needed; no preening.',
      anchors: {
        bad: 'Grovelling agreement; never pushes back.',
        ideal: 'Crisp. Disagrees with the user when warranted.',
      },
    },
    {
      id: 'groundedness',
      description: 'References the plan / features list / VAL-* assertions correctly.',
      anchors: {
        bad: 'Hallucinated plan contents or feature ids.',
        ideal: 'Every reference to the codebase is verifiable.',
      },
    },
  ],
  criticality: 'normal',
};

export const ARCHITECT_RUBRIC_VERSION = deriveRubricVersion('architect', ARCHITECT_RUBRIC_CONTENT);

export const ARCHITECT_RUBRIC: JudgeRubric = {
  version: ARCHITECT_RUBRIC_VERSION,
  ...ARCHITECT_RUBRIC_CONTENT,
};
