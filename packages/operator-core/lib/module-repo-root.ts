/**
 * The git checkout that contains the CALLING module, correct both when the module runs from
 * source (tsx, vitest) and when it runs inlined into the esbuild host bundle
 * (`apps/operator/dist-host/hono-host.mjs`, which bg-host and the operators execute).
 *
 *     const REPO_ROOT = moduleRepoRoot(import.meta.url);
 *
 * Why not `resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')`: esbuild inlines
 * every module into ONE file, so inside the bundle `import.meta.url` is the BUNDLE's URL, not
 * the source file's. A fixed climb sized for the source location then starts from
 * `apps/operator/dist-host/` and lands above the checkout (five levels: `/home/<user>`).
 * Measured 2026-10-01 (P-016, EI-24788071071653463): dead-citation-sweep failed every run with
 * `git ls-files … fatal: not a git repository`, and the same climb made completion-claim-recheck
 * read every cited source file as missing and supervision-reconcile report its drop-in check
 * as `unavailable`, both silently. Walking up to the nearest `.git` does not depend on how deep
 * the starting directory is, so it gives the same answer from either location.
 *
 * Deliberately NOT `PAPERCUSP_INTEGRATION_ROOT`: callers include tests and scanners that must
 * read the checkout they run IN (the green-checkpoint runs them in an isolated checkout while
 * that variable names the shared tree). Callers that want the declared integration tree already
 * have `integrationRoot()`.
 *
 * `.git` may be a directory (a normal checkout) or a file (a worktree or a submodule). A module
 * inside a submodule therefore resolves to the SUBMODULE root, which is the repository that
 * contains it.
 *
 * Never throws: several callers compute this at module load, where a throw would take the whole
 * host bundle down. With no checkout above the module it returns the module's own directory, so
 * a git command run there fails loudly instead of quietly running somewhere unrelated.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleRepoRoot(
  moduleUrl: string,
  hasGitEntry: (dir: string) => boolean = (dir) => existsSync(join(dir, '.git')),
): string {
  const start = dirname(fileURLToPath(moduleUrl));
  let dir = start;
  for (;;) {
    if (hasGitEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
