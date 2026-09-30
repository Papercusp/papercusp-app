/**
 * MEM09 — boot-recall: box-specific hardware quirk
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a machine-specific hardware fact (the dev box's only
 * reliable capture mic is the Logitech Brio; the Yeti enumerates but
 * records silence). Generic debugging advice can't name the specific
 * device — only the seeded memory can.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM09_MIC_DEVICE: Scenario = {
  id: 'op-MEM09-mic-device',
  version: 1,
  target: 'operator',
  description:
    'A developer reports that their audio-capture e2e test records pure silence on the shared dev box even though the capture device enumerates fine, and asks for ideas. The team recorded the box-specific cause of exactly this symptom; success looks like the operator surfacing the recorded device guidance (available in operator memory), naming the device that actually works.',
  persona: PEDANTIC_DEV,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'feedback',
        body: 'On the primary dev box, audio e2e capture must use the Logitech Brio webcam mic. The Blue Yeti enumerates fine under PipeWire but captures pure silence — a known quirk, not a test bug. Select the Brio explicitly via PULSE_SOURCE.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /\bBrio\b/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM09_MIC_DEVICE;
