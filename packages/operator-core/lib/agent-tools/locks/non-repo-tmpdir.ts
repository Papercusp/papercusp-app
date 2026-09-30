/**
 * Test-support: make a temp dir GUARANTEED to have no `.git` ancestor.
 *
 * Several unit tests for the capability file tools + the file-lock guard
 * (`capability/file-tools.test.ts`, `locks/file-lock-guard.test.ts`) rely on an
 * "uncoordinated" path — one OUTSIDE any git repo — so `guardFileLock` resolves
 * zero lockable paths and runs the body WITHOUT touching identity/PG. They built
 * that path with `mkdtempSync(join(os.tmpdir(), …))`, which silently breaks when
 * the suite runner's `TMPDIR` resolves INSIDE this monorepo:
 *   - `findRepoRoot` then finds the monorepo `.git` above the temp dir → the path
 *     is treated as coordinated → `guardFileLock` calls `readIdentity`, which
 *     throws on the identity-less test ctx (EI-5826), or the lock store is hit
 *     when the test expected it skipped.
 * The shared vitest config (`libs/test-config`) already tries to dodge this by
 * forcing `TMPDIR=/tmp/pcv`, but only when `TMPDIR` is unset/non-existent — an
 * in-repo `TMPDIR` that EXISTS defeats that guard (the recurring EI-5541 class).
 *
 * This helper closes the gap at the source: it picks a temp BASE that provably
 * has no `.git` ancestor (independent of `TMPDIR`), so the test premise holds
 * regardless of how the runner configures temp.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasValidGitEntry } from './valid-git-entry';

/** Walk up from `dir` to `/` looking for a VALID `.git` entry (gitlink file OR
 *  git dir with HEAD — see valid-git-entry.ts for why bare existence is not
 *  enough). Mirrors `findRepoRoot` in file-lock-guard.ts. */
export function hasGitAncestor(dir: string): boolean {
  let d = dir;
  for (let i = 0; i < 60 && d && d !== dirname(d); i++) {
    if (hasValidGitEntry(d)) return true;
    d = dirname(d);
  }
  return false;
}

/**
 * Create a fresh temp dir whose path has NO `.git` ancestor, so the capability
 * file tools treat it as an uncoordinated (un-lockable) path. Tries `os.tmpdir()`
 * first, then falls back to repo-free OS temp roots when `tmpdir()` itself lives
 * inside a repo (the in-repo-`TMPDIR` trap). Throws if no repo-free base exists
 * (so the test fails loudly rather than silently exercising the locked path).
 */
export function mkNonRepoTmpDir(prefix: string): string {
  const candidates = [tmpdir(), '/tmp', '/var/tmp'];
  for (const base of candidates) {
    if (hasGitAncestor(base)) continue;
    try {
      return mkdtempSync(join(base, prefix));
    } catch {
      // base not writable / missing — try the next candidate.
    }
  }
  throw new Error(
    `mkNonRepoTmpDir: no repo-free, writable temp base found among ${candidates.join(', ')} — ` +
      'every candidate has a .git ancestor or is unwritable.',
  );
}
