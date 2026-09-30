/**
 * hive-member-repos — derive a Hive's member-repo refs for the directory
 * announce, and match a repo query against discovered hives
 * (hive-from-github-url-2026-06-11 P-003; the lookup leg of P-005).
 *
 * The refs ride the announce as `member_repos` (encoded `<owner>/<repo>[#<id>]`,
 * hive-announce.ts) so a peer pasting a GitHub URL can find the Hive that
 * already wraps that repo. Derived FRESH at publish time (like `hivePubkey`)
 * from the registry's P-002 github coords, with the member's
 * `.papercusp/shared.json` as fallback — never persisted in the registry meta,
 * so member additions surface on the next publish/boot/re-register.
 *
 * IO is seam-injected (registry + shared-config loads) so the derivation
 * unit-tests without PG or a filesystem — the house inject-the-IO-seam pattern.
 */

import { loadHarnessRegistry, type HarnessRegistry } from './harness-registry';
import { loadSharedConfigFromProjectDir } from './harness/load-shared-config';
import { parseGithubUrl } from './harness/clone-github';
import {
  encodeMemberRepoRef,
  parseMemberRepoRef,
} from './sync/hyperbee/hive-announce';

export interface DeriveMemberRepoDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  loadSharedConfig?: (projectDir: string) => { github_remote: string; github_repository_id: number } | null;
}

/**
 * Encoded member-repo refs for one Hive: every member harness (the home itself
 * + every `hive_slug` member) that has a known upstream repo. Registry P-002
 * coords win; a member's shared.json is the fallback; a member with neither is
 * skipped (a local-only repo has no upstream to bind). De-duplicated by
 * owner/repo (an id-bearing ref wins over an id-less one for the same repo).
 */
export async function deriveHiveMemberRepoRefs(
  workspaceId: string | undefined,
  potHomeSlug: string,
  deps: DeriveMemberRepoDeps = {},
): Promise<string[]> {
  const loadReg = deps.loadRegistry ?? loadHarnessRegistry;
  const loadShared = deps.loadSharedConfig ?? loadSharedConfigFromProjectDir;
  const reg = await loadReg(workspaceId);
  const members = reg.projects.filter(
    (p) => p.slug === potHomeSlug || p.hive_slug === potHomeSlug,
  );
  // key = lowercased owner/repo → encoded ref; id-bearing encodings win.
  const out = new Map<string, string>();
  for (const m of members) {
    let owner: string | undefined;
    let repo: string | undefined;
    let id: number | undefined;
    if (m.github_remote) {
      const parsed = parseGithubUrl(m.github_remote);
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
      if (typeof m.github_repository_id === 'number') id = m.github_repository_id;
    }
    if (!owner || !repo) {
      try {
        const cfg = loadShared(m.path);
        if (cfg?.github_remote) {
          const parsed = parseGithubUrl(cfg.github_remote);
          if (parsed) {
            owner = parsed.owner;
            repo = parsed.repo;
            if (id === undefined && typeof cfg.github_repository_id === 'number') {
              id = cfg.github_repository_id;
            }
          }
        }
      } catch {
        /* unreadable shared.json — skip the fallback, not the member */
      }
    }
    if (!owner || !repo) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    const encoded = encodeMemberRepoRef({
      owner,
      repo,
      ...(id !== undefined ? { githubRepositoryId: id } : {}),
    });
    const prev = out.get(key);
    if (!prev || (id !== undefined && !prev.includes('#'))) out.set(key, encoded);
  }
  return [...out.values()];
}

/** A repo to look for — by immutable id (preferred) and/or owner/repo name. */
export interface RepoQuery {
  githubRepositoryId?: number;
  owner?: string;
  repo?: string;
}

/**
 * Does a hive's `memberRepos` set contain the queried repo? Ids are
 * authoritative when BOTH sides carry one (a rename can alias owner/repo);
 * otherwise a case-insensitive owner/repo match decides.
 */
export function hiveMatchesRepo(memberRepos: string[] | undefined, q: RepoQuery): boolean {
  if (!memberRepos?.length) return false;
  for (const enc of memberRepos) {
    const ref = parseMemberRepoRef(enc);
    if (!ref) continue;
    if (q.githubRepositoryId !== undefined && ref.githubRepositoryId !== undefined) {
      if (ref.githubRepositoryId === q.githubRepositoryId) return true;
      continue;
    }
    if (
      q.owner &&
      q.repo &&
      ref.owner.toLowerCase() === q.owner.toLowerCase() &&
      ref.repo.toLowerCase() === q.repo.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}
