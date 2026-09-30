/**
 * SN-H01 — "what's the fleet doing right now?"
 *
 * The Sentinel must answer a live hive-state question by CONSULTING A TOOL
 * (roster / fleet read) and giving a grounded, speakable summary of who is
 * actually running and on what — not a blind, memory-sourced guess. This is the
 * anti-hallucination floor for the hive-knowledge set. realWorkspace so it runs
 * against the live workspace's actual roster.
 *
 * sentinel-as-claude-tui-2026-06-23 (voice-flow testing P2).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { consultedATool } from './_asserts';
import { formatLength220, noMarkdownInSay } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const SN_H01_FLEET_STATUS: Scenario = {
  id: 'sn-H01-fleet-status',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel "what is the fleet/swarm doing right now?". Success: the Sentinel calls a roster/fleet read tool (does NOT answer from memory) and gives a grounded, speakable summary of which agents are live and what they are working on — naming real entities from the workspace, not invented ones. The judge must penalize a confident answer with no tool call (hallucination risk) and reward a crisp, accurate, voice-friendly summary.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 150, maxCostUsd: 1.0 },
  realWorkspace: true,
  runMatrix: { repeat: 1, variancePolicy: 'none' },
  asserts: [
    { kind: 'custom', name: 'consultedATool', eval: consultedATool },
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN_H01_FLEET_STATUS;
