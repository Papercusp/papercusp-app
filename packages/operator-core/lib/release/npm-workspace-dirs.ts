/**
 * The npm-workspace NAME → repo-relative DIRECTORY map, derived from the root package.json's
 * `workspaces` patterns plus each workspace's own `package.json` name.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
 * A green-checkpoint signature leg names its owning workspace by PACKAGE NAME
 * (`@papercusp/operator-core`), while every path the gate ledgers — admissions, candidate
 * containment — is REPO-relative. Anything that has to join those two needs the directory, and
 * the only honest source for it is the workspace's own package.json.
 *
 * ── WHY IT IS DERIVED AND NOT HAND-WRITTEN ───────────────────────────────────────────────
 * A hand-maintained name→dir table is a second copy of something package.json already owns, so
 * it drifts the moment a workspace is added or moved (derived-truth ladder, rung 1: DERIVE).
 *
 * ── WHY basename() IS NOT A SUBSTITUTE (measured, do not "simplify" this away) ────────────
 * The tempting shortcut is to infer the directory from the package name's last segment. Measured
 * across this repo on 2026-09-22: of 105 workspaces, 98 have a name whose last segment equals
 * their directory basename and 7 do NOT — `@papercusp/web` → `apps/operator`,
 * `@papercusp/cupboard-worker` → `apps/operator-public`, `@papercusp/publish-worker` →
 * `apps/papercusp-publish`, `@papercusp/plugin-loader-core` → `libs/generic/plugin-loader`,
 * `@papercusp/publish-auth` → `libs/papercusp-publish-auth`, `@papercusp/db-org` →
 * `libs/papercusp/libs/db`, `@papercusp/omp` → `packages/omp-plugin`. `@papercusp/web` is a live
 * green-checkpoint signature leg, so the shortcut is wrong on exactly the legs the gate reports.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';

interface NpmWorkspaceDirsCache {
  /** Keyed by repo root: one operator process can serve more than one checkout. */
  byRoot: Map<string, Readonly<Record<string, string>>>;
}

// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair, so a split module record stays visible to
// listModuleDuplications() instead of reporting a confident `[]`.
const __npmWorkspaceDirs = pinModuleState<NpmWorkspaceDirsCache>(
  '@papercusp/operator-core.npmWorkspaceDirs',
  () => ({ byRoot: new Map() }),
);

/** Reset the memo between tests THROUGH the module's own seam. */
export function __resetNpmWorkspaceDirsCache(): void {
  __npmWorkspaceDirs.byRoot.clear();
}

/**
 * Expand the root package's declared workspace directories. The root patterns are either
 * concrete directories or one-level trailing `/*` globs; this mirrors the same local discovery
 * the test router does, deliberately avoiding a task runner that would execute work at import.
 */
function declaredWorkspaceDirs(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    const dirs = new Set<string>();
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern) continue;
      const normalized = pattern.replace(/\\/g, '/');
      if (normalized.endsWith('/*') && !normalized.slice(0, -2).includes('*')) {
        const base = normalized.slice(0, -2);
        try {
          for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(join(root, base, entry.name, 'package.json'))) {
              dirs.add(`${base}/${entry.name}`);
            }
          }
        } catch {
          // A declared glob base that is absent in this checkout contributes nothing.
        }
        continue;
      }
      if (!normalized.includes('*') && existsSync(join(root, normalized, 'package.json'))) {
        dirs.add(normalized);
      }
    }
    return [...dirs];
  } catch {
    return [];
  }
}

/**
 * Map every declared npm workspace's package NAME to its repo-relative directory.
 *
 * Memoized per root: the map is static for the life of a checkout, and the callers (the gate's
 * repair-queue write path) would otherwise re-read ~100 package.json files on every queue
 * change. A workspace ADDED after first call therefore does not appear until the process
 * restarts or `__resetNpmWorkspaceDirsCache()` runs — acceptable because a new workspace cannot
 * already be a leg of a frozen candidate cut before it existed.
 *
 * Returns `{}` rather than throwing when the root is unreadable: the callers degrade to
 * unresolved (workspace-relative) paths, which is what they did before this map existed.
 */
export function npmWorkspaceDirsByName(root: string): Readonly<Record<string, string>> {
  const cached = __npmWorkspaceDirs.byRoot.get(root);
  if (cached) return cached;
  const out: Record<string, string> = {};
  for (const dir of declaredWorkspaceDirs(root)) {
    try {
      const { name } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      // First declaration wins; a duplicate name is a broken tree, not something to guess at.
      if (typeof name === 'string' && name.length > 0 && !(name in out)) out[name] = dir;
    } catch {
      // A workspace whose package.json is unreadable simply does not map.
    }
  }
  const frozen = Object.freeze(out);
  __npmWorkspaceDirs.byRoot.set(root, frozen);
  return frozen;
}
