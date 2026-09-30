/**
 * AI SDK v6 provider adapter behind the owned ModelPort (P-009 / D-010).
 *
 * This module imports only AI SDK's provider specification. Concrete provider
 * packages are selected in provider-router.ts; no AI SDK type escapes the
 * ModelPort boundary.
 */
import { costFromTokens } from '@papercusp/model-pricing';
import type {
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type {
  ModelContentPart,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelStopReason,
  ModelStreamEvent,
  ModelUsage,
} from './model-port';
import type { AiSdkProviderId } from './model-selection';
import {
  modelToolNameCodec,
  providerWireToolName,
  type ModelToolNameCodec,
} from './model-tool-name-codec';

export interface AiSdkPortModel {
  model: LanguageModelV3;
  provider: AiSdkProviderId | 'gateway-codex';
  /** Provider-scoped model id used for canonical pricing. */
  modelId: string;
  effort?: string | null;
  /** Per-request headers (the gateway priority tier lives here). */
  headers?: Record<string, string | undefined>;
}

export interface AiSdkPortOptions {
  resolveModel(req: ModelRequest): Promise<AiSdkPortModel> | AiSdkPortModel;
}

/**
 * AI-provider function names share a conservative alphanumeric/underscore/
 * hyphen wire contract. Papercusp's canonical projected-tool names contain a
 * namespace colon (`capability:read`), so send a deterministic readable alias
 * and translate it back at the ModelPort boundary. The digest makes aliases
 * collision-resistant while the 64-char cap remains valid across providers.
 */
export function aiSdkWireToolName(name: string): string {
  return providerWireToolName(name);
}

function toolNameCodec(req: ModelRequest): ModelToolNameCodec {
  return modelToolNameCodec(req.tools);
}

function jsonValue(value: unknown): JSONValue | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}

function toolNames(messages: ModelMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_call') names.set(part.id, part.name);
    }
  }
  return names;
}

function resultOutput(part: Extract<ModelContentPart, { type: 'tool_result' }>): LanguageModelV3ToolResultOutput {
  const value = jsonValue(part.content);
  if (part.isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value };
}

/** Map owned messages to the AI SDK v6 provider-spec prompt. */
export function toAiSdkPrompt(
  system: string | undefined,
  messages: ModelMessage[],
  encodeToolName: (name: string) => string = (name) => name,
): LanguageModelV3Message[] {
  const prompt: LanguageModelV3Message[] = [];
  if (system) prompt.push({ role: 'system', content: system });
  const names = toolNames(messages);

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: Extract<LanguageModelV3Message, { role: 'assistant' }>['content'] = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'tool_call') {
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: encodeToolName(part.name),
            input: part.input ?? {},
          });
        }
      }
      if (content.length) prompt.push({ role: 'assistant', content });
      continue;
    }

    const text = message.content.filter((part) => part.type === 'text');
    if (text.length) {
      prompt.push({
        role: 'user',
        content: text.map((part) => ({ type: 'text' as const, text: part.text })),
      });
    }
    const results = message.content.filter((part) => part.type === 'tool_result');
    if (results.length) {
      prompt.push({
        role: 'tool',
        content: results.map((part) => ({
          type: 'tool-result' as const,
          toolCallId: part.toolCallId,
          toolName: encodeToolName(names.get(part.toolCallId) ?? 'unknown_tool'),
          output: resultOutput(part),
        })),
      });
    }
  }
  return prompt;
}

