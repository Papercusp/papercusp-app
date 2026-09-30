/**
 * anthropic-port — the gateway-native ModelPort adapter (P-007,
 * own-tui-full-divorce-2026-08-24; D-010).
 *
 * Implements ModelPort over the anthropic-messages wire dialect, riding the
 * SAME substrate as the proven stateless family in
 * `@papercusp/papercusp-shared/agent` (imported via the operator shim):
 *  - `resolveStatelessTransport()` — OAuth-direct vs gateway-pool delegation,
 *    route-account pin, base-URL precedence (PAPERCUSP_ANTHROPIC_URL →
 *    ANTHROPIC_BASE_URL → api.anthropic.com);
 *  - `priorityTierHeaders()` — the x-papercusp-priority admission tier
 *    (an untiered in-process call lands in the first-shed band and starves
 *    under fleet load — the scout's 12-day outage);
 *  - `buildSystemParam()` — the Claude-Code-identifier system framing a
 *    Max-OAuth request needs to land in the right 429 bucket.
 *
 * What this adapter ADDS over that family: tools on the request +
 * tool_use/tool_result content blocks round-tripped both ways — the loop's
 * whole reason to exist. The raw SSE stream is parsed into the owned
 * ModelStreamEvent vocabulary; tool-call input JSON is accumulated across
 * input_json_delta frames and emitted COMPLETE (the loop never sees a
 * half-parsed argument object).
 *
 * Retry/governor policy deliberately stays OUT of the adapter for the
 * walking skeleton: the SDK's own maxRetries covers transport blips, and the
 * loop surfaces a terminal error event the caller can re-drive. Wiring
 * runAgentTurn's governor around each step is P-009 (sessions) territory,
 * where per-session pacing decisions actually live.
 */
import { costFromTokens } from '@papercusp/model-pricing';
import {
  buildSystemParam,
  headersToRecord,
  ownerHeaders,
  priorityTierHeaders,
  resolveStatelessTransport,
} from '../agent-chat-stream';
import type {
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelStopReason,
  ModelStreamEvent,
  ModelUsage,
} from './model-port';
import {
  modelToolNameCodec,
  type ModelToolNameCodec,
} from './model-tool-name-codec';

// ---------------------------------------------------------------------------
// Request mapping (owned types → anthropic wire shapes)

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(
  messages: ModelMessage[],
  encodeToolName: (name: string) => string = (name) => name,
): Array<{
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((p): AnthropicContentBlock => {
      switch (p.type) {
        case 'text':
          return { type: 'text', text: p.text };
        case 'tool_call':
          return { type: 'tool_use', id: p.id, name: encodeToolName(p.name), input: p.input ?? {} };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? null),
            ...(p.isError ? { is_error: true } : {}),
          };
      }
    }),
  }));
}

export function buildAnthropicParams(
  req: ModelRequest,
  codec: ModelToolNameCodec = modelToolNameCodec(req.tools),
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages: toAnthropicMessages(req.messages, codec.encode),
    // ALWAYS framed (even empty): a Max-OAuth request without the Claude Code
    // identifier system block is shunted to the stricter 429 bucket.
    system: buildSystemParam(req.system ?? ''),
    stream: true,
  };
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: codec.encode(t.name),
      ...(t.description !== undefined ? { description: t.description } : {}),
      input_schema: t.inputSchema,
    }));
  }
  // opus models reject the temperature parameter (API constraint, 2026-05).
  if (req.temperature !== undefined && !/opus/i.test(req.model)) {
    params.temperature = req.temperature;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Raw-stream parsing (anthropic SSE events → owned ModelStreamEvent)

function mapStopReason(raw: unknown): ModelStopReason {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'other';
  }
}

