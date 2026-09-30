/**
 * github-facts — populate the Insights ProjectCard from real GitHub repo
 * metadata (tier-A, per v5 §17).
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 (P-073a).
 *
 * The ProjectCard has always had slots for description / owner / license /
 * languages / GitHub link, but `loadHarnessInsights` only ever filled them
 * with a slug-derived fallback. This module resolves the harness's GitHub
 * repo (via its git `origin` remote) and fetches the real facts through the
 * operator's authenticated Octokit, mapping them into the card's props. The
 * endpoint passes the result as the `project` override; everything degrades
 * to the existing fallback (no token, no remote, non-GitHub remote, API
 * error) so this never breaks the tab.
 *
 * Layering:
 *   - mapRepoFactsToProjectCard() — PURE: GitHub responses → Partial<ProjectCardProps>.
 *   - fetchGithubRepoFacts()      — one repo via an injected Octokit.
 *   - loadProjectCardFromGithub() — resolve + fetch + 1h read-through cache.
 * All collaborators are injectable, so the logic is unit-tested with no live
 * GitHub / PG / git (see github-facts.test.ts).
 *
 * Follow-up (not here): persist the cache in PG instead of in-process, and
 * surface claim-status / Discord from the binding service + harness config.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Octokit } from '@octokit/rest';
import type {
  ProjectCardProps,
  ProjectCardLanguage,
} from './card-types';
import type { ActivityFeedEvent } from './card-types';
import { getOctokit } from '../identity/octokit-client';
import { resolveProject } from '../harness-core';
import { TtlMap } from '../ttl-map';

const execFileP = promisify(execFile);

/**
 * GitHub Linguist colors for the common languages we'll actually see here.
 * Unknown languages fall back to a neutral gray. (Subset of github/linguist's
 * languages.yml — not exhaustive by design.)
 */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Dart: '#00B4AB',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  Nix: '#7e7eff',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  MDX: '#fcb32c',
  Astro: '#ff5a03',
};
const FALLBACK_LANG_COLOR = '#8b949e';

/** Subset of the GitHub `GET /repos/:owner/:repo` response we consume. */
export interface GithubRepoResponse {
  name?: string;
  description?: string | null;
  html_url?: string;
  owner?: { login?: string } | null;
  license?: { spdx_id?: string | null } | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string | null;
  /** Repo topics — included by default since the `mercy` preview graduated. */
  topics?: string[] | null;
}

/** Subset of the GitHub `GET /repos/:owner/:repo/releases/latest` response. */
export interface GithubReleaseResponse {
  tag_name?: string | null;
  name?: string | null;
  published_at?: string | null;
  html_url?: string | null;
}

/** PURE: GitHub `topics` → a cleaned, length-clamped list (max 8). */
function cleanTopics(topics: string[] | null | undefined): string[] {
  if (!Array.isArray(topics)) return [];
  return topics.filter((t) => typeof t === 'string' && t.length > 0).slice(0, 8);
}

/**
 * PURE: a `releases/latest` response → the ProjectCard `latestRelease` slot.
 * `undefined` (not the empty object) when there's no usable tag, so the
 * per-field merge leaves the card's default (null) in place.
 */
function mapLatestRelease(
  release: GithubReleaseResponse | null | undefined,
): ProjectCardProps['latestRelease'] {
  if (!release) return undefined;
  const tag = (release.tag_name || release.name || '').trim();
  if (!tag) return undefined;
  return {
    tag,
    publishedAtIso: release.published_at ?? null,
    url: release.html_url ?? null,
  };
}

function topLanguages(
  bytes: Record<string, number> | null | undefined,
  n = 3,
): ProjectCardLanguage[] {
  const entries = Object.entries(bytes ?? {}).filter(([, b]) => b > 0);
  const total = entries.reduce((sum, [, b]) => sum + b, 0);
  if (total <= 0) return [];
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, b]) => ({
      name,
      color: LANG_COLORS[name] ?? FALLBACK_LANG_COLOR,
      percent: Math.round((b / total) * 1000) / 10,
    }));
}

