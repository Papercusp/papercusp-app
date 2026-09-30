/**
 * Search-provider credentials reader/writer.
 *
 * Persisted in `harness_shared.operator_search_provider_credentials` (PG,
 * migration 047). Encrypted at rest via pgcrypto; NOT in zero_harness
 * publication — values never broadcast over WS.
 *
 * The 14 OMP web_search providers each look for one or more env vars at
 * spawn time. The orchestrator reads from this table and injects the
 * configured ones into OMP's spawn env so users never have to set them
 * in shell rc files.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (PR after foundation).
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

/**
 * Canonical env-var names the 14 OMP search providers consume. The
 * `id` is the OMP provider id (matches @oh-my-pi/pi-coding-agent's
 * `SearchProviderId`); `envVars` lists the names the provider's
 * `isAvailable()` check looks for, in OMP's preference order.
 */
export interface SearchProviderEnvSpec {
  id: string;
  label: string;
  /** Primary env var (preferred). */
  primary: string;
  /** Alternate env vars OMP will accept (in preference order). */
  alternates?: string[];
  /** Special — multi-field config (e.g. SearXNG endpoint + auth). */
  fields?: string[];
}

/**
 * Provider list mirrors `@oh-my-pi/pi-coding-agent` providers (see
 * reference_omp_tool_surface memory artifact). Update if OMP changes.
 */
export const SEARCH_PROVIDERS: SearchProviderEnvSpec[] = [
  { id: 'tavily', label: 'Tavily', primary: 'TAVILY_API_KEY' },
  { id: 'perplexity', label: 'Perplexity', primary: 'PERPLEXITY_API_KEY', alternates: ['PPLX_API_KEY'] },
  { id: 'brave', label: 'Brave', primary: 'BRAVE_API_KEY' },
  { id: 'jina', label: 'Jina', primary: 'JINA_API_KEY' },
  { id: 'kimi', label: 'Kimi (Moonshot)', primary: 'MOONSHOT_SEARCH_API_KEY', alternates: ['KIMI_SEARCH_API_KEY', 'MOONSHOT_API_KEY'] },
  { id: 'anthropic', label: 'Anthropic Search', primary: 'ANTHROPIC_API_KEY' },
  { id: 'gemini', label: 'Gemini', primary: 'GEMINI_API_KEY' },
  { id: 'codex', label: 'Codex', primary: 'CODEX_API_KEY' },
  { id: 'zai', label: 'Z.AI', primary: 'ZAI_API_KEY' },
  { id: 'exa', label: 'Exa', primary: 'EXA_API_KEY' },
  { id: 'parallel', label: 'Parallel', primary: 'PARALLEL_API_KEY' },
  { id: 'kagi', label: 'Kagi', primary: 'KAGI_API_KEY' },
  { id: 'synthetic', label: 'Synthetic', primary: 'SYNTHETIC_API_KEY' },
  {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    primary: 'SEARXNG_ENDPOINT',
    fields: ['SEARXNG_ENDPOINT', 'SEARXNG_TOKEN', 'SEARXNG_BASIC_USERNAME', 'SEARXNG_BASIC_PASSWORD'],
  },
];

/** Storage shape: env-var-name → value. Single payload, opaque to schema changes in SEARCH_PROVIDERS. */
export type SearchProviderCredentials = Record<string, string>;

async function readAll(): Promise<SearchProviderCredentials> {
  const raw = await readOperatorState<SearchProviderCredentials>('operator_search_provider_credentials');
  return raw && typeof raw === 'object' ? raw : {};
}

async function writeAll(creds: SearchProviderCredentials): Promise<void> {
  await writeOperatorState('operator_search_provider_credentials', creds);
}

/** Read all configured search-provider env vars. Server-side only. */
export async function readSearchProviderCredentials(): Promise<SearchProviderCredentials> {
  return readAll();
}

/**
 * Update one or more env vars. Only fields present in `partial` are
 * touched; pass an empty string to clear a field.
 */
export async function writeSearchProviderCredentials(
  partial: Record<string, string | null>,
): Promise<SearchProviderCredentials> {
  const current = await readAll();
  const next = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v === null || v === '') {
      delete next[k];
    } else if (typeof v === 'string') {
      next[k] = v.trim();
    }
  }
  await writeAll(next);
  return next;
}

/** Mask a key for client display: 'sk-...AbCd'. Null when too short. */
export function maskKey(value: string | undefined | null): string | null {
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

/**
 * Build a server-readable list (with full keys) — used by the
 * orchestrator's spawn-env injection. NEVER returned over the wire.
 */
export async function buildSpawnEnv(): Promise<Record<string, string>> {
  const all = await readAll();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Build the masked-only view for the operator UI. Each provider returns
 * the configured env-var-names with masked values; `null` for any field
 * whose value isn't configured.
 */
export interface MaskedSearchProvidersView {
  providers: Array<{
    id: string;
    label: string;
    fields: Array<{ envVar: string; masked: string | null; isPrimary: boolean }>;
  }>;
  updatedAt: number | null;
}

export async function readMaskedView(): Promise<MaskedSearchProvidersView> {
  const all = await readAll();
  return {
    providers: SEARCH_PROVIDERS.map((p) => {
      const fields = p.fields ?? [p.primary, ...(p.alternates ?? [])];
      return {
        id: p.id,
        label: p.label,
        fields: fields.map((envVar) => ({
          envVar,
          masked: maskKey(all[envVar]),
          isPrimary: envVar === p.primary,
        })),
      };
    }),
    updatedAt: null, // updated_at is on the row; not exposed here
  };
}
