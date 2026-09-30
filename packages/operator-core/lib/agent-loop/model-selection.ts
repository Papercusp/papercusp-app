/**
 * Provider/model selection for the owned loop (P-009, D-010).
 *
 * The public model wire stays the same one psu uses: `<modelId>[:<effort>]`.
 * A recognized effort suffix is peeled conservatively (so a provider model id
 * containing `:` is never damaged), while provider/model capabilities come
 * from models.dev. The catalog is advisory and cached: the subscription
 * gateway's well-known Claude/Codex families still work while models.dev is
 * unreachable, but unknown unqualified ids fail loud instead of guessing a
 * provider.
 */
import { MODEL_EFFORT_LEVELS, splitModelSpec, type ModelEffort } from '../agent-config-constants';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_TTL_MS = 15 * 60_000;

export const AI_SDK_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'groq',
  'xai',
] as const;

export type AiSdkProviderId = (typeof AI_SDK_PROVIDER_IDS)[number];
export type LoopProviderId = AiSdkProviderId | 'gateway-anthropic' | 'gateway-codex';

export interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  tool_call?: boolean;
  temperature?: boolean;
  release_date?: string;
  last_updated?: string;
  limit?: { context?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  npm?: string;
  env?: string[];
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface LoopModelSelection {
  /** Original psu-shaped input. */
  spec: string;
  /** Provider wire id, with psu-only `[1m]` decoration removed. */
  modelId: string;
  effort: ModelEffort | null;
  provider: LoopProviderId;
  metadata: ModelsDevModel | null;
  providerMetadata: ModelsDevProvider | null;
}

/**
 * The capability of one model spec on the in-process Agent Chat loop.
 *
 * Tier configuration is intentionally backend-neutral and may contain models
 * that only an OMP subprocess understands (for example an `openrouter/...`
 * selector).  The loop has a narrower executable boundary than that generic
 * menu.  Keep the classification next to the resolver so route validation and
 * menu annotations cannot grow independent provider allow-lists.
 */
export type LoopModelCapability =
  | { executable: true; provider: LoopProviderId }
  | { executable: false; reason: string };

let cachedCatalog: { value: ModelsDevCatalog; expiresAt: number } | null = null;
let catalogInFlight: Promise<ModelsDevCatalog> | null = null;

export interface LoadModelsDevOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Fetch and cache the models.dev catalog. A failed fetch is not cached. */
export async function loadModelsDevCatalog(
  opts: LoadModelsDevOptions = {},
): Promise<ModelsDevCatalog> {
  const now = opts.now?.() ?? Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) return cachedCatalog.value;
  if (catalogInFlight) return catalogInFlight;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2_500;
  catalogInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const body = await response.json() as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('models.dev returned a non-object catalog');
      }
      const value = body as ModelsDevCatalog;
      cachedCatalog = { value, expiresAt: (opts.now?.() ?? Date.now()) + MODELS_DEV_TTL_MS };
      return value;
    } finally {
      clearTimeout(timer);
      catalogInFlight = null;
    }
  })();
  return catalogInFlight;
}

/** Tests and an operator-side refresh can explicitly invalidate the snapshot. */
export function resetModelsDevCatalogCache(): void {
  cachedCatalog = null;
  catalogInFlight = null;
}

function isAiSdkProvider(value: string): value is AiSdkProviderId {
  return (AI_SDK_PROVIDER_IDS as readonly string[]).includes(value);
}

function withoutPsuWindowMarker(model: string): string {
  return model.replace(/\[1m\](?=$|:)/gi, '');
}

function modelDate(model: ModelsDevModel): string {
  return model.release_date ?? model.last_updated ?? '';
}

function newestFamilyModel(
  catalog: ModelsDevCatalog | null,
  provider: string,
  family: string,
): ModelsDevModel | null {
  const values = Object.values(catalog?.[provider]?.models ?? {})
    .filter((model) => model.family === family)
    .sort((a, b) => modelDate(b).localeCompare(modelDate(a)) || b.id.localeCompare(a.id));
  return values[0] ?? null;
}

function findModel(
  catalog: ModelsDevCatalog | null,
  provider: string,
  modelId: string,
): ModelsDevModel | null {
  const models = catalog?.[provider]?.models;
  if (!models) return null;
  return models[modelId] ?? Object.values(models).find((model) => model.id === modelId) ?? null;
}

function findUnqualifiedModel(
  catalog: ModelsDevCatalog | null,
  modelId: string,
): { provider: string; model: ModelsDevModel } | null {
  if (!catalog) return null;
  const matches: Array<{ provider: string; model: ModelsDevModel }> = [];
  for (const [provider, entry] of Object.entries(catalog)) {
    const model = entry.models?.[modelId]
      ?? Object.values(entry.models ?? {}).find((candidate) => candidate.id === modelId);
    if (model) matches.push({ provider, model });
  }
  if (matches.length === 1) return matches[0];
  return null;
}

const CLAUDE_ALIASES: Record<string, { family: string; fallback: string }> = {
  opus: { family: 'claude-opus', fallback: 'claude-opus-4-7' },
  sonnet: { family: 'claude-sonnet', fallback: 'claude-sonnet-4-6' },
  fable: { family: 'claude-fable', fallback: 'claude-fable-5' },
  haiku: { family: 'claude-haiku', fallback: 'claude-haiku-4-5' },
};

const CODEX_ALIASES: Record<string, string> = {
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
};

function effortValues(model: ModelsDevModel | null): string[] | null {
  if (!model) return null;
  const option = model.reasoning_options?.find((candidate) => candidate.type === 'effort');
  return option?.values ?? (model.reasoning === false ? [] : null);
}

