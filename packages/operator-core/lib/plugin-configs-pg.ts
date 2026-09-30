/**
 * Plugin-configs PG mirror.
 *
 * The substrate plugin loader (apps/operator/app/api/_hono/plugins.ts) reads
 * `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json` at runtime,
 * so the file is authoritative. This mirror exists for cross-harness reads
 * and Zero subscriptions ("which harnesses have plugin X configured how?").
 *
 * Encryption-at-rest (Migration 039): the JSONB payload is pgcrypto-encrypted
 * via pgp_sym_encrypt into the `config_ct BYTEA` column. The legacy plaintext
 * `config` column is dead — the payload moved to config_ct — so this helper
 * never writes it: it is `NOT NULL DEFAULT '{}'` in the shipped schema, so we
 * OMIT it on insert (the default applies) rather than writing NULL (which the
 * constraint would reject). `updated_at` is the bigint epoch-MS the column
 * stores, not `now()` (a timestamptz the bigint column would reject). The
 * on-disk file is a separate exposure — the substrate plugin loader cannot
 * decrypt — and is mode 0600 (see oauth/storage-fs.ts).
 *
 * Contract:
 *   - Every API route that mutates a plugin-config file MUST call
 *     `mirrorPluginConfig(harness, plugin)` immediately after.
 *   - If a direct CLI invocation outside the operator UI drifts the file
 *     ahead of PG, run `scripts/backfill-plugin-configs.mjs` to reconcile.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkspace } from '@papercusp/db-org';

import { papercuspPath } from './papercusp-root';
import { activeWorkspaceId } from './workspace-registry';
import { getDbEncryptionKey } from './db-encryption';
function HARNESSES_DIR() { return papercuspPath('harnesses'); }

async function readJsonFile<T>(p: string): Promise<T | null> {
  if (!existsSync(p)) return null;
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

/** Mirror one plugin-config JSON into PG. Pass `null` cfg to delete. */
export async function mirrorPluginConfig(
  harness: string,
  plugin: string,
  cfg: Record<string, unknown> | null = null,
): Promise<void> {
  if (cfg === null) {
    // Re-read from disk (caller may have just written it).
    const path = join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
    cfg = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
  }
  const cfgValue = cfg;
  const text = JSON.stringify(cfgValue);
  const key = getDbEncryptionKey();
  await withWorkspace(activeWorkspaceId(), async (tx) => {
    await tx`
      INSERT INTO harness_shared.plugin_configs
        (harness_slug, plugin_slug, config_ct, updated_at, workspace_id)
      VALUES (
        ${harness}, ${plugin},
        pgp_sym_encrypt(${text}, ${key}),
        (extract(epoch from now()) * 1000)::bigint, ${activeWorkspaceId()}
      )
      ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
        SET config_ct = pgp_sym_encrypt(${text}, ${key}),
            updated_at = (extract(epoch from now()) * 1000)::bigint,
            workspace_id = EXCLUDED.workspace_id
    `;
  });
}

/** Decrypt and return the PG-mirrored config (server-side only — needs the
 *  encryption key). Returns null if no row exists. */
export async function loadPluginConfig(
  harness: string,
  plugin: string,
): Promise<Record<string, unknown> | null> {
  const key = getDbEncryptionKey();
  let result: Record<string, unknown> | null = null;
  await withWorkspace(activeWorkspaceId(), async (tx) => {
    const rows = await tx<{ payload: Record<string, unknown> | null }[]>`
      SELECT
        CASE
          WHEN config_ct IS NOT NULL
            THEN pgp_sym_decrypt(config_ct, ${key})::jsonb
          ELSE config
        END AS payload
      FROM harness_shared.plugin_configs
      WHERE harness_slug = ${harness} AND plugin_slug = ${plugin}
      LIMIT 1
    `;
    result = rows[0]?.payload ?? null;
  });
  return result;
}

/** Drop a plugin-config row (used when a plugin is disabled/uninstalled). */
export async function deletePluginConfig(harness: string, plugin: string): Promise<void> {
  await withWorkspace(activeWorkspaceId(), async (tx) => {
    await tx`
      DELETE FROM harness_shared.plugin_configs
      WHERE harness_slug = ${harness} AND plugin_slug = ${plugin}
    `;
  });
}
