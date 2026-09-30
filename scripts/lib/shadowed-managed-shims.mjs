/**
 * WI-10001537 — detect an unmanaged wrapper shadowing a managed
 * `~/.papercusp/bin` shim on PATH.
 *
 * This is the DETECTOR half. The installer heals the condition on every boot
 * (`healShadowedManagedShims` in packages/operator-core/lib/desktop-install/
 * papercusp-files.ts); this asks the question the way a user actually
 * experiences it — "what does the shell resolve `psu` to?" — so it also catches
 * causes the healer cannot fix from directory contents alone: a PATH entry we
 * do not scan, a shell profile that re-prepends a stale dir, a wrapper an
 * install script rewrites after boot.
 *
 * Asking PATH rather than re-walking directories is deliberate: it is the ONE
 * question whose wrong answer caused the incident, and it cannot drift out of
 * sync with the healer the way a second copy of the healer's own logic would.
 * A managed shim refreshed on every boot is worth exactly nothing if the shell
 * never resolves to it, and until this check existed nothing anywhere looked.
 */
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * @param {{ home?: string, binDir?: string, path?: string }} [opts]
 * @returns {{ name: string, managedPath: string, resolvedPath: string }[]}
 *   One entry per managed shim that PATH resolves somewhere OTHER than the
 *   managed copy. Empty when every shim resolves correctly, when the managed bin
 *   dir does not exist (a machine with no desktop install), or when the dir is
 *   not on PATH at all (a different, non-shadowing problem).
 */
export function findShadowedManagedShims({
  home = homedir(),
  binDir = join(home, '.papercusp', 'bin'),
  path: pathEnv = process.env.PATH ?? '',
} = {}) {
  let entries;
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch {
    return []; // no managed install here — nothing to shadow
  }

  const dirs = pathEnv.split(delimiter).filter(Boolean);
  // If the managed dir is not on this PATH at all, every shim would "resolve
  // elsewhere" and we would report the whole directory as shadowed — a wall of
  // false alarms for a different problem entirely.
  if (!dirs.some((d) => safeResolve(d) === safeResolve(binDir))) return [];

  const problems = [];
  for (const entry of entries) {
    // Only shims the installer WRITES (regular files). The entries it merely
    // links (claude, codex, bun, gh, python) point AT the user's own install by
    // design, so resolving elsewhere is correct for them, not a defect.
    if (!entry.isFile()) continue;
    const managedPath = join(binDir, entry.name);
    const resolvedPath = resolveOnPath(entry.name, dirs);
    if (!resolvedPath) continue; // not executable anywhere — not a shadowing fault
    if (safeResolve(resolvedPath) === safeResolve(managedPath)) continue;
    problems.push({ name: entry.name, managedPath, resolvedPath });
  }
  return problems;
}

function safeResolve(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function resolveOnPath(name, dirs) {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      if (!lstatSync(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here / not executable — keep looking */
    }
  }
  return null;
}

/** @param {ReturnType<typeof findShadowedManagedShims>} problems */
export function formatShadowedShimProblems(problems) {
  return problems
    .map(
      (p) =>
        `${p.name}: PATH resolves to ${p.resolvedPath}, shadowing the managed ${p.managedPath}` +
        (p.name === 'psu'
          ? ' — a psu shim without the re-exec loop turns a host hand-off into a hard death (WI-10001537)'
          : ''),
    )
    .join('; ');
}
