import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the autonomous-harness package root.
 *
 * In dev: falls back to `~/autonomous-harness` (symlinked to
 * `libs/papercusp/packages/harness/` in this repo).
 *
 * In the desktop bundle: Tauri's main.rs sets `PAPERCUSP_HARNESS_DIR`
 * to the bundled `<resource-dir>/sidecar/harness` so the orchestrator
 * finds run.sh + prompts + templates without any user setup.
 *
 * Last resort: the harness package inside THIS repo checkout. A fresh
 * clone (CI runner, new box) has neither the env nor the `~` symlink,
 * which made getKnownRoles() return nothing and fail every suite that
 * imports the MEMORY_MAP role validator (WI-123, nightly run 2). Only
 * consulted when the symlink is absent, so symlinked dev boxes are
 * unaffected.
 */
const inRepoHarnessDir = join(
  dirname(fileURLToPath(import.meta.url)), // <repo>/packages/operator-core/lib
  '..', '..', '..',
  'libs', 'papercusp', 'packages', 'harness',
);

export function harnessPackageDir(): string {
  const fromEnv = process.env.PAPERCUSP_HARNESS_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const symlinked = join(homedir(), 'autonomous-harness');
  if (existsSync(symlinked)) return symlinked;
  if (existsSync(inRepoHarnessDir)) return inRepoHarnessDir;
  return symlinked;
}

export function harnessPath(...segments: string[]): string {
  return join(harnessPackageDir(), ...segments);
}

/**
 * Absolute path to the TypeScript orchestrator entry point
 * (`@papercusp/orchestrator/bin/run.ts`). Sibling of the harness package.
 *
 * Used by spawn sites that previously invoked `bash run.sh` for the
 * full main loop. The bash run.sh remains as a function library for
 * sites that source individual helpers (e.g. invokeScoperBackground)
 * but is no longer the canonical iteration driver.
 *
 * IMPORTANT: `path.join('..')` collapses syntactically — NOT via the
 * filesystem. When harnessPackageDir() is a symlink (default dev:
 * ~/autonomous-harness → .../libs/papercusp/packages/harness), a naive
 * `join(base, '..')` walks up from the SYMLINK NAME's parent
 * (`~/orchestrator/bin/run.ts`), not the symlink target's. We resolve
 * the real path first so '..' correctly lands on `.../packages/`.
 */
export function orchestratorRunBin(): string {
  const base = harnessPackageDir();
  let real: string;
  try {
    real = realpathSync(base);
  } catch {
    // Symlink missing or path doesn't exist — fall back to the unresolved
    // path. The caller's existsSync check will surface the real problem.
    real = base;
  }
  return join(real, '..', 'orchestrator', 'bin', 'run.ts');
}

/**
 * Absolute path to the orchestrator's single-invoke entry
 * (`bin/invoke-once.ts`) — the TS replacement for the legacy
 * `source <(awk ... run.sh); invoke <role>` shell-out that the
 * scoper-background and /harness spawn route used.
 * Resolved the same symlink-safe way as orchestratorRunBin().
 */
export function invokeOnceBin(): string {
  const base = harnessPackageDir();
  let real: string;
  try {
    real = realpathSync(base);
  } catch {
    real = base;
  }
  const dir = join(real, '..', 'orchestrator', 'bin');
  // The packaged desktop ships a self-contained esbuild bundle
  // (invoke-once.mjs) so the spawn runs under plain `node` with no tsx and no
  // node_modules dep tree (build-desktop-sidecar.sh). Dev uses the .ts via tsx.
  const mjs = join(dir, 'invoke-once.mjs');
  if (existsSync(mjs)) return mjs;
  return join(dir, 'invoke-once.ts');
}

/**
 * Absolute path to the `tsx` runner used to execute the orchestrator
 * entry point. Resolved via Node's module resolution from the
 * orchestrator package so we don't depend on the project's CWD having
 * `tsx` installed (the spawn happens in the user's project dir, e.g.
 * ~/sheets-clone, which has no node_modules of its own).
 *
 * Why not `npx --no-install tsx`? npx walks up from CWD; in a user
 * project directory there is no node_modules, so it aborts with
 * `npx canceled due to missing packages and no YES option: ["tsx"]`
 * and the harness silently fails to launch.
 */
export function tsxBin(): string {
  const orch = orchestratorRunBin();
  // <pkg>/bin/run.ts → walk up to <pkg>, resolve tsx from there.
  const orchPkgDir = join(orch, '..', '..');
  const req = createRequire(join(orchPkgDir, 'package.json'));
  // tsx ships its CLI as `tsx/dist/cli.mjs` (exposed as the `tsx` bin).
  // require.resolve('tsx') returns the package main, but we need the
  // CLI entry — hop to the package.json then read `bin.tsx`.
  const tsxPkgJson = req.resolve('tsx/package.json');
  const tsxPkgDir = join(tsxPkgJson, '..');
  // tsx's package.json: "bin": { "tsx": "./dist/cli.mjs" }
  return join(tsxPkgDir, 'dist', 'cli.mjs');
}
