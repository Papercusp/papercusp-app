/**
 * Clone a GitHub repository for the create-harness "GitHub URL" flow
 * (papercusp-dogfood-v5 Phase 1b P-008/P-009, Entry 2 of §3).
 *
 * Design — discovered during implementation 2026-05-24:
 *
 * The original plan called for `isomorphic-git` + `@octokit/*` to do
 * OAuth-token-authenticated cloning ourselves. After grounding against
 * the existing setup-wizard (`apps/operator/app/_components/SetupWizard/
 * StepGit.tsx`) the actual established pattern is:
 *
 *   - User runs `gh auth login` (covered in StepGit; will be gated on
 *     during alpha graduation).
 *   - `gh` registers itself as a git credential helper at install
 *     (or via `gh auth setup-git`).
 *   - From then on, plain `git clone https://github.com/owner/repo`
 *     auths transparently via the credential helper — no token in
 *     our process, no OAuth flow in our code.
 *
 * This module shells out to `git clone` and lets the system handle
 * auth. Side benefits:
 *   - No new deps (isomorphic-git + @octokit/* avoided).
 *   - GitHub-CLI is the user's source of truth for "am I signed into
 *     GitHub?" — one credential, no drift.
 *   - We respect whatever credential management the user has set up,
 *     including 2FA / SSH keys / GH Enterprise / corp SSO.
 *   - Public repos clone with no auth at all (degrades gracefully).
 *
 * Security: `git clone <url> <dest>` is invoked via `execFile` (shell-less,
 * argv-quoted). The URL is validated against a strict GitHub-URL allowlist
 * regex; the destination is resolved + bounded to the workspace clones dir.
 * The auth (if any) flows through git's credential helper, never through
 * our env vars or process state.
 */

import { execFile, spawn } from 'node:child_process';
import { workspacesRoot } from '../workspace-registry';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Lazy: this server module is pulled into the operator-vite SPA bundle, where
// node:util is browser-stubbed (promisify === undefined). Calling promisify at
// module-eval would throw at import → blank page. Defer to first call; never
// invoked in the browser. (Next-removal client/server split is in progress —
// plan finish-next-removal-2026-06-01.)
const execFileP: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);

/**
 * Accepted GitHub URL shapes:
 *   - https://github.com/<owner>/<repo>
 *   - https://github.com/<owner>/<repo>.git
 *   - git@github.com:<owner>/<repo>
 *   - git@github.com:<owner>/<repo>.git
 *
 * Owner + repo segments are restricted to GitHub's actual rules:
 *   - 1-39 chars
 *   - alphanum, hyphen, underscore, dot
 *   - cannot start/end with separator (we allow it for owner since
 *     GitHub does too in practice; repo regex is strict)
 *
 * Anything else (other hosts, paths with extra segments, query strings,
 * fragments) is rejected to keep this helper exclusively for the
 * GitHub-URL create-harness flow.
 */
const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
const GITHUB_SSH_RE =
  /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  /** Normalized HTTPS URL we'll actually invoke `git clone` with. */
  cloneUrl: string;
}

export function parseGithubUrl(url: string): ParsedGithubUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let m = GITHUB_HTTPS_RE.exec(trimmed);
  if (!m) m = GITHUB_SSH_RE.exec(trimmed);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  // Final guard: catch a few owner/repo strings the broad regex would
  // accept but GitHub doesn't allow. Owner can't be all dots; repo
  // can't be just '.' or '..'.
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Default directory where cloned repos land. Workspace-scoped so each
 * workspace has its own set; never touches user's existing repos.
 *
 * The destination subdir is derived from the repo name so the user can
 * `cd` into a predictable path. If the directory already exists the
 * clone fails fast — caller decides whether to overwrite (with the
 * destructive-action gesture) or rename.
 */
export function defaultClonesDir(): string {
  return join(workspacesRoot(), 'clones');
}

export interface CloneResult {
  /** Absolute path the repo was cloned into. */
  path: string;
  /** Parsed URL parts. */
  parsed: ParsedGithubUrl;
  /**
   * The upstream's default branch, read from the fresh clone's HEAD
   * (hive-from-github-url P-002). Absent when unreadable (empty repo,
   * detached HEAD) — callers treat it as best-effort.
   */
  defaultBranch?: string;
}

/**
 * Read the default branch of a clone — `git symbolic-ref --short HEAD` in the
 * repo dir. A fresh clone's HEAD is the remote's default branch (true for
 * shallow clones too). Returns null when unreadable (detached HEAD, empty
 * repo, not a repo) — best-effort by design.
 */
export async function readCloneDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repoPath,
      timeout: 10_000,
    });
    const branch = String(stdout).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export interface CloneError {
  /** Stable error code for the create-harness UI to react on. */
  code:
    | 'invalid_url'
    | 'dest_exists'
    | 'auth_required'
    | 'not_found'
    | 'network_timeout'
    | 'git_missing'
    | 'unknown';
  /** Human-readable message, trimmed to 500 chars. */
  message: string;
}

