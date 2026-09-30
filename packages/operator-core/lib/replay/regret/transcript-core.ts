/**
 * transcript-core.ts — pure stream-json transcript parsing for regret mining
 * (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * Input: a `harness_shared.harness_run_output.jsonl_body` — the orchestrator's
 * persisted raw agent stream (invoke.ts §11.5: PG is canonical; on-disk files
 * are CLI fallback only). Output: an assistant-TURN timeline with per-turn
 * tool calls, tool errors, token usage, and rescue markers — the substrate
 * divergence-core.ts detects over.
 *
 * Backend coverage mirrors cost-cap.ts `extractRunUsage`:
 *
 *   claude — `assistant` events grouped by message id (one TURN per message);
 *            `tool_use` content blocks become TurnToolCall entries, matched to
 *            their `user`-event `tool_result` (`is_error`) by tool_use_id;
 *            `message.usage` is cumulative per message — last wins per turn.
 *            The terminal `result` event carries total_cost_usd; the
 *            `papercusp.run_meta` trailer stamps backend/model/role.
 *   codex/omp — not turn-parsed in v1 (the fleet is claude-backend first);
 *            their sessions still get selection-level findings — zero turns
 *            parsed ⇒ divergence null, replay_status 'skipped'.
 *
 * Junk tolerance: non-JSON lines and unknown event types are skipped — the
 * stream may be truncated mid-write (a crashed run is exactly the session
 * regret mining cares about).
 */

export interface TurnToolCall {
  name: string;
  /** Stable key of the tool input (sorted-key JSON, truncated) — repeat-loop detection. */
  inputKey: string;
  isError: boolean;
}

export interface TranscriptTurn {
  /** Assistant-turn ordinal (0-based) — the unit divergence findings point at. */
  index: number;
  messageId: string | null;
  /** Concatenated assistant text, truncated per turn. */
  text: string;
  toolCalls: TurnToolCall[];
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
}

export interface ParsedTranscript {
  backend: string | null;
  model: string | null;
  role: string | null;
  turns: TranscriptTurn[];
  totalOutputTokens: number;
  totalCostUsd: number | null;
  /** Turn indexes carrying a human/peer rescue marker (yield / turn-interrupt) in the preceding user content. */
  rescueMarkerTurns: number[];
}

const TURN_TEXT_CAP = 2000;
const INPUT_KEY_CAP = 500;

/** Conservative rescue-marker patterns: cooperative-yield / turn-interrupt vocabulary in injected user content. */
const RESCUE_MARKER_RE =
  /turn[:._]interrupt|interrupt_(?:cooperative|force|deferred)|wrap up \+ end your turn|asks you to wrap up/i;

/** Sorted-key JSON so semantically-equal inputs key identically. Depth-capped against pathological nesting. */
export function stableInputKey(input: unknown, depth = 0): string {
  const encoded = encodeStable(input, depth);
  return encoded.length > INPUT_KEY_CAP ? encoded.slice(0, INPUT_KEY_CAP) : encoded;
}