export function effortProviderOptions(
  provider: AiSdkPortModel['provider'],
  effort: string | null | undefined,
): SharedV3ProviderOptions | undefined {
  if (!effort) return undefined;
  switch (provider) {
    case 'anthropic':
      return { anthropic: { effort } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case 'gateway-codex':
    case 'openai':
      return { openai: { reasoningEffort: effort } };
    case 'mistral':
      return { mistral: { reasoningEffort: effort } };
    case 'groq':
      return { groq: { reasoningEffort: effort } };
    case 'xai':
      return { xai: { reasoningEffort: effort } };
  }
}

export function buildAiSdkCallOptions(
  req: ModelRequest,
  resolved: AiSdkPortModel,
  codec: ModelToolNameCodec = toolNameCodec(req),
): LanguageModelV3CallOptions {
  return {
    prompt: toAiSdkPrompt(req.system, req.messages, codec.encode),
    ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            name: codec.encode(tool.name),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            // ModelPort owns JSON Schema as a provider-neutral object. AI SDK
            // consumes draft-07 here; capability schemas already use it.
            inputSchema: tool.inputSchema as never,
          })),
          toolChoice: { type: 'auto' as const },
        }
      : {}),
    ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    ...(effortProviderOptions(resolved.provider, resolved.effort)
      ? { providerOptions: effortProviderOptions(resolved.provider, resolved.effort) }
      : {}),
  };
}

function stopReason(raw: LanguageModelV3StreamPart & { type: 'finish' }): ModelStopReason {
  switch (raw.finishReason.unified) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool-calls':
      return 'tool_use';
    default:
      return 'other';
  }
}

function usage(raw: LanguageModelV3StreamPart & { type: 'finish' }): ModelUsage {
  const input = raw.usage.inputTokens;
  const output = raw.usage.outputTokens;
  const inputTokens = input.total ?? ((input.noCache ?? 0) + (input.cacheRead ?? 0));
  const outputTokens = output.total ?? ((output.text ?? 0) + (output.reasoning ?? 0));
  return {
    inputTokens,
    outputTokens,
    ...(input.cacheRead !== undefined ? { cacheReadTokens: input.cacheRead } : {}),
    ...(input.cacheWrite !== undefined ? { cacheCreationTokens: input.cacheWrite } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error) ?? String(error);
}

async function* readAiSdkStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  modelId: string,
  decodeToolName: (name: string) => string = (name) => name,
): AsyncGenerator<ModelStreamEvent, void, void> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      switch (value.type) {
        case 'text-delta':
          yield { type: 'text_delta', text: value.delta };
          break;
        case 'reasoning-delta':
          yield { type: 'reasoning_delta', text: value.delta };
          break;
        case 'tool-call': {
          let input: unknown = {};
          if (value.input.trim()) {
            try {
              input = JSON.parse(value.input);
            } catch {
              input = { __unparsed: value.input };
            }
          }
          yield {
            type: 'tool_call',
            id: value.toolCallId,
            name: decodeToolName(value.toolName),
            input,
          };
          break;
        }
        case 'finish': {
          const baseUsage = usage(value);
          const priced = costFromTokens(modelId, baseUsage);
          yield {
            type: 'stop',
            reason: stopReason(value),
            usage: priced.priced ? { ...baseUsage, costUsd: priced.usd } : baseUsage,
          };
          finished = true;
          break;
        }
        case 'error':
          yield { type: 'error', message: errorMessage(value.error), raw: value.error };
          return;
        default:
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!finished) {
    yield { type: 'error', message: 'AI SDK provider stream ended without a finish event' };
  }
}

export function createAiSdkPort(opts: AiSdkPortOptions): ModelPort {
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      let resolved: AiSdkPortModel;
      try {
        resolved = await opts.resolveModel(req);
      } catch (error) {
        yield { type: 'error', message: errorMessage(error) };
        return;
      }
      try {
        const codec = toolNameCodec(req);
        const result = await resolved.model.doStream(buildAiSdkCallOptions(req, resolved, codec));
        yield* readAiSdkStream(result.stream, resolved.modelId, codec.decode);
      } catch (error) {
        if (req.signal?.aborted) {
          yield { type: 'stop', reason: 'aborted' };
          return;
        }
        yield { type: 'error', message: errorMessage(error) };
      }
    },
  };
}