/**
 * PURE map: GitHub repo + languages responses → ProjectCard props.
 * Missing/garbage fields collapse to `undefined` so the per-field merge in
 * `loadHarnessInsights` falls back to the slug-derived defaults.
 */
export function mapRepoFactsToProjectCard(
  repo: GithubRepoResponse,
  languageBytes: Record<string, number> | null | undefined,
  release?: GithubReleaseResponse | null,
): Partial<ProjectCardProps> {
  const spdx = repo.license?.spdx_id;
  const license = spdx && spdx !== 'NOASSERTION' ? spdx : null;
  return {
    // Leave name/githubUrl/owner undefined when GitHub didn't give them, so
    // the loader's slug-based fallback wins instead of blanking the card.
    name: repo.name || undefined,
    description: repo.description ?? '',
    ownerDisplayName: repo.owner?.login || undefined,
    license,
    languages: topLanguages(languageBytes),
    githubUrl: repo.html_url || undefined,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
    forks: typeof repo.forks_count === 'number' ? repo.forks_count : null,
    openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : null,
    lastActivityIso: repo.pushed_at ?? null,
    topics: cleanTopics(repo.topics),
    latestRelease: mapLatestRelease(release),
  };
}

/**
 * Parse a git remote URL into {owner, name}. Handles the three shapes git
 * emits: https://github.com/o/r(.git), git@github.com:o/r.git, and ssh://.
 * Non-GitHub remotes return null.
 */
export function parseGithubRemote(raw: string): { owner: string; name: string } | null {
  const s = raw.trim();
  if (!/github\.com/i.test(s)) return null;
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/** Fetch one repo's facts through an injected Octokit. null on any error. */
export async function fetchGithubRepoFacts(
  owner: string,
  name: string,
  octokit: Octokit,
): Promise<Partial<ProjectCardProps> | null> {
  try {
    const [repoRes, langRes, relRes] = await Promise.all([
      octokit.rest.repos.get({ owner, repo: name }),
      octokit.rest.repos
        .listLanguages({ owner, repo: name })
        .catch(() => ({ data: {} as Record<string, number> })),
      // A repo with no releases 404s here — degrade to "no release" rather
      // than failing the whole fetch.
      octokit.rest.repos
        .getLatestRelease({ owner, repo: name })
        .catch(() => ({ data: null as GithubReleaseResponse | null })),
    ]);
    return mapRepoFactsToProjectCard(
      repoRes.data as GithubRepoResponse,
      langRes.data as Record<string, number>,
      relRes.data as GithubReleaseResponse | null,
    );
  } catch {
    return null;
  }
}

async function defaultResolveRepoPath(
  _workspaceId: string,
  slug: string,
): Promise<string | null> {
  // resolveProject resolves the harness within the active workspace — the
  // same context the insights endpoint runs its PG queries in. The git
  // `origin` remote is shared across phase worktrees, so any path works.
  const resolved = await resolveProject(slug);
  return resolved?.path ?? null;
}

async function defaultOwnerName(
  repoPath: string,
): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { timeout: 5000 },
    );
    return parseGithubRemote(stdout);
  } catch {
    return null;
  }
}

const TTL_MS = 60 * 60 * 1000; // 1h — mirrors the Cupboard indexer cadence.
// One entry per owner/name repo; TtlMap drops expired keys instead of
// retaining them forever (audit P-004 / EI-127/EI-79 class).
const REPO_CACHE_MAX = 1024;
const cache = new TtlMap<Partial<ProjectCardProps> | null>({
  ttlMs: TTL_MS,
  maxEntries: REPO_CACHE_MAX,
});

export interface LoadProjectCardOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test seams — runtime callers omit these. */
  octokit?: Octokit | null;
  resolveRepoPath?: (workspaceId: string, slug: string) => Promise<string | null>;
  ownerName?: (repoPath: string) => Promise<{ owner: string; name: string } | null>;
  now?: () => number;
}

/**
 * Resolve the harness's GitHub repo and return real ProjectCard facts, or
 * `undefined` to let the slug-derived fallback render. Read-through cached
 * per owner/name for 1h. Never throws.
 */