function encodeStable(value: unknown, depth: number): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (depth > 4) return '"…"';
  if (Array.isArray(value)) return `[${value.map((v) => encodeStable(v, depth + 1)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encodeStable(obj[k], depth + 1)}`).join(',')}}`;
}

interface ToolCallSlot {
  turnIndex: number;
  callIndex: number;
}

/** Parse a persisted jsonl stream body into the turn timeline. Never throws. */
export function parseTranscript(jsonlBody: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  const byMessageId = new Map<string, TranscriptTurn>();
  const callsByToolUseId = new Map<string, ToolCallSlot>();
  const rescueTurns = new Set<number>();
  let backend: string | null = null;
  let model: string | null = null;
  let role: string | null = null;
  let totalCostUsd: number | null = null;
  /** The message currently streaming (stream_event message_start) — its
   *  terminal message_delta carries the REAL cumulative output usage (the
   *  `assistant` events' usage snapshots are early-stream and tiny). */
  let streamingMessageId: string | null = null;

  for (const line of jsonlBody.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // truncated/garbled line — skip
    }
    const type = event.type;

    if (type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const messageId = typeof message.id === 'string' ? message.id : null;
      let turn = messageId !== null ? byMessageId.get(messageId) : undefined;
      if (!turn) {
        turn = {
          index: turns.length,
          messageId,
          text: '',
          toolCalls: [],
          outputTokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
        };
        turns.push(turn);
        if (messageId !== null) byMessageId.set(messageId, turn);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (turn.text.length < TURN_TEXT_CAP) {
            turn.text = (turn.text + block.text).slice(0, TURN_TEXT_CAP);
          }
        } else if (block.type === 'tool_use') {
          const call: TurnToolCall = {
            name: typeof block.name === 'string' ? block.name : 'unknown',
            inputKey: stableInputKey(block.input),
            isError: false,
          };
          turn.toolCalls.push(call);
          if (typeof block.id === 'string') {
            callsByToolUseId.set(block.id, { turnIndex: turn.index, callIndex: turn.toolCalls.length - 1 });
          }
        }
      }
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage) {
        // Cumulative per message — last event for the message wins.
        if (typeof usage.output_tokens === 'number') turn.outputTokens = usage.output_tokens;
        if (typeof usage.input_tokens === 'number') turn.inputTokens = usage.input_tokens;
        if (typeof usage.cache_read_input_tokens === 'number') turn.cacheReadTokens = usage.cache_read_input_tokens;
      }
    } else if (type === 'user') {
      const message = event.message as Record<string, unknown> | undefined;
      const content = message && Array.isArray(message.content) ? message.content : [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue;
        if (typeof block.tool_use_id === 'string' && block.is_error === true) {
          const slot = callsByToolUseId.get(block.tool_use_id);
          const call = slot ? turns[slot.turnIndex]?.toolCalls[slot.callIndex] : undefined;
          if (call) call.isError = true;
        }
      }
      // Rescue markers ride injected user content (coord yield lines,
      // turn-interrupt notices). Attribute to the NEXT assistant turn (the
      // one acting under the interrupt) = current turns.length.
      if (RESCUE_MARKER_RE.test(trimmed)) rescueTurns.add(turns.length);
    } else if (type === 'stream_event') {
      const streamEvent = event.event as Record<string, unknown> | undefined;
      if (!streamEvent) continue;
      if (streamEvent.type === 'message_start') {
        const message = streamEvent.message as Record<string, unknown> | undefined;
        if (message && typeof message.id === 'string') streamingMessageId = message.id;
      } else if (streamEvent.type === 'message_delta' && streamingMessageId !== null) {
        const usage = streamEvent.usage as Record<string, unknown> | undefined;
        const turn = byMessageId.get(streamingMessageId);
        if (turn && usage && typeof usage.output_tokens === 'number') {
          turn.outputTokens = Math.max(turn.outputTokens, usage.output_tokens);
        }
      }
    } else if (type === 'result') {
      const cost = event.total_cost_usd;
      if (typeof cost === 'number') totalCostUsd = cost; // last wins (cumulative)
    } else if (type === 'papercusp.run_meta') {
      if (typeof event.backend === 'string') backend = event.backend;
      if (typeof event.model === 'string') model = event.model;
      if (typeof event.role === 'string') role = event.role;
    }
  }

  return {
    backend,
    model,
    role,
    turns,
    totalOutputTokens: turns.reduce((sum, t) => sum + t.outputTokens, 0),
    totalCostUsd,
    // A marker after the final assistant turn anchors to that final turn.
    rescueMarkerTurns:
      turns.length === 0 ? [] : [...new Set([...rescueTurns].map((i) => Math.min(i, turns.length - 1)))].sort((a, b) => a - b),
  };
}
