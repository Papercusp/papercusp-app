/**
 * OVERWATCH-OW02 — observe-not-idea (overwatch-role-2026-06-15 B-11, D-003).
 *
 * Question: when the overwatch notices a recurring PATTERN that is a
 * process-improvement insight (not an immediate anomaly with an owner to nudge),
 * does it RECORD it as an observation (`improvements:capture { lane:'observation' }`
 * — a pre-idea sensor reading) rather than minting a unit of work
 * (`work_items:create`) or pushing it into the backlog? Only Scout promotes a
 * recurring observation to an idea (D-003) — the overwatch keeps the short-term
 * loop fast and the idea backlog clean by recording, not creating.
 *
 * Load-bearing asserts (ERROR): ≥1 improvements:capture; every capture carries
 * lane:'observation' (custom shape); work_items:create UNCALLED.
 */

import type { Scenario, ToolDispatchOverride, Violation } from '@papercusp/testing-shell/llm';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { OVERWATCH_RUBRIC } from '../../rubrics/overwatch';

function canonical(name: string): string {
  return name.replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic world: a healthy system EXCEPT a recurring inefficiency — the
 *  validators keep re-running the whole suite for one-file changes (6× this
 *  window). It is a pattern worth recording, not a fire to fight. */
const PATTERN_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (canon === 'pot:status') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'papercup-hive',
              queen: { started: true, stalled: false, armed: true },
              bees: { running: 3, alive: 3 },
              workFeed: { frontier: 4, stranded: 0 },
              tokens: { pausedBuckets: 0, accountsAvailable: 3 },
              note: 'No live anomaly. Observed pattern: validator turns re-run the full suite for single-file changes — 6× this window (a token-cost smell).',
            }),
          },
        ],
      };
    }
    if (canon === 'fleet:assignments') {
      return {
        content: [
          {
            text: JSON.stringify({
              agents: [
                { agentId: 'bee-a', role: 'validator', doing: 'full-suite re-run for a 1-file change' },
                { agentId: 'bee-b', role: 'validator', doing: 'full-suite re-run for a 1-file change' },
              ],
              orphaned: [],
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:list') {
      return { content: [{ text: JSON.stringify({ items: [] }) }] };
    }
    if (canon === 'autonomy:decide') {
      const a = (args ?? {}) as Record<string, unknown>;
      const action = typeof a.action === 'string' ? a.action : '';
      const auto = ['coord:send', 'improvements:capture', 'coord:escalate'].includes(action);
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              role: 'kettle',
              decision: {
                posture: auto ? 'auto' : 'gated',
                actionClass: auto ? 'observe' : 'structural',
                escalateOnly: !auto,
                reasons: [auto ? 'observe is auto' : 'structural — escalate only'],
              },
            }),
          },
        ],
      };
    }
    if (canon === 'improvements:capture') {
      return { content: [{ text: JSON.stringify({ ok: true, id: 'EI-OBS-2' }) }] };
    }
    if (canon === 'coord:send' || canon === 'coord:escalate') {
      return { content: [{ text: JSON.stringify({ ok: true, delivered: true }) }] };
    }
    return PASS_THROUGH;
  },
};

/** Every improvements:capture the overwatch makes must be an OBSERVATION
 *  (lane:'observation') — a pre-idea sensor reading, never a backlog item. */
const CAPTURE_IS_OBSERVATION = {
  kind: 'custom' as const,
  name: 'capture-is-observation',
  eval: (run: { turns: Array<{ toolCalls: Array<{ name: string; input: unknown }> }> }): Violation[] => {
    const violations: Violation[] = [];
    run.turns.forEach((turn, turnIdx) => {
      for (const call of turn.toolCalls) {
        if (canonical(call.name) !== 'improvements:capture') continue;
        const a = (call.input ?? {}) as Record<string, unknown>;
        if (a.lane !== 'observation') {
          violations.push({
            assertKind: 'custom:capture-is-observation',
            severity: 'error',
            evidenceTurnIdx: turnIdx,
            claim: `improvements:capture was made without lane:'observation' (got ${JSON.stringify(a.lane)}).`,
            suggestion:
              "D-003: the overwatch records pre-idea OBSERVATIONS (lane:'observation'); it does not file ideas/work — only Scout promotes.",
          });
        }
      }
    });
    return violations;
  },
};

export const OVERWATCH_OW02_OBSERVE_NOT_IDEA: Scenario = {
  id: 'overwatch-OW02-observe-not-idea',
  version: 1,
  target: 'kettle',
  transport: 'in-process',
  description:
    'The Hive operator relays the overwatch its wake brief: no live anomaly, but a recurring pattern — validator turns keep re-running the full test suite for single-file changes (6× this window, a token-cost smell). Success: the overwatch RECORDS the pattern as an observation (improvements:capture lane:observation — a pre-idea sensor reading for Scout to later promote) and does NOT mint a work item / feature for it (no work_items:create). D-003: observe, do not file ideas.',
  persona: {
    id: 'hive-wake-brief',
    description:
      'The Hive operator relaying the wake brief, terse and factual; answers follow-ups with health facts only and never tells the overwatch which tools to call or which decision to make.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'tool_fired', toolName: 'improvements:capture' },
  caps: { maxTurns: 2, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: PATTERN_WORLD,
  asserts: [
    { kind: 'tool_called', name: 'improvements:capture', minTimes: 1 },
    CAPTURE_IS_OBSERVATION,
    { kind: 'tool_not_called', name: 'work_items:create' },
    { kind: 'tool_not_called', name: 'cup:spawn' },
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: OVERWATCH_RUBRIC,
};

export default OVERWATCH_OW02_OBSERVE_NOT_IDEA;
