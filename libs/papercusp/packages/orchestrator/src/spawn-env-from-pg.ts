/**
 * Read the operator's encrypted search-provider credentials directly
 * from PG and return them as a plain env-var map for spawn injection.
 *
 * Mirrors `apps/operator/lib/search-provider-credentials.ts:buildSpawnEnv`
 * but with no operator-app dependency — this module only sees the
 * orchestrator's existing PG client and reads the encryption key from
 * the same source (env var or `~/.papercusp/db-encryption-key`).
 *
 * Schema: Migration 047. Single row per workspace, payload is JSONB
 * `{ ENV_VAR_NAME: value, ... }`, encrypted at rest in `payload_ct`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorPg } from './invoke';

const ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY';
const KEY_FILE = join(homedir(), '.papercusp', 'db-encryption-key');

function readEncryptionKey(): string | null {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (existsSync(KEY_FILE)) {
    try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Read decrypted search-provider credentials for `workspaceId`. Returns
 * `{}` when nothing is configured, the table is missing, or decryption
 * fails — best-effort, the agent still spawns without these env vars.
 */
export async function buildSearchProviderSpawnEnv(
  pg: OrchestratorPg,
  workspaceId: string,
): Promise<Record<string, string>> {
  const key = readEncryptionKey();
  if (!key) return {};

  try {
    // RLS scopes by app.workspace_id GUC; set it transactionally.
    // postgres-js pg`set_config(...)` returns rows; ignore.
    await pg`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    const rows = await pg`
      SELECT
        CASE
          WHEN payload_ct IS NOT NULL
            THEN pgp_sym_decrypt(payload_ct, ${key})::jsonb
          ELSE payload
        END AS plaintext
      FROM harness_shared.operator_search_provider_credentials
       WHERE workspace_id = ${workspaceId}
    `;
    if (!rows || rows.length === 0) return {};
    const payload = (rows[0] as { plaintext: Record<string, unknown> | null }).plaintext;
    if (!payload || typeof payload !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
