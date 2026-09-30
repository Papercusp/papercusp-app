/**
 * revalidate-repo-coords — registry github coords survive repo renames
 * (hive-from-repo-hardening-2026-06-11 P-009).
 *
 * A `ProjectEntry` registered from a GitHub URL carries three upstream
 * coordinates (harness-registry.ts): the mutable `github_remote` HTTPS URL,
 * the IMMUTABLE numeric `github_repository_id`, and `github_default_branch`.
 * When the upstream repo is renamed on GitHub the remote URL goes stale while
 * the id stays valid — every consumer keyed on the URL (clone, fork-PR repo
 * context, member_repos derivation) then points at a redirect that GitHub may
 * eventually re-issue to someone else.
 *
 * `revalidateRepoCoords` re-fetches each coord-bearing project BY ID
 * (`GET /repositories/{repository_id}` — rename-proof) and repairs drift:
 * a changed `full_name` rewrites `github_remote` to the canonical clone URL;
 * a changed `default_branch` rewrites `github_default_branch`. All repairs
 * land in ONE `mutateHarnessRegistry` call (atomic; no lost-update race with
 * concurrent registry writers).
 *
 * Posture: best-effort hygiene, NOT a sync system.
 *   - Never throws — per-repo failures are counted, not fatal.
 *   - Unauthenticated box (getOctokit → null) → silent zero-count skip.
 *   - >MAX_COORD_ENTRIES coord-bearing entries → log + bail (a registry that
 *     big needs a real sync job, not a boot-time sweep).
 *
 * The once-per-process boot trigger (`ensureRepoCoordsRevalidatedOnce`)
 * mirrors the `ensureHiveDirectoryWired` posture in hive-directory-boot.ts:
 * module-level flag + fire-and-forget, wired from boot-all next to the
 * hive-directory boot-join — it must NEVER block or fail boot.
 */

import type { HarnessRegistry } from '../harness-registry';
import { parseGithubUrl } from './clone-github';

/** Best-effort cap: above this many coord-bearing entries we log + bail. */
export const MAX_COORD_ENTRIES = 200;

export interface RevalidateRepoCoordsCounts {
  /** Coord-bearing entries we attempted to verify (includes failures). */
  checked: number;
  /** Entries whose github_remote was repaired after an upstream rename. */
  renamed: number;
  /** Entries whose github_default_branch was repaired. */
  branchChanged: number;
  /** Per-repo API failures + (on a failed mutate) repairs that didn't land. */
  failed: number;
}

const ZERO: RevalidateRepoCoordsCounts = { checked: 0, renamed: 0, branchChanged: 0, failed: 0 };

/** The one Octokit surface this module needs — narrow so tests inject a literal. */
export interface RepoCoordsOctokit {
  request(
    route: 'GET /repositories/{repository_id}',
    params: { repository_id: number },
  ): Promise<{
    data: { full_name?: string; default_branch?: string; clone_url?: string };
  }>;
}

export interface RevalidateRepoCoordsDeps {
  /** Default: lib/identity/octokit-client getOctokit. null → silent skip. */
  getOctokit?: () => Promise<RepoCoordsOctokit | null>;
  /** Default: loadHarnessRegistry. */
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  /** Default: mutateHarnessRegistry (the atomic FOR-UPDATE read-modify-write). */
  mutateRegistry?: (
    mutator: (reg: HarnessRegistry) => HarnessRegistry,
    workspaceId?: string,
  ) => Promise<HarnessRegistry>;
}

interface CoordRepair {
  /** Guard: only applied when the entry still carries this repo id. */
  repoId: number;
  remote?: string;
  branch?: string;
}

/**
 * Verify + repair the upstream GitHub coordinates of every coord-bearing
 * registry project in `workspaceId` (default: the active workspace). Never
 * throws; returns the counts either way.
 */
