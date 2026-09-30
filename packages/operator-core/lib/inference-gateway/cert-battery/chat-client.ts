/**
 * cert-battery/chat-client — the LIVE ProbeContext: an OpenAI `/v1/chat/completions`
 * client over a served backend's baseUrl. Injected `fetch` keeps it testable; the
 * unit tests never touch this file (they inject a fake `chat`), so this is exercised
 * only by the real certification run against a live backend (e.g. ornith at the
 * D-011 sanitizer :11435).
 */
import type { ChatRequest, ChatResult, ProbeContext, RawToolCall } from './types';

export interface OpenAiProbeClientOpts {
  /** No trailing slash — the completion lands at `${baseUrl}/v1/chat/completions`. */
  baseUrl: string;
  /** The served model id (the backend's `models[]` entry). */
  model: string;
  /** Optional bearer token (local backends need none; vLLM behind auth might). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Build a ProbeContext that talks to a live OpenAI-compatible backend. */
export function createOpenAiProbeContext(opts: OpenAiProbeClientOpts): ProbeContext {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  return {
    now: () => Date.now(),
    async chat(req: ChatRequest): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        stream: false,
      };
      if (req.tools?.length) body.tools = req.tools;
      if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`cert probe chat failed: ${res.status} ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string | null }[];
      };
      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const toolCalls: RawToolCall[] = (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
      }));
      return {
        text: message.content ?? '',
        toolCalls,
        stopReason: choice?.finish_reason ?? null,
      };
    },
  };
}
