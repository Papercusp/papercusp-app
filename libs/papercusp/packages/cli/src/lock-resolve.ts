/**
 * Recursive `requires` resolver for `papercusp.lock` (spec §14.9.7).
 *
 * Hard `requires` are pinned transitively: when the user installs plugin A,
 * we recursively pull in A's requires, those plugins' requires, and so on.
 * Cycles are broken by tracking visited slugs.
 *
 * `recommends` are NOT in the lockfile until the user accepts them; the
 * resolver returns them separately so the install command can prompt.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspRoot } from './papercusp-root.ts';
const PAPERCUSP_ROOT = papercuspRoot();
const GLOBAL_PLUGINS_DIR = join(PAPERCUSP_ROOT, 'global-plugins');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');

export interface ResolveResult {
  /** Plugins that should be in the lockfile. Includes the root + all transitive
   *  `requires`. Order is dependency-first (leaves before roots). */
  pinned: Array<{ slug: string; version: string; requiredBy: string }>;
  /** Plugins suggested by `recommends` along the chain — surfaced to the user
   *  but not auto-pinned. */
  recommended: string[];
  /** Slugs we couldn't resolve because they aren't installed locally. */
  missing: string[];
}

interface ManifestSubset {
  name: string;
  version: string;
  requires?: string[];
  recommends?: string[];
}

async function readInstalledManifest(slug: string): Promise<ManifestSubset | null> {
  const path = join(GLOBAL_PLUGINS_DIR, slug, 'papercusp.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as ManifestSubset;
  } catch {
    return null;
  }
}

/**
 * Resolve `requires` transitively starting from `rootSlug`. The resolver
 * does NOT fetch from the marketplace — it only walks already-installed
 * manifests. Missing requires surface in `result.missing`; the install
 * command is responsible for fetching them.
 */
export async function resolveRequires(rootSlug: string, rootRequiredBy = 'user'): Promise<ResolveResult> {
  const pinned: ResolveResult['pinned'] = [];
  const recommended = new Set<string>();
  const missing: string[] = [];
  const visited = new Set<string>();

  async function walk(slug: string, requiredBy: string): Promise<void> {
    if (visited.has(slug)) return;
    visited.add(slug);
    const manifest = await readInstalledManifest(slug);
    if (!manifest) {
      missing.push(slug);
      return;
    }
    // Recurse into requires first so transitive deps come before their parents
    // in `pinned` (helps callers do leaf-first installation).
    for (const dep of manifest.requires ?? []) {
      await walk(dep, slug);
    }
    for (const rec of manifest.recommends ?? []) {
      if (!visited.has(rec)) recommended.add(rec);
    }
    pinned.push({ slug: manifest.name, version: manifest.version, requiredBy });
  }

  await walk(rootSlug, rootRequiredBy);
  return { pinned, recommended: [...recommended], missing };
}

/** Walk every entry in a harness lockfile and return the union of resolves. */
export async function resolveLockfile(harnessSlug: string): Promise<ResolveResult> {
  const lockPath = join(HARNESSES_DIR, harnessSlug, 'papercusp.lock');
  if (!existsSync(lockPath)) {
    return { pinned: [], recommended: [], missing: [] };
  }
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
    entries: Record<string, { requiredBy: string }>;
  };
  const userInstalled = Object.entries(lock.entries)
    .filter(([, e]) => e.requiredBy === 'user')
    .map(([slug]) => slug);
  const merged: ResolveResult = { pinned: [], recommended: [], missing: [] };
  const seen = new Set<string>();
  const recSet = new Set<string>();
  for (const slug of userInstalled) {
    const r = await resolveRequires(slug, 'user');
    for (const p of r.pinned) {
      if (!seen.has(p.slug)) {
        seen.add(p.slug);
        merged.pinned.push(p);
      }
    }
    for (const rec of r.recommended) recSet.add(rec);
    for (const m of r.missing) if (!merged.missing.includes(m)) merged.missing.push(m);
  }
  merged.recommended = [...recSet];
  return merged;
}
