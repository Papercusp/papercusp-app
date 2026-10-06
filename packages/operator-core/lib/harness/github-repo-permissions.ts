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

// ── P-018 (pot-review-integration-mode-2026-10-05): checkable repo facts ──────
//
// The creation-time "Where should the agents' work go?" question recommends —
// and in one case locks — an answer from facts GitHub can tell us. Same seam,
// same credential and same never-throw contract as fetchRepoPushPermission:
// every fact is `null` when it cannot be read, and each sub-probe fails alone.

/** The Octokit surface the facts probe needs — narrow so tests inject a literal. */
export interface RepoIntegrationFactsOctokit {
  repos: {
    get(params: { owner: string; repo: string }): Promise<{
      data: { permissions?: { push?: boolean }; private?: boolean; default_branch?: string };
    }>;
    getBranch(params: { owner: string; repo: string; branch: string }): Promise<{
      data: { protected?: boolean };
    }>;
    getBranchRules?(params: { owner: string; repo: string; branch: string }): Promise<{
      data: Array<{ type?: string }>;
    }>;
    listContributors(params: { owner: string; repo: string; per_page?: number }): Promise<{
      data: Array<{ login?: string; type?: string }> | unknown;
    }>;
  };
  users: {
    getAuthenticated(): Promise<{ data: { login?: string } }>;
  };
  actions: {
    listRepoWorkflows(params: { owner: string; repo: string; per_page?: number }): Promise<{
      data: { total_count?: number };
    }>;
  };
}

/** What GitHub can tell us about a repo, for the integration-mode recommendation. */
export interface RepoIntegrationFacts {
  /** The acting identity can push to the repo. */
  canWrite: boolean | null;
  isPrivate: boolean | null;
  defaultBranch: string | null;
  /** The default branch is protected or has a pull-request ruleset. */
  mainRequiresPr: boolean | null;
  /** Someone other than the acting identity has commits in the repo (bots excluded). */
  otherCommitters: boolean | null;
  /** The repo defines GitHub Actions workflows (CI / deploys). */
  hasCi: boolean | null;
}

export const UNKNOWN_REPO_INTEGRATION_FACTS: Readonly<RepoIntegrationFacts> = Object.freeze({
  canWrite: null,
  isPrivate: null,
  defaultBranch: null,
  mainRequiresPr: null,
  otherCommitters: null,
  hasCi: null,
});

export interface FetchRepoIntegrationFactsDeps {
  /** Default: lib/identity/octokit-client getOctokit (gh-token auth). null → unauthenticated. */
  getOctokit?: () => Promise<RepoIntegrationFactsOctokit | null>;
}

async function orNull<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch {
    return null;
  }
}

/**
 * Read the facts the recommendation rules use. Never throws: no auth, 404,
 * rate-limit or any other failure turns the affected fact(s) into `null`.
 */
export async function fetchRepoIntegrationFacts(
  owner: string,
  repo: string,
  deps: FetchRepoIntegrationFactsDeps = {},
): Promise<RepoIntegrationFacts> {
  const getOctokit =
    deps.getOctokit ??
    (async () =>
      (await (await import('../identity/octokit-client')).getOctokit()) as unknown as RepoIntegrationFactsOctokit | null);
  const oc = await orNull(getOctokit);
  if (!oc) return { ...UNKNOWN_REPO_INTEGRATION_FACTS };

  const meta = await orNull(async () => (await oc.repos.get({ owner, repo })).data);
  const defaultBranch = typeof meta?.default_branch === 'string' ? meta.default_branch : null;

  const [protectedBranch, rules, contributors, me, workflows] = await Promise.all([
    defaultBranch
      ? orNull(async () => (await oc.repos.getBranch({ owner, repo, branch: defaultBranch })).data.protected ?? null)
      : Promise.resolve(null),
    defaultBranch && oc.repos.getBranchRules
      ? orNull(async () => (await oc.repos.getBranchRules!({ owner, repo, branch: defaultBranch })).data)
      : Promise.resolve(null),
    orNull(async () => (await oc.repos.listContributors({ owner, repo, per_page: 30 })).data),
    orNull(async () => (await oc.users.getAuthenticated()).data.login ?? null),
    orNull(async () => (await oc.actions.listRepoWorkflows({ owner, repo, per_page: 1 })).data.total_count ?? null),
  ]);

  const hasPrRule = Array.isArray(rules) ? rules.some((r) => r?.type === 'pull_request') : null;
  let mainRequiresPr: boolean | null = null;
  if (protectedBranch === true || hasPrRule === true) mainRequiresPr = true;
  else if (protectedBranch === false) mainRequiresPr = false; // and no pull_request rule (checked above)

  let otherCommitters: boolean | null = null;
  if (Array.isArray(contributors) && typeof me === 'string' && me) {
    const humans = (contributors as Array<{ login?: string; type?: string }>).filter(
      (c) => typeof c?.login === 'string' && c.type !== 'Bot' && !c.login.endsWith('[bot]'),
    );
    otherCommitters = humans.some((c) => c.login!.toLowerCase() !== me.toLowerCase());
  }

  return {
    canWrite: typeof meta?.permissions?.push === 'boolean' ? meta.permissions.push : null,
    isPrivate: typeof meta?.private === 'boolean' ? meta.private : null,
    defaultBranch,
    mainRequiresPr,
    otherCommitters,
    hasCi: typeof workflows === 'number' ? workflows > 0 : null,
  };
}
