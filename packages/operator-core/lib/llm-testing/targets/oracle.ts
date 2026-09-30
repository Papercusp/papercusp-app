/**
 * Oracle ChatTarget — drives `oracle:chat` over HTTP+SSE.
 *
 * Plan §11. Second concrete target after operator. Validates that the
 * framework's `ChatTarget` interface generalizes — same Persona /
 * Sim-user / Judge / Asserts work against any LLM chat surface that
 * exposes a streaming POST endpoint.
 *
 * Oracle is read-only Q&A: the brain has the workspace's docs +
 * harness tools but no write capabilities. Scenarios focus on
 * citation accuracy, refusal-to-speculate, tool selection. No
 * <continue/>, no auto-fire, no card emission (oracle doesn't use
 * the operator card surface).
 *
 * Endpoint: POST /api/oracle/chat
 * Body shape (per apps/operator/app/api/_hono/oracle.ts):
 *   { messages: [...], currentPath?, tutorialMode?, uiClientId? }
 * SSE event names (per oracle:chat tool's eventWireKinds):
 *   delta / tool_call / done / error
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

const BEHAVIORS = [
  // Borrows the operator catalog where it applies; oracle-specific
  // behaviors (no cards, refusal-to-speculate) ride on the judge
  // axes rather than separate kinds.
  'B14', 'B15', 'B16', 'B27',
];

export interface OracleTargetOpts {
  baseUrl?: string;
}

export class OracleTarget implements ChatTarget {
  readonly id = 'oracle';
  readonly behaviors = BEHAVIORS;
  private readonly opts: OracleTargetOpts;

  constructor(opts: OracleTargetOpts = {}) {
    this.opts = opts;
  }

  async open(opts: SessionOptions): Promise<ChatSession> {
    const baseUrl = this.opts.baseUrl
      ?? llmTestBaseUrl()
      ?? 'http://127.0.0.1:3055';
    if (opts.transport !== 'http-sse') {
      throw new Error(`oracle target supports only transport='http-sse' (got '${opts.transport}')`);
    }
    return new OracleSession({ runId: opts.runId, baseUrl });
  }
}

interface SessionState {
  runId: string;
  baseUrl: string;
}

class OracleSession implements ChatSession {
  readonly sessionId: string;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
    this.sessionId = `llm-testing/${state.runId}`;
  }

  async send(input: TurnInput): Promise<TurnResult> {
    const url = `${this.state.baseUrl}/api/oracle/chat`;
    const body = {
      messages: input.messages,
      uiClientId: this.sessionId,
      currentPath: (input.meta?.currentPath as string | undefined) ?? '',
      tutorialMode: input.meta?.tutorialMode === true,
    };

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
      cards: [],
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
    // Oracle doesn't emit control tags, but parse the text anyway in case
    // future versions adopt them. Cheap.
    result.controlTags = extractControlTags(result.assistantText);
    return result;
  }

  async close(): Promise<void> {
    // Oracle target holds no per-run resources.
  }
}

// =============================================================================
// SSE parsing — identical to OperatorTarget; lifted to reduce drift.
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
  let data: unknown = raw;
  try { data = JSON.parse(raw); } catch { /* keep raw */ }
  return { name, data, tMs: 0 };
}

function applyEvent(ev: SseEvent, result: TurnResult): void {
  switch (ev.name) {
    case 'delta': {
      const text = extractDeltaText(ev.data);
      if (text) result.assistantText += text;
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
    case 'done': {
      const d = ev.data as { costUsd?: number } | undefined;
      if (d?.costUsd) result.costUsd = d.costUsd;
      result.finishReason = 'done';
      break;
    }
    case 'error': {
      const e = ev.data as { message?: string } | undefined;
      result.error = e?.message ?? 'unknown error';
      result.finishReason = 'error';
      break;
    }
  }
}

function extractDeltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as { text?: unknown; delta?: unknown };
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.delta === 'string') return obj.delta;
  }
  return '';
}

function extractControlTags(text: string): ControlTag[] {
  const tags: ControlTag[] = [];
  const re = /<(continue|sleep|spawn)(\s+([^/>]*))?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase() as ControlTag['tag'];
    tags.push({ tag });
  }
  return tags;
}

function errorTurn(message: string, latencyMs: number): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [] satisfies CardEvent[],
    controlTags: [],
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
    error: message,
    rawSseTape: [],
  };
}
