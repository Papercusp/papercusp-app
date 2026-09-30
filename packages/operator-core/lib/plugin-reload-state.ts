/**
 * Hot-reload state preservation — implementation backing the
 * `getStateForReload` / `restoreFromReload` hooks from
 * @papercusp/plugin-sdk PluginHooks. Postgres-backed via
 * harness_shared.plugin_reload_state (Migration 055).
 *
 * Lifecycle:
 *   1. Plugin reload begins (file change, config update, etc.)
 *   2. Host calls plugin.getStateForReload(ctx) — returns JSON value
 *   3. Host calls `savePluginReloadState` to stash it
 *   4. New module instance loads; init() runs
 *   5. Host calls `loadPluginReloadState` + plugin.restoreFromReload(state)
 *   6. Host deletes the row (one-shot; restore must succeed-or-discard)
 *
 * Failure mode: state larger than MAX_STATE_BYTES is silently dropped
 * (logged). Plugin authors with bigger state should use ctx.kv or
 * pluginDataDir, which have their own quota semantics.
 */

import type { Sql } from 'postgres';

export const MAX_STATE_BYTES = 64 * 1024;

export interface ReloadStateDeps {
  pluginId: string;
  harnessSlug: string;
  sql: Sql;
}

/**
 * Persist a plugin's reload state. Returns true on success, false if
 * the state exceeded the size cap (state is dropped) or wasn't
 * JSON-serialisable.
 */
export async function savePluginReloadState(
  deps: ReloadStateDeps,
  state: unknown,
): Promise<boolean> {
  const { pluginId, harnessSlug, sql } = deps;
  if (state === undefined) return false;
  let serialised: string;
  try {
    serialised = JSON.stringify(state);
  } catch {
    return false;
  }
  if (serialised === undefined) return false;
  const byteSize = Buffer.byteLength(serialised, 'utf8');
  if (byteSize > MAX_STATE_BYTES) {
    return false;
  }
  await sql`
    INSERT INTO harness_shared.plugin_reload_state (plugin_id, harness_slug, state, byte_size, saved_at)
    VALUES (${pluginId}, ${harnessSlug}, ${serialised}::text::jsonb, ${byteSize}, now())
    ON CONFLICT (plugin_id, harness_slug) DO UPDATE
      SET state = EXCLUDED.state,
          byte_size = EXCLUDED.byte_size,
          saved_at = now()
  `;
  return true;
}

/**
 * Pop the reload state for a (plugin, harness) pair. Returns undefined
 * if no state was stashed. Always deletes the row so restore is
 * one-shot — if restoreFromReload throws, the host shouldn't retry
 * indefinitely against stale state.
 */
export async function popPluginReloadState(deps: ReloadStateDeps): Promise<unknown | undefined> {
  const { pluginId, harnessSlug, sql } = deps;
  const rows = await sql<Array<{ state: unknown }>>`
    DELETE FROM harness_shared.plugin_reload_state
      WHERE plugin_id = ${pluginId}
        AND harness_slug = ${harnessSlug}
      RETURNING state
  `;
  if (rows[0] === undefined) return undefined;
  const raw = rows[0].state;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Delete a plugin's reload state without reading it. Called on
 * uninstall — uninstalled plugins shouldn't leak state in the table.
 */
export async function clearPluginReloadState(deps: ReloadStateDeps): Promise<void> {
  const { pluginId, harnessSlug, sql } = deps;
  await sql`
    DELETE FROM harness_shared.plugin_reload_state
      WHERE plugin_id = ${pluginId}
        AND harness_slug = ${harnessSlug}
  `;
}
