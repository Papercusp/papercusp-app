/**
 * hive-repo-init — make a freshly created coding-hive home a REAL, usable git repo,
 * and (by default) publish it to a private GitHub remote.
 *
 * Plan per-hive-git-and-release-gate-2026-06-29 (P-003/P-004, D-003).
 *
 * A coding hive's home is `git init`'d empty at create (init-local-dir.ts). A bare
 * init has NO commit and NO branch, and — critically — git-sync treats a repo with no
 * `self_repo` marker / no real history as ineligible, so origin freezes (the 2026-06-20
 * incident). This module finishes the job:
 *   1. commitInitialHiveRepo — stage the scaffold, make the initial commit, and put the
 *      repo on the `staging` integration branch (the branch git-sync + the green gate use).
 *   2. publishHiveRepo — DEFAULT to creating a private GitHub remote + pushing when git
 *      credentials are present (`gh auth status`), else stay local-only. The local
 *      staging→main green gate still runs with no remote; a remote can be added later via
 *      the same publishHiveRepo() (the standalone "publish to GitHub" action reuses it).
 *
 * Everything is best-effort by contract: callers MUST treat a failure as non-fatal — a
 * hive with a local-only repo is still valid. Nothing here throws into the create flow
 * when used as documented (publishHiveRepo never throws; commitInitialHiveRepo throws
 * only on a genuine git failure the caller wraps in try/catch).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Identity for the scaffold commit — a bot, never a real contributor (the real author
 *  is whoever first does feature work). Kept local so it carries no PII. */
const HIVE_BOT_NAME = 'Papercusp Hive';
const HIVE_BOT_EMAIL = 'hive@papercusp.local';

/** The integration branch a coding hive works on (git-sync pushes it; the green gate
 *  fast-forwards `main` from it). Matches the coding blueprint's releaseGate default. */
export const DEFAULT_INTEGRATION_BRANCH = 'staging';

export interface CommitInitialResult {
  /** true when this call made the initial commit; false when the repo already had
   *  history (a linked/cloned repo) or had no .git (nothing to do). */
  committed: boolean;
  /** The branch the repo is on after this call. */
  branch: string;
}

/**
 * Stage the scaffold, make the initial commit, and put a FRESH repo on `branch`
 * (default `staging`). No-op when the repo already has commits (a linked/cloned repo —
 * we must not rewrite its history or rename its branch) or has no `.git`.
 */
export async function commitInitialHiveRepo(opts: {
  path: string;
  slug: string;
  branch?: string;
}): Promise<CommitInitialResult> {
  const branch = opts.branch ?? DEFAULT_INTEGRATION_BRANCH;
  if (!existsSync(join(opts.path, '.git'))) return { committed: false, branch };

  // Already has commits? (a linked/cloned repo) → leave its history + branch untouched.
  try {
    await execFileP('git', ['-C', opts.path, 'rev-parse', '--verify', 'HEAD'], { timeout: 10_000 });
    return { committed: false, branch };
  } catch {
    /* unborn HEAD → a fresh `git init` with no commit yet; proceed. */
  }

  await execFileP('git', ['-C', opts.path, 'add', '-A'], { timeout: 30_000 });
  await execFileP(
    'git',
    [
      '-C',
      opts.path,
      '-c',
      `user.name=${HIVE_BOT_NAME}`,
      '-c',
      `user.email=${HIVE_BOT_EMAIL}`,
      'commit',
      '-m',
      `Initialize ${opts.slug} hive`,
      '--quiet',
    ],
    { timeout: 30_000 },
  );
  // Rename whatever the init default branch was (master/main, per the host's
  // init.defaultBranch) to the integration branch — robust regardless of git config.
  await execFileP('git', ['-C', opts.path, 'branch', '-M', branch], { timeout: 10_000 });
  return { committed: true, branch };
}

export interface GithubCredentials {
  authed: boolean;
  login?: string;
}

/** DI seam (EI-7163): the same shape as `execFileP` — production always defaults to it;
 *  tests inject a fake so the retry-on-partial-push-failure logic below is unit-testable
 *  without shelling out to real `gh`/network (that stays integration-only, per this
 *  file's existing convention). */
type ExecFn = typeof execFileP;

/** Is `gh` authenticated? (The existing private-member clone path proves gh + auth work
 *  on this host.) Returns the logged-in login when resolvable (the default repo owner). */
export async function detectGithubCredentials(exec: ExecFn = execFileP): Promise<GithubCredentials> {
  try {
    await exec('gh', ['auth', 'status'], { timeout: 10_000 });
  } catch {
    return { authed: false };
  }
  try {
    const { stdout } = await exec('gh', ['api', 'user', '--jq', '.login'], { timeout: 10_000 });
    const login = stdout.trim();
    return login ? { authed: true, login } : { authed: true };
  } catch {
    return { authed: true };
  }
}

export interface PublishResult {
  /** 'remote' = a GitHub remote is set (created now or already present); 'local-only' =
   *  no remote (no creds / disabled / failed). The local gate still runs either way. */
  mode: 'remote' | 'local-only';
  remote?: string;
  /** The numeric GitHub repo id (immutable) when created — matches ProjectEntry.github_repository_id. */
  repoId?: number;
  defaultBranch?: string;
  /** true only when this call created+pushed the remote. */
  pushed: boolean;
  /** machine-readable why, for local-only outcomes (no_git_credentials, no_owner_resolved,
   *  remote_already_set, gh_repo_create_failed: …, push_failed_after_remote_create: … [EI-7163]). */
  reason?: string;
  /** EI-7163: true when a same-call retry push succeeded after `gh repo create --push`'s
   *  own push leg failed (e.g. a transient network blip, or — the incident this guards —
   *  a `gh` git_protocol=ssh vs box ssh-identity mismatch). Worth logging even on success:
   *  it means the FIRST push attempt silently failed and would otherwise go unnoticed. */
  recoveredFromPushFailure?: boolean;
}

