/**
 * Plugin capability grants store — Tier 2 of the two-tier capability
 * check. Source of truth is `harness_shared.plugin_capability_grants`
 * (Migration 051). The legacy file at
 * `~/.papercusp/granted-capabilities.json` is read-only fallback for one
 * release cycle so installs predating Migration 051 don't lose grants.
 *
 * Wildcards in granted caps follow the same matching rules as manifest
 * caps; the loader's `hasCapability(ctx, cap)` does the actual matching
 * by ANDing manifest with the granted set returned here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { getOrgPg } from '@papercusp/db-org';
import { papercuspPath } from './papercusp-root';

export interface GrantInput {
  pluginName: string;
  pluginVersion: string;
  harnessSlug: string;       // '' for global
  capabilities: string[];
  grantedBy?: string;
  reason?: string;
}

interface LegacyFile {
  grants?: Record<string, { grantedAt: string }>;
}

/**
 * Load the legacy file format: keys like
 *   "<plugin>:<harness>:<capability>"
 *   "<plugin>@<version>:<harness>:<capability>"
 * Used for read-only backfill into PG; never written back.
 */
function readLegacyGrants(): GrantInput[] {
  const path = join(papercuspPath(), 'granted-capabilities.json');
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as LegacyFile;
    const grants = parsed.grants ?? {};
    const groups = new Map<string, GrantInput>();
    for (const key of Object.keys(grants)) {
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const head = parts[0]; // <plugin> or <plugin>@<version>
      const harnessSlug = parts[1];
      const capability = parts.slice(2).join(':');
      const atSign = head.lastIndexOf('@');
      const pluginName = atSign > 0 ? head.slice(0, atSign) : head;
      const pluginVersion = atSign > 0 ? head.slice(atSign + 1) : '0.0.0';
      const groupKey = `${pluginName}@${pluginVersion}\x1f${harnessSlug}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          pluginName,
          pluginVersion,
          harnessSlug,
          capabilities: [],
          reason: 'legacy-file backfill',
        });
      }
      groups.get(groupKey)!.capabilities.push(capability);
    }
    return Array.from(groups.values());
  } catch {
    return [];
  }
}

/**
 * Read all grants for a (plugin, harness) pair. Reads PG first, then
 * unions with legacy-file grants for the same key. Caller passes the
 * pinned plugin version so a re-grant on upgrade is enforced.
 */
export async function getGrantsForPluginInHarness(
  pluginName: string,
  pluginVersion: string,
  harnessSlug: string,
  /** Optional sql override for tests; production callers omit. */
  opts?: { sql?: ReturnType<typeof getOrgPg>['sql']; skipLegacy?: boolean },
): Promise<string[]> {
  const out = new Set<string>();
  try {
    const sql = opts?.sql ?? getOrgPg().sql;
    const rows = await sql<{ capability: string }[]>`
      SELECT capability FROM harness_shared.plugin_capability_grants
      WHERE plugin_name = ${pluginName}
        AND plugin_version = ${pluginVersion}
        AND harness_slug IN (${harnessSlug}, '')
    `;
    for (const r of rows) out.add(r.capability);
  } catch {
    // PG unavailable — caller still gets file-fallback below.
  }
  if (!opts?.skipLegacy) {
    for (const g of readLegacyGrants()) {
      if (g.pluginName !== pluginName) continue;
      if (g.pluginVersion !== pluginVersion && g.pluginVersion !== '0.0.0') continue;
      if (g.harnessSlug !== harnessSlug && g.harnessSlug !== '') continue;
      for (const c of g.capabilities) out.add(c);
    }
  }
  return Array.from(out);
}

/**
 * Persist a grant. If the (plugin, version, harness, cap) tuple already
 * exists, it's a no-op. ON CONFLICT DO NOTHING keeps the original
 * granted_at + granted_by — re-granting at the same scope shouldn't
 * silently mutate the audit trail.
 */
export async function grantCapabilities(
  input: GrantInput,
  opts?: { sql?: ReturnType<typeof getOrgPg>['sql'] },
): Promise<void> {
  if (input.capabilities.length === 0) return;
  const sql = opts?.sql ?? getOrgPg().sql;
  for (const cap of input.capabilities) {
    await sql`
      INSERT INTO harness_shared.plugin_capability_grants
        (plugin_name, plugin_version, harness_slug, capability, granted_by, reason)
      VALUES (${input.pluginName}, ${input.pluginVersion}, ${input.harnessSlug}, ${cap},
              ${input.grantedBy ?? null}, ${input.reason ?? null})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function revokeCapabilities(
  input: GrantInput,
  opts?: { sql?: ReturnType<typeof getOrgPg>['sql'] },
): Promise<void> {
  if (input.capabilities.length === 0) return;
  const sql = opts?.sql ?? getOrgPg().sql;
  for (const cap of input.capabilities) {
    await sql`
      DELETE FROM harness_shared.plugin_capability_grants
      WHERE plugin_name = ${input.pluginName}
        AND plugin_version = ${input.pluginVersion}
        AND harness_slug = ${input.harnessSlug}
        AND capability = ${cap}
    `;
  }
}

/**
 * Copy every (plugin, version, capability) grant on `sourceSlug` to the
 * same triple keyed under `targetSlug`. Used by snapshot fork so the new
 * harness inherits its parent's capability decisions instead of silently
 * degrading on first invocation. ON CONFLICT DO NOTHING — a re-fork
 * doesn't duplicate.
 */
export async function copyGrantsToNewHarness(
  sourceSlug: string,
  targetSlug: string,
  /**
   * Optional: override the postgres-js client. Used by the integration
   * test to point at a testcontainers PG schema; default uses the
   * operator's org-PG. Production callers omit this.
   */
  opts?: { sql?: ReturnType<typeof getOrgPg>['sql'] },
): Promise<{ copied: number }> {
  if (!sourceSlug || !targetSlug || sourceSlug === targetSlug) return { copied: 0 };
  const sql = opts?.sql ?? getOrgPg().sql;
  const result = await sql`
    INSERT INTO harness_shared.plugin_capability_grants
      (plugin_name, plugin_version, harness_slug, capability, granted_by, reason)
    SELECT plugin_name, plugin_version, ${targetSlug}, capability,
           'system', ${`fork from ${sourceSlug}`}
      FROM harness_shared.plugin_capability_grants
     WHERE harness_slug = ${sourceSlug}
    ON CONFLICT DO NOTHING
    RETURNING 1
  `;
  return { copied: result.length };
}

// NOTE: the `harness_shared.plugin_capability_grants` table is defined in
// `000-baseline.sql` (originally migration 051). The runtime `ensureTable()`
// `CREATE TABLE IF NOT EXISTS` that used to live here was redundant — and a
// "schema = migrations only" violation that failed on a no-CREATE role — so it
// was removed in revive-plugin-system-2026-06-04 D-001.

/**
 * One-shot backfill: read every legacy-file grant + every (plugin,
 * harness) pair currently in `enabled-plugins.json`, and write a system
 * grant covering the manifest's declared capabilities. Run once at
 * operator boot. After this, the legacy file is read-fallback only.
 */
export async function backfillGrantsFromEnabledPluginsAndLegacyFile(
  enabledHarnesses: { harnessSlug: string; plugins: { name: string; version: string; manifestCapabilities: string[] }[] }[],
  /** Optional injection for tests: sql override and a skip-legacy flag
   * so the test doesn't pull in `~/.papercusp/granted-capabilities.json`
   * from the dev box. Production callers omit. */
  opts?: { sql?: ReturnType<typeof getOrgPg>['sql']; skipLegacy?: boolean },
): Promise<{ inserted: number }> {
  let inserted = 0;
  // 1) From the legacy file — preserve historical grants verbatim.
  if (!opts?.skipLegacy) {
    for (const g of readLegacyGrants()) {
      await grantCapabilities(
        { ...g, grantedBy: 'system', reason: 'legacy-file backfill' },
        { sql: opts?.sql },
      );
      inserted += g.capabilities.length;
    }
  }
  // 2) From `enabled-plugins.json` — every plugin that's enabled in a
  // harness gets its manifest-declared caps granted (silent backfill so
  // existing harnesses don't break on first reload). Users can revoke
  // any of these later from the consent UI.
  for (const h of enabledHarnesses) {
    for (const p of h.plugins) {
      await grantCapabilities(
        {
          pluginName: p.name,
          pluginVersion: p.version,
          harnessSlug: h.harnessSlug,
          capabilities: p.manifestCapabilities,
          grantedBy: 'system',
          reason: 'enabled-plugins.json backfill',
        },
        { sql: opts?.sql },
      );
      inserted += p.manifestCapabilities.length;
    }
  }
  return { inserted };
}
