/**
 * self-describing-store — the shared READ core of the local content stores
 * (template-store.ts, rubric-store.ts). Extracted per su-bbf8a's Q2 consult answer
 * on local-first-party-rubric-bundling-2026-07-07: the read half (env → dev-fallback
 * resolution, layered bundled/user roots, self-describing-dir enumeration with
 * user-shadows-bundled dedupe) is domain-free and was the fiddly part — share it;
 * the WRITE halves (templates: overlay into an app dir; rubrics: seed into plan
 * rows) are deliberately NOT generalized.
 *
 * Kind-parameterized by a small config + an injected per-dir reader: a store is
 * `{ envVar, devFallbackDir, userSubdir }` plus a `readDir(dir, ref, layer)` that
 * parses one self-describing subdir (listing.json + the kind's manifest) into the
 * kind's own type — or null to skip a non-store dir. Extraction is ADDITIVE: both
 * stores keep their public APIs byte-compatible. (Candidate for a later lift to a
 * generic lib if a third kind appears.)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { papercuspPath } from '../papercusp-root';

/** One resolved store root. Later roots shadow earlier ones on a ref collision. */
export interface SelfDescribingRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

export interface SelfDescribingRootsConfig {
  /** Env var naming the bundled (read-only) dir in a packaged install. */
  envVar: string;
  /** In-repo fallback for the bundled layer when the env var is unset (dev). */
  devFallbackDir: string;
  /** <papercuspRoot> subdir of the writable user layer (the v2 install target). */
  userSubdir: string;
}

/** The bundled (read-only) dir: env override → in-repo dev fallback. */
export function bundledDirFromEnv(envVar: string, devFallbackDir: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return devFallbackDir;
}

/** The monorepo root = the nearest ancestor carrying BOTH a package.json and a
 *  `packages/` dir. Stable across the source layout AND an esbuild bundle (the
 *  parent workspace dir has neither, so the walk stops exactly at the repo root). */
function isMonorepoRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'));
}

function walkUpToRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 24; i += 1) {
    if (isMonorepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve the in-repo dev-fallback dir (`<repoRoot>/<subdir>`) for a bundled content
 * layer, ROBUST to the calling module having been esbuild-bundled.
 *
 * The old approach hard-coded the number of `..` from `import.meta.url` (e.g.
 * `../../../../templates` from `packages/operator-core/lib/cupboard/`). That silently
 * breaks under bundling: the staging/bg host boots from `apps/operator/dist-host/
 * hono-host.mjs` (one directory SHALLOWER than the source `lib/cupboard/`), so a fixed
 * `..×4` overshoots the repo root by one level and lands on a non-existent
 * `<workspace>/templates` — the store enumerated an absent dir and returned count:0
 * (`:3170` bundled staging host, WI-3398 2026-07-08; rubric-store shared the bug).
 *
 * Instead, WALK UP to the monorepo root (the nearest ancestor with package.json +
 * packages/) from the caller's own module dir — always inside the repo whether the
 * module is running as source OR bundled — then from cwd as a fallback, then append
 * `<subdir>`. `existsSync` downstream treats a still-missing dir as an empty layer.
 */
export function inRepoFallbackDir(subdir: string, moduleUrl: string): string {
  const root =
    walkUpToRepoRoot(dirname(fileURLToPath(moduleUrl))) ?? walkUpToRepoRoot(process.cwd());
  return join(root ?? process.cwd(), subdir);
}

/**
 * The layered roots, in RESOLUTION order — later layers shadow earlier ones on a
 * ref collision, so the writable user layer wins over the bundled first-party set.
 */
export function selfDescribingRoots(cfg: SelfDescribingRootsConfig): SelfDescribingRoot[] {
  return [
    { dir: bundledDirFromEnv(cfg.envVar, cfg.devFallbackDir), layer: 'bundled' },
    { dir: papercuspPath(cfg.userSubdir), layer: 'user' },
  ];
}

/**
 * Enumerate every self-describing subdir across the layered roots. A user-layer
 * ref shadows a bundled one. Non-dir entries (README.md) and dirs the reader
 * rejects (no manifest) are skipped. Sorted by ref for stable output.
 */
/**
 * A later-layer entry met an earlier-layer entry on the same ref. Recorded
 * whether or not the shadow was allowed, so a caller can SHOW it — silent
 * shadowing is what let a half-written user-layer dir replace an official
 * template with a nameless one (WI-37781).
 */
export interface ShadowEvent {
  ref: string;
  /** The layer that supplied the entry now in effect. */
  winnerLayer: 'bundled' | 'user';
  /** The layer whose entry was (or would have been) replaced. */
  shadowedLayer: 'bundled' | 'user';
  /** true when the shadow was REFUSED and the earlier entry was kept. */
  refused: boolean;
  reason?: string;
}

export interface EnumerateOptions<T> {
  /**
   * Decide whether `next` (a later, higher-precedence layer) may replace
   * `prev`. Default: always allow — the historical blind-overwrite behaviour.
   */
  mayShadow?: (next: T, prev: T, ref: string) => { allow: boolean; reason?: string };
  /** Called for every ref collision, allowed or refused. */
  onShadow?: (event: ShadowEvent) => void;
}

export function enumerateSelfDescribingDirs<T>(
  roots: SelfDescribingRoot[],
  readDir: (dir: string, ref: string, layer: 'bundled' | 'user') => T | null,
  opts: EnumerateOptions<T> = {},
): T[] {
  const byRef = new Map<string, T>();
  const layerByRef = new Map<string, 'bundled' | 'user'>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const ref of entries) {
      const dir = join(root.dir, ref);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const entry = readDir(dir, ref, root.layer);
      if (!entry) continue;

      const prev = byRef.get(ref);
      if (prev === undefined) {
        byRef.set(ref, entry);
        layerByRef.set(ref, root.layer);
        continue;
      }

      // A ref collision across layers: later root (user) normally overwrites
      // earlier (bundled) — but the policy may refuse, and either way it is
      // reported rather than happening silently.
      const prevLayer = layerByRef.get(ref) ?? 'bundled';
      const verdict = opts.mayShadow?.(entry, prev, ref) ?? { allow: true };
      if (verdict.allow) {
        byRef.set(ref, entry);
        layerByRef.set(ref, root.layer);
      }
      opts.onShadow?.({
        ref,
        winnerLayer: verdict.allow ? root.layer : prevLayer,
        shadowedLayer: verdict.allow ? prevLayer : root.layer,
        refused: !verdict.allow,
        reason: verdict.reason,
      });
    }
  }
  return [...byRef.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
