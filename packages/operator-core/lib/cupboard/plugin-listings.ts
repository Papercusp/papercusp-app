/**
 * Cupboard plugin-listing resolution for the import-time blueprint
 * dependency validator (revive-cupboard-distribution-2026-06-04 D-003 / P2).
 *
 * The blueprint dep-validator (`@papercusp/blueprint-distribution`
 * `validateBlueprintDependencies`) resolves a blueprint's declared plugin deps
 * against three host sets: tools in the catalog, plugins already installed, and
 * plugins **installable from the Cupboard**. Until E4 (the 3-kind storefront)
 * landed, the operator passed an EMPTY `cupboardPlugins` set, so a declared
 * plugin that exists in the Cupboard but isn't installed locally would
 * false-fail. This module wires the live `GET /listings?kind=plugin` read so
 * "needs plugin X — installable from the Cupboard" is truthful.
 *
 * Both helpers are best-effort and never throw: a Cupboard that's unreachable
 * yields `{ names: ∅, reachable: false }` so the caller can downgrade a
 * plugin-missing verdict to a warning rather than hard-failing on a transient
 * network blip.
 */
import { resolveCupboardBaseUrl } from './base-url';
import {
  listPluginsIn,
  resolveProjectPath,
  HARNESSES_DIR,
  GLOBAL_PLUGINS_DIR,
  type PluginManifest,
} from '../plugin-catalog';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

export type InstalledPlugin = PluginManifest & { source: string; path: string };

export interface CupboardPluginResolution {
  /** The `listing_ref` (plugin slug) of every active `kind=plugin` listing. */
  names: Set<string>;
  /** False if the Cupboard fetch failed/timed out (so callers don't hard-fail on a blip). */
  reachable: boolean;
}

interface CupboardListingRow {
  listing_kind?: string;
  listing_ref?: string | null;
  title?: string | null;
}

/**
 * Fetch the plugin slugs available in the Cupboard storefront. Mirrors the
 * operator cupboard proxy's fetch (resolveCupboardBaseUrl + `/listings?kind=`)
 * but reads directly here — this runs at harness:create gate time, off the
 * request path. A plugin listing's identifier is its `listing_ref` (the
 * within-project plugin slug, required for non-harness kinds); we fall back to
 * `title` only if a row somehow lacks a ref.
 */
export async function resolveCupboardPluginNames(
  opts: { timeoutMs?: number } = {},
): Promise<CupboardPluginResolution> {
  const names = new Set<string>();
  const base = resolveCupboardBaseUrl();
  const url = `${base}/listings?kind=plugin&limit=200`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) return { names, reachable: false };
    const data = (await res.json()) as { results?: CupboardListingRow[] };
    const rows = Array.isArray(data?.results) ? data.results : [];
    for (const r of rows) {
      const ref = (r.listing_ref ?? r.title ?? '').trim();
      if (ref) names.add(ref);
    }
    return { names, reachable: true };
  } catch {
    return { names, reachable: false };
  }
}

/**
 * Every plugin installed/reachable on this host: global plugins, every installed
 * harness's bundled plugins, and (if `harnessSlug` resolves) that harness's
 * project-scoped plugins. Deduped by manifest name (first-seen wins, matching the
 * loader's project→harness→global precedence). Best-effort.
 */
export async function listAllInstalledPlugins(harnessSlug?: string): Promise<InstalledPlugin[]> {
  const dirs: Array<{ dir: string; source: 'project' | 'harness' | 'global' }> = [];
  if (harnessSlug) {
    const projectPath = await resolveProjectPath(harnessSlug).catch(() => null);
    if (projectPath) dirs.push({ dir: join(projectPath, 'plugins'), source: 'project' });
  }
  const harnessesRoot = HARNESSES_DIR();
  if (existsSync(harnessesRoot)) {
    const entries = await fs.readdir(harnessesRoot, { withFileTypes: true }).catch(() => []);
    for (const h of entries) {
      if (!h.isDirectory()) continue;
      dirs.push({ dir: join(harnessesRoot, h.name, 'plugins'), source: 'harness' });
    }
  }
  dirs.push({ dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

  const seen = new Set<string>();
  const out: InstalledPlugin[] = [];
  for (const { dir, source } of dirs) {
    for (const p of await listPluginsIn(dir, source)) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      out.push(p);
    }
  }
  return out;
}

/** Names of every plugin installed/reachable on this host. */
export async function listInstalledPluginNames(harnessSlug?: string): Promise<Set<string>> {
  return new Set((await listAllInstalledPlugins(harnessSlug)).map((p) => p.name));
}

/** The installed plugin with manifest name `name`, or null. */
export async function findInstalledPlugin(name: string): Promise<InstalledPlugin | null> {
  return (await listAllInstalledPlugins()).find((p) => p.name === name) ?? null;
}