/**
 * Publish a fresh hive repo to a GitHub remote — the DEFAULT behavior when git
 * credentials are present (private repo), else a no-op local-only result. NEVER throws:
 * a failure returns mode:'local-only' with a reason, so the create flow proceeds with a
 * valid local repo. Reused by pot:create and the standalone "publish to GitHub" action.
 */
export async function publishHiveRepo(
  opts: {
    path: string;
    slug: string;
    /** gh owner/org for the new repo; default = the authenticated login. */
    owner?: string;
    /** default 'private' (D-003 — hive repos are private by default). */
    visibility?: 'private' | 'public';
    /** branch to push; default `staging`. */
    branch?: string;
    /** git remote name; default 'origin'. */
    remoteName?: string;
  },
  exec: ExecFn = execFileP,
): Promise<PublishResult> {
  const branch = opts.branch ?? DEFAULT_INTEGRATION_BRANCH;
  const visibility = opts.visibility ?? 'private';
  const remoteName = opts.remoteName ?? 'origin';

  // Already has a remote? leave it (idempotent — e.g. a re-run or a cloned repo).
  try {
    const { stdout } = await exec('git', ['-C', opts.path, 'remote', 'get-url', remoteName], {
      timeout: 10_000,
    });
    const existing = stdout.trim();
    if (existing) {
      return { mode: 'remote', remote: existing, pushed: false, reason: 'remote_already_set' };
    }
  } catch {
    /* no remote yet → proceed */
  }

  const creds = await detectGithubCredentials(exec);
  if (!creds.authed) return { mode: 'local-only', pushed: false, reason: 'no_git_credentials' };
  const owner = opts.owner ?? creds.login;
  if (!owner) return { mode: 'local-only', pushed: false, reason: 'no_owner_resolved' };

  const repoArg = `${owner}/${opts.slug}`;
  try {
    await exec(
      'gh',
      [
        'repo',
        'create',
        repoArg,
        `--${visibility}`,
        '--source',
        opts.path,
        '--remote',
        remoteName,
        '--push',
      ],
      { timeout: 120_000 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // EI-7163: `gh repo create --push` is ONE command that does TWO server-side-visible
    // things — create the repo, THEN push. When the CREATE succeeds but the PUSH leg
    // fails (observed root cause: gh's git_protocol=ssh vs a box ssh-identity mismatch —
    // now fixed at the env level, but the code must never again mask this class), `gh`
    // still exits non-zero and lands here — but a real GitHub repo now exists AND `gh`
    // has already added the local `origin` remote pointing at it (gh does --remote add
    // before attempting --push). The OLD behavior returned a generic
    // `gh_repo_create_failed`, indistinguishable from "nothing happened server-side" —
    // exactly the silent degradation this EI reports. Detect the partial success and
    // try ONE explicit push before giving up, so a transient push-only failure
    // self-heals instead of stranding an unpushed (but very real) remote repo.
    let orphanedRemote: string | undefined;
    try {
      const { stdout } = await exec('git', ['-C', opts.path, 'remote', 'get-url', remoteName], {
        timeout: 10_000,
      });
      orphanedRemote = stdout.trim() || undefined;
    } catch {
      /* repo creation itself failed before a remote was ever added — the plain old case */
    }
    if (!orphanedRemote) {
      return { mode: 'local-only', pushed: false, reason: `gh_repo_create_failed: ${msg.slice(0, 200)}` };
    }
    try {
      await exec('git', ['-C', opts.path, 'push', '-u', remoteName, branch], { timeout: 60_000 });
    } catch (pushErr) {
      const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      // A real GitHub repo + a configured local remote exist, unpushed — never let this
      // be indistinguishable from "no server-side state changed". Callers MUST log this
      // loudly (see hive/_create.ts) rather than swallow it as an ordinary local-only.
      return {
        mode: 'local-only',
        pushed: false,
        remote: orphanedRemote,
        reason: `push_failed_after_remote_create: ${pushMsg.slice(0, 200)} (original: ${msg.slice(0, 100)})`,
      };
    }
    // Retry push succeeded — recovered. Fall through to the normal success path below,
    // flagged so the caller can still surface that the first attempt silently failed.
    let repoId: number | undefined;
    try {
      const { stdout } = await exec('gh', ['api', `repos/${repoArg}`, '--jq', '.id'], { timeout: 10_000 });
      const n = Number(stdout.trim());
      repoId = Number.isFinite(n) ? n : undefined;
    } catch {
      /* id optional */
    }
    return {
      mode: 'remote',
      remote: orphanedRemote,
      ...(repoId ? { repoId } : {}),
      defaultBranch: branch,
      pushed: true,
      recoveredFromPushFailure: true,
    };
  }

  let repoId: number | undefined;
  try {
    const { stdout } = await exec('gh', ['api', `repos/${repoArg}`, '--jq', '.id'], {
      timeout: 10_000,
    });
    const n = Number(stdout.trim());
    repoId = Number.isFinite(n) ? n : undefined;
  } catch {
    /* id optional */
  }
  let remote: string | undefined;
  try {
    const { stdout } = await exec('git', ['-C', opts.path, 'remote', 'get-url', remoteName], {
      timeout: 10_000,
    });
    remote = stdout.trim() || undefined;
  } catch {
    /* remote url optional */
  }
  return {
    mode: 'remote',
    ...(remote ? { remote } : {}),
    ...(repoId ? { repoId } : {}),
    defaultBranch: branch,
    pushed: true,
  };
}
