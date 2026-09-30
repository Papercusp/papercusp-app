/**
 * Third-party INTEGRATION credentials — a generic PG-backed secret store
 * for API keys that don't belong in `operator_credentials` (the closed
 * 4-key platform allowlist: openai/anthropic/zeroentropy/github_pat, see
 * `setup:save_key`) or `operator_search_provider_credentials` (OMP web
 * search only).
 *
 * Storage policy (repo CLAUDE.md): a secret NEVER goes into a tree file.
 * When a user hands over a third-party provider key for a feature (e.g. a
 * WeatherAPI key for a weather widget — owner-ask-batch-2026-07-06 P-002),
 * it is written here instead — `harness_shared.operator_integration_credentials`
 * (migration 526), encrypted at rest via pgcrypto (see db-encryption.ts
 * ENCRYPTED_TABLES), single-row-per-workspace, NOT in the zero_harness
 * publication (never broadcast over WS).
 *
 * Shape mirrors search-provider-credentials.ts: opaque `Record<string,
 * string>` keyed by a caller-chosen name (e.g. `WEATHERAPI_API_KEY`) so
 * adding a new integration never needs a schema/migration change — only a
 * new key name.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

export type IntegrationCredentials = Record<string, string>;

async function readAll(): Promise<IntegrationCredentials> {
  const raw = await readOperatorState<IntegrationCredentials>('operator_integration_credentials');
  return raw && typeof raw === 'object' ? raw : {};
}

async function writeAll(creds: IntegrationCredentials): Promise<void> {
  await writeOperatorState('operator_integration_credentials', creds);
}

/** Read all configured integration keys. Server-side only — full values. */
export async function readIntegrationCredentials(): Promise<IntegrationCredentials> {
  return readAll();
}

/** Read a single integration key's raw value (server-side only). */
export async function readIntegrationKey(name: string): Promise<string | undefined> {
  const all = await readAll();
  return all[name];
}

/**
 * Upsert one or more integration keys. Only names present in `partial` are
 * touched; pass an empty string or null to clear a key.
 */
export async function writeIntegrationCredentials(
  partial: Record<string, string | null>,
): Promise<IntegrationCredentials> {
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

/** Mask a key for client display / logs: 'sk-...AbCd'. Null when too short. */
export function maskIntegrationKey(value: string | undefined | null): string | null {
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

/** Masked view of every configured integration key — safe to log/return to a client. */
export async function readMaskedIntegrationView(): Promise<Record<string, string | null>> {
  const all = await readAll();
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(all)) out[k] = maskIntegrationKey(all[k]);
  return out;
}
