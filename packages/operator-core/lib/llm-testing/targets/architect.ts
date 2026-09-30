/**
 * Architect ChatTarget — drives `architect:chat` over HTTP+SSE.
 *
 * Plan §11. Third concrete target after operator + oracle. Further
 * validates the framework's abstraction generalizes: architect's wire
 * format differs (raw-text delta events, single `message` + `history`
 * body shape instead of a messages array) but the framework's
 * Persona / SimUser / Judge / Asserts / Runner all reuse without
 * modification.
 *
 * Architect is harness-scoped (`harnessSlug` in body). Scenarios must
 * target a real harness; mark them `realWorkspace: true`.
 *
 * Endpoint: POST /api/agent-tools/architect/chat
 * Body (per libs/agent-chat/src/useHarnessChatRuntime.ts):
 *   { harnessSlug: string, history: ChatHistoryEntry[], message: string }
 * SSE (per apps/operator/lib/agent-tools/architect/chat.ts header):
 *   event: delta     data: <raw text>          (NOT JSON — z.string() wire kind)
 *   event: tool_call data: { name, input }     (JSON object)
 *   event: cost      data: { usd, input, output }
 *   event: error     data: <raw text>
 *   event: done      data: <ToolResult.content as JSON>
 */

import type {
  ChatSession,
  ChatTarget,
  SessionOptions,
  SseEvent,
  ToolCallEvent,
  TurnInput,
  TurnResult,
  CardEvent,
  ControlTag,
} from '@papercusp/testing-shell/llm';

import { llmTestBaseUrl } from './base-url';

export interface ArchitectTargetOpts {
  baseUrl?: string;
  /** Default harness slug if scenario meta doesn't override. */
  defaultHarnessSlug?: string;
}

export class ArchitectTarget implements ChatTarget {
  readonly id = 'architect';
  readonly behaviors = ['B14', 'B15', 'B16']; // shares the operator catalog where it applies
  private readonly opts: ArchitectTargetOpts;

  constructor(opts: ArchitectTargetOpts = {}) {
    this.opts = opts;
  }

  async open(opts: SessionOptions): Promise<ChatSession> {
    const baseUrl = this.opts.baseUrl
      ?? llmTestBaseUrl()
      ?? 'http://127.0.0.1:3055';
    if (opts.transport !== 'http-sse') {
      throw new Error(`architect target supports only transport='http-sse' (got '${opts.transport}')`);
    }
    return new ArchitectSession({
      runId: opts.runId,
      baseUrl,
      defaultHarnessSlug: this.opts.defaultHarnessSlug ?? 'sheets',
    });
  }
}

interface SessionState {
  runId: string;
  baseUrl: string;
  defaultHarnessSlug: string;
}

class ArchitectSession implements ChatSession {
  readonly sessionId: string;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
    this.sessionId = `llm-testing/${state.runId}`;
  }

  async send(input: TurnInput): Promise<TurnResult> {
    // Translate the runner's messages-array shape into architect's
    // single-message + history-array shape. Last user message becomes
    // `message`; everything prior is folded into `history`.
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let message = '';
    for (let i = 0; i < input.messages.length; i++) {
      const m = input.messages[i];
      if (m.role === 'system') continue;
      if (i === input.messages.length - 1 && m.role === 'user') {
        message = m.content;
      } else if (m.role === 'user' || m.role === 'assistant') {
        history.push({ role: m.role, content: m.content });
      }
    }
    if (!message) {
      return errorTurn('no user message to send (architect requires a non-empty message)', 0);
    }

    const harnessSlug = (input.meta?.harnessSlug as string | undefined) ?? this.state.defaultHarnessSlug;
    const body = { harnessSlug, history, message };

    const url = `${this.state.baseUrl}/api/agent-tools/architect/chat?client=${encodeURIComponent(this.sessionId)}`;
    const startMs = Date.now();
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 120_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(killer);
      return errorTurn(`fetch failed: ${(err as Error).message}`, Date.now() - startMs);
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(killer);
      const text = await resp.text().catch(() => '');
      return errorTurn(`HTTP ${resp.status}: ${text.slice(0, 200)}`, Date.now() - startMs);
    }

    const result: TurnResult = {
      assistantText: '',
      toolCalls: [],
      toolResults: [],
      cards: [] satisfies CardEvent[],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    };
    try {
      for await (const ev of readSse(resp.body, startMs)) {
        result.rawSseTape.push(ev);
        applyEvent(ev, result);
        if (ev.name === 'done' || ev.name === 'error') break;
      }
    } catch (err) {
      result.finishReason = 'error';
      result.error = (err as Error).message;
    } finally {
      clearTimeout(killer);
    }
    result.latencyMs = Date.now() - startMs;
    result.controlTags = extractControlTags(result.assistantText);
    return result;
  }

  async close(): Promise<void> {
    // No per-run resources to release.
  }
}

// =============================================================================
// SSE parsing — note: architect's `delta` events carry raw text, not JSON.
// =============================================================================

async function* readSse(body: ReadableStream<Uint8Array>, startMs: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        parsed.tMs = Date.now() - startMs;
        yield parsed;
      }
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let name = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && name === 'message') return null;
  const raw = dataLines.join('\n');
  // architect 'delta' and 'error' events are raw text. 'tool_call',
  // 'cost', 'done' are JSON. Probe by trying JSON first; fall through
  // to raw on failure.
  let data: unknown = raw;
  try { data = JSON.parse(raw); } catch { /* keep raw */ }
  return { name, data, tMs: 0 };
}

function applyEvent(ev: SseEvent, result: TurnResult): void {
  switch (ev.name) {
    case 'delta': {
      // Architect's delta is raw text — the JSON.parse upstream may
      // have succeeded if the text happens to be a JSON literal
      // (a quoted string, a number). Cover both cases.
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      result.assistantText += text;
      break;
    }
    case 'tool_call': {
      const tc = ev.data as { name?: string; input?: unknown };
      if (tc?.name) {
        const event: ToolCallEvent = { name: tc.name, input: tc.input };
        result.toolCalls.push(event);
      }
      break;
    }
    case 'cost': {
      const d = ev.data as { usd?: number } | undefined;
      if (typeof d?.usd === 'number') result.costUsd += d.usd;
      break;
    }
    case 'done': {
      result.finishReason = 'done';
      break;
    }
    case 'error': {
      result.error = typeof ev.data === 'string' ? ev.data : 'unknown error';
      result.finishReason = 'error';
      break;
    }
  }
}

function extractControlTags(text: string): ControlTag[] {
  const tags: ControlTag[] = [];
  const re = /<(continue|sleep|spawn)(\s+([^/>]*))?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tags.push({ tag: m[1].toLowerCase() as ControlTag['tag'] });
  }
  return tags;
}

function errorTurn(message: string, latencyMs: number): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
    error: message,
    rawSseTape: [],
  };
}
