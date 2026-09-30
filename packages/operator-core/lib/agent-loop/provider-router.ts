/**
 * ModelPort router for the owned loop (P-009 / D-010).
 *
 * Subscription models keep riding Papercusp's proven inference gateway;
 * explicitly provider-qualified API-key models use AI SDK v6 provider
 * packages. The loop above this module sees only ModelPort.
 */
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { priorityTierHeaders, routeAccountHeaders } from '../agent-chat-stream';
import { readCredentials, type Credentials } from '../credentials';
import { createAiSdkPort } from './ai-sdk-port';
import { createAnthropicPort } from './anthropic-port';
import type { ModelPort, ModelRequest, ModelStreamEvent } from './model-port';
import {
  loadModelsDevCatalog,
  resolveLoopModelSpec,
  type AiSdkProviderId,
  type LoopModelSelection,
  type ModelsDevCatalog,
} from './model-selection';

const API_KEY_ENV: Record<AiSdkProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
};

export interface ProviderFactoryArgs {
  selection: LoopModelSelection;
  apiKey?: string;
  gatewayBaseUrl: string;
}

export interface RoutedModelPortOptions {
  /** Fixed catalog/test seam. `undefined` loads the cached live models.dev catalog. */
  catalog?: ModelsDevCatalog | null;
  loadCatalog?: () => Promise<ModelsDevCatalog>;
  credentials?: () => Promise<Credentials>;
  env?: NodeJS.ProcessEnv;
  gatewayBaseUrl?: string;
  anthropicPort?: ModelPort;
  createLanguageModel?: (args: ProviderFactoryArgs) => Promise<LanguageModelV3>;
}

function gatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  const port = Number(env.PAPERCUSP_GATEWAY_PORT);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8788}/v1`;
}

function storedKey(provider: AiSdkProviderId, credentials: Credentials): string | undefined {
  if (provider === 'openai') return credentials.openai_api_key?.trim() || undefined;
  if (provider === 'anthropic') return credentials.anthropic_api_key?.trim() || undefined;
  return undefined;
}

function apiKeyFor(
  selection: LoopModelSelection,
  credentials: Credentials,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (selection.provider === 'gateway-anthropic' || selection.provider === 'gateway-codex') {
    return undefined;
  }
  const fromStore = storedKey(selection.provider, credentials);
  if (fromStore) return fromStore;
  const names = selection.providerMetadata?.env?.length
    ? selection.providerMetadata.env
    : API_KEY_ENV[selection.provider];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function defaultLanguageModel(args: ProviderFactoryArgs): Promise<LanguageModelV3> {
  const { selection, apiKey } = args;
  switch (selection.provider) {
    case 'gateway-codex': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        baseURL: args.gatewayBaseUrl,
        apiKey: 'papercusp-gateway',
      })(selection.modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(selection.modelId);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(selection.modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(selection.modelId);
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral');
      return createMistral({ apiKey })(selection.modelId);
    }
    case 'groq': {
      const { createGroq } = await import('@ai-sdk/groq');
      return createGroq({ apiKey })(selection.modelId);
    }
    case 'xai': {
      const { createXai } = await import('@ai-sdk/xai');
      return createXai({ apiKey })(selection.modelId);
    }
    case 'gateway-anthropic':
      throw new Error('gateway-anthropic is handled by the native Anthropic ModelPort');
  }
}

async function catalogFor(opts: RoutedModelPortOptions): Promise<ModelsDevCatalog | null> {
  if (opts.catalog !== undefined) return opts.catalog;
  try {
    return await (opts.loadCatalog?.() ?? loadModelsDevCatalog());
  } catch {
    // The catalog enriches selection/capability validation; it is not allowed
    // to take the two subscription gateways down. Unknown bare ids still fail
    // closed in resolveLoopModelSpec without it.
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default ModelPort for agent chats: route each request from its model spec. */
export function createRoutedModelPort(opts: RoutedModelPortOptions = {}): ModelPort {
  const env = opts.env ?? process.env;
  const nativeAnthropic = opts.anthropicPort ?? createAnthropicPort();
  const createLanguageModel = opts.createLanguageModel ?? defaultLanguageModel;
  const readCreds = opts.credentials ?? readCredentials;
  const baseUrl = opts.gatewayBaseUrl ?? gatewayBaseUrl(env);

  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      let selection: LoopModelSelection;
      try {
        selection = resolveLoopModelSpec(req.model, await catalogFor(opts));
      } catch (error) {
        yield { type: 'error', message: errorMessage(error) };
        return;
      }

      if (req.temperature !== undefined && selection.metadata?.temperature === false) {
        yield {
          type: 'error',
          message: `${selection.modelId} does not accept temperature according to models.dev metadata`,
        };
        return;
      }

      if (selection.provider === 'gateway-anthropic') {
        yield* nativeAnthropic.stream({ ...req, model: selection.modelId });
        return;
      }
      // Capture the narrowed discriminant before the async resolver closure;
      // property narrowings do not survive an async boundary in TypeScript.
      const aiProvider: Exclude<LoopModelSelection['provider'], 'gateway-anthropic'> =
        selection.provider;

      let credentials: Credentials;
      try {
        credentials = aiProvider === 'gateway-codex' ? {} : await readCreds();
      } catch (error) {
        yield { type: 'error', message: `failed to read provider credentials: ${errorMessage(error)}` };
        return;
      }
      const apiKey = apiKeyFor(selection, credentials, env);
      if (aiProvider !== 'gateway-codex' && !apiKey) {
        const names = selection.providerMetadata?.env?.length
          ? selection.providerMetadata.env
          : API_KEY_ENV[aiProvider];
        yield {
          type: 'error',
          message:
            `${selection.provider}/${selection.modelId} needs an API key ` +
            `(${names.join(' or ')}); configure the key or use a claude/ or codex/ subscription model`,
        };
        return;
      }

      const aiPort = createAiSdkPort({
        resolveModel: async () => ({
          model: await createLanguageModel({ selection, apiKey, gatewayBaseUrl: baseUrl }),
          provider: aiProvider,
          modelId: selection.modelId,
          effort: selection.effort,
          ...(aiProvider === 'gateway-codex'
            ? { headers: { ...priorityTierHeaders(req.priority), ...routeAccountHeaders(req.account) } }
            : {}),
        }),
      });
      if (aiProvider === 'gateway-codex' && req.maxTokens !== undefined) {
        // ChatGPT's subscription Responses backend rejects the otherwise
        // standard `max_output_tokens` field (HTTP 400, live-verified during
        // P-009). AI SDK emits that field whenever maxOutputTokens is set.
        // Omit it on this ONE wire rather than breaking compaction's bounded
        // summarizer call; direct OpenAI/API-key providers still receive and
        // enforce the requested limit.
        const { maxTokens: _unsupportedMaxTokens, ...gatewayReq } = req;
        yield* aiPort.stream({ ...gatewayReq, model: selection.modelId });
        return;
      }
      yield* aiPort.stream({ ...req, model: selection.modelId });
    },
  };
}