function assertEffortSupported(modelId: string, effort: ModelEffort | null, model: ModelsDevModel | null): void {
  if (!effort) return;
  const allowed = effortValues(model);
  if (allowed && !allowed.includes(effort)) {
    throw new Error(
      `${modelId}:${effort} is not supported by models.dev metadata; ` +
      `allowed effort values: ${allowed.length ? allowed.join('|') : 'none'}. ` +
      'Refusing to silently lower the requested effort.',
    );
  }
}

/**
 * Resolve one psu-compatible model spec.
 *
 * Routing rules are explicit:
 * - bare Claude/Codex aliases and ids use the subscription gateways;
 * - `claude/<id>` and `codex/<id>` force those gateways;
 * - `<ai-sdk-provider>/<id>` uses that provider package + API key;
 * - a unique non-Claude/non-OpenAI models.dev id uses its AI SDK provider;
 * - unknown bare ids fail instead of being sent to an arbitrary credential.
 */
export function resolveLoopModelSpec(
  spec: string,
  catalog: ModelsDevCatalog | null,
): LoopModelSelection {
  const { model: splitModel, effort: splitEffort } = splitModelSpec(spec);
  if (!splitModel) throw new Error('model is required');
  const effort = splitEffort as ModelEffort | null;
  if (effort && !(MODEL_EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new Error(`unrecognized effort ${JSON.stringify(effort)}`);
  }
  const undecorated = withoutPsuWindowMarker(splitModel.trim());
  const lower = undecorated.toLowerCase();

  const claudeAlias = CLAUDE_ALIASES[lower];
  if (claudeAlias) {
    const metadata = newestFamilyModel(catalog, 'anthropic', claudeAlias.family);
    const modelId = metadata?.id ?? claudeAlias.fallback;
    assertEffortSupported(modelId, effort, metadata);
    return {
      spec,
      modelId,
      effort,
      provider: 'gateway-anthropic',
      metadata,
      providerMetadata: catalog?.anthropic ?? null,
    };
  }

  const codexAlias = CODEX_ALIASES[lower];
  if (codexAlias) {
    const metadata = findModel(catalog, 'openai', codexAlias);
    assertEffortSupported(codexAlias, effort, metadata);
    return {
      spec,
      modelId: codexAlias,
      effort,
      provider: 'gateway-codex',
      metadata,
      providerMetadata: catalog?.openai ?? null,
    };
  }

  const slash = undecorated.indexOf('/');
  if (slash > 0) {
    const prefix = lower.slice(0, slash);
    const modelId = undecorated.slice(slash + 1);
    if (!modelId) throw new Error(`model id is missing after provider ${prefix}/`);
    if (prefix === 'claude') {
      const metadata = findModel(catalog, 'anthropic', modelId);
      assertEffortSupported(modelId, effort, metadata);
      return {
        spec,
        modelId,
        effort,
        provider: 'gateway-anthropic',
        metadata,
        providerMetadata: catalog?.anthropic ?? null,
      };
    }
    if (prefix === 'codex') {
      const metadata = findModel(catalog, 'openai', modelId);
      assertEffortSupported(modelId, effort, metadata);
      return {
        spec,
        modelId,
        effort,
        provider: 'gateway-codex',
        metadata,
        providerMetadata: catalog?.openai ?? null,
      };
    }
    if (!isAiSdkProvider(prefix)) {
      throw new Error(
        `unsupported loop provider ${JSON.stringify(prefix)}; ` +
        `supported AI SDK providers: ${AI_SDK_PROVIDER_IDS.join(', ')}, plus claude/ and codex/ gateways`,
      );
    }
    const metadata = findModel(catalog, prefix, modelId);
    assertEffortSupported(modelId, effort, metadata);
    return {
      spec,
      modelId,
      effort,
      provider: prefix,
      metadata,
      providerMetadata: catalog?.[prefix] ?? null,
    };
  }

  if (/^claude-/i.test(undecorated)) {
    const metadata = findModel(catalog, 'anthropic', undecorated);
    assertEffortSupported(undecorated, effort, metadata);
    return {
      spec,
      modelId: undecorated,
      effort,
      provider: 'gateway-anthropic',
      metadata,
      providerMetadata: catalog?.anthropic ?? null,
    };
  }
  if (/^(?:gpt-|o\d|codex-)/i.test(undecorated)) {
    const metadata = findModel(catalog, 'openai', undecorated);
    assertEffortSupported(undecorated, effort, metadata);
    return {
      spec,
      modelId: undecorated,
      effort,
      provider: 'gateway-codex',
      metadata,
      providerMetadata: catalog?.openai ?? null,
    };
  }

  const unique = findUnqualifiedModel(catalog, undecorated);
  if (unique && isAiSdkProvider(unique.provider)) {
    assertEffortSupported(undecorated, effort, unique.model);
    return {
      spec,
      modelId: undecorated,
      effort,
      provider: unique.provider,
      metadata: unique.model,
      providerMetadata: catalog?.[unique.provider] ?? null,
    };
  }

  throw new Error(
    `cannot resolve provider for model ${JSON.stringify(undecorated)}; ` +
    'use <provider>/<model> (for example openai/gpt-5.4) or a psu Claude/Codex alias',
  );
}

/**
 * Classify a tier/model spec against the owned loop's executable boundary.
 *
 * This deliberately uses a null catalog: models.dev enriches known provider
 * metadata, but it must not be required to decide whether the provider syntax
 * is executable.  The result is therefore stable during catalog outages and
 * carries the resolver's loud failure reason for UI/route consumers.
 */
export function classifyLoopModelSpec(spec: string): LoopModelCapability {
  try {
    const selection = resolveLoopModelSpec(spec, null);
    return { executable: true, provider: selection.provider };
  } catch (error) {
    return {
      executable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
