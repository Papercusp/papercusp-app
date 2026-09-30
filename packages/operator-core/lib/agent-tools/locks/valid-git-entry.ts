/**
 * Shared validity check for the `.git` ENTRY found by repo-root walks.
 *
 * A `.git` entry only marks a repo root when it is VALID:
 *   - a FILE — a submodule / linked-worktree gitlink (`gitdir: …`), or
 *   - a DIRECTORY containing `HEAD` — every real git dir has one (`git init`
 *     creates it); git itself refuses to treat a HEAD-less dir as a repo.
 *
 * WHY (2026-07-13 incident, WI-4722): a stray EMPTY `/tmp/.git` (an accidental
 * `mkdir .git` with cwd=/tmp by some process on the shared box) made every
 * naive `existsSync(join(d, '.git'))` walk treat `/tmp` as a repo root. That
 * red-pinned the release gate (locks/coordination-domain.test.ts +
 * locks/non-repo-tmpdir.test.ts) and — worse — would have collapsed the lock
 * coordination domain of every non-repo tmpdir path to `/tmp`, de-serializing
 * unrelated edits. Any process can drop an empty `.git` anywhere, so the walks
 * must not trust bare existence. The PreToolUse hook's `find_repo_root`
 * (apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh) applies the
 * SAME check — keep them in sync (the file-lock-guard parity contract).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** True when `dir` contains a VALID `.git` entry (gitlink file, or git dir with HEAD). */
export function hasValidGitEntry(dir: string): boolean {
  const entry = join(dir, '.git');
  let st;
  try {
    st = statSync(entry);
  } catch {
    return false; // no .git entry at all
  }
  if (st.isFile()) return true; // submodule / worktree gitlink ("gitdir: …")
  if (st.isDirectory()) return existsSync(join(entry, 'HEAD')); // real git dir ⇒ HEAD exists
  return false;
}