export async function loadProjectCardFromGithub(
  opts: LoadProjectCardOpts,
): Promise<Partial<ProjectCardProps> | undefined> {
  try {
    const now = (opts.now ?? Date.now)();
    const resolveRepoPath = opts.resolveRepoPath ?? defaultResolveRepoPath;
    const ownerName = opts.ownerName ?? defaultOwnerName;

    const repoPath = await resolveRepoPath(opts.workspaceId, opts.harnessSlug);
    if (!repoPath) return undefined;
    const on = await ownerName(repoPath);
    if (!on) return undefined;

    const key = `${on.owner}/${on.name}`.toLowerCase();
    const hit = cache.getEntry(key, now);
    if (hit) return hit.value ?? undefined;

    const octokit =
      opts.octokit !== undefined ? opts.octokit : await getOctokit();
    if (!octokit) return undefined; // no token — don't cache; degrade to fallback

    const facts = await fetchGithubRepoFacts(on.owner, on.name, octokit);
    cache.set(key, facts, now);
    return facts ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Contributor commit counts (tier-A) ─────────────────────────────

export interface GithubContributorEntry {
  login?: string | null;
  contributions?: number;
}

/** PURE: GitHub /contributors list → { lowercased-login: commit-count }. */
export function mapContributorsToCommitCounts(
  list: GithubContributorEntry[] | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list ?? []) {
    if (!c || typeof c.login !== 'string' || c.login.length === 0) continue;
    out[c.login.toLowerCase()] =
      typeof c.contributions === 'number' ? c.contributions : 0;
  }
  return out;
}

/** Fetch contributor commit counts for one repo via an injected Octokit. */
export async function fetchGithubContributorCommits(
  owner: string,
  name: string,
  octokit: Octokit,
): Promise<Record<string, number> | null> {
  try {
    const res = await octokit.rest.repos.listContributors({
      owner,
      repo: name,
      per_page: 100,
    });
    return mapContributorsToCommitCounts(res.data as GithubContributorEntry[]);
  } catch {
    return null;
  }
}

const commitsCache = new TtlMap<Record<string, number> | null>({
  ttlMs: TTL_MS,
  maxEntries: REPO_CACHE_MAX,
});

/**
 * Resolve the harness's GitHub repo and return per-login commit counts
 * (tier-A — verifiable via the GitHub API), keyed by lowercased login.
 * Same resolution + 1h cache + graceful degradation as the ProjectCard
 * loader. Returns undefined to leave People rows commit-count-less.
 */
export async function loadGithubContributorCommits(
  opts: LoadProjectCardOpts,
): Promise<Record<string, number> | undefined> {
  try {
    const now = (opts.now ?? Date.now)();
    const resolveRepoPath = opts.resolveRepoPath ?? defaultResolveRepoPath;
    const ownerName = opts.ownerName ?? defaultOwnerName;

    const repoPath = await resolveRepoPath(opts.workspaceId, opts.harnessSlug);
    if (!repoPath) return undefined;
    const on = await ownerName(repoPath);
    if (!on) return undefined;

    const key = `${on.owner}/${on.name}`.toLowerCase();
    const hit = commitsCache.getEntry(key, now);
    if (hit) return hit.value ?? undefined;

    const octokit =
      opts.octokit !== undefined ? opts.octokit : await getOctokit();
    if (!octokit) return undefined;

    const commits = await fetchGithubContributorCommits(on.owner, on.name, octokit);
    commitsCache.set(key, commits, now);
    return commits ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Repo README (tier-A orientation, P-004) ─────────────────────────

/**
 * PURE: decode a GitHub `GET /repos/:owner/:repo/readme` response body
 * (base64-encoded markdown) to text. null when there's nothing usable.
 */
export function decodeGithubReadme(
  data: { content?: string | null; encoding?: string | null } | null | undefined,
): string | null {
  if (!data || typeof data.content !== 'string' || data.content.length === 0) {
    return null;
  }
  try {
    const enc: BufferEncoding =
      !data.encoding || data.encoding === 'base64' ? 'base64' : 'utf8';
    const text = Buffer.from(data.content, enc).toString('utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

const readmeCache = new TtlMap<string | null>({
  ttlMs: TTL_MS,
  maxEntries: REPO_CACHE_MAX,
});

/**
 * Resolve the harness's GitHub repo and return its README markdown (tier-A —
 * straight from GitHub, the hard authority), or undefined to leave the
 * HowItWorksHere card README-less. Same resolution + 1h cache + graceful
 * degradation as loadProjectCardFromGithub. Never throws.
 */
export async function loadRepoReadme(
  opts: LoadProjectCardOpts,
): Promise<string | undefined> {
  try {
    const now = (opts.now ?? Date.now)();
    const resolveRepoPath = opts.resolveRepoPath ?? defaultResolveRepoPath;
    const ownerName = opts.ownerName ?? defaultOwnerName;

    const repoPath = await resolveRepoPath(opts.workspaceId, opts.harnessSlug);
    if (!repoPath) return undefined;
    const on = await ownerName(repoPath);
    if (!on) return undefined;

    const key = `${on.owner}/${on.name}`.toLowerCase();
    const hit = readmeCache.getEntry(key, now);
    if (hit) return hit.value ?? undefined;

    const octokit =
      opts.octokit !== undefined ? opts.octokit : await getOctokit();
    if (!octokit) return undefined;

    let md: string | null = null;
    try {
      const res = await octokit.rest.repos.getReadme({
        owner: on.owner,
        repo: on.name,
      });
      md = decodeGithubReadme(
        res.data as { content?: string; encoding?: string },
      );
    } catch {
      md = null; // 404 (no README) / API error → degrade to README-less
    }
    readmeCache.set(key, md, now);
    return md ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Merged-PR activity events (tier-A, P-003) ───────────────────────

/**
 * Subset of a GitHub `GET /repos/:owner/:repo/pulls` (or search) entry we
 * consume to build a tier-A merged-PR activity event.
 */
export interface GithubPullEntry {
  number?: number;
  title?: string | null;
  html_url?: string | null;
  /** Non-null iff the PR was actually merged (not just closed). */
  merged_at?: string | null;
  /** The merge-commit SHA — the tier-B completion anchor (Phase-2). */
  merge_commit_sha?: string | null;
  user?: { login?: string | null } | null;
}

/**
 * Stable dedupe key for a merged PR, shared by the GitHub-sourced event
 * and the PG `auto_review_audit`-sourced event so the merge collapses the
 * two into one. Keyed on PR number — the stable cross-source identity.
 */
export function prDedupKey(prNumber: number): string {
  return `pr:${prNumber}`;
}

export interface MapMergedPrsOpts {
  /** Clamp the produced events to this many (most-recent-first). */
  limit?: number;
  /** Build a click target for a PR with no html_url. Optional. */
  buildHref?: (prNumber: number) => string | null;
  /** Clock seam for the relative-time label. */
  now?: () => number;
}

/**
 * PURE: GitHub closed-PR list → tier-A `pr_merged` activity events.
 * Drops un-merged (closed-but-not-merged) PRs, sorts by merge time desc,
 * stamps `tsEpoch` (for the cross-source sort) + `dedupKey` (PR number) so
 * `loadHarnessActivity` can interleave + dedupe against the PG ledger.
 */
export function mapMergedPrsToActivityEvents(
  pulls: GithubPullEntry[] | null | undefined,
  opts: MapMergedPrsOpts = {},
): ActivityFeedEvent[] {
  const nowMs = (opts.now ?? Date.now)();
  const buildHref = opts.buildHref;
  const events: ActivityFeedEvent[] = [];
  for (const pr of pulls ?? []) {
    if (!pr || typeof pr.number !== 'number') continue;
    if (typeof pr.merged_at !== 'string' || pr.merged_at.length === 0) continue;
    const ts = new Date(pr.merged_at).getTime();
    if (Number.isNaN(ts)) continue;
    const login = pr.user?.login || 'unknown';
    const title = (pr.title || '').trim();
    const shaShort = pr.merge_commit_sha
      ? ` (${pr.merge_commit_sha.slice(0, 7)})`
      : '';
    events.push({
      id: `pr-gh-${pr.number}`,
      kind: 'pr_merged',
      text: title
        ? `merged PR #${pr.number} — ${title}${shaShort}`
        : `merged PR #${pr.number}${shaShort}`,
      actorLogin: login,
      whenLabel: relTimeLabel(nowMs - ts),
      href: pr.html_url || (buildHref ? buildHref(pr.number) : null),
      tsEpoch: ts,
      dedupKey: prDedupKey(pr.number),
    });
  }
  events.sort((a, b) => (b.tsEpoch ?? 0) - (a.tsEpoch ?? 0));
  const limit = opts.limit;
  return typeof limit === 'number' ? events.slice(0, Math.max(0, limit)) : events;
}

/**
 * Relative-time label (`3m ago`). Mirrors harness-activity/load.ts `relTime`
 * but takes an explicit age so it's testable with an injected clock.
 */
function relTimeLabel(ageMs: number): string {
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

/** Fetch the recently-merged PRs for one repo via an injected Octokit. */
export async function fetchGithubMergedPrs(
  owner: string,
  name: string,
  octokit: Octokit,
  perPage = 30,
): Promise<GithubPullEntry[] | null> {
  try {
    // Closed PRs, most-recently-updated first; the pure mapper drops the
    // closed-but-not-merged ones. (state='closed' covers merged, since a
    // merged PR is also closed.)
    const res = await octokit.rest.pulls.list({
      owner,
      repo: name,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
    });
    return res.data as GithubPullEntry[];
  } catch {
    return null;
  }
}

const mergedPrCache = new TtlMap<GithubPullEntry[] | null>({
  ttlMs: TTL_MS,
  maxEntries: REPO_CACHE_MAX,
});

export interface LoadMergedPrEventsOpts extends LoadProjectCardOpts {
  /** Clamp the produced events. Default 20 (the card's cap). */
  limit?: number;
  /** Build a click target for a PR with no html_url. Optional. */
  buildHref?: (prNumber: number) => string | null;
}

/**
 * Resolve the harness's GitHub repo and return its recently-merged PRs as
 * tier-A `pr_merged` activity events (verifiable via the GitHub API), or
 * `undefined` to leave the feed GitHub-event-less. Same resolution + 1h
 * cache + graceful degradation as the sibling loaders. Never throws.
 *
 * The endpoint passes the result into `loadHarnessActivity({ githubEvents })`,
 * which interleaves them with the PG ledger by `tsEpoch` and dedupes by
 * `dedupKey` (PR number) so a PR seen in both sources renders once.
 */
export async function loadGithubMergedPrEvents(
  opts: LoadMergedPrEventsOpts,
): Promise<ActivityFeedEvent[] | undefined> {
  try {
    const now = (opts.now ?? Date.now)();
    const resolveRepoPath = opts.resolveRepoPath ?? defaultResolveRepoPath;
    const ownerName = opts.ownerName ?? defaultOwnerName;

    const repoPath = await resolveRepoPath(opts.workspaceId, opts.harnessSlug);
    if (!repoPath) return undefined;
    const on = await ownerName(repoPath);
    if (!on) return undefined;

    const key = `${on.owner}/${on.name}`.toLowerCase();
    let pulls: GithubPullEntry[] | null;
    const hit = mergedPrCache.getEntry(key, now);
    if (hit) {
      pulls = hit.value;
    } else {
      const octokit =
        opts.octokit !== undefined ? opts.octokit : await getOctokit();
      if (!octokit) return undefined; // no token — degrade to PG-only feed
      pulls = await fetchGithubMergedPrs(on.owner, on.name, octokit);
      mergedPrCache.set(key, pulls, now);
    }

    if (!pulls) return undefined;
    const events = mapMergedPrsToActivityEvents(pulls, {
      limit: opts.limit ?? 20,
      buildHref: opts.buildHref,
      now: () => now,
    });
    return events.length > 0 ? events : undefined;
  } catch {
    return undefined;
  }
}

/** Test-only: clear the module caches between cases. */
export function _clearGithubFactsCacheForTests(): void {
  cache.clear();
  commitsCache.clear();
  readmeCache.clear();
  mergedPrCache.clear();
}
