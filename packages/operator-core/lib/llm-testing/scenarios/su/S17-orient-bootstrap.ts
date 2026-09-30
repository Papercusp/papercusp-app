/**
 * SU-S17 — reach for coord:orient at wake (tool-call-batching-wrappers P-008 / D-004).
 *
 * Question: at session start, when the engineer must orient (assignments + claimable
 * + inbox + plan-events + a memory recall + declare intent), does it REACH for the ONE
 * coord:orient { intent } bundle, or fan out the six primitives (fleet:assignments +
 * work_items:list + coord:inbox + coord:plan-events + memory:search +
 * coord:declare-intent) one round-trip at a time?
 *
 * Load-bearing assert (ERROR): coord:orient is called. Secondary: the bootstrap
 * primitives are NOT hand-fanned (they belong inside the one orient call).
 *
 * ⚠ DO NOT WEAKEN THE ERROR ASSERT BECAUSE OF THE TURN-START ORIENTATION FOLD.
 * (plan fleet-deltas-leader-primitives-2026-07-10, P-005 / D-008 ruling 4, which this
 * comment CORRECTS after reading the scenario rather than its item text.)
 *
 * The fold delivers an `## Orientation` block carrying ONLY held work-items,
 * unanswered directed messages, and whether a wake source is armed — and only to
 * hook-enrolled Claude Code sessions. THIS scenario's ask deliberately spans what the
 * block EXCLUDES: "what's claimable" and "recall anything relevant to the gateway-retry
 * work". `claimable` is absent from the fold by design (a raw status='open' query
 * overcounts ~13x, so a wrong count injected every turn is worse than none) and so is
 * mem0. Therefore coord:orient remains the CORRECT call here whether or not a block
 * arrived, and the ERROR assert stays load-bearing. What changed is only the FRAMING:
 * orient is no longer "the mandated bootstrap you must always call" — it is the
 * deliberate full read, which is exactly what this ask requires.
 *
 * The complement is NOT covered here and is worth adding when the scenario harness can
 * seed injected context: an agent handed an `## Orientation` block, asked ONLY for what
 * the block already contains, should NOT call coord:orient. Assert-by-absence needs that
 * seeding to be meaningful, so it is deliberately not faked in this file.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { ORIENT_BOOTSTRAP_CONTEXT } from './_overrides';

export const SU_S17_ORIENT_BOOTSTRAP: Scenario = {
  id: 'su-S17-orient-bootstrap',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    "A developer tells the engineer: you're starting your shift — get oriented before picking anything up. What are you assigned, what's claimable, any unread messages, what plans changed, and recall anything relevant to the gateway-retry work you're about to do — and declare that you're on it. This ask spans the claimable backlog and a mem0 recall — neither of which the turn-start orientation fold carries — so the full read is genuinely required here. The engineer should do it in ONE coord:orient { intent } call (which folds assignments + claimable + inbox + plan-events + a memory recall + the declare) rather than fanning out fleet:assignments + work_items:list + coord:inbox + coord:plan-events + memory:search + coord:declare-intent separately.",
  persona: BRIEF_ADMIN,
  simUserContext:
    'You are a brief admin starting an engineer shift. Ask once for the engineer to orient on assignments, ' +
    'claimable work, unread inbox, recent plan events, and memory relevant to gateway-retry, and to declare ' +
    'that they are continuing the assigned gateway-retry lane. The needed outcome is one coord:orient call ' +
    'whose intent names gateway-retry, followed by an accurate concise summary and an unambiguous statement ' +
    'that the engineer is continuing WI-512. A prose summary faithfully grounded in the tool result satisfies ' +
    'you; do not demand raw JSON, unsupported recall/include parameters, or a separate memory:search / ' +
    'coord:declare-intent call. Once the one-call result and WI-512 continuation are clear, declare success.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: ORIENT_BOOTSTRAP_CONTEXT,
  asserts: [
    assertToolCalled(['coord:orient'], {
      name: 'reaches-for-orient-at-wake',
      claim:
        'Expected the engineer to bootstrap with ONE coord:orient { intent } call — this ask spans the ' +
        'claimable backlog and a mem0 recall, which the turn-start orientation fold does not carry — ' +
        'coord:orient was never called.',
      suggestion:
        'Call coord:orient { intent } — it returns assignments + claimable + inbox + plan-events + a memory recall AND declares your intent, in one round-trip. An `## Orientation` block does NOT substitute: it carries held items / unanswered directed messages / wake-source only.',
    }),
    assertToolCallCountAtMost(['fleet:assignments', 'coord:plan-events', 'coord:declare-intent'], 1, {
      name: 'does-not-hand-fan-the-bootstrap-primitives',
      claim:
        'The engineer fanned out the bootstrap primitives (fleet:assignments / coord:plan-events / ' +
        'coord:declare-intent) separately instead of folding them into the single coord:orient call.',
      suggestion: 'coord:orient bundles those — prefer it at wake over calling each primitive.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S17_ORIENT_BOOTSTRAP;
