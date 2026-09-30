/**
 * Resolve the `papercusp` CLI binary the operator should spawn.
 *
 * The plugin + marketplace routes shell out to the CLI for
 * enable/disable/install/uninstall. In the packaged desktop the binary is on
 * PATH (or `PAPERCUSP_CLI` is injected). When the operator runs straight from
 * the monorepo without that linkage, bare `papercusp` fails with
 * `spawn papercusp ENOENT` — which silently breaks plugin toggles in the UI.
 *
 * Resolution order:
 *   1. `PAPERCUSP_CLI` env (the desktop's escape hatch).
 *   2. The in-repo bin (`libs/papercusp/packages/cli/bin/papercusp`), found by
 *      walking up from cwd — the Hono host runs with cwd=apps/operator, so a
 *      few levels up lands on the repo root that owns libs/.
 *   3. Bare `papercusp` (PATH) — preserves the prior behavior as a last resort.
 *
 * Memoized for the process lifetime (the binary never moves while the server
 * is alive).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_REL_BIN = join('libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp');

let cached: string | null = null;

function findRepoBin(from: string): string | null {
  let dir = resolve(from);
  // Walk up to the filesystem root, checking for the in-repo bin at each
  // ancestor. Stops at `/` (parent === dir).
  for (;;) {
    const bin = join(dir, REPO_REL_BIN);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolvePapercuspCli(): string {
  if (cached) return cached;
  const env = process.env.PAPERCUSP_CLI;
  if (env) {
    cached = env;
    return cached;
  }
  cached = findRepoBin(process.cwd()) ?? 'papercusp';
  return cached;
}

/** Test-only — reset the memoized path so a different cwd/env can be picked up. */
export function _resetPapercuspCliCache(): void {
  cached = null;
}
