/**
 * MEM05 — boot-recall: service ownership / restart etiquette
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: an operational ownership fact (fictional: the holepunch
 * signaling server belongs to the voice-infra rotation; announce before
 * restarting). If the assistant names the voice-infra channel/rotation,
 * boot-recall surfaced the memory.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM05_SIGNALING_OWNER: Scenario = {
  id: 'op-MEM05-signaling-owner',
  version: 1,
  target: 'operator',
  description:
    'A brief admin says they need to restart the holepunch signaling server and asks whether there is anything they should know or do first. The team has a recorded ownership/etiquette rule for exactly this action; success looks like the operator surfacing that recorded rule (available in operator memory) before any restart steps.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'project',
        body: 'The holepunch signaling server is owned by the voice-infra rotation. Announce in #voice-infra and wait for an ack BEFORE restarting it — unannounced restarts drop every active voice channel mid-call.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /voice-infra/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM05_SIGNALING_OWNER;
