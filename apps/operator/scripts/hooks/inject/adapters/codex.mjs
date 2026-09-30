/**
 * CODEX CLI injection adapter (codex-cli 0.146.0).
 *
 * Plan: codex-context-injection-parity-2026-08-09, P-003.
 *
 * ── PROVENANCE OF EVERY NAME IN THIS FILE (P-003: no speculative event names) ──
 * The event names and field names below are NOT inferred from Claude's shape.
 * They are read from codex's OWN embedded draft-07 JSON Schemas, which ship
 * inside the native binary at
 *   node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
 * as 21 objects titled `<event>.command.input` / `<event>.command.output`
 * (byte offset ~247,553,000; extract by balanced-brace parse). Codex describes
 * its own hook wire format; nothing here is guessed.
 *
 * ⚠ The plan's premise that this binary "is NOT under @openai/codex-linux-x64 …
 * so it could not be string-scanned" is FALSE — it is there, 311MB. The
 * downstream premise (the 2026-06-21 "codex PreToolUse hooks are inert" verdict
 * in codex-omp-claude-feature-parity-2026-06-21 P-011/P-020) does not survive
 * either: codex 0.146.0 ships a complete, self-describing hook system.
 *
 * ── THE ONE REAL STRUCTURAL DIFFERENCE FROM CLAUDE: MID-TURN IS PER-CALL ──
 * Claude's mid-turn boundary is PostToolBatch — one event per resolved BATCH,
 * carrying `tool_calls[]`. Codex has NO batch event at all; its event set is
 * pre-tool-use, post-tool-use, permission-request, pre-compact, post-compact,
 * session-start, session-end, user-prompt-submit, subagent-start, subagent-stop,
 * stop. The closest analogue is PostToolUse, which fires PER TOOL CALL and
 * carries a single `tool_name` / `tool_input` / `tool_response` triple.
 *
 * D-001's InjectionRequest.toolCalls is an ARRAY, so this adapter emits an array
 * of length 1 and the frozen interface absorbs the difference with no reshaping.
 * The COST is real and should be known rather than discovered later: a codex
 * turn that makes N tool calls hits the mid-turn port N times where claude hits
 * it once. The server-side session-epoch dedup is what makes that affordable —
 * anything already surfaced this epoch is not re-paid — but it is a genuinely
 * different call profile, and it is why PostToolUse is registered WITHOUT a
 * matcher restriction only after measuring. See the plan's Decisions.
 *
 * ── WHY PostToolUse AND NOT PreToolUse HERE ──
 * Same reason as claude (D-027): codex's pre-tool-use output schema carries
 * permission semantics (its PreToolUseHookSpecificOutputWire sits alongside
 * PermissionRequestDecisionWire), and a hook that only wants to SAY something
 * must never also vote on whether the call runs. post-tool-use.command.output
 * carries `additionalContext` with no permission field.
 *
 * ── THE IDENTITY HOOK PORTS (portable-identity-packages-2026-09-26 P-011) ──
 * pre-tool-use maps to the GUARD port, which only ever votes no (D-023 §3).
 * Re-read from codex-cli 0.159.0's embedded schemas on 2026-09-30:
 *   pre-tool-use.command.output  hookSpecificOutput.permissionDecision
 *                                allow|deny|ask + permissionDecisionReason
 *   stop.command.output          NO hookSpecificOutput (additionalProperties
 *                                false); only decision:'block' + reason
 *   stop.command.input           stop_hook_active: boolean (required)
 *   session-start.command.output hookSpecificOutput.additionalContext
 *   session-start.command.input  source: startup|resume|clear|compact|fork
 */

/** @typedef {import('../ports.mjs').InjectionPort} InjectionPort */

import { buildDigest, clampPrompt, guardCall } from '../core.mjs';

export const client = 'codex';

/** See adapters/claude.mjs: a resume or a fork replays a transcript that
 *  already holds what the compaction rules said. */
const COMPACTION_SOURCES = new Set(['startup', 'clear', 'compact']);

/**
 * Codex delivers `hook_event_name` in PascalCase in the event payload
 * (`"const": "UserPromptSubmit"` / `"const": "PostToolUse"` in the input
 * schemas), while the CONFIG/CLI vocabulary for the same events is kebab-case
 * (`user-prompt-submit`, `post-tool-use`). Both spellings are accepted here so
 * this maps correctly whether the caller passes the event name from the payload
 * or from the hook declaration.
 *
 * @param {string} nativeEvent
 * @returns {InjectionPort | null}
 */
