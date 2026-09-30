import { parseBridgeModel } from '../../inference-gateway/codex-cli-bridge';
import type { BuiltCatalog } from './su-catalog';

const CODEX_GATEWAY_AUTH = 'papercusp-gateway';

export type ResponsesInputItem = Record<string, unknown>;

export interface CodexResponsesToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface CodexResponsesTurn {
  text: string;
  toolCalls: CodexResponsesToolCall[];
  outputItems: ResponsesInputItem[];
  inputTokens: number;
  outputTokens: number;
}

interface CompletedResponse {
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export function isCodexResponsesModel(model: string | undefined): boolean {
  return /^(?:chatgpt:|gpt-|openai-codex\/)/i.test(model?.trim() ?? '');
}

export function messagesToResponsesInput(
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
): ResponsesInputItem[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      type: 'message',
      role: message.role,
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        },
      ],
    }));
}

export function catalogToResponsesTools(catalog: BuiltCatalog): ResponsesInputItem[] {
  return catalog.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

function gatewayUrl(): string {
  const raw = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(raw) && raw > 0 ? raw : 8788;
  return `http://127.0.0.1:${port}/v1/responses`;
}

function parseSseEvents(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // A malformed event cannot safely participate in state replay. The
      // completed-response requirement below turns the whole turn into a loud
      // error rather than silently returning a partial tool call.
    }
  }
  return out;
}

function outputText(items: ResponsesInputItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!content || typeof content !== 'object') continue;
      const block = content as { type?: unknown; text?: unknown };
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('');
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

export function parseCodexResponsesSse(raw: string): CodexResponsesTurn {
  const events = parseSseEvents(raw);
  let completed: CompletedResponse | null = null;
  const doneItems: ResponsesInputItem[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const e = event as { type?: unknown; response?: unknown; item?: unknown };
    if (e.type === 'response.completed' && e.response && typeof e.response === 'object') {
      completed = e.response as CompletedResponse;
    }
    if (e.type === 'response.output_item.done' && e.item && typeof e.item === 'object') {
      doneItems.push(e.item as ResponsesInputItem);
    }
  }
  // The ChatGPT stream can send every item through output_item.done and then
  // finish with output: []. Preserve those items for text and tool replay.
  const outputItems = Array.isArray(completed?.output) && completed.output.length > 0
    ? (completed!.output as ResponsesInputItem[])
    : doneItems;
  if (!completed && outputItems.length === 0) {
    throw new Error('codex Responses tool loop: stream ended without a completed response or output item');
  }
  const toolCalls: CodexResponsesToolCall[] = [];
  for (const item of outputItems) {
    if (item.type !== 'function_call') continue;
    const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!callId || !name) throw new Error('codex Responses tool loop: function_call omitted call_id or name');
    toolCalls.push({ callId, name, input: parseArguments(item.arguments) });
  }
  const usage = completed?.usage;
  return {
    text: outputText(outputItems),
    toolCalls,
    outputItems,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
  };
}

export async function callCodexResponsesTurn(opts: {
  model: string;
  instructions: string;
  input: ResponsesInputItem[];
  catalog: BuiltCatalog;
  maxOutputTokens: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CodexResponsesTurn> {
  const { id, effort } = parseBridgeModel(opts.model);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(gatewayUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CODEX_GATEWAY_AUTH}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-papercusp-priority': 'prompt-ablation',
    },
    body: JSON.stringify({
      model: id,
      reasoning: { effort },
      instructions: opts.instructions,
      input: opts.input,
      tools: catalogToResponsesTools(opts.catalog),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_output_tokens: opts.maxOutputTokens,
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    }),
    signal: opts.signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`codex Responses tool loop: gateway ${response.status}: ${body.slice(0, 500)}`);
  }
  return parseCodexResponsesSse(body);
}
