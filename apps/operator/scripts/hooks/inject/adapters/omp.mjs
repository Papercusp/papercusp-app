/**
 * OMP adapter for the shared context-injection dispatcher.
 *
 * Implements the D-001 frozen InjectionAdapter interface, shared verbatim with
 * `codex-context-injection-parity-2026-08-09`. This file is PURE: it maps omp's
 * native events to the two injection ports and shapes the request. It performs
 * no I/O and imports nothing from `core.mjs` — transport, timeout, kill-switch
 * and fail-silent live there and are identical for every client.
 *
 * ── Why omp needs an adapter that looks slightly different from claude's ──
 * OMP does not execute hooks as subprocesses. A hook is a TS/JS module loaded
 * IN-PROCESS via `await import()` (v17.0.7, src/extensibility/hooks/loader.ts).
 * The client-native artifact that bridges omp's module world to this dispatcher
 * is `apps/operator/scripts/hooks/omp/inject-hook.ts` — the structural
 * equivalent of claude's `.sh` files. That artifact invokes `index.mjs` exactly
 * as claude's hooks are invoked (argv + event JSON on stdin, payload on stdout),
 * so all three clients share one dispatcher and one code path.
 *
 * Consequence for `render()`: claude's stdout payload is a JSON envelope
 * (`hookSpecificOutput.additionalContext`) because that is what the claude CLI
 * parses. OMP's artifact consumes stdout directly and hands the string to
 * `pi.sendMessage()` / the `before_agent_start` return value, so omp's payload
 * is the PLAIN TEXT. Confirmed compatible with `core.mjs` unchanged by the seam
 * owner (su-e0359276, 2026-08-09) — D-001 needs no revision for this.
 *
 * Event vocabulary is measured, not assumed — see plan Decision D-002 for the
 * source evidence behind every event name used here.
 */

/** D-001 invariant 5 — CLAMP BEFORE SENDING. These bound the SERVER's query
 *  construction, so they are contract, not tuning. Do not "optimize" them. */
const TURN_START_PROMPT_CLAMP = 4000;
const MID_TURN_MAX_CALLS = 12;
const MID_TURN_FIELD_CLAMP = 400;

/**
 * OMP native event -> injection port.
 *
 * `before_agent_start` (NOT `turn_start`) is the turn-start port: it fires after
 * the user submits a prompt and before the agent loop begins, and it is the only
 * omp event that carries the prompt text. It is the structural analogue of
 * claude's UserPromptSubmit.
 *
 * `turn_end` (NOT `tool_result`) is the mid-turn port: it carries
 * `toolResults[]` for the whole turn, matching claude's PostToolBatch
 * once-per-batch shape and D-001's 12-calls clamp. `tool_result` fires once per
 * individual call, which would both over-fire and mis-shape the digest.
 */
export function portForEvent(nativeEvent) {
  if (nativeEvent === 'before_agent_start') return 'turn-start';
  if (nativeEvent === 'turn_end') return 'mid-turn';
  return null;
}

function clamp(value, max) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      // Circular / non-serialisable tool arguments must never throw here: a
      // malformed single call degrades to an empty field, not a lost injection.
      text = '';
    }
  }
  return typeof text === 'string' ? text.slice(0, max) : '';
}

/** Flatten an omp content array (TextContent | ImageContent)[] to text.
 *  Images carry no query signal, so they are dropped rather than stringified. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Build the mid-turn digest from a `turn_end` event.
 *
 * omp splits what claude delivers as one record across two places, so this has
 * to correlate them: `toolResults[]` (ToolResultMessage: toolCallId, toolName,
 * content) carries the OUTPUT, while the INPUT lives on the assistant message
 * as `ToolCall` items (`{ type:'toolCall', id, name, arguments }`) inside
 * `message.content`. Join on toolCallId === toolCall.id.
 *
 * A missing input is not a failure — a result whose call cannot be correlated
 * still carries real query signal in its output, so it is emitted with an empty
 * toolInput rather than dropped.
 */
function buildToolCallDigest(event) {
  const results = Array.isArray(event?.toolResults) ? event.toolResults : [];
  if (results.length === 0) return [];

  const inputsById = new Map();
  const assistantContent = event?.message?.content;
  if (Array.isArray(assistantContent)) {
    for (const part of assistantContent) {
      if (part && typeof part === 'object' && part.type === 'toolCall' && typeof part.id === 'string') {
        inputsById.set(part.id, part.arguments);
      }
    }
  }

  const digest = [];
  for (const result of results.slice(0, MID_TURN_MAX_CALLS)) {
    if (!result || typeof result !== 'object') continue;
    digest.push({
      tool: typeof result.toolName === 'string' ? result.toolName : '',
      toolInput: clamp(inputsById.get(result.toolCallId), MID_TURN_FIELD_CLAMP),
      toolResponse: clamp(contentToText(result.content), MID_TURN_FIELD_CLAMP),
    });
  }
  return digest;
}

