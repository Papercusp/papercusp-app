/**
 * upstream-repo-context — where does a harness's code land upstream?
 * (hive-from-github-url-2026-06-11 P-013 / D-005 — the fork-PR context fixes.)
 *
 * The feature-passed fork-PR hook used to read ONLY `.papercusp/shared.json`,
 * silently no-opping for every URL-created harness (which has registry coords
 * but no shared.json), and hardcoded `baseBranch: 'main'` (wrong PRs for
 * `master` upstreams). This module is the repaired source chain, in order:
 *
 *   1. `.papercusp/shared.json` (the legacy per-harness share flip)
 *   2. the registry github coords (P-002 — stamped at clone/registration)
 *   3. `git remote get-url origin` parsed from the working tree
 *
 * and the default-branch chain: registry `github_default_branch` →
 * local `git symbolic-ref refs/remotes/origin/HEAD` → authoritative remote
 * `git ls-remote --symref origin HEAD` → none (caller decides the last-resort
 * fallback). Pure over injected seams.
 */

import type { ProjectEntry } from '../harness-registry';
import { parseGithubUrl } from './clone-github';

export interface UpstreamRepoSource {
  github_remote: string;
  github_repository_id?: number;
  /** Upstream default branch when KNOWN (registry or origin/HEAD) — no guess. */
  default_branch?: string;
  owner: string;
  repo: string;
  source: 'shared-config' | 'registry' | 'git-remote';
}

export interface UpstreamRepoDeps {
  loadSharedConfig?: (projectDir: string) => { github_remote: string; github_repository_id: number } | null;
  /** `git -C <path> remote get-url origin` → the url, or null. */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  /** `git -C <path> symbolic-ref --short refs/remotes/origin/HEAD` → 'origin/<branch>' or null. */
  gitOriginHead?: (repoPath: string) => Promise<string | null>;
  /** `git -C <path> ls-remote --symref origin HEAD` parsed to its branch name, or null. */
  gitRemoteHead?: (repoPath: string) => Promise<string | null>;
}

async function defaultGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['-C', repoPath, ...args], { timeout: 10_000 });
    const out = String(stdout).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the upstream repo source for a registry project. Null = this harness
 * has no known upstream (a purely local repo) — fork-PR correctly no-ops.
 */
export async function resolveUpstreamRepoSource(
  project: Pick<ProjectEntry, 'path' | 'github_remote' | 'github_repository_id' | 'github_default_branch'>,
  deps: UpstreamRepoDeps = {},
): Promise<UpstreamRepoSource | null> {
  const loadShared = deps.loadSharedConfig ?? (await import('./load-shared-config')).loadSharedConfigFromProjectDir;
  const gitRemoteUrl = deps.gitRemoteUrl ?? ((p: string) => defaultGit(p, ['remote', 'get-url', 'origin']));
  const gitOriginHead =
    deps.gitOriginHead ?? ((p: string) => defaultGit(p, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']));
  const gitRemoteHead =
    deps.gitRemoteHead ??
    (async (p: string) => {
      const out = await defaultGit(p, ['ls-remote', '--symref', 'origin', 'HEAD']);
      if (!out) return null;
      for (const line of out.split('\n')) {
        const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/.exec(line.trim());
        if (match) return match[1];
      }
      return null;
    });

  // The remote + id, by source precedence.
  let remote: string | undefined;
  let repoId: number | undefined;
  let source: UpstreamRepoSource['source'] | undefined;

  try {
    const cfg = loadShared(project.path);
    if (cfg?.github_remote) {
      remote = cfg.github_remote;
      repoId = cfg.github_repository_id;
      source = 'shared-config';
    }
  } catch {
    /* unreadable shared.json — fall through */
  }
  if (!remote && project.github_remote) {
    remote = project.github_remote;
    if (typeof project.github_repository_id === 'number') repoId = project.github_repository_id;
    source = 'registry';
  }
  if (!remote) {
    const url = await gitRemoteUrl(project.path);
    if (url) {
      remote = url;
      source = 'git-remote';
    }
  }
  if (!remote || !source) return null;
  const parsed = parseGithubUrl(remote);
  if (!parsed) return null;

  // The default branch, by source precedence: registry stamp → origin/HEAD.
  let defaultBranch: string | undefined;
  if (project.github_default_branch) {
    defaultBranch = project.github_default_branch;
  } else {
    const head = await gitOriginHead(project.path);
    if (head) {
      // 'origin/main' → 'main' (symbolic-ref --short keeps the remote prefix).
      defaultBranch = head.includes('/') ? head.slice(head.indexOf('/') + 1) : head;
    } else {
      // A valid clone does not necessarily carry refs/remotes/origin/HEAD
      // (papercup-rust-mobile was the live counterexample). Ask the remote for
      // its authoritative HEAD symref before leaving callers to guess `main`.
      defaultBranch = (await gitRemoteHead(project.path)) ?? undefined;
    }
  }

  return {
    github_remote: parsed.cloneUrl,
    ...(repoId !== undefined ? { github_repository_id: repoId } : {}),
    ...(defaultBranch ? { default_branch: defaultBranch } : {}),
    owner: parsed.owner,
    repo: parsed.repo,
    source,
  };
}

/**
 * The feature-passed GATE (P-013): does this harness's code land upstream via
 * the fork-PR flow? True for the legacy shared.json flip, and for a HIVE
 * MEMBER with registry coords (URL-created — shared via the hive). A
 * standalone private harness with registry coords stays out — opening PRs on
 * someone's repo from a private local harness must be an explicit share/flip,
 * not a side effect of feature-pass.
 */
export function upstreamGateAllows(
  project: Pick<ProjectEntry, 'harness_kind' | 'hive_slug' | 'github_remote'>,
  src: UpstreamRepoSource,
): boolean {
  if (src.source === 'shared-config') return true;
  return Boolean(project.hive_slug || project.harness_kind === 'hive');
}
