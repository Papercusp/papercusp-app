/**
 * SU-S03 — push, not poll.
 *
 * Question: asked to make a panel live-update, does the engineer reach for a
 * push transport (SSE on web / IPC on desktop, via @papercusp/sync) rather
 * than defaulting to a polling loop?
 *
 * Load-bearing asserts (ERROR): the engineer reads current source/docs first
 * and the reply credits a push transport. The judge distinguishes recommending
 * a component timer from explicitly rejecting one; a bare lexical exclusion
 * cannot make that distinction and is deliberately not used here.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertToolCalledWithin } from './_asserts';
import { PUSH_UI_GROUNDING_CONTEXT } from './_overrides';

export const SU_S03_PUSH_NOT_POLL: Scenario = {
  id: 'su-S03-push-not-poll',
  version: 4,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer wants a small panel that live-updates: as fleet agents change state, the panel should refresh on its own without the user reloading. They ask the engineer how to wire the live updates from the operator to the UI. Mentioning a discarded timer design solely to explain its removal is not a failure; recommending it as the implementation is.',
  persona: PEDANTIC_DEV,
  simUserContext:
    'You are a developer asking for the current, concrete wiring of a live fleet-agent-state panel. ' +
    'A complete answer names the existing advRoster.list query, HarnessSyncProvider/useSyncQuery, the ' +
    'sync_invalidate LISTEN/NOTIFY bridge, and the source files that define them. The provider mounts the ' +
    'shared sync boundary; SessionsRosterContext is the concrete consumer that calls useSyncQuery. Once the engineer gives ' +
    'that grounded path, declare success; never demand invented latency numbers.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: PUSH_UI_GROUNDING_CONTEXT,
  asserts: [
    assertToolCalledWithin(['docs:*', 'search:*', 'repomix:pack'], 1, {
      name: 'grounds-current-push-surface-first',
      claim:
        'Expected the engineer to inspect the current docs or source in the first assistant turn ' +
        'before naming Papercusp-specific event endpoints, hooks, or packages.',
      suggestion: "Playbook 'Docs-first': verify the current push/sync surface before prescribing its API.",
    }),
    assertTextRequires(
      /\b(SSE|server-sent|IPC|pg_notify|LISTEN\/NOTIFY|useSyncQuery|useSync|@papercusp\/sync|EventSource)\b/i,
      {
        name: 'credits-push-transport',
        claim:
          'Expected the engineer to wire live updates via a push transport ' +
          '(SSE/IPC through @papercusp/sync), not a polling loop.',
        suggestion: "Playbook: don't default to polling — push (IPC on desktop, SSE on web); route data through @papercusp/sync.",
      },
    ),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S03_PUSH_NOT_POLL;
