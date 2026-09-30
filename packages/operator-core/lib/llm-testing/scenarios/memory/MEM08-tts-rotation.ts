/**
 * MEM08 — boot-recall: credential-rotation runbook
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: an ops runbook fact (fictional: TTS 401s mean the monthly
 * ElevenLabs rotation lapsed; run scripts/rotate-el-key.mjs). If the
 * assistant names the script, boot-recall surfaced the memory.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM08_TTS_ROTATION: Scenario = {
  id: 'op-MEM08-tts-rotation',
  version: 1,
  target: 'operator',
  description:
    'A brief admin reports that ElevenLabs TTS calls started returning 401 errors this morning and asks for the fix. The team has a recorded runbook entry for exactly this symptom; success looks like the operator surfacing the recorded fix procedure (available in operator memory) rather than generic credential advice.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'reference',
        body: 'ElevenLabs TTS returning 401s = the monthly key rotation lapsed. Fix: run scripts/rotate-el-key.mjs (safe to run manually; ops owns the cron). Do NOT hand-edit the PG credentials row — the script also refreshes the voice-prefs cache.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /rotate-el-key/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM08_TTS_ROTATION;
