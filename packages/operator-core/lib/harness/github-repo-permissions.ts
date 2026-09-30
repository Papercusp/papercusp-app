/**
 * github-repo-permissions — best-effort probe of the acting user's push
 * permission on a GitHub repo (git-sync-any-hive-2026-06-12 P-002).
 *
 * `fetchRepoPushPermission(owner, repo)` does an authenticated
 * `GET /repos/{owner}/{repo}` and returns `permissions.push ?? null`.
 * ANY failure — gh CLI missing / not authenticated, 404, network,
 * rate-limit — returns `null` (= "unknown"), NEVER throws: the caller
 * (`git-sync/decide-git-sync-push.ts`, invoked by B-01 at routine-seed
 * time) treats null as "no signal" and decides optimistically.
 *
 * Credentials are NOT resolved here — auth rides the existing
 * `lib/identity/octokit-client` `getOctokit()`, whose per-request hook
 * sources the token from `lib/identity/gh-token` (`gh auth token`,
 * in-process cache, 401 → refresh-and-retry-once). Same path as
 * binding-service / ensure-fork / revalidate-repo-coords — one
 * credential, no drift (and the same reason `clone-github.ts` shells
 * out to plain `git clone`: gh is the source of truth for GitHub auth).
 *
 * The Octokit surface is narrowed to a structural interface and the
 * client getter is injectable, so unit tests inject a literal and make
 * no live GitHub calls (same pattern as `revalidate-repo-coords.ts`).
 * The default getter lazy-imports octokit-client to stay import-safe in
 * the operator-vite SPA bundle.
 */

/** The one Octokit surface this module needs — narrow so tests inject a literal. */
export interface RepoPermissionsOctokit {
  repos: {
    get(params: { owner: string; repo: string }): Promise<{
      data: { permissions?: { push?: boolean } };
    }>;
  };
}

export interface FetchRepoPushPermissionDeps {
  /** Default: lib/identity/octokit-client getOctokit (gh-token auth). null → unauthenticated. */
  getOctokit?: () => Promise<RepoPermissionsOctokit | null>;
}

/**
 * Does the acting GitHub identity have push on `owner/repo`?
 * `true` / `false` when GitHub answers; `null` when unknown (no auth,
 * 404, network, rate-limit — any failure at all). Never throws.
 */
export async function fetchRepoPushPermission(
  owner: string,
  repo: string,
  deps: FetchRepoPushPermissionDeps = {},
): Promise<boolean | null> {
  try {
    const getOctokit =
      deps.getOctokit ??
      (async () =>
        (await (await import('../identity/octokit-client')).getOctokit()) as RepoPermissionsOctokit | null);
    const oc = await getOctokit();
    if (!oc) return null; // gh CLI missing / not authenticated — no signal
    const { data } = await oc.repos.get({ owner, repo });
    return data.permissions?.push ?? null;
  } catch {
    return null; // best-effort by design: 404 / network / rate-limit / anything
  }
}
