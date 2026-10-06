import { readCredentials } from '../credentials';
import { EmbedBudgetExhaustedError, embedAdmission } from './embed-admission';
import {
  buildOpenAiEmbedderCore as buildPureOpenAiEmbedderCore,
  type OpenAiEmbedderHooks,
  type OpenAiEmbedderOpts,
} from './openai-embedder-core';

export {
  EMBED_FETCH_TIMEOUT_MS,
  EMBED_MAX_ATTEMPTS,
  EMBED_TOTAL_BUDGET_MS,
  nextEmbedBackoffMs,
  parseOpenAiDurationMs,
  retryDelayFromHeaders,
} from './openai-embedder-core';
export type { OpenAiEmbedAdmission, OpenAiEmbedderHooks, OpenAiEmbedderOpts } from './openai-embedder-core';

export async function resolveOpenAiKey(): Promise<string> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const credentials = await readCredentials();
    if (credentials.openai_api_key) key = credentials.openai_api_key;
  } catch {
    /* credentials may be unavailable in a standalone worker; keep the env fallback */
  }
  return key;
}

/** Operator policy wrapper: keep admission receipts and budget classification at the host edge. */
export function buildOpenAiEmbedderCore(
  apiKey: string,
  opts: OpenAiEmbedderOpts = {},
  hooks: OpenAiEmbedderHooks = {},
): ReturnType<typeof buildPureOpenAiEmbedderCore> {
  return buildPureOpenAiEmbedderCore(apiKey, opts, {
    ...hooks,
    admission: hooks.admission ?? (() => embedAdmission()),
    isBudgetExhausted: hooks.isBudgetExhausted ?? ((error) => error instanceof EmbedBudgetExhaustedError),
  });
}
