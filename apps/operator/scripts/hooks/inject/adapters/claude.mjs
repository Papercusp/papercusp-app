/**
 * CLAUDE CODE injection adapter.
 *
 * Migrated VERBATIM IN SEMANTICS from the two shell hooks it replaces:
 *   apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh      (turn-start)
 *   apps/operator/scripts/hooks/cc/posttoolbatch-midturn-context.sh (mid-turn)
 *
 * Claude is 100% of current injection traffic, so this adapter's job is to
 * change NOTHING observable. Any behavioural difference here is a regression,
 * however tidy it looks.
 */

/** @typedef {import('../ports.mjs').InjectionPort} InjectionPort */

import { buildDigest, clampPrompt, guardCall } from '../core.mjs';

export const client = 'claude';

/**
 * ⚠ MID-TURN IS PostToolBatch, NOT PreToolUse — do NOT "fix" this back (D-027).
 *
 * PreToolUse does not inject additionalContext unless it also carries a
 * `permissionDecision`, and emitting `permissionDecision: 'allow'` from a
 * CONTEXT hook would blanket auto-approve every tool call it matched, bypassing
 * the permission system entirely. A hook that only wants to SAY something must
 * never also vote on whether the call runs.
 *
 * PostToolBatch carries no permission semantics, takes no matcher (so it fires
 * on every batch), and fires after a batch resolves BUT BEFORE THE NEXT MODEL
 * REQUEST — precisely when the agent is about to decide what to do next. This
 * was found by building the PreToolUse version first and watching it deliver
 * nothing with every unit test green.
 *
 * PreToolUse DOES map to a port now, but to the GUARD port (pre-tool), never a
 * context one (P-011, D-023 §3). A worn identity's deny rule is the one thing
 * that is meant to vote, and it may only ever vote no: render() below emits a
 * deny or nothing — never allow, never updatedInput, never additionalContext.
 *
 * @param {string} nativeEvent
 * @returns {InjectionPort | null}
 */
export function portForEvent(nativeEvent) {
  if (nativeEvent === 'UserPromptSubmit') return 'turn-start';
  if (nativeEvent === 'PostToolBatch') return 'mid-turn';
  if (nativeEvent === 'PreToolUse') return 'pre-tool';
  if (nativeEvent === 'Stop') return 'stop';
  if (nativeEvent === 'SessionStart') return 'compaction';
  return null;
}

/**
 * The SessionStart sources that can carry a fresh context the identity's
 * compaction rules should re-seed. A resume replays the old transcript, which
 * already holds what they said, so it is no signal. Whether a `startup` is a
 * first launch or a respawned owner is the SERVER's call (D-024 §3): only it
 * can see whether this owner has taken a turn before.
 */
const COMPACTION_SOURCES = new Set(['startup', 'clear', 'compact']);

/**
 * @param {InjectionPort} port
 * @param {any} event  Claude's hook event JSON, as delivered on stdin.
 * @returns {object | null} null = no signal, spend nothing
 */
export function parse(port, event) {
  if (!event || typeof event !== 'object') return null;

  if (port === 'turn-start') {
    const prompt = event.prompt;
    // A non-string prompt is malformed input, not an empty one: bail rather
    // than coercing, so a client-side shape change surfaces as silence here
    // instead of as a garbage query server-side.
    if (typeof prompt !== 'string') return null;
    return { prompt: clampPrompt(prompt) };
  }

  if (port === 'mid-turn') {
    const calls = event.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return null;
    const toolCalls = buildDigest(
      calls.map((c) => ({
        tool: c && typeof c === 'object' ? c.tool_name : undefined,
        toolInput: c && typeof c === 'object' ? c.tool_input : undefined,
        toolResponse: c && typeof c === 'object' ? c.tool_response : undefined,
      })),
    );
    if (toolCalls.length === 0) return null;
    return { toolCalls };
  }

  if (port === 'pre-tool') return guardCall(event.tool_name, event.tool_input);

  if (port === 'stop') {
    // A stop hook that already made the turn continue once must not do it
    // again: that is how a stop rule would loop the session forever.
    if (event.stop_hook_active === true) return null;
    return {};
  }

  if (port === 'compaction') {
    const source = event.source;
    if (typeof source !== 'string' || !COMPACTION_SOURCES.has(source)) return null;
    return { source };
  }

  return null;
}

/** @type {Partial<Record<InjectionPort, string>>} */
const CONTEXT_EVENT_NAMES = {
  'turn-start': 'UserPromptSubmit',
  'mid-turn': 'PostToolBatch',
  stop: 'Stop',
  compaction: 'SessionStart',
};

/**
 * Claude reads injected context from `hookSpecificOutput.additionalContext`,
 * and `hookEventName` must echo the event that produced it. A Stop hook's
 * additionalContext makes the conversation continue with it in view
 * (code.claude.com/docs/en/hooks, read 2026-09-30).
 *
 * pre-tool is the exception: its text is a refusal reason, and it renders ONLY
 * as a deny.
 * @param {InjectionPort} port
 * @param {string} text
 * @returns {string | null}
 */
export function render(port, text) {
  if (port === 'pre-tool') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: text,
      },
    });
  }
  const hookEventName = CONTEXT_EVENT_NAMES[port];
  if (!hookEventName) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

/**
 * SEAM (P-002 audit): claude cannot pre-empt, and the reason is structural
 * rather than incidental. The hook is a SUBPROCESS whose stdout the CLI reads;
 * `additionalContext` is merged into the prompt (turn-start) or into the batch
 * boundary the CLI is already assembling (mid-turn). No queue exists, so there
 * is nothing for the agent loop to drain and nothing it can cancel.
 *
 * Note the near-miss already documented on `portForEvent` above: PreToolUse
 * WOULD have been able to interfere — not by cancelling, but because delivering
 * context there requires also emitting a `permissionDecision`, i.e. voting on
 * whether the call runs. That was rejected for the same reason this seam is
 * safe: a hook that only wants to SAY something must never also act on the call.
 * The pre-tool GUARD port (P-011) is the one deliberate vote, and it rides the
 * same return value: a deny for one pending call, which cancels nothing else.
 *
 * @type {import('../ports.mjs').DeliverySeam}
 */
export const deliverySeam = {
  mechanism: 'hook-return-value',
  artifact: 'apps/operator/scripts/hooks/inject/index.mjs (stdout → claude CLI)',
  evidence:
    'render() returns a hookSpecificOutput.additionalContext envelope on stdout; the CLI ' +
    'merges it. Verified against the two shell hooks this adapter replaces, which used the ' +
    'same envelope. No message-queue API is involved on any path.',
};

export default { client, portForEvent, parse, render, deliverySeam };
