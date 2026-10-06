import { execFile } from 'node:child_process';
import * as nodePath from 'node:path';

/** `undefined` means Git could not establish ownership; callers should fail open. */
export type GitTrackednessProbe = (
  repoRoot: string,
  repoRelativePath: string,
) => boolean | null | undefined | Promise<boolean | null | undefined>;

function runGitOutput(args: readonly string[], maxBuffer = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Ask HEAD's tree (the object store, not the index) whether `pathFromCwd` is committed.
 * `pathFromCwd` is resolved relative to `cwd`, which may be any directory inside the
 * work tree (including inside a submodule, which then answers for that submodule).
 * `undefined` means Git could not answer: no HEAD yet, not a repository, or a timeout.
 *
 * Why this exists (WI-10005009): git-sync rewrites .git/index on every sweep, and Git
 * does not verify the index checksum on ordinary reads. With the index truncated to half
 * its size, `git ls-files --error-unmatch -- <tracked path>` exits 1 with "did not match
 * any file(s) known to git", byte-for-byte the untracked answer (measured 2026-10-01,
 * git 2.43.0). HEAD's tree cannot be half-written, so it is the cross-check for any
 * index "no".
 */
export async function isCommittedAtHead(cwd: string, pathFromCwd: string): Promise<boolean | undefined> {
  try {
    const listing = await runGitOutput(
      ['-C', cwd, '--literal-pathspecs', 'ls-tree', '-z', '--name-only', 'HEAD', '--', pathFromCwd],
    );
    return listing.length > 0;
  } catch {
    return undefined;
  }
}

/**
 * Ask Git whether a path is tracked: in the index, or committed at HEAD. Status 1 from
 * the index means an ordinary untracked/ignored path ONLY when HEAD agrees; an index "no"
 * for a path HEAD contains is a torn-index read (see isCommittedAtHead) and answers true.
 * Every other failure is uncertainty and must not suppress an advisory.
 */
export async function isGitTrackedPath(repoRoot: string, repoRelativePath: string): Promise<boolean | undefined> {
  let status: unknown;
  try {
    await runGitOutput(['-C', repoRoot, 'ls-files', '--error-unmatch', '--', repoRelativePath]);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      const record = error as { status?: unknown; code?: unknown };
      status = typeof record.status === 'number' ? record.status : record.code;
    }
  }
  if (await isCommittedAtHead(repoRoot, repoRelativePath) === true) return true;
  return status === 1 ? false : undefined;
}

/** Map a path reference into one checkout, refusing external or ambiguous paths. */
export function repoRelativePathUnderRoot(reference: string, repoRoot: string): string | undefined {
  const value = reference.trim();
  if (!value || value.startsWith('~')) return undefined;
  if (value === '..' || value.startsWith('../') || value.startsWith('..\\')) return undefined;

  const root = nodePath.resolve(repoRoot);
  const absolute = nodePath.isAbsolute(value) ? nodePath.resolve(value) : nodePath.resolve(root, value);
  const relative = nodePath.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(nodePath.sep).join('/');
}
