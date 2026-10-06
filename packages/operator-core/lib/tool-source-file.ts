/**
 * tool-source-file — the absolute file that defined a tool, in ANY runtime
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-002 / EI-25176539351759672).
 *
 * `projectedToolSourceFile` (tooldef) answers from the call stack captured when the tool
 * registered. That works wherever each module is its own file (tsx, vitest) and answers
 * null for every tool inside a bundle: the bg-host runs one esbuild file, so every frame
 * reported that file and the capture could not tell the tool's module from tooldef's.
 * The deployment-staleness screen runs inside that bg-host, so it answered
 * `tool-source-unknown` for every promoted tool-failure it triaged (217 open bugs on
 * 2026-10-05) and stamped readiness nobody re-screens.
 *
 * In a bundle tooldef now records the frames' LINES instead, and this module maps them
 * to the defining module through the `// <path>` marker esbuild writes above each
 * inlined module (`bundle-definition-site.ts` in tooldef has the pure half). The host
 * half is here because it reads a file: tooldef ships a browser-safe barrel.
 *
 * Every miss is `null` — unknown, never a guess: no site, an unreadable bundle, a bundle
 * rewritten after this process loaded it, a marker that does not resolve on disk.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { pinModuleState } from '@papercusp/module-singleton';
import {
  definingModuleOfBundledSite,
  indexBundleModuleMarkers,
  projectedToolBundledDefinitionSite,
  projectedToolSourceFile,
  type BundleModuleMarkers,
  type BundledDefinitionSite,
} from '@papercusp/tooldef';

export interface ToolSourceFileDeps {
  /** The stack-captured path (tooldef). Defaults to {@link projectedToolSourceFile}. */
  sourceFileFor?: (toolName: string) => string | null;
  /** The bundled site (tooldef). Defaults to {@link projectedToolBundledDefinitionSite}. */
  bundledSiteFor?: (toolName: string) => BundledDefinitionSite | null;
  /** Read the bundle's text and modification time. */
  readBundle?: (file: string) => Promise<{ text: string; mtimeMs: number } | null>;
  /** Stat-only probe used as the cache key, so an unchanged bundle is read once. */
  bundleMtime?: (file: string) => Promise<number | null>;
  /** When this process started (epoch ms). A bundle modified later is not the one loaded. */
  processStartedAtMs?: () => number;
  /** Existence probe for the working-directory calibration. */
  exists?: (absolute: string) => boolean;
}

/**
 * One parsed marker index per bundle file, keyed by its mtime. Indexing reads the whole
 * bundle (≈70MB for the host), so it must happen once per bundle, not once per tool: a
 * retriage pass screens up to 100 rows. Pinned per the shared-lib singleton rule.
 */
const cacheState = pinModuleState('@papercusp/operator-core.tool-source-file', () => ({
  markers: new Map<string, { mtimeMs: number; markers: Promise<BundleModuleMarkers | null> }>(),
}));

const defaultReadBundle = async (file: string) => {
  const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  return { text, mtimeMs: info.mtimeMs };
};

const defaultBundleMtime = async (file: string) => (await stat(file)).mtimeMs;

const defaultProcessStartedAtMs = () => Date.now() - process.uptime() * 1000;

/**
 * The bundler's working directory — what every marker path is relative to. It is the
 * nearest ancestor of the bundle's own directory against which tooldef's OWN marker
 * names a file that exists. Self-calibrating, so it needs no knowledge of how or where
 * the bundle was built; null when no ancestor fits (a bundle shipped without its source
 * tree, e.g. a desktop install), which is a correct unknown.
 */
export function bundlerWorkDir(
  bundleFile: string,
  selfModule: string,
  exists: (absolute: string) => boolean = existsSync,
): string | null {
  let dir = path.dirname(bundleFile);
  for (;;) {
    if (exists(path.resolve(dir, selfModule))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function markersFor(file: string, deps: ToolSourceFileDeps): Promise<BundleModuleMarkers | null> {
  const mtimeMs = await (deps.bundleMtime ?? defaultBundleMtime)(file);
  if (mtimeMs === null) return null;
  // A bundle written after this process started is not the code this process runs —
  // the bg-host rebuilds its bundle only BEFORE it starts — so its line numbers would
  // name the wrong modules. Unknown, not a guess.
  if (mtimeMs > (deps.processStartedAtMs ?? defaultProcessStartedAtMs)()) return null;
  const hit = cacheState.markers.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.markers;
  // A read that changed under us (mtime moved between stat and read) or failed is an
  // unknown for this mtime, settled to null so the cached promise never rejects.
  const markers = (deps.readBundle ?? defaultReadBundle)(file)
    .then((read) => (read && read.mtimeMs === mtimeMs ? indexBundleModuleMarkers(read.text) : null))
    .catch(() => null);
  cacheState.markers.set(file, { mtimeMs, markers });
  return markers;
}

/** Resolve a bundled definition site to the absolute path of its defining module. */
export async function resolveBundledDefinitionSite(
  site: BundledDefinitionSite,
  deps: ToolSourceFileDeps = {},
): Promise<string | null> {
  try {
    const markers = await markersFor(site.file, deps);
    if (!markers) return null;
    const modules = definingModuleOfBundledSite(markers, site);
    if (!modules) return null;
    const workDir = bundlerWorkDir(site.file, modules.selfModule, deps.exists ?? existsSync);
    return workDir ? path.resolve(workDir, modules.definingModule) : null;
  } catch {
    return null;
  }
}

/**
 * The absolute file that defined `toolName`, or null when it cannot be established.
 * The stack-captured path wins; a bundled site is resolved only when that is absent.
 */
export async function resolveToolSourceFile(
  toolName: string,
  deps: ToolSourceFileDeps = {},
): Promise<string | null> {
  const direct = (deps.sourceFileFor ?? projectedToolSourceFile)(toolName);
  if (direct) return direct;
  const site = (deps.bundledSiteFor ?? projectedToolBundledDefinitionSite)(toolName);
  return site ? resolveBundledDefinitionSite(site, deps) : null;
}

/** Test seam: drop every cached marker index. */
export function resetToolSourceFileCache(): void {
  cacheState.markers.clear();
}