const GIT_AUTH_HINTS = [
  /Authentication failed/i,
  /could not read Username/i,
  /terminal prompts disabled/i,
  /Permission denied \(publickey\)/i,
  /403/,
];
const GIT_NOT_FOUND_HINTS = [
  /Repository not found/i,
  /does not exist/i,
  /404/,
];
// Connection-level failures: the host was unreachable / the transfer stalled.
// These are TRANSIENT (a flaky uplink, an upstream peering blip, GitHub edge
// congestion) and — crucially — distinct from `auth_required`: re-running
// `gh auth login` cannot fix a packet-level timeout. A connection failure is
// mutually exclusive with auth (a `403`/"Authentication failed" only arrives
// AFTER a successful connect), so this check is safe to run first.
//
// EI-3548: surfaced because a transient api.github.com connect-timeout window
// rendered the setup wizard's generic "workspace setup failed" and led the
// owner to (uselessly) re-auth GitHub. The UI keys off this code to message a
// network error + auto-retry instead of implying a credential problem.
const GIT_NETWORK_HINTS = [
  /Connection timed out/i,
  /Failed to connect to/i,
  /Couldn't connect to server/i,
  /Could not resolve host/i,            // DNS hiccup — also a transient network fault
  /Network is unreachable/i,
  /Connection reset by peer/i,
  /Operation timed out/i,
  /\btimed out\b/i,                     // our own "git clone timed out after Ns" hard-timeout
  /gnutls_handshake\(\) failed/i,
  /SSL_ERROR_SYSCALL/i,
];

// git is effectively UNAVAILABLE even though a `git` file exists on PATH: on a
// fresh macOS, `/usr/bin/git` is a Command-Line-Tools STUB that, when invoked
// non-interactively, prints one of these and exits non-zero (it would otherwise
// pop a GUI "install developer tools" dialog). The build does NOT vendor git on
// macOS (build-desktop-sidecar.sh assumes "macOS ships git by default" — false
// for a CLT-less machine), so this is a real fresh-Mac setup blocker. Treat it
// as git_missing with an actionable install hint, not a cryptic "unknown".
const GIT_UNAVAILABLE_HINTS = [
  /xcode-select: note: no developer tools/i,
  /no developer tools were found/i,
  /invalid active developer path/i,
  /missing xcrun/i,
  /Command Line Tools/i,
];

/** Is this stderr the macOS CLT-stub "git isn't really installed" signal? */
export function isGitUnavailable(stderr: string): boolean {
  return GIT_UNAVAILABLE_HINTS.some((re) => re.test(stderr));
}

/** Actionable "git missing" message, platform-aware (macOS → xcode-select). */
export function gitMissingMessage(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'git is not available. On macOS, install it with `xcode-select --install` (or `brew install git`), then Retry.';
  }
  return 'git is not installed or not on PATH.';
}

export function classifyGitError(stderr: string): CloneError['code'] {
  for (const re of GIT_NETWORK_HINTS) if (re.test(stderr)) return 'network_timeout';
  for (const re of GIT_AUTH_HINTS) if (re.test(stderr)) return 'auth_required';
  for (const re of GIT_NOT_FOUND_HINTS) if (re.test(stderr)) return 'not_found';
  return 'unknown';
}

export interface CloneOpts {
  /** Override the clones dir (tests use this; default is workspace-scoped). */
  clonesDir?: string;
  /** Override the dest subdir name (default = parsed.repo). */
  destName?: string;
  /** Pass `--depth 1` for a shallow clone (faster for large repos). Default false. */
  shallow?: boolean;
  /** Hard timeout (ms) for the whole clone — protects against runaway. Default 5 min. */
  timeoutMs?: number;
  /**
   * Pin the clone to a branch OR tag via `git clone --branch <ref>` (composes
   * with `shallow` for a `--depth 1 --branch <tag>` exact-version clone — the
   * dogfood release pin). Omit to take the remote's default branch (today's
   * behavior for the create-from-URL flow).
   */
  ref?: string;
  /**
   * Receives live progress parsed from `git clone --progress` stderr — the
   * `Receiving objects: N%` (download) and `Resolving deltas: N%` phases. Callers
   * that surface a progress bar throttle these. Omitted ⇒ no progress wiring (the
   * create-from-URL flow today); behavior is otherwise identical.
   */
  onProgress?: (p: { phase: 'receiving' | 'resolving'; percent: number }) => void;
}

export interface GitCloneOutcome {
  ok: boolean;
  /** stderr (trimmed, tail-capped) on failure; '' on success. */
  message: string;
  /** True when git itself was missing (ENOENT). */
  gitMissing?: boolean;
}