/**
 * Shape the InjectionRequest. Returns null for "no signal, spend nothing" —
 * core.mjs must not POST for a null.
 *
 * IDENTITY (D-002, and the WI-1866 bug class this must not recreate): the owner
 * is `PAPERCUSP_SID` read from the process env. Because the hook runs IN the omp
 * process, it sees the per-session env psu-launcher built for that session
 * (psu-launcher.mjs:5377 merges envelopeEnv, which carries a per-session
 * PAPERCUSP_SID). WI-1866's "omp cannot interpolate ${PAPERCUSP_SID}" limitation
 * applies to the static mcp.json only and does NOT reach this layer. Do not
 * substitute the mcp.json `?client=` param or any per-machine id here — that is
 * exactly how every omp session previously collapsed into one coord identity.
 */
export function parse(port, event) {
  const owner = process.env.PAPERCUSP_SID || '';
  // D-001 invariant 3 — no SID means this is not a psu session.
  if (!owner) return null;

  const base = {
    owner,
    workspace: process.env.PAPERCUSP_WORKSPACE || '',
    harness: process.env.PAPERCUSP_HARNESS_SLUG || '',
    // EI-18893248175645463: an operator/superuser-scope session never exports
    // PAPERCUSP_HARNESS_SLUG, which left the harness + hive memory pools empty
    // for the session's whole lifetime. cwd lets the server run its own
    // env -> marker-file -> meta-repo fallback chain instead of giving up.
    cwd: process.cwd(),
    client: 'omp',
  };

  if (port === 'turn-start') {
    const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
    if (!prompt.trim()) return null;
    return { ...base, prompt: prompt.slice(0, TURN_START_PROMPT_CLAMP) };
  }

  if (port === 'mid-turn') {
    const toolCalls = buildToolCallDigest(event);
    if (toolCalls.length === 0) return null;
    return { ...base, toolCalls };
  }

  return null;
}

/**
 * Render the stdout payload.
 *
 * Plain text, not a JSON envelope: omp's artifact consumes stdout directly (see
 * the header). An empty/whitespace-only response yields null so the artifact
 * injects nothing at all rather than an empty system-reminder.
 */
export function render(_port, text, _event) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return text;
}

/** @type {{client:'omp'}} */
export const client = 'omp';

/**
 * SEAM (P-002 audit): this is the client that HAD the defect, so the declaration
 * records what it is now and what it must never go back to.
 *
 * OMP loads hooks in-process, so there is no stdout the runtime merges for us —
 * the artifact has to hand the text to the runtime through some API, and WHICH
 * API is the entire safety question. It previously used
 * `sendMessage(..., { deliverAs: 'followUp' })`, carrying a comment asserting
 * that a followUp "queues the context after the current action instead of
 * cancelling an in-flight tool call." It does precisely the opposite: any queued
 * message makes the agent loop discard the tool calls it was about to run and
 * synthesise "Skipped due to pending system advisory". 13/13 measured.
 *
 * It now returns the block FROM a `tool_result` handler, whose returned content
 * the runtime merges into that tool result — the additive property claude and
 * codex get from stdout, reached through omp's module seam. The delivery POINT
 * is unchanged (a followUp queued at turn_end already surfaced at the start of
 * the next turn — the very turn whose call it was killing); only the
 * cancellation is gone.
 *
 * ⛔ `deliverAs: 'nextTurn'` is NOT an alternative. It looks like the obvious
 * repair and is strictly worse: while streaming it lands in a deferred buffer
 * whose ONLY drain is a later turn-triggering delivery, so it would trade a
 * loud, countable tax for a silent hole.
 *
 * @type {import('../ports.mjs').DeliverySeam}
 */
export const deliverySeam = {
  mechanism: 'tool-result-merge',
  artifact: 'apps/operator/scripts/hooks/omp/inject-hook.ts (pi.on("tool_result") return value)',
  evidence:
    "Read from the pi runtime's own bundle, not from API names: sendCustomMessage routes a " +
    'followUp to agent.followUp(), and the agent loop discards pending tool calls whenever a ' +
    'message is queued. emitToolResult merges a handler\'s returned content into the tool ' +
    'result instead. Measured before the fix: 13 cancellations, 13 immediately preceded by ' +
    'one of our blocks, no other cause.',
};

export default { client, portForEvent, parse, render, deliverySeam };