export function portForEvent(nativeEvent) {
  switch (nativeEvent) {
    case 'UserPromptSubmit':
    case 'user-prompt-submit':
      return 'turn-start';
    case 'PostToolUse':
    case 'post-tool-use':
      return 'mid-turn';
    case 'PreToolUse':
    case 'pre-tool-use':
      return 'pre-tool';
    case 'Stop':
    case 'stop':
      return 'stop';
    case 'SessionStart':
    case 'session-start':
      return 'compaction';
    default:
      return null;
  }
}

/**
 * @param {InjectionPort} port
 * @param {any} event  codex hook event JSON, as delivered on stdin.
 * @returns {object | null} null = no signal, spend nothing
 */
export function parse(port, event) {
  if (!event || typeof event !== 'object') return null;

  // Codex passes `cwd` in EVERY hook event (it is `required` in every input
  // schema). Prefer it over the hook process's own cwd: it is the session's
  // working root, which is what the server's harness-detection chain needs.
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : undefined;

  if (port === 'turn-start') {
    const prompt = event.prompt;
    if (typeof prompt !== 'string') return null;
    return { prompt: clampPrompt(prompt), ...(cwd ? { cwd } : {}) };
  }

  if (port === 'mid-turn') {
    // Per-call, not per-batch — see the header. One call in, one-element digest
    // out, so the server sees the same shape claude produces.
    const tool = event.tool_name;
    if (typeof tool !== 'string' || !tool) return null;
    const toolCalls = buildDigest([
      { tool, toolInput: event.tool_input, toolResponse: event.tool_response },
    ]);
    if (toolCalls.length === 0) return null;
    return { toolCalls, ...(cwd ? { cwd } : {}) };
  }

  if (port === 'pre-tool') {
    const call = guardCall(event.tool_name, event.tool_input);
    return call ? { ...call, ...(cwd ? { cwd } : {}) } : null;
  }

  if (port === 'stop') {
    // The block below makes the turn continue once; a stop that is already the
    // result of one must end, or a stop rule loops the session forever.
    if (event.stop_hook_active === true) return null;
    return cwd ? { cwd } : {};
  }

  if (port === 'compaction') {
    const source = event.source;
    if (typeof source !== 'string' || !COMPACTION_SOURCES.has(source)) return null;
    return { source, ...(cwd ? { cwd } : {}) };
  }

  return null;
}

/** @type {Partial<Record<InjectionPort, string>>} */
const CONTEXT_EVENT_NAMES = {
  'turn-start': 'UserPromptSubmit',
  'mid-turn': 'PostToolUse',
  compaction: 'SessionStart',
};

/**
 * Codex's injection envelope is shape-identical to Claude's: the output schemas
 * define `hookSpecificOutput: { hookEventName, additionalContext }`, with
 * `hookEventName` a const echoing the event. Identical shape, independently
 * verified from codex's own schema — not assumed from claude.
 *
 * Two ports differ, both per the schemas in the header: pre-tool renders ONLY
 * as a deny, and stop has no context channel at all — `decision: 'block'` with
 * the context as its `reason` is how a stop hook makes codex continue with it.
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
  if (port === 'stop') return JSON.stringify({ decision: 'block', reason: text });
  const hookEventName = CONTEXT_EVENT_NAMES[port];
  if (!hookEventName) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

/**
 * SEAM (P-002 audit): codex cannot pre-empt, for the same structural reason as
 * claude and on independently-read evidence — codex's OWN embedded draft-07
 * output schemas (see the header for the extraction) define
 * `hookSpecificOutput: { hookEventName, additionalContext }` on
 * `post-tool-use.command.output`, with NO permission field beside it. The
 * payload is the hook's return value; nothing is enqueued.
 *
 * The pre-tool-use output schema DOES carry permission semantics
 * (`PreToolUseHookSpecificOutputWire` sits alongside `PermissionRequestDecisionWire`),
 * which is exactly why this adapter binds mid-turn to post-tool-use instead —
 * the same near-miss claude documents, avoided the same way.
 *
 * @type {import('../ports.mjs').DeliverySeam}
 */
export const deliverySeam = {
  mechanism: 'hook-return-value',
  artifact: 'apps/operator/scripts/hooks/inject/index.mjs (stdout → codex CLI)',
  evidence:
    "Read from codex 0.146.0's embedded JSON Schemas in the native binary, not inferred " +
    'from claude: post-tool-use.command.output declares additionalContext and carries no ' +
    'permission field. No queueing API appears on the delivery path.',
};

export default { client, portForEvent, parse, render, deliverySeam };
