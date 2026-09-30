/**
 * Shared deterministic asserts for the Sentinel scenario suite
 * (sentinel-as-claude-tui-2026-06-23 voice-flow testing).
 *
 * The Sentinel runs the role='sentinel' converse brain; the agent-mcp route
 * streams the assistant turn RAW (the client strips control tags for display,
 * the server re-parses to dispatch), so `<handoff>` lands in the
 * harness's accumulated `assistantText` and tool calls land in `toolCalls`.
 */
import type { RunSummary, Violation } from '@papercusp/testing-shell/llm';

/**
 * Dual-accept, mirroring the parser's own alternation in
 * `operator-converse-tags.ts` — it MUST match every spelling the parser
 * accepts (`<handoff>` and the legacy `<handoff_to_mug>` / `<handoff_to_queen>`).
 *
 * This is load-bearing for the NEGATIVE assert below, not just tidiness: a
 * new-name-only regex would stop matching the moment the prompt flips, so
 * `noHandoff` would pass VACUOUSLY on a run where the Sentinel did hand off.
 * A silently-passing guard is worse than a failing one.
 */
const HANDOFF_RE = /<handoff(?:_to_(?:mug|queen))?[\s/>]/i;
const DELEGATE_RE = /<delegate_deep/i;

/** SOME assistant turn must emit `<handoff>` (work routed to the queue). */
export function emitsHandoff(run: RunSummary): Violation[] {
  if (run.turns.some((t) => HANDOFF_RE.test(t.assistantText))) return [];
  return [
    {
      assertKind: 'custom:emitsHandoff',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel never emitted <handoff> for a planning-scale ask.',
      suggestion:
        'Route substantial multi-step work to the queue via <handoff> (files a high-priority work_item + nudges the recipient), not plan/place/execute it itself.',
    },
  ];
}

/** NO assistant turn may emit `<handoff>` (kept local / answered directly). */
export function noHandoff(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => HANDOFF_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noHandoff',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel handed a quick, directly-answerable request off to the Mug.',
      suggestion:
        'Reserve <handoff> for substantial multi-step work; answer status / quick-recall directly — a handoff spams the work queue.',
    },
  ];
}

/** NO assistant turn may emit `<delegate_deep>` (the ask should stay local / answered directly). */
export function noDelegate(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => DELEGATE_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noDelegate',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel routed the ask through <delegate_deep> instead of answering from existing delegation state.',
      suggestion:
        'Use <delegate_deep> only for NEW hard-thinking work. A follow-up on an existing analysis should be answered from the open delegation work-item state.',
    },
  ];
}

/**
 * The Sentinel must CONSULT A TOOL before answering a question about live hive
 * state (fleet/plans/work-items/mail), rather than answering blind from memory —
 * the anti-hallucination floor for the hive-knowledge scenarios. Tool-agnostic
 * (any toolCall counts) so it doesn't brittle-pin a specific read tool name.
 */
export function consultedATool(run: RunSummary): Violation[] {
  if (run.turns.some((t) => t.toolCalls.length > 0)) return [];
  return [
    {
      assertKind: 'custom:consultedATool',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel answered a live-hive-state question without calling any tool (blind/likely hallucinated).',
      suggestion:
        'Answer live hive questions by calling a read tool (roster / plans / work-items / coord), not from memory.',
    },
  ];
}
