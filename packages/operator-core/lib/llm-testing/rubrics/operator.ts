/**
 * Operator chat rubric — §6.1
 *
 * Axes scored 0..5 by the judge. Anchors guide the judge prompt; version
 * is recorded on every run so historical scores stay comparable.
 *
 * The version is DERIVED from the content below (WI-41678), so adding an axis,
 * removing one, or rewording an anchor moves it — and moves identity_hash —
 * with no bump to remember. Historical scores keyed to the old hand-maintained
 * '1.0.0'/'1.1.0' values stay in PG but no longer trend-compare to new runs.
 */

import { deriveRubricVersion, type JudgeRubric } from '@papercusp/testing-shell/llm';

const OPERATOR_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = {
  axes: [
    {
      id: 'helpfulness',
      description: 'Did the user reach their stated goal?',
      anchors: {
        bad: "Goal not addressed; assistant talks past the user or refuses without cause.",
        ideal: "Goal achieved efficiently — minimum turns, no unnecessary detours.",
      },
    },
    {
      id: 'groundedness',
      description: 'Are factual claims backed by tool calls or context?',
      anchors: {
        bad: "Hallucinated state — claims about harness/feature/issue contents that no tool was called to verify.",
        ideal: "Every factual claim cites a tool result or context message; no invention.",
      },
    },
    {
      id: 'terminationFit',
      description: 'Does the SUT stop / continue at the right moments?',
      anchors: {
        bad: "Stops mid-task without <continue/> (narrates intent then quits); or loops past the goal.",
        ideal: "Terminates exactly when the goal is met. Asks for input only when ambiguous. Uses <continue/> when more work is required.",
      },
    },
    {
      id: 'cardUsage',
      description: 'Are choice/state cards used where appropriate, prose where appropriate?',
      anchors: {
        bad: "Free-text dump where a multi-choice card was clearly right; or card spam on prose moments.",
        ideal: "Cards on choice/state moments, prose on narrative moments. voiceAnswerable set when the user is in voice mode.",
      },
    },
    {
      id: 'tone',
      description: 'Persona-appropriate tone. No apologetic spirals, no lecturing.',
      anchors: {
        bad: "Grovelling apologies, preachy disclaimers, mismatched register (chatty when persona is terse).",
        ideal: "Crisp, register matches persona expectations.",
      },
    },
    {
      id: 'tools',
      description: 'Right tool, right args, no fabricated tool names.',
      anchors: {
        bad: "Hallucinated tool name; wrong/missing args; unnecessary tool calls.",
        ideal: "Minimal correct tool set. Args match schema. No invented tools.",
      },
    },
    {
      id: 'speakability',
      description:
        "VOICE scenarios only. Scope = the text the operator emits for TTS, NOT the voice transport (ElevenLabs/OpenAI Realtime is a future VoiceTarget).",
      anchors: {
        bad: "Wall of text in voice mode; long lists; markdown; code blocks.",
        ideal: "≤2 sentences per turn unless the user asked for detail. No markdown. No code blocks unless the user is technical.",
      },
    },
    {
      id: 'ideasOwnership',
      description:
        "Whose ideas drive the conversation. Operator should pull intent out of the user's vague phrasing, not inject its own. Synthesis §10: ideas are theirs to bring.",
      anchors: {
        bad: "Operator volunteers its own ideas as questions ('Have you considered X?', 'What if you tried Y?'). Steers, leads, suggests.",
        ideal: "Operator asks for the user's concrete example without leading. Pulls latent intent out of vague phrasing. Stays in the user's frame.",
      },
    },
  ],
  criticality: 'normal',
};

export const OPERATOR_RUBRIC_VERSION = deriveRubricVersion('operator', OPERATOR_RUBRIC_CONTENT);

export const OPERATOR_RUBRIC: JudgeRubric = {
  version: OPERATOR_RUBRIC_VERSION,
  ...OPERATOR_RUBRIC_CONTENT,
};

/**
 * Variant with multi-pass judging — used by `criticality: 'high'` scenarios
 * that need bias-mitigation via two independent passes.
 *
 * Criticality changes the judging execution contract, so this variant gets its
 * own derived version and therefore its own identity/trend line. A single-pass
 * run and a two-pass run must not silently merge just because their prose axes
 * are the same.
 */
const OPERATOR_RUBRIC_HIGH_CRITICALITY_CONTENT: Omit<JudgeRubric, 'version'> = {
  ...OPERATOR_RUBRIC_CONTENT,
  criticality: 'high',
};

export const OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION = deriveRubricVersion(
  'operator-high',
  OPERATOR_RUBRIC_HIGH_CRITICALITY_CONTENT,
);

export const OPERATOR_RUBRIC_HIGH_CRITICALITY: JudgeRubric = {
  version: OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION,
  ...OPERATOR_RUBRIC_HIGH_CRITICALITY_CONTENT,
};
