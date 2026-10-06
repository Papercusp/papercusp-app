/**
 * session-timeline-parsers — codex + omp transcript-line parsers for the
 * agents-roster thinking pane (agents-roster "every agent has a history").
 *
 * The pane's timeline contract is `AgentTimelineEntry` (defined with the claude
 * parser in endpoint-route/routes/harness/streams.ts). Claude interactive
 * sessions and spawned bees already stream; codex sessions (rollout jsonl under
 * the per-session CODEX_HOME) and omp sessions (jsonl under
 * ~/.omp/agent/sessions) had NO parser, so the roster could only show a
 * "Live thinking unavailable" note for them. These parsers close that gap: both
 * formats are append-only JSONL, so the session-thinking endpoint reuses its
 * tail-backfill + poll-follow machinery unchanged — only the line→entries
 * transform differs per backend.
 *
 * Both parsers share the claude parser's contract: `parseLine(line) →
 * entries[]` + `flush() → entries[]` (these two are stateless per line, so
 * flush is always empty — kept for interface parity).
 */

import type { AgentTimelineEntry } from './endpoint-route/routes/harness/streams';
import { blockPayloadText, codexToolCallArgsRaw } from './transcript-wire';

export interface TimelineLineParser {
  parseLine(line: string): AgentTimelineEntry[];
  flush(): AgentTimelineEntry[];
}

function compactToolArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** Current Codex message records carry their readable text in response-item
 * content blocks. Keep this tiny extractor local to the timeline vocabulary:
 * ingest applies its own redaction/capping policy, while this live stream is
 * capped at the SSE boundary after parsing. */
function codexMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text: string } => {
      if (!block || typeof block !== 'object') return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return (
        (candidate.type === 'text' ||
          candidate.type === 'input_text' ||
          candidate.type === 'output_text') &&
        typeof candidate.text === 'string'
      );
    })
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Codex rollout jsonl → timeline entries. Wire shape per line:
 *   { timestamp: ISO, type: 'session_meta'|'event_msg'|'response_item'|
 *     'turn_context'|'compacted', payload: {...} }
 *
 * Mapping (the pane's vocabulary):
 *  - response_item/message user        → prompt (canonical current shape)
 *  - response_item/message assistant   → text (canonical current shape)
 *  - event_msg user_message/agent_message → legacy prompt/text fallback
 *  - response_item/function_call,
 *    custom_tool_call, tool_search_call → tool_use. The ARGUMENTS field differs
 *    per record type (`arguments` / `input` / `query`) — read via
 *    transcript-wire's `codexToolCallArgsRaw`, shared with the corpus parser.
 *  - response_item/function_call_output,
 *    custom_tool_call_output           → tool_result. `output` is a block ARRAY
 *    on current builds; read via transcript-wire's `blockPayloadText`.
 *  - response_item/tool_search_output  → tool_result, but read from `tools[]`
 *    (NAMES only), because this record type carries no `output` field and its
 *    per-tool `description` is the tool's full prompt.
 *  - response_item/reasoning           → status '[thinking] …' when a readable
 *    summary exists (the content itself ships encrypted — skipped otherwise)
 *  - compacted                         → status
 *  - everything else (session_meta, token_count, turn_context,
 *    developer/system messages, …) → skipped
 */
export function createCodexTimelineParser(): TimelineLineParser {
  // Older Codex builds wrote the same visible message twice: once as an
  // event_msg and once as response_item/message. Current builds write only the
  // response item. Remember the last visible message so supporting both wire
  // generations cannot duplicate a turn. Tool/meta records deliberately do not
  // reset this key: they can sit between the two representations of one message;
  // a real next turn changes role/text (normally via its prompt) and advances it.
  let lastVisibleMessageKey: string | null = null;
  const visibleMessage = (
    role: 'user' | 'assistant',
    text: string,
    ts: string | undefined,
  ): AgentTimelineEntry[] => {
    if (!text.trim()) return [];
    const key = `${role}\u0000${text}`;
    if (key === lastVisibleMessageKey) return [];
    lastVisibleMessageKey = key;
    return [{ kind: role === 'user' ? 'prompt' : 'text', text, ts }];
  };

  return {
    parseLine(line: string): AgentTimelineEntry[] {
      let rec: {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      try {
        rec = JSON.parse(line);
      } catch {
        return [];
      }
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      const p = (rec.payload ?? {}) as Record<string, unknown>;
      const pt = typeof p.type === 'string' ? p.type : '';

      if (rec.type === 'event_msg') {
        if ((pt === 'task_complete' || pt === 'turn_completed') && typeof p.turn_id === 'string' && p.turn_id && ts && Number.isFinite(Date.parse(ts))) {
          return [{ kind: 'result', outcome: p.error || p.is_error === true || p.status === 'failed' ? 'failed' : 'succeeded', text: typeof p.last_agent_message === 'string' ? p.last_agent_message : '', ts }];
        }
        if (pt === 'turn_aborted') return [{ kind: 'result', outcome: 'failed', text: 'The agent turn was interrupted.', ts }];
        if (pt === 'user_message' && typeof p.message === 'string') {
          return visibleMessage('user', p.message, ts);
        }
        if (pt === 'agent_message' && typeof p.message === 'string') {
          return visibleMessage('assistant', p.message, ts);
        }
        return [];
      }
      if (rec.type === 'response_item') {
        if (pt === 'message') {
          const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
          if (!role) return [];
          return visibleMessage(role, codexMessageText(p.content), ts);
        }
        if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'tool_search_call') {
          const ns = typeof p.namespace === 'string' ? `${p.namespace}.` : '';
          const name = typeof p.name === 'string' ? p.name : pt;
          return [{
            kind: 'tool_use',
            toolName: `${ns}${name}`,
            // WI-41498: the args field VARIES BY RECORD TYPE and this read only
            // knew about `function_call`'s `arguments`. `custom_tool_call` — the
            // overwhelming majority of real codex tool calls (155 vs 4 in the
            // measured session) — carries `input`, so every one of those chips
            // reached the conversation popup naming a tool and showing nothing
            // it was called with. The field list is shared with the corpus
            // parser (transcript-wire) precisely so the two cannot drift again.
            toolInput: compactToolArgs(codexToolCallArgsRaw(p)),
            toolId: typeof p.call_id === 'string' ? p.call_id : undefined,
            ts,
          }];
        }
        if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
          return [{
            kind: 'tool_result',
            // WI-41498: current Codex writes `output` as an ARRAY of
            // `{type:'input_text', text}` blocks. The old `JSON.stringify`
            // fallback turned that into a raw `[{"type":"input_text",…}]` dump
            // in the pane (30 of 31 results in the measured session) rather
            // than the text the tool actually returned.
            text: blockPayloadText(p.output),
            toolId: typeof p.call_id === 'string' ? p.call_id : undefined,
            ts,
          }];
        }
        if (pt === 'tool_search_output') {
          // A tool_search_output has NO `output` field at all — its result is a
          // `tools[]` array of `{type, name, description}` entries. Falling into
          // the branch above would call blockPayloadText(undefined) and render an
          // empty result; before this branch existed the record matched nothing
          // and the search's RESULT was dropped from the timeline entirely, while
          // its `tool_search_call` was shown — a call chip with no answer.
          //
          // Render NAMES ONLY. Each entry's `description` is the tool's full
          // prompt text (kilobytes each, and a namespace entry carries the whole
          // server instruction block), so joining descriptions here would dump
          // tens of KB per search into the pane and the corpus.
          const tools = Array.isArray(p.tools) ? p.tools : [];
          const names = tools
            .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          return [{
            kind: 'tool_result',
            text: names.length ? `${names.length} tool(s): ${names.join(', ')}` : '',
            toolId: typeof p.call_id === 'string' ? p.call_id : undefined,
            ts,
          }];
        }
        if (pt === 'reasoning') {
          const summary = Array.isArray(p.summary)
            ? (p.summary as Array<{ text?: string } | string>)
              .map((s) => (typeof s === 'string' ? s : s?.text ?? ''))
              .filter(Boolean)
              .join(' ')
            : '';
          return summary ? [{ kind: 'status', text: `[thinking] ${summary}`, ts }] : [];
        }
        return [];
      }
      if (rec.type === 'compacted') {
        return [{ kind: 'status', text: 'context compacted', ts }];
      }
      return [];
    },
    flush(): AgentTimelineEntry[] {
      return [];
    },
  };
}

