/**
 * tool-path — the ONE canonical list of directories where the user's CLI tools
 * (git, gh, kopia, claude/codex/omp, …) actually live, plus helpers to guarantee
 * they're on a spawned process's PATH.
 *
 * WHY THIS EXISTS (found 2026-06-25 via an owner Mac-VM "Papercusp setup failed"):
 * a packaged macOS GUI app is launched by launchd with a MINIMAL PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT inherit the user's shell PATH.
 * On Apple-Silicon Macs, Homebrew installs to **`/opt/homebrew/bin`**, which is
 * on NEITHER the launchd PATH nor the old hand-written lists in serve.ts /
 * terminal-spawn.ts. So the dogfood `git clone` (whose git credential helper is
 * `gh`) could not find `gh`/`git` → it failed to authenticate the private repo
 * → the wizard showed a generic "Setting up Papercusp workspace failed". Worse,
 * the DETECTION sites (preflight, agent-auth-detect) already probe
 * `/opt/homebrew/bin`, so the app reported "gh is installed" while the EXECUTION
 * PATH couldn't run it — a maddening "reauth doesn't help" loop.
 *
 * Keep every tool-dir list in the codebase sourced from STANDARD_TOOL_DIRS so
 * detection and execution can never drift apart again.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * EI-3620: the vendored macOS git bundle, relative to the sidecar bin dir.
 * build-desktop-sidecar.sh cross-vendors a relocatable git under
 * `<sidecarBin>/.git-vendor/{bin,libexec/git-core,share/git-core/templates}`
 * (mirroring WI-3314's postgres-client-tool vendoring — see the build script
 * for the full mechanism). This bottle's `git` was not built with
 * RUNTIME_PREFIX, so its compiled-in `--exec-path` is a hardcoded absolute
 * Homebrew path that doesn't exist on a clean Mac — GIT_EXEC_PATH (and
 * GIT_TEMPLATE_DIR, for `git init`/`git clone`'s default hooks/templates) must
 * be set explicitly at spawn time regardless of how the dylibs were relocated.
 */
export const GIT_VENDOR_DIRNAME = '.git-vendor';

/** Pure: compute the vendored-git env vars for a given sidecar bin dir. Callers
 *  gate on the vendor tree actually existing there (see ensureToolPathEnv). */
export function vendoredGitEnv(sidecarBin: string): { GIT_EXEC_PATH: string; GIT_TEMPLATE_DIR: string } {
  const root = join(sidecarBin, GIT_VENDOR_DIRNAME);
  return {
    GIT_EXEC_PATH: join(root, 'libexec', 'git-core'),
    GIT_TEMPLATE_DIR: join(root, 'share', 'git-core', 'templates'),
  };
}

/**
 * Standard directories user CLI tools live in, in PATH-priority order. Includes
 * BOTH Homebrew prefixes: `/opt/homebrew` (Apple Silicon) and `/usr/local`
 * (Intel macOS + common Linux), plus the system dirs and `~/.local/bin`. Dirs
 * that don't exist on a given platform are simply inert in PATH — harmless.
 */
export function standardToolDirs(platform: NodeJS.Platform = process.platform): string[] {
  // Order: Homebrew first (so a user's gh/git wins over a stale system shim),
  // then system dirs, then the user-local bin.
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    join(homedir(), '.local', 'bin'),
  ];
  // Windows manages PATH entirely differently; callers gate on platform, but be
  // defensive and return an empty list so we never inject POSIX dirs there.
  return platform === 'win32' ? [] : dirs;
}

/**
 * Compose the PATH a spawned subprocess should see: an optional bundled
 * sidecar-bin dir FIRST (so shipped binaries win), then the inherited PATH, then
 * the standard tool dirs guaranteed present. De-duplicated, first occurrence
 * wins (so we never reorder what's already there — we only APPEND what's
 * missing). Pure — no env reads — so it is trivially testable.
 */
export function composeToolPath(opts: {
  sidecarBin?: string | undefined;
  currentPath?: string | undefined;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = opts.platform ?? process.platform;
  const sep = platform === 'win32' ? ';' : ':';
  const parts = [opts.sidecarBin ?? '', opts.currentPath ?? '', ...standardToolDirs(platform)]
    .flatMap((p) => p.split(sep))
    .filter(Boolean);
  return [...new Set(parts)].join(sep);
}

/**
 * Idempotently ensure the standard tool dirs are on `process.env.PATH` for the
 * CURRENT process (and thus every child it spawns). No-op on Windows. Call once,
 * early, in any entrypoint that spawns user CLI tools. Returns the resulting PATH.
 */
export function ensureToolPathEnv(): string {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const next = composeToolPath({
    sidecarBin: process.env.PAPERCUSP_SIDECAR_BIN,
    currentPath: process.env.PATH,
  });
  process.env.PATH = next;
  // EI-3620: when the sidecar ships a vendored macOS git (bin/.git-vendor/…),
  // point every spawned child at it via env — cheaper + safer than patching
  // the ~80 individual `spawn('git', …)` call sites across the codebase, and
  // every one of them already inherits process.env unless it explicitly
  // overrides `env` with a fresh object (none currently drop GIT_* vars).
  // Never clobbers an operator/power-user's own explicit GIT_EXEC_PATH.
  if (
    process.platform === 'darwin' &&
    process.env.PAPERCUSP_SIDECAR_BIN &&
    !process.env.GIT_EXEC_PATH &&
    existsSync(join(process.env.PAPERCUSP_SIDECAR_BIN, GIT_VENDOR_DIRNAME, 'bin', 'git'))
  ) {
    const gitEnv = vendoredGitEnv(process.env.PAPERCUSP_SIDECAR_BIN);
    process.env.GIT_EXEC_PATH = gitEnv.GIT_EXEC_PATH;
    if (!process.env.GIT_TEMPLATE_DIR) process.env.GIT_TEMPLATE_DIR = gitEnv.GIT_TEMPLATE_DIR;
  }
  return next;
}
