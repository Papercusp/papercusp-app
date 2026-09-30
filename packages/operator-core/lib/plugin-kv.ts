/**
 * Plugin-private key/value store — implementation of @papercusp/plugin-sdk's
 * `PluginKv` interface. Backed by harness_shared.plugin_kv (Migration 054).
 *
 * Quota model:
 *   - Per-key: bytes(JSON.stringify(value)) ≤ DEFAULT_MAX_BYTES_PER_KEY
 *   - Per-plugin: SUM(byte_size) over (plugin_id, harness_slug) rows
 *                 ≤ DEFAULT_MAX_BYTES_PER_PLUGIN (after the write)
 *
 * Both are configurable per-plugin via the manifest's `kvQuota` field
 * (e.g. `{ maxBytesPerKey: 50000, maxBytesPerPlugin: 5242880 }`).
 *
 * @see /docs/spec/plugin-quickstart#ctxkv
 */

import { KvQuotaError, type PluginKv } from '@papercusp/plugin-sdk';
import type { Sql } from 'postgres';

export const DEFAULT_MAX_BYTES_PER_KEY = 10 * 1024;
export const DEFAULT_MAX_BYTES_PER_PLUGIN = 1024 * 1024;

export interface KvQuotaConfig {
  maxBytesPerKey?: number;
  maxBytesPerPlugin?: number;
}

export interface KvDeps {
  /** Plugin-id namespace (slug). */
  pluginId: string;
  /** Harness slug providing tenant scoping. */
  harnessSlug: string;
  /** Postgres handle. */
  sql: Sql;
  /** Optional quota override; falls back to module defaults. */
  quota?: KvQuotaConfig;
}

/**
 * Build a `PluginKv` bound to a (plugin, harness) pair. Wires through
 * the postgres handle from the operator's getOrgPg() at construction
 * time so the hot path is just a function call.
 */
export function makePluginKv(deps: KvDeps): PluginKv {
  const { pluginId, harnessSlug, sql } = deps;
  const maxBytesPerKey = deps.quota?.maxBytesPerKey ?? DEFAULT_MAX_BYTES_PER_KEY;
  const maxBytesPerPlugin = deps.quota?.maxBytesPerPlugin ?? DEFAULT_MAX_BYTES_PER_PLUGIN;

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      validateKey(key);
      const rows = await sql<Array<{ value: unknown }>>`
        SELECT value FROM harness_shared.plugin_kv
          WHERE plugin_id = ${pluginId}
            AND harness_slug = ${harnessSlug}
            AND key = ${key}
          LIMIT 1
      `;
      if (rows[0] === undefined) return undefined;
      // postgres-js returns JSONB as a string when cast via ::jsonb in
      // the INSERT; parse here so callers don't have to.
      const raw = rows[0].value;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as T;
        }
      }
      return raw as T;
    },

    async set(key: string, value: unknown): Promise<void> {
      validateKey(key);
      const serialised = JSON.stringify(value);
      if (serialised === undefined) {
        throw new TypeError(`ctx.kv.set('${key}', …) — value is not JSON-serialisable`);
      }
      const byteSize = Buffer.byteLength(serialised, 'utf8');
      if (byteSize > maxBytesPerKey) {
        throw new KvQuotaError(
          `ctx.kv.set('${key}', …) — value is ${byteSize} bytes, limit is ${maxBytesPerKey} per key`,
          'per-key',
          maxBytesPerKey,
          byteSize,
        );
      }
      // Total-quota check: compute remaining headroom by reading the
      // current SUM minus the existing row's contribution (if any). Then
      // ensure the new write fits.
      const [{ used }] = await sql<[{ used: number }]>`
        SELECT COALESCE(SUM(byte_size), 0)::int AS used
          FROM harness_shared.plugin_kv
          WHERE plugin_id = ${pluginId}
            AND harness_slug = ${harnessSlug}
      `;
      const [existing] = await sql<Array<{ byte_size: number }>>`
        SELECT byte_size FROM harness_shared.plugin_kv
          WHERE plugin_id = ${pluginId}
            AND harness_slug = ${harnessSlug}
            AND key = ${key}
          LIMIT 1
      `;
      const projected = Number(used) - (existing?.byte_size ?? 0) + byteSize;
      if (projected > maxBytesPerPlugin) {
        throw new KvQuotaError(
          `ctx.kv.set('${key}', …) — plugin total would be ${projected} bytes, limit is ${maxBytesPerPlugin}`,
          'per-plugin',
          maxBytesPerPlugin,
          projected,
        );
      }
      await sql`
        INSERT INTO harness_shared.plugin_kv (plugin_id, harness_slug, key, value, byte_size, updated_at)
        VALUES (${pluginId}, ${harnessSlug}, ${key}, ${serialised}::text::jsonb, ${byteSize}, now())
        ON CONFLICT (plugin_id, harness_slug, key) DO UPDATE
          SET value = EXCLUDED.value,
              byte_size = EXCLUDED.byte_size,
              updated_at = now()
      `;
    },

    async delete(key: string): Promise<void> {
      validateKey(key);
      await sql`
        DELETE FROM harness_shared.plugin_kv
          WHERE plugin_id = ${pluginId}
            AND harness_slug = ${harnessSlug}
            AND key = ${key}
      `;
    },

    async list(opts?: { prefix?: string; limit?: number; afterKey?: string }): Promise<string[]> {
      const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
      const prefix = opts?.prefix ?? '';
      const afterKey = opts?.afterKey ?? '';
      const rows = await sql<Array<{ key: string }>>`
        SELECT key FROM harness_shared.plugin_kv
          WHERE plugin_id = ${pluginId}
            AND harness_slug = ${harnessSlug}
            AND key > ${afterKey}
            AND key LIKE ${prefix + '%'}
          ORDER BY key ASC
          LIMIT ${limit}
      `;
      return rows.map((r) => r.key);
    },
  };
}

/**
 * Reject empty / whitespace-only keys and keys with newlines, plus
 * an upper bound on length to keep PG keys index-friendly. Returns
 * normally; throws on bad input.
 */
function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('ctx.kv key must be a non-empty string');
  }
  if (key.length > 1024) {
    throw new TypeError(`ctx.kv key is ${key.length} chars, limit is 1024`);
  }
  // Reject ASCII control characters (0x00-0x1f and 0x7f).
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new TypeError('ctx.kv key may not contain control characters');
    }
  }
}
