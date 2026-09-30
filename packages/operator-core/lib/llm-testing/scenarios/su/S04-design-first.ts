/**
 * SU-S04 — design-first UI work.
 *
 * Question: on a UI/component ask, does the engineer ground the work in the
 * design system (design-phase:* token/component registry, or the design docs)
 * before hand-rolling a component?
 *
 * Load-bearing assert (ERROR): a design-phase:* tool was called, OR a docs:*
 * call whose args reference "design".
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch, assertToolSequence, effectiveToolCall } from './_asserts';
import { makeDesignStatusBadgeContext } from './_overrides';

function reachesForDesignSystem(tc: ToolCallEvent): boolean {
  const { name, input } = effectiveToolCall(tc);
  if (name.startsWith('design-phase:')) return true;
  if (name.startsWith('docs:')) {
    return /design/i.test(JSON.stringify(input));
  }
  return false;
}

function materializesApprovedComponent(tc: ToolCallEvent): boolean {
  const { name, input: args } = effectiveToolCall(tc);
  const input = JSON.stringify(args);
  if (name === 'capability:write' || name === 'capability:edit') {
    return /HarnessCard\.tsx/i.test(input);
  }
  return name === 'code:run'
    && /capability(?::|\.|\[['"])?(?:write|edit)/i.test(input)
    && /HarnessCard\.tsx/i.test(input);
}

function verifiesApprovedComponent(tc: ToolCallEvent): boolean {
  const { name, input } = effectiveToolCall(tc);
  return name === 'capability:read' && /HarnessCard\.tsx/i.test(JSON.stringify(input));
}

export const SU_S04_DESIGN_FIRST: Scenario = {
  id: 'su-S04-design-first',
  version: 6,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to update the existing HarnessCard so its existing live / idle / stale state is rendered with the shared StatusPill. They explicitly prohibit a new badge primitive and approve direct implementation in this session.',
  persona: PATIENT_ADMIN,
  simUserContext:
    'Your exact request is to update apps/operator-vite/src/components/harness-card/HarnessCard.tsx so its ' +
    'EXISTING live | idle | stale state prop renders the EXISTING shared StatusPill inline. Do not request a new ' +
    'status value, a wrapper component, or another path. Say the approach and self-execution route are already ' +
    'approved. On every follow-up, repeat only that unchanged request and tell the engineer to proceed now.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  get toolOverride() {
    return makeDesignStatusBadgeContext();
  },
  asserts: [
    assertToolMatch(reachesForDesignSystem, {
      name: 'reaches-for-design-system',
      claim:
        'Expected the engineer to consult the design system before hand-rolling UI — a design-phase:* ' +
        'tool (tokens / component registry) or a docs:* read of the design docs.',
      suggestion: "Playbook: read the design docs + check design-phase tokens/registry before building UI.",
    }),
    assertToolMatch(materializesApprovedComponent, {
      name: 'materializes-approved-component',
      claim:
        'The engineer researched the design system but never materialized the approved status-badge change.',
      suggestion:
        'After grounding in StatusPill and the existing HarnessCard source, use code:run or capability:write/edit ' +
        'to land the approved component instead of repeating discovery or asking again.',
    }),
    assertToolSequence(materializesApprovedComponent, verifiesApprovedComponent, {
      name: 'verifies-materialized-component',
      claim:
        'The engineer did not read HarnessCard.tsx after the mutation, so its completion claim is not grounded in the materialized bytes.',
      suggestion:
        'After the write result, call capability:read on HarnessCard.tsx and verify the StatusPill mapping before claiming done.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S04_DESIGN_FIRST;
