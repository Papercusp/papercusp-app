/** Daemon-owned capability truth, shared through PG rather than an operator cache (WI-41089). */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { LspLanguage, LspReadinessIntent } from './lsp-adapter';

export type LspCapabilitySource = 'initialize' | 'request-success' | 'publish' | 'method-not-found';
export interface LspCapabilityKey {
  language: LspLanguage;
  intent: LspReadinessIntent;
  serverIdentity: string;
}
export interface LspCapabilityObservation extends LspCapabilityKey {
  supported: boolean;
  source: LspCapabilitySource;
  evidence: string;
}
export interface LspCapabilityStore {
  get(key: LspCapabilityKey): Promise<LspCapabilityObservation | null>;
  observe(observation: LspCapabilityObservation): Promise<void>;
}

/** A new binary/version earns new cells; an old refusal cannot poison an upgraded pin. */
export function lspServerIdentity(bin: string, serverInfo: unknown, extraBins: readonly string[] = []): string {
  const hash = createHash('sha256').update(JSON.stringify(serverInfo ?? null));
  for (const path of [bin, ...extraBins]) hash.update(realpathSync(path)).update(readFileSync(path));
  return hash.digest('hex');
}

const PROVIDERS: Readonly<Partial<Record<LspReadinessIntent, string>>> = {
  definition: 'definitionProvider', references: 'referencesProvider',
  implementations: 'implementationProvider', 'rename-preview': 'renameProvider',
  'symbol-search': 'workspaceSymbolProvider',
};

export function initializeCapabilityObservations(
  language: LspLanguage, serverIdentity: string, capabilities: unknown,
): LspCapabilityObservation[] {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return [];
  return Object.entries(PROVIDERS).map(([intent, provider]) => {
    const value = (capabilities as Record<string, unknown>)[provider];
    return {
      language, serverIdentity, intent: intent as LspReadinessIntent,
      supported: value === true || (value !== null && typeof value === 'object' && !Array.isArray(value)),
      source: 'initialize', evidence: provider,
    };
  });
  // Legacy publishDiagnostics is implicit. Missing diagnosticProvider only declines
  // PULL diagnostics; it says nothing about the PUSH path this adapter uses.
}

const PRIORITY: Readonly<Record<LspCapabilitySource, number>> = {
  initialize: 1, 'request-success': 2, publish: 2, 'method-not-found': 3,
};

export class PgLspCapabilityStore implements LspCapabilityStore {
  constructor(private readonly getSql: () => postgres.Sql = () => getOrgPg().sql) {}

  async get(key: LspCapabilityKey): Promise<LspCapabilityObservation | null> {
    const sql = this.getSql();
    const [row] = await sql`
      SELECT supported, source, evidence FROM harness_shared.lsp_capabilities
      WHERE language = ${key.language} AND intent = ${key.intent} AND server_identity = ${key.serverIdentity}
    `;
    return row ? { ...key, supported: row.supported as boolean,
      source: row.source as LspCapabilitySource, evidence: row.evidence as string } : null;
  }

  async observe(observation: LspCapabilityObservation): Promise<void> {
    const sql = this.getSql();
    await sql`
      INSERT INTO harness_shared.lsp_capabilities
        (language, intent, server_identity, supported, source, evidence, evidence_priority)
      VALUES (${observation.language}, ${observation.intent}, ${observation.serverIdentity},
        ${observation.supported}, ${observation.source}, ${observation.evidence}, ${PRIORITY[observation.source]})
      ON CONFLICT (language, intent, server_identity) DO UPDATE SET
        supported = EXCLUDED.supported, source = EXCLUDED.source, evidence = EXCLUDED.evidence,
        evidence_priority = EXCLUDED.evidence_priority, observed_at = now()
      WHERE EXCLUDED.evidence_priority >= lsp_capabilities.evidence_priority
        AND (EXCLUDED.supported, EXCLUDED.source, EXCLUDED.evidence)
          IS DISTINCT FROM (lsp_capabilities.supported, lsp_capabilities.source, lsp_capabilities.evidence)
    `;
  }
}

export class LspUnsupportedIntentError extends Error {
  constructor(key: LspCapabilityKey, evidence: string) {
    super(`LSP ${key.language} does not support intent '${key.intent}' (${evidence}); refusing to report no results`);
    this.name = 'LspUnsupportedIntentError';
  }
}

export async function requireLspCapability(store: LspCapabilityStore, key: LspCapabilityKey): Promise<void> {
  const observation = await store.get(key);
  if (observation?.supported === false) throw new LspUnsupportedIntentError(key, observation.evidence);
}

/** Only the exact protocol code is negative capability evidence; generic failures stay unknown. */
export async function requestWithLspCapability<T>(
  store: LspCapabilityStore, key: LspCapabilityKey, method: string, request: () => Promise<T>,
): Promise<T> {
  await requireLspCapability(store, key);
  let result: T;
  try { result = await request(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === -32601) {
      await store.observe({ ...key, supported: false, source: 'method-not-found', evidence: `${method}: -32601` });
      throw new LspUnsupportedIntentError(key, `${method}: -32601`);
    }
    throw error;
  }
  await store.observe({ ...key, supported: true, source: 'request-success', evidence: method });
  return result;
}

export const lspCapabilityStore: LspCapabilityStore = new PgLspCapabilityStore();
