/**
 * Plugin-enables PG mirror.
 *
 * The papercusp CLI is the source-of-truth WRITER for
 * `~/.papercusp/harnesses/<slug>/enabled-plugins.json`. This module mirrors
 * that JSON into `harness_shared.plugin_enables` so READ paths can use one
 * cross-harness PG query (and Zero) instead of fanning over the filesystem.
 *
 * Workspace scoping: every mirror/read uses `withWorkspace(activeWorkspaceId())`
 * so the GUC is set, RLS predicates pass on the matching workspace, and rows
 * carry the workspace_id column.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkspace } from '@papercusp/db-org';

import { papercuspPath } from './papercusp-root';
import { activeWorkspaceId } from './workspace-registry';
function HARNESSES_DIR() { return papercuspPath('harnesses'); }

interface EnabledFile {
  enabled: Record<string, { version: string; enabledAt: string; configHash: string }>;
}

async function readEnabled(harness: string): Promise<EnabledFile | null> {
  const p = join(HARNESSES_DIR(), harness, 'enabled-plugins.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as EnabledFile;
  } catch {
    return null;
  }
}

/**
 * `plugin_enables.enabled_at` is BIGINT epoch-ms (Zero-era contract, see the
 * column comment in the baseline), but the CLI's enabled-plugins.json stores
 * `enabledAt` as an ISO string — passing it through verbatim made every
 * fresh-DB INSERT fail (EI-300: the .deb first-run logged
 * `invalid input syntax for type bigint: "2026-06-10T10:58:51.426Z"` and the
 * mirror retried forever; populated dev DBs never hit it because the
 * ON CONFLICT update path doesn't touch enabled_at).
 */
export function enabledAtEpochMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Mirror a single harness's enabled-plugins.json into PG. */
export async function mirrorHarness(harness: string): Promise<void> {
  const file = await readEnabled(harness);
  const enabled = file?.enabled ?? {};
  const slugs = Object.keys(enabled);
  const ws = activeWorkspaceId();

  await withWorkspace(ws, async (tx) => {
    for (const [pluginSlug, meta] of Object.entries(enabled)) {
      await tx`
        INSERT INTO harness_shared.plugin_enables
          (harness_slug, plugin_slug, version, config_hash, enabled_at, updated_at, workspace_id)
        VALUES (${harness}, ${pluginSlug}, ${meta.version ?? ''}, ${meta.configHash ?? ''},
                ${enabledAtEpochMs(meta.enabledAt)}, now(), ${ws})
        ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
          SET version = EXCLUDED.version,
              config_hash = EXCLUDED.config_hash,
              updated_at = now(),
              workspace_id = EXCLUDED.workspace_id
      `;
    }
    if (slugs.length === 0) {
      await tx`DELETE FROM harness_shared.plugin_enables WHERE harness_slug = ${harness}`;
    } else {
      await tx`
        DELETE FROM harness_shared.plugin_enables
        WHERE harness_slug = ${harness} AND plugin_slug NOT IN ${tx(slugs)}
      `;
    }
  });
}

/** Read every (harness → enabled plugin slugs) mapping from PG (active workspace). */
export async function listEnabledByHarness(): Promise<Record<string, string[]>> {
  const rows = await withWorkspace(activeWorkspaceId(), async (tx) => {
    return await tx<Array<{ harness_slug: string; plugin_slug: string }>>`
      SELECT harness_slug, plugin_slug FROM harness_shared.plugin_enables
       ORDER BY harness_slug, plugin_slug
    `;
  });
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    (out[r.harness_slug] ??= []).push(r.plugin_slug);
  }
  return out;
}

/** For a given plugin slug, which harnesses have it enabled (in active workspace)? */
export async function harnessesByPlugin(pluginSlug: string): Promise<string[]> {
  const rows = await withWorkspace(activeWorkspaceId(), async (tx) => {
    return await tx<Array<{ harness_slug: string }>>`
      SELECT harness_slug FROM harness_shared.plugin_enables
       WHERE plugin_slug = ${pluginSlug}
       ORDER BY harness_slug
    `;
  });
  return rows.map((r) => r.harness_slug);
}
