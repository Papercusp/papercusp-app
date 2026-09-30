/**
 * git-reset-to-remote-main — the "switch to remote main" RECOVERY action
 * (dogfood-silent-canonical-hive-join P-015 / R2).
 *
 * A user who messed up their LOCAL `main` (bad commits, a broken merge, drift) clicks a
 * button to restore their checkout to the CANONICAL/public remote main. This is a
 * destructive git op — `reset --hard origin/main` discards diverged commits AND
 * uncommitted changes — so it is made fully RECOVERABLE before touching anything:
 *
 *   1. a recovery BRANCH `papercusp-backup/pre-remote-main-reset-<ts>` is force-created at
 *      the current HEAD (recover committed work via `git reset --hard <that branch>`);
 *   2. `git stash create` captures uncommitted changes into a dangling commit WITHOUT
 *      disturbing the tree (recover via `git stash apply <stashSha>`);
 *   3. only then `git fetch <remote> <branch>` + `git reset --hard <remote>/<branch>`
 *      (git also stamps ORIG_HEAD, a third recovery path).
 *
 * It runs UNDER the per-checkout `git-sync:<slug>` exclusive lock so it never races the
 * git-sync routine's fetch/merge/push; if the lock is held (git-sync mid-commit) it
 * returns `git_sync_busy` and the caller retries.
 *
 * All side effects are injectable seams (the lib DI-for-tests pattern): production
 * defaults shell `git` + take the real resource lock; tests pass fakes.
 */

/** Outcome of a reset-to-remote-main. `ok:false` carries a machine-readable `error`. */
export interface ResetToRemoteMainResult {
  ok: boolean;
  slug: string;
  path?: string;
  /** The HEAD before the reset (recoverable). */
  previousHead?: string;
  /** The HEAD after the reset (= the remote tip). */
  newHead?: string;
  /** Branch force-created at the pre-reset HEAD — recover committed work from it. */
  recoveryBranch?: string;
  /** `git stash create` sha of pre-reset uncommitted changes, or null when clean. */
  stashSha?: string | null;
  /** The remote ref reset to (e.g. "origin/main"). */
  remote?: string;
  /** Machine-readable failure: unknown_project | git_sync_busy | git_failed:<msg>. */
  error?: string;
}

export interface ResetToRemoteMainDeps {
  /** Resolve the checkout dir for a slug. Default: resolveProjectDir. */
  resolvePath?: (slug: string) => Promise<string | null>;
  /** Run a git command in `cwd`, returning stdout. THROWS on non-zero. Default: execFileSync git. */
  runGit?: (cwd: string, args: string[]) => string;
  /** Run `fn` holding the `git-sync:<slug>` exclusive lock; resolve `{ busy:true }` if a
   *  peer (the git-sync routine) holds it. Default: the real resource lock. */
  withGitSyncLock?: <T>(slug: string, fn: () => Promise<T>) => Promise<T | { busy: true }>;
  /** Monotonic-ish timestamp for the recovery-branch name. Default: Date.now. */
  now?: () => number;
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_BRANCH = 'main';

async function defaultResolvePath(slug: string): Promise<string | null> {
  const { resolveProjectDir } = await import('../spawn-config');
  return resolveProjectDir(slug);
}

function defaultRunGit(cwd: string, args: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }) as string;
}

/** Take the SAME `git-sync:<slug>` exclusive lock the git-sync routine uses (cd = the
 *  workspace id), so a reset never races an in-flight auto-commit. Best-effort release. */
async function defaultWithGitSyncLock<T>(slug: string, fn: () => Promise<T>): Promise<T | { busy: true }> {
  const [{ inWorkspaceTxn }, { tryAcquireResource, tryReleaseResource }, { registerGitSyncResource }, { activeWorkspaceId }] =
    await Promise.all([
      import('../agent-tools/locks/in-workspace-txn'),
      import('../agent-tools/locks/su-lock-store'),
      import('./git-sync/git-sync-action'),
      import('../workspace-registry'),
    ]);
  const cd = activeWorkspaceId() || '*';
  const resource = `git-sync:${slug}`;
  const OWNER = 'desktop:remote-main-reset';
  const acquired = await inWorkspaceTxn(cd, OWNER, async (tx: unknown) => {
    await registerGitSyncResource(tx as never, slug);
    return tryAcquireResource(tx as never, {
      coordinationDomain: cd,
      resource,
      mode: 'exclusive',
      owner: OWNER,
      ownerLabel: OWNER,
      reason: 'reset to remote main',
      ttlSec: 120,
    });
  });
  if (!acquired?.ok) return { busy: true };
  try {
    return await fn();
  } finally {
    try {
      await inWorkspaceTxn(cd, OWNER, async (tx: unknown) =>
        tryReleaseResource(tx as never, { coordinationDomain: cd, owner: OWNER, resource }),
      );
    } catch {
      /* best-effort release — the TTL reaps a leaked lock */
    }
  }
}

/**
 * Reset the `slug` checkout to `<remote>/<branch>` (default origin/main), snapshotting
 * first so it is fully recoverable, under the git-sync lock. Never throws.
 */
export async function resetToRemoteMain(
  opts: { slug: string; remote?: string; branch?: string },
  deps: ResetToRemoteMainDeps = {},
): Promise<ResetToRemoteMainResult> {
  const resolvePath = deps.resolvePath ?? defaultResolvePath;
  const runGit = deps.runGit ?? defaultRunGit;
  const withGitSyncLock = deps.withGitSyncLock ?? defaultWithGitSyncLock;
  const now = deps.now ?? Date.now;
  const remote = opts.remote ?? DEFAULT_REMOTE;
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const slug = opts.slug;

  const path = await resolvePath(slug).catch(() => null);
  if (!path) return { ok: false, slug, error: 'unknown_project' };

  const locked = await withGitSyncLock(slug, async (): Promise<ResetToRemoteMainResult> => {
    try {
      const previousHead = runGit(path, ['rev-parse', 'HEAD']).trim();
      // 1. recovery branch at the current HEAD (committed-work safety net).
      const recoveryBranch = `papercusp-backup/pre-remote-main-reset-${now()}`;
      runGit(path, ['branch', '-f', recoveryBranch, previousHead]);
      // 2. capture uncommitted changes non-destructively (empty when the tree is clean).
      const stashSha = runGit(path, ['stash', 'create']).trim() || null;
      // 3. fetch + hard reset to the canonical remote tip.
      runGit(path, ['fetch', remote, branch]);
      runGit(path, ['reset', '--hard', `${remote}/${branch}`]);
      const newHead = runGit(path, ['rev-parse', 'HEAD']).trim();
      return {
        ok: true,
        slug,
        path,
        previousHead,
        newHead,
        recoveryBranch,
        stashSha,
        remote: `${remote}/${branch}`,
      };
    } catch (e) {
      return { ok: false, slug, path, error: `git_failed:${(e as Error)?.message?.slice(0, 200) ?? e}` };
    }
  });

  if (locked && typeof locked === 'object' && 'busy' in locked) {
    return { ok: false, slug, path, error: 'git_sync_busy' };
  }
  return locked as ResetToRemoteMainResult;
}