/** Pure parser for one `git clone --progress` stderr segment. Exported for
 *  tests — git emits these with \r rewrites; we split then match each segment. */
export function parseGitProgressLine(
  seg: string,
): { phase: 'receiving' | 'resolving'; percent: number } | null {
  const r = /Receiving objects:\s+(\d+)%/.exec(seg);
  if (r) return { phase: 'receiving', percent: Number(r[1]) };
  const d = /Resolving deltas:\s+(\d+)%/.exec(seg);
  if (d) return { phase: 'resolving', percent: Number(d[1]) };
  return null;
}

/**
 * Run `git clone --progress`, streaming receiving/resolving percentages to
 * `onProgress`, buffering stderr (tail-capped) for error classification, with a
 * hard timeout that SIGTERM→SIGKILLs a runaway. Never rejects — resolves a
 * GitCloneOutcome the caller maps to a CloneResult/CloneError. Replaces the
 * buffered execFile so progress can stream; the classification/timeout/cleanup
 * contract is preserved.
 */
export function runGitClone(
  args: string[],
  timeoutMs: number,
  onProgress?: CloneOpts['onProgress'],
): Promise<GitCloneOutcome> {
  return new Promise((resolveOutcome) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Disable interactive prompts — the credential helper either has creds or
      // we surface auth_required immediately (never block on a password prompt).
      child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      resolveOutcome({ ok: false, message: (e as Error).message || 'git spawn failed', gitMissing: true });
      return;
    }

    let stderr = '';
    let settled = false;
    const finish = (o: GitCloneOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(o);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000);
      hard.unref?.();
      finish({ ok: false, message: `git clone timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString();
      stderr += chunk;
      // git progress is unbounded \r-rewrites; keep only the tail (the fatal
      // error line is last) so classification still works without OOM.
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
      if (!onProgress) return;
      for (const seg of chunk.split(/[\r\n]+/)) {
        const p = parseGitProgressLine(seg);
        if (p) onProgress(p);
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({ ok: false, message: e.message || 'git spawn failed', gitMissing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, message: '' });
      else finish({ ok: false, message: stderr.trim() || `git clone exited with code ${code}` });
    });
  });
}

/**
 * Clone a GitHub repo. Returns the resulting absolute path on success,
 * or a structured error on failure. Never throws for predictable
 * failures (invalid URL, dest exists, auth needed, repo missing) —
 * the create-harness route maps these to HTTP 400/401/404 cleanly.
 */
export async function cloneGithubRepo(
  url: string,
  opts: CloneOpts = {},
): Promise<CloneResult | CloneError> {
  const parsed = parseGithubUrl(url);
  if (!parsed) {
    return {
      code: 'invalid_url',
      message:
        'Not a recognized GitHub URL. Expected one of: ' +
        'https://github.com/<owner>/<repo>, ' +
        'git@github.com:<owner>/<repo>.',
    };
  }

  const clonesDir = opts.clonesDir ?? defaultClonesDir();
  const destName = (opts.destName ?? parsed.repo).replace(/\.git$/, '');
  const dest = resolve(clonesDir, destName);
  // Path-bound assertion: dest MUST live inside clonesDir. resolve()
  // strips traversal, then we string-compare to be sure.
  if (!dest.startsWith(resolve(clonesDir) + '/') && dest !== resolve(clonesDir)) {
    return {
      code: 'invalid_url',
      message: 'Resolved destination escapes the workspace clones dir',
    };
  }
  if (existsSync(dest)) {
    return {
      code: 'dest_exists',
      message: `A directory already exists at ${dest}. Move or rename it before cloning.`,
    };
  }

  await mkdir(dirname(dest), { recursive: true });

  const args = ['clone', '--progress'];
  if (opts.shallow) args.push('--depth', '1');
  if (opts.ref) args.push('--branch', opts.ref);
  args.push(parsed.cloneUrl, dest);

  const outcome = await runGitClone(args, opts.timeoutMs ?? 5 * 60 * 1000, opts.onProgress);
  if (outcome.ok) {
    const defaultBranch = await readCloneDefaultBranch(dest);
    return { path: dest, parsed, ...(defaultBranch ? { defaultBranch } : {}) };
  }

  // Clean up half-cloned dest so caller can retry.
  try { await rm(dest, { recursive: true, force: true }); } catch { /* best-effort */ }

  if (
    outcome.gitMissing ||
    /command not found|ENOENT/.test(outcome.message) ||
    isGitUnavailable(outcome.message)
  ) {
    return { code: 'git_missing', message: gitMissingMessage() };
  }
  return {
    code: classifyGitError(outcome.message),
    message: outcome.message.slice(0, 500),
  };
}

export function isCloneError(r: CloneResult | CloneError): r is CloneError {
  return 'code' in r;
}