/**
 * omp session jsonl → timeline entries. Wire shape per line:
 *   { type: 'message'|'session'|'title'|…, timestamp: ISO,
 *     message?: { role: 'user'|'assistant'|'toolResult', content: blocks[] } }
 * with content blocks { type: 'text'|'thinking'|'toolCall', … }.
 *
 * Mapping: user text → prompt · assistant text → text · assistant thinking →
 * status '[thinking] …' · assistant toolCall → tool_use · toolResult-role text
 * → tool_result. Non-message records (session/title/model_change/…) → skipped.
 */
export function createOmpTimelineParser(): TimelineLineParser {
  return {
    parseLine(line: string): AgentTimelineEntry[] {
      let rec: {
        type?: string;
        timestamp?: string;
        message?: {
          role?: string;
          content?: unknown;
          // A failed turn carries its whole payload here, with `content` empty.
          stopReason?: string;
          errorMessage?: unknown;
          errorStatus?: unknown;
        };
      };
      try {
        rec = JSON.parse(line);
      } catch {
        return [];
      }
      if (rec.type !== 'message' || !rec.message) return [];
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      const { role } = rec.message;
      const content = Array.isArray(rec.message.content)
        ? (rec.message.content as Array<Record<string, unknown>>)
        : typeof rec.message.content === 'string'
          ? [{ type: 'text', text: rec.message.content }]
          : [];

      const out: AgentTimelineEntry[] = [];
      for (const block of content) {
        const bt = typeof block.type === 'string' ? block.type : '';
        if (bt === 'text' && typeof block.text === 'string') {
          if (role === 'user') out.push({ kind: 'prompt', text: block.text, ts });
          else if (role === 'toolResult') out.push({ kind: 'tool_result', text: block.text, ts });
          else out.push({ kind: 'text', text: block.text, ts });
        } else if (bt === 'thinking' && typeof block.thinking === 'string') {
          out.push({ kind: 'status', text: `[thinking] ${block.thinking}`, ts });
        } else if (bt === 'toolCall') {
          out.push({
            kind: 'tool_use',
            toolName: typeof block.name === 'string' ? block.name : 'tool',
            toolInput: block.arguments,
            toolId: typeof block.id === 'string' ? block.id : undefined,
            ts,
          });
        }
      }

      // A failed turn writes `content: []`, so the loop above emits nothing and the
      // session renders BLANK — the operator sees an agent that simply stopped, with
      // the provider's reason sitting unread on the wire. Surface it. Emitted whenever
      // the turn errored, not only when `out` is empty: a turn that produced some text
      // and THEN failed must not look like it succeeded.
      const { stopReason, errorMessage, errorStatus } = rec.message;
      if (stopReason === 'error' && typeof errorMessage === 'string' && errorMessage.trim()) {
        const status = typeof errorStatus === 'number' ? ` (${errorStatus})` : '';
        out.push({ kind: 'status', text: `[error]${status} ${errorMessage}`, ts });
      }
      if (role === 'assistant' && stopReason === 'stop' && ts && Number.isFinite(Date.parse(ts))) out.push({ kind: 'result', outcome: 'succeeded', text: '', ts });
      if (role === 'assistant' && stopReason === 'error') out.push({ kind: 'result', outcome: 'failed', text: '', ts });
      return out;
    },
    flush(): AgentTimelineEntry[] {
      return [];
    },
  };
}