export async function revalidateRepoCoords(
  workspaceId?: string,
  deps: RevalidateRepoCoordsDeps = {},
): Promise<RevalidateRepoCoordsCounts> {
  const counts: RevalidateRepoCoordsCounts = { ...ZERO };
  try {
    const getOctokit =
      deps.getOctokit ??
      (async () =>
        (await (await import('../identity/octokit-client')).getOctokit()) as RepoCoordsOctokit | null);
    const octokit = await getOctokit();
    // Unauthenticated box — no API, nothing to verify against. Silent skip.
    if (!octokit) return counts;

    const loadRegistry =
      deps.loadRegistry ?? (await import('../harness-registry')).loadHarnessRegistry;
    const reg = await loadRegistry(workspaceId);
    const coordEntries = reg.projects.filter(
      (p) => typeof p.github_repository_id === 'number' && Number.isFinite(p.github_repository_id),
    );
    if (coordEntries.length === 0) return counts;
    if (coordEntries.length > MAX_COORD_ENTRIES) {
       
      console.warn(
        `[revalidate-repo-coords] skipping: ${coordEntries.length} coord-bearing entries ` +
          `exceed the ${MAX_COORD_ENTRIES}-entry best-effort cap (this is boot hygiene, not a sync system)`,
      );
      return counts;
    }

    const repairs = new Map<string, CoordRepair>();
    for (const entry of coordEntries) {
      counts.checked += 1;
      const repoId = entry.github_repository_id as number;
      let data: { full_name?: string; default_branch?: string; clone_url?: string };
      try {
        ({ data } = await octokit.request('GET /repositories/{repository_id}', {
          repository_id: repoId,
        }));
      } catch (e) {
        counts.failed += 1;
         
        console.warn(
          `[revalidate-repo-coords] '${entry.slug}' (repo ${repoId}): fetch failed — ${e instanceof Error ? e.message : e}`,
        );
        continue;
      }
      const fullName = typeof data.full_name === 'string' ? data.full_name : null;
      if (!fullName) {
        counts.failed += 1;
        continue;
      }

      const repair: CoordRepair = { repoId };
      // Rename drift: the immutable-id fetch's full_name vs the owner/repo
      // parsed out of the stored remote (case-insensitive — GitHub treats
      // owner/repo case-insensitively and may re-case on rename).
      const parsed = entry.github_remote ? parseGithubUrl(entry.github_remote) : null;
      const storedFullName = parsed ? `${parsed.owner}/${parsed.repo}` : null;
      if (!storedFullName || storedFullName.toLowerCase() !== fullName.toLowerCase()) {
        repair.remote =
          typeof data.clone_url === 'string' && data.clone_url
            ? data.clone_url
            : `https://github.com/${fullName}.git`;
        counts.renamed += 1;
         
        console.log(
          `[revalidate-repo-coords] '${entry.slug}': upstream renamed ` +
            `${storedFullName ?? '(unparseable remote)'} → ${fullName}; repairing github_remote`,
        );
      }
      // Default-branch drift (also repaired when the entry never had one).
      if (
        typeof data.default_branch === 'string' &&
        data.default_branch &&
        data.default_branch !== entry.github_default_branch
      ) {
        repair.branch = data.default_branch;
        counts.branchChanged += 1;
      }
      if (repair.remote !== undefined || repair.branch !== undefined) {
        repairs.set(entry.slug, repair);
      }
    }

    if (repairs.size === 0) return counts;

    // ONE atomic mutate applying every repair. The mutator re-checks the repo
    // id so a concurrent re-registration of the slug to a different repo is
    // never clobbered with stale coords.
    const mutateRegistry =
      deps.mutateRegistry ?? (await import('../harness-registry')).mutateHarnessRegistry;
    try {
      await mutateRegistry(
        (cur) => ({
          ...cur,
          projects: cur.projects.map((p) => {
            const r = repairs.get(p.slug);
            if (!r || p.github_repository_id !== r.repoId) return p;
            return {
              ...p,
              ...(r.remote !== undefined ? { github_remote: r.remote } : {}),
              ...(r.branch !== undefined ? { github_default_branch: r.branch } : {}),
            };
          }),
        }),
        workspaceId,
      );
    } catch (e) {
      // The repairs didn't land — report them as failures, not successes.
      counts.failed += repairs.size;
      counts.renamed = 0;
      counts.branchChanged = 0;
       
      console.warn(
        `[revalidate-repo-coords] registry mutate failed (${repairs.size} repair(s) dropped): ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
    return counts;
  } catch (e) {
    // NEVER throws — this is boot-adjacent hygiene.
     
    console.warn(
      `[revalidate-repo-coords] sweep failed: ${e instanceof Error ? e.message : e}`,
    );
    return counts;
  }
}

// ── Once-per-process boot trigger ───────────────────────────────────────────
// The `ensureHiveDirectoryWired` posture (hive-directory-boot.ts): module-level
// flag + fire-and-forget. Called from boot-all's post-boot hygiene block; a
// repeat bootAllHarnessesForActiveWorkspace() pass (the retry path) no-ops.

let _revalidatedOnce = false;

/**
 * Fire the coord revalidation once per process, detached. Synchronous + void:
 * the caller never awaits it, and `revalidateRepoCoords` already never throws,
 * so this can NEVER block or fail boot. `workspaceId` omitted → the active
 * workspace (the registry helpers' default). `deps` is the test seam — the
 * boot site passes nothing.
 */
export function ensureRepoCoordsRevalidatedOnce(
  workspaceId?: string,
  deps?: RevalidateRepoCoordsDeps,
): void {
  if (_revalidatedOnce) return;
  _revalidatedOnce = true;
  void revalidateRepoCoords(workspaceId, deps)
    .then((c) => {
      if (c.renamed || c.branchChanged || c.failed) {
         
        console.log(
          `[revalidate-repo-coords] boot sweep: checked=${c.checked} renamed=${c.renamed} ` +
            `branchChanged=${c.branchChanged} failed=${c.failed}`,
        );
      }
    })
    .catch(() => {
      /* unreachable (revalidateRepoCoords never throws) — belt and braces */
    });
}

/** Test seam: drop the once-flag so the next ensure call re-runs. */
export function __resetRepoCoordsRevalidationForTests(): void {
  _revalidatedOnce = false;
}