interface RawEvent {
  type?: string;
  index?: number;
  message?: { usage?: RawUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: RawUsage;
  error?: { message?: string };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse a raw anthropic-messages SSE event stream into ModelStreamEvents.
 * Pure over its input iterable — unit-testable with a scripted array, and the
 * live adapter feeds it the SDK's MessageStream (which is async-iterable over
 * exactly these raw frames).
 */
export async function* parseAnthropicStream(
  raw: AsyncIterable<unknown> | Iterable<unknown>,
  decodeToolName: (name: string) => string = (name) => name,
): AsyncGenerator<ModelStreamEvent, void, void> {
  const liveTools = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: ModelStopReason = 'other';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;

  const foldUsage = (u: RawUsage | undefined) => {
    if (!u) return;
    const inp = num(u.input_tokens);
    const out = num(u.output_tokens);
    if (inp !== undefined) inputTokens = inp;
    if (out !== undefined) outputTokens = out;
    const cr = num(u.cache_read_input_tokens);
    const cc = num(u.cache_creation_input_tokens);
    if (cr !== undefined) cacheReadTokens = cr;
    if (cc !== undefined) cacheCreationTokens = cc;
  };

  for await (const frame of raw as AsyncIterable<unknown>) {
    const ev = frame as RawEvent;
    switch (ev.type) {
      case 'message_start':
        foldUsage(ev.message?.usage);
        break;
      case 'content_block_start':
        if (
          ev.content_block?.type === 'tool_use' &&
          typeof ev.content_block.name === 'string' &&
          typeof ev.index === 'number'
        ) {
          liveTools.set(ev.index, {
            id: typeof ev.content_block.id === 'string' ? ev.content_block.id : `tool_${ev.index}`,
            name: decodeToolName(ev.content_block.name),
            json: '',
          });
        }
        break;
      case 'content_block_delta': {
        const d = ev.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          yield { type: 'text_delta', text: d.text };
        } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
          yield { type: 'reasoning_delta', text: d.thinking };
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const t = typeof ev.index === 'number' ? liveTools.get(ev.index) : undefined;
          if (t) t.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const t = typeof ev.index === 'number' ? liveTools.get(ev.index) : undefined;
        if (t) {
          liveTools.delete(ev.index!);
          let input: unknown = {};
          if (t.json.trim()) {
            try {
              input = JSON.parse(t.json);
            } catch {
              // Malformed accumulated JSON: surface the raw text rather than
              // silently dropping the call — the loop's unknown-input handling
              // (tool execution / schema validation) reports it usefully.
              input = { __unparsed: t.json };
            }
          }
          yield { type: 'tool_call', id: t.id, name: t.name, input };
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = mapStopReason(ev.delta.stop_reason);
        foldUsage(ev.usage);
        break;
      case 'message_stop':
        break;
      case 'error':
        yield {
          type: 'error',
          message: typeof ev.error?.message === 'string' ? ev.error.message : 'anthropic stream error',
          raw: frame,
        };
        return;
      default:
        break;
    }
  }

  yield {
    type: 'stop',
    reason: stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    } satisfies ModelUsage,
  };
}

// ---------------------------------------------------------------------------
// The port

export interface AnthropicPortOpts {
  /**
   * Injectable raw-stream factory (tests; alternate wire providers). Default:
   * lazy-import `@anthropic-ai/sdk`, resolve the stateless transport FRESH per
   * call (token expiry / delegation can change between steps), and open
   * `client.messages.stream(params)`.
   */
  rawStream?: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AnthropicMessageStream> | AnthropicMessageStream;
}

/** The SDK's MessageStream is async-iterable and exposes its connected
 * response. Keep that metadata on the raw-stream seam so the adapter can
 * capture gateway routing headers without constraining test fakes. */
type AnthropicMessageStream = AsyncIterable<unknown> & {
  response?: { headers?: unknown };
};

async function defaultRawStream(
  params: Record<string, unknown>,
  priority: string | undefined,
  account: string | undefined,
  ownerId: string | undefined,
  signal?: AbortSignal,
): Promise<AnthropicMessageStream> {
  const transport = resolveStatelessTransport(account);
  const sdkMod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Anthropic: any = (sdkMod as { default?: unknown }).default ?? sdkMod;
  const client = new Anthropic({
    baseURL: transport.baseURL,
    authToken: transport.token,
    defaultHeaders: {
      ...transport.headers,
      ...priorityTierHeaders(priority),
      ...ownerHeaders(ownerId),
    },
    maxRetries: 2,
  });
  // The SDK's MessageStream is async-iterable over the raw SSE frames —
  // exactly what parseAnthropicStream consumes. `stream: true` is implied by
  // .stream(); strip it from params to keep the SDK's typed surface happy.
  const { stream: _stream, ...rest } = params;
  return client.messages.stream(rest, signal ? { signal } : {}) as AnthropicMessageStream;
}

const ROUTED_ACCOUNT_HEADER = 'x-papercusp-routed-account';

function servedAccountFromStream(stream: AnthropicMessageStream): string | undefined {
  const value = headersToRecord(stream.response?.headers)?.[ROUTED_ACCOUNT_HEADER];
  const account = value?.trim();
  return account || undefined;
}

/** Stamp costUsd onto a stop event's usage from the canonical price table
 *  (P-009 usage accounting; @papercusp/model-pricing is D-002-A's single
 *  source of truth). Unknown model ⇒ usage left WITHOUT costUsd — never a
 *  fabricated $0; the session store records the turn as unpriced instead. */
export function withCost(
  model: string,
  ev: Extract<ModelStreamEvent, { type: 'stop' }>,
): Extract<ModelStreamEvent, { type: 'stop' }> {
  if (!ev.usage) return ev;
  const { usd, priced } = costFromTokens(model, ev.usage);
  if (!priced) return ev;
  return { ...ev, usage: { ...ev.usage, costUsd: usd } };
}

/** Gateway-native ModelPort: anthropic-messages dialect over the stateless
 *  family's transport (OAuth-direct or gateway-pool, per the shared choice). */
export function createAnthropicPort(opts: AnthropicPortOpts = {}): ModelPort {
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const codec = modelToolNameCodec(req.tools);
      const params = buildAnthropicParams(req, codec);
      let raw: AnthropicMessageStream;
      try {
        raw = opts.rawStream
          ? await opts.rawStream(params, req.signal)
          : await defaultRawStream(params, req.priority, req.account, req.ownerId, req.signal);
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }
      try {
        let servedAccount: string | undefined;
        for await (const ev of parseAnthropicStream(raw, codec.decode)) {
          // MessageStream.response is populated only after the native stream
          // connects. Re-read it as frames arrive and immediately before
          // forwarding the terminal stop event.
          servedAccount = servedAccountFromStream(raw) ?? servedAccount;
          if (ev.type === 'stop') {
            const withAccount = servedAccount ? { ...ev, servedAccount } : ev;
            yield withCost(req.model, withAccount);
          } else {
            yield ev;
          }
        }
      } catch (e) {
        if (req.signal?.aborted) {
          yield { type: 'stop', reason: 'aborted' };
          return;
        }
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
