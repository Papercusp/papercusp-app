/**
 * SN-D01 — Sentinel delegates HARD THINKING instead of grinding or mis-routing
 * (voice-unified-sentinel-pipeline-2026-07-01, P-007, D-003).
 *
 * Question: when a voice user asks something that needs REAL investigation
 * (deep code/state analysis) but whose ANSWER belongs back in the conversation,
 * does the Sentinel route it through the delegate-deep seam (`<delegate_deep>`)
 * — NOT hand it to the Mug (she places work; she is not an answer channel),
 * NOT spawn anything itself, and NOT disappear into the analysis inline?
 *
 * Assertable the same way the handoff suite is: the converse route streams the
 * assistant turn RAW, so the `<delegate_deep` tag lands in assistantText.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';
import { noHandoff } from './_asserts';

const DELEGATE_RE = /<delegate_deep/i;

/** Deterministic: SOME assistant turn must emit `<delegate_deep>`. */
function emitsDelegate(run: RunSummary): Violation[] {
  if (run.turns.some((t) => DELEGATE_RE.test(t.assistantText))) return [];
  return [
    {
      assertKind: 'custom:emitsDelegate',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel never emitted <delegate_deep> for a hard-thinking question.',
      suggestion:
        'A question needing real investigation whose answer belongs back in the conversation goes through the delegate-deep seam (an ephemeral background agent answers; the result re-enters the pane) — not the Mug, not inline grinding.',
    },
  ];
}

export const SN_D01_DELEGATE_HARD_THINKING: Scenario = {
  id: 'sn-D01-delegate-hard-thinking',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel a hard analysis question that needs minutes of real investigation but expects an ANSWER back in the conversation (e.g. "dig through the federation test history and tell me why the joiner tests keep flaking — I want your actual diagnosis, not a guess"). Success: the Sentinel acks honestly ("digging into that — I\'ll come back to you") and emits <delegate_deep> with a faithful summary/brief so a background agent works it. The judge must NOT reward: handing the QUESTION to the Mug (<handoff> — she places work, she is not an answer channel), attempting the whole analysis inline, or pretending to already know the answer.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsDelegate', eval: emitsDelegate },
    // A thinking question must NOT be routed to the Mug…
    { kind: 'custom', name: 'noHandoff', eval: noHandoff },
    // (A `tool_not_called: 'cup:spawn'` assert sat here until P-059. It could
    // never fail — `cup:spawn` excluded `papercup` from its agentRoles, and the
    // Sentinel's `<spawn>` tag is `!isSentinel`-guarded — and the verb is now
    // retired outright. Re-pointing it was rejected: EVERY surviving spawn door
    // is likewise unreachable for this role, so the guard is structural, not
    // behavioural, and any replacement would be vacuous in the same way.)
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};
