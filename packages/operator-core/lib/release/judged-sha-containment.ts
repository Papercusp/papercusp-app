/**
 * Per-path containment against the sha the gate is judging — the completion evidence a
 * gate-red claim needs ("I fixed N reds" is only true if the judged sha carries them).
 *
 * This module used to be `converge-repair-head.ts` and carried the fast-forward plan that
 * moved a frozen queue's `repairHead` to the staging tip. That plan is gone (plan
 * frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, P-002 / D-004): a fix enters the
 * judged lineage ONLY through `admitPathsOntoRepairHead` (repair-head-admission.ts), which
 * replaces exactly the named paths on top of repairHead and never reads the tip as a whole.
 * What remains here is the read side — where the integration branch is, and whether a given
 * path's content on the judged sha equals its content on that branch.
 */
import { spawnSync } from 'node:child_process';

export function integrationBranch(): string {
  return process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging';
}

export interface GitProbe {
  /** Resolve a ref to a sha, or null when it does not resolve. */
  revParse(root: string, ref: string): string | null;
  /** true / false, or null when the probe itself failed (never a guess). */
  isAncestor(root: string, ancestor: string, descendant: string): boolean | null;
  /** Blob sha of `path` at `ref`, or null when absent. */
  blobAt(root: string, ref: string, path: string): string | null;
  /** Repo-relative submodule paths, longest-first is applied by the caller. */
  submodulePaths?(root: string): string[];
  /** The gitlink pin for a submodule at a superproject ref, or null when absent/unreadable. */
  gitlinkAt?(root: string, ref: string, submodule: string): string | null;
  /** Blob sha inside a submodule commit, or null when absent/unreadable. */
  blobAtInSubmodule?(root: string, submodule: string, ref: string, path: string): string | null;
}

const run = (argv: string[], root: string) =>
  spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });

export const realGitProbe: GitProbe = {
  revParse(root, ref) {
    // `--verify --quiet` matters: a bare `git rev-parse <ref>` PRINTS the ref string to
    // stdout before exiting 128, which a naive capture stores as though it were a sha.
    const r = run(['rev-parse', '--verify', '--quiet', ref], root);
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  },
  isAncestor(root, ancestor, descendant) {
    const r = run(['merge-base', '--is-ancestor', ancestor, descendant], root);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    // Any other status (bad object, git failure) is UNKNOWN, not "false".
    return null;
  },
  blobAt(root, ref, path) {
    const r = run(['rev-parse', '--verify', '--quiet', `${ref}:${path}`], root);
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  },
  submodulePaths(root) {
    const r = run(['config', '--file', '.gitmodules', '--get-regexp', 'path'], root);
    if (r.status !== 0) return [];
    return (r.stdout ?? '')
      .split('\n')
      .map((line) => /^\S+\s+(.+)$/.exec(line.trim())?.[1]?.trim() ?? '')
      .filter((path): path is string => path.length > 0)
      .sort((a, b) => b.length - a.length);
  },
  gitlinkAt(root, ref, submodule) {
    const r = run(['ls-tree', ref, '--', submodule], root);
    const match = /^160000\s+commit\s+([0-9a-f]{40,64})\b/.exec((r.stdout ?? '').trim());
    return r.status === 0 && match ? match[1] : null;
  },
  blobAtInSubmodule(root, submodule, ref, path) {
    // `git -C root -C submodule` resolves the second -C relative to the first.
    const r = run(['-C', submodule, 'rev-parse', '--verify', '--quiet', `${ref}:${path}`], root);
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  },
};

export interface PathContainment {
  path: string;
  /** true = the judged sha carries this path's current staging content. */
  containedInJudgedSha: boolean;
  judgedBlob: string | null;
  stagingBlob: string | null;
}

function submoduleForPath(path: string, submodules: readonly string[]): string | null {
  return submodules.find((submodule) => path === submodule || path.startsWith(`${submodule}/`)) ?? null;
}

/** Resolve a superproject-relative path through its gitlink when it lives in a submodule. */
function blobAtPath(
  git: GitProbe,
  root: string,
  ref: string,
  path: string,
  submodules: readonly string[],
): string | null {
  const submodule = submoduleForPath(path, submodules);
  if (!submodule || !git.gitlinkAt || !git.blobAtInSubmodule) return git.blobAt(root, ref, path);
  const pin = git.gitlinkAt(root, ref, submodule);
  if (!pin) return null;
  return git.blobAtInSubmodule(root, submodule, pin, path.slice(submodule.length + 1));
}

/**
 * Per-path containment against the sha the gate is actually judging. Equal blobs mean the
 * judged sha already has that path's staging content.
 *
 * A path inside a submodule is resolved through the gitlink each superproject ref pins;
 * asking the superproject for `<sha>:submodule/file` returns no blob because the tree stores
 * only the gitlink. Equal nested blobs prove that PATH is current, not that the candidate is
 * otherwise current, so callers still need the surrounding candidate/ancestry evidence.
 */
export function containmentForPaths(
  paths: string[],
  judgedSha: string,
  root: string,
  git: GitProbe = realGitProbe,
  branch: string = integrationBranch(),
): PathContainment[] {
  const submodules = git.submodulePaths?.(root) ?? [];
  return paths.map((path) => {
    const judgedBlob = blobAtPath(git, root, judgedSha, path, submodules);
    const stagingBlob = blobAtPath(git, root, branch, path, submodules);
    return {
      path,
      containedInJudgedSha: judgedBlob !== null && judgedBlob === stagingBlob,
      judgedBlob,
      stagingBlob,
    };
  });
}
