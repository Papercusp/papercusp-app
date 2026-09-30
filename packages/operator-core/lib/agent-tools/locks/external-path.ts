/**
 * Deterministic lock keys for authorized files outside a repository.
 *
 * The lock store intentionally accepts only relative POSIX keys. Home-directory
 * configuration and the current user's XDG runtime directory are still shared
 * mutable state, though, and previously bypassed coordination entirely. Map
 * absolute paths under either root to reserved logical keys; managed Papercusp
 * repositories are the deliberate exception and resolve to their physical
 * repository domain + repo-relative path before this fallback runs.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hasValidGitEntry } from './valid-git-entry';

export const EXTERNAL_HOME_LOCK_PREFIX = '@external/home';
export const EXTERNAL_RUNTIME_LOCK_PREFIX = '@external/runtime';
export const EXTERNAL_LOCK_PREFIXES = [
  EXTERNAL_HOME_LOCK_PREFIX,
  EXTERNAL_RUNTIME_LOCK_PREFIX,
] as const;

export interface ExternalPathRoots {
  home?: string;
  /** `null` disables runtime mapping for compatibility helpers/tests. */
  runtimeDir?: string | null;
}

/**
 * The canonical lock identity for an absolute path supplied through
 * `external_paths`. Repository files use the same `(coordination_domain,
 * repo-relative path)` pair as the native edit hooks; non-repository files use
 * the reserved external keyspace and the caller's default domain.
 */
export interface ExternalLockPathIdentity {
  path: string;
  /** Present when the absolute path resolves inside a managed repository. */
  coordinationDomain?: string;
}

function defaultRuntimeDir(): string | undefined {
  const configured = process.env.XDG_RUNTIME_DIR?.trim();
  if (configured) return configured;
  if (process.platform !== 'linux') return undefined;
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/run/user/${uid}`;
}

function relativeFile(root: string | null | undefined, absolute: string): string | undefined {
  if (!root || !isAbsolute(root)) return undefined;
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/** Resolve a path through existing symlink components without requiring its leaf to exist. */
function physicalPath(input: string): string {
  const absolute = resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** Find the nearest valid repository root, mirroring the edit-hook walk. */
function findRepoRoot(input: string): string | undefined {
  let dir = input;
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  for (let depth = 0; depth < 40 && dir !== dirname(dir); depth += 1) {
    if (hasValidGitEntry(dir)) {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

function pathIsWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

/** The canonical Papercusp staging tree used by the automatic edit hook. */
function canonicalTreeRoot(): string {
  const workspaceRoot =
    process.env.PAPERCUSP_WORKSPACE_ROOT?.trim() || join(homedir(), 'papercupai-workspace');
  const candidate = process.env.PAPERCUSP_CANONICAL_TREE?.trim() || join(workspaceRoot, 'papercusp');
  try {
    return realpathSync(candidate);
  } catch {
    return resolve(candidate);
  }
}

/**
 * Keep this predicate in lockstep with the cc/OMP hooks: only the canonical
 * Papercusp tree (including its nested repositories) and managed suite-app
 * checkouts are repository-domain lock roots. An unrelated git repository in
 * HOME must remain an ordinary external file, as it is for the hooks.
 */
function isManagedRepositoryRoot(repoRoot: string): boolean {
  const canonical = canonicalTreeRoot();
  if (pathIsWithin(repoRoot, canonical)) {
    // Isolation worktrees intentionally bypass automatic locking.
    return !pathIsWithin(repoRoot, join(canonical, '.papercusp', 'worktrees'));
  }

  const rawWorkspacesRoot =
    process.env.PAPERCUSP_WORKSPACES_ROOT?.trim() || join(homedir(), '.papercusp-workspaces');
  let workspacesRoot: string;
  try {
    workspacesRoot = realpathSync(rawWorkspacesRoot);
  } catch {
    workspacesRoot = resolve(rawWorkspacesRoot);
  }
  const parts = relative(workspacesRoot, repoRoot).split(sep);
  return (
    parts.length === 4 &&
    !['', '.', '..'].includes(parts[0] ?? '') &&
    parts[1] === '.papercusp' &&
    parts[2] === 'apps' &&
    !['', '.', '..'].includes(parts[3] ?? '') &&
    hasValidGitEntry(repoRoot)
  );
}

/**
 * Resolve an absolute path to the repository-domain identity used by hooks.
 * Returns undefined for an ordinary home/runtime file or an unmanaged repo.
 */
export function managedRepositoryPathToLockIdentity(input: string): ExternalLockPathIdentity | undefined {
  if (!isAbsolute(input)) {
    throw new Error(`external path must be absolute (received ${JSON.stringify(input)})`);
  }
  if (input.includes('\u0000')) throw new Error('external path contains a NUL byte');

  const absolute = physicalPath(input);
  const repoRoot = findRepoRoot(absolute);
  if (!repoRoot || !isManagedRepositoryRoot(repoRoot)) return undefined;

  const repoRelative = relative(repoRoot, absolute);
  if (!repoRelative || repoRelative === '..' || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
    return undefined;
  }
  return {
    coordinationDomain: repoRoot,
    path: repoRelative.split(sep).join('/'),
  };
}

/**
 * Resolve the one canonical identity shared by `locks:acquire`, `locks:queue`,
 * and the native edit hooks. A managed repository file MUST NOT fall through to
 * `@external/home/*`, because that creates a second key for the same bytes.
 */
export function resolveExternalPathLockIdentity(
  input: string,
  roots: ExternalPathRoots = {},
): ExternalLockPathIdentity {
  return managedRepositoryPathToLockIdentity(input) ?? { path: externalPathToLockKey(input, roots) };
}

/**
 * Map an absolute path below the current user's XDG runtime directory or home
 * directory to the lock namespace shared with the client edit hooks.
 *
 * The runtime root is checked first so a test/runtime directory nested below
 * HOME still gets the more precise `@external/runtime/*` namespace.
 */
export function externalPathToLockKey(
  input: string,
  roots: ExternalPathRoots = {},
): string {
  if (!isAbsolute(input)) {
    throw new Error(`external path must be absolute (received ${JSON.stringify(input)})`);
  }
  if (input.includes('\u0000')) throw new Error('external path contains a NUL byte');
  const absolute = resolve(input);

  const runtimeRoot = roots.runtimeDir === undefined ? defaultRuntimeDir() : roots.runtimeDir;
  const runtimeRel = relativeFile(runtimeRoot, absolute);
  if (runtimeRel) {
    return `${EXTERNAL_RUNTIME_LOCK_PREFIX}/${runtimeRel.split(sep).join('/')}`;
  }

  const homeRoot = resolve(roots.home ?? homedir());
  const homeRel = relativeFile(homeRoot, absolute);
  if (homeRel) {
    return `${EXTERNAL_HOME_LOCK_PREFIX}/${homeRel.split(sep).join('/')}`;
  }

  throw new Error(
    `external path must name a file below the current user's XDG runtime directory or home (${homeRoot})`,
  );
}

/**
 * Backward-compatible home-only helper for callers/tests that intentionally
 * model the pre-runtime namespace. New lock surfaces should use
 * `externalPathToLockKey` so acquire and queue share runtime parity.
 */
export function externalHomePathToLockKey(input: string, home = homedir()): string {
  return externalPathToLockKey(input, { home, runtimeDir: null });
}

export function isExternalLockKey(path: string): boolean {
  return EXTERNAL_LOCK_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
