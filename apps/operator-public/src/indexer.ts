/**
 * Cupboard stats indexer — Phase 9 P-076.
 *
 * Plan: papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.
 * v5 addendum 3: Cupboard cards display only tier-A stats (verifiable
 * via GitHub API), never HYPERBEE-claimed numbers (queue depth,
 * working count). This indexer runs hourly to refresh those tier-A
 * fields on each listed harness:
 *
 *   - stars (from gh /repos response)
 *   - contributor_count (from gh /repos/.../contributors HEAD link)
 *   - last_activity_at (from gh /repos response `pushed_at`)
 *   - languages (from gh /repos/.../languages)
 *
 * Refusal modes:
 *   - rate-limited (429 / X-RateLimit-Remaining=0) → record + skip
 *   - 404 (repo deleted/private) → auto-unlist with reason='by_indexer'
 *   - generic 5xx → record + continue to next harness
 *
 * The indexer runs unauthenticated (Cupboard server has no GitHub
 * app credentials yet); rate limits are tighter (60/hr) so we cap
 * the batch at INDEXER_BATCH_SIZE per cron tick.
 */

import type { Env } from './env';
import {
  audit,
  clearHarnessAttestation,
  listHarnesses,
  markHarnessUnlisted,
  updateHarnessStats,
  type HarnessRow,
} from './db';

const GH_API = 'https://api.github.com';

interface GhRepoInfo {
  stars: number;
  last_activity_at: number | null;
  not_found: boolean;
  rate_limited: boolean;
  error_status: number | null;
}

interface GhLanguagesInfo {
  languages: Record<string, number> | null;
  not_found: boolean;
  rate_limited: boolean;
}

interface GhContributorCount {
  count: number | null;
  rate_limited: boolean;
}

interface FetchFn {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * GET /repos/:owner/:repo — base stats. unauthenticated; relies on
 * GitHub's public-repo allowance.
 */
export async function fetchGhRepo(
  owner: string, repo: string, fetchImpl: FetchFn = fetch,
): Promise<GhRepoInfo> {
  const url = `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'papercusp-cupboard-indexer' },
    });
  } catch {
    return { stars: 0, last_activity_at: null, not_found: false, rate_limited: false, error_status: -1 };
  }
  if (res.status === 404) {
    return { stars: 0, last_activity_at: null, not_found: true, rate_limited: false, error_status: 404 };
  }
  if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
    return { stars: 0, last_activity_at: null, not_found: false, rate_limited: true, error_status: res.status };
  }
  if (!res.ok) {
    return { stars: 0, last_activity_at: null, not_found: false, rate_limited: false, error_status: res.status };
  }
  const body = (await res.json()) as { stargazers_count?: number; pushed_at?: string };
  return {
    stars: typeof body.stargazers_count === 'number' ? body.stargazers_count : 0,
    last_activity_at: body.pushed_at ? Date.parse(body.pushed_at) : null,
    not_found: false,
    rate_limited: false,
    error_status: null,
  };
}

/**
 * GET /repos/:owner/:repo/languages → {Language: bytes}
 */
export async function fetchGhLanguages(
  owner: string, repo: string, fetchImpl: FetchFn = fetch,
): Promise<GhLanguagesInfo> {
  const url = `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'papercusp-cupboard-indexer' },
    });
  } catch {
    return { languages: null, not_found: false, rate_limited: false };
  }
  if (res.status === 404) return { languages: null, not_found: true, rate_limited: false };
  if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
    return { languages: null, not_found: false, rate_limited: true };
  }
  if (!res.ok) return { languages: null, not_found: false, rate_limited: false };
  const body = (await res.json()) as Record<string, number>;
  return { languages: body, not_found: false, rate_limited: false };
}

/**
 * Approximate contributor count by HEAD-ing the contributors endpoint
 * and parsing the Link: rel="last" pagination header's page count.
 * Cheaper than fetching the full list. Returns null when the count
 * can't be cheaply established.
 */
export async function fetchGhContributorCount(
  owner: string, repo: string, fetchImpl: FetchFn = fetch,
): Promise<GhContributorCount> {
  const url = `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors?per_page=1&anon=true`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'HEAD',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'papercusp-cupboard-indexer' },
    });
  } catch {
    return { count: null, rate_limited: false };
  }
  if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
    return { count: null, rate_limited: true };
  }
  if (!res.ok) return { count: null, rate_limited: false };
  const link = res.headers.get('link') ?? '';
  // Match `<...&page=N>; rel="last"`
  const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return { count: n, rate_limited: false };
  }
  // No `last` link with per_page=1 ⇒ ≤1 contributor.
  return { count: 1, rate_limited: false };
}

interface GhGistInfo {
  found: boolean;
  rate_limited: boolean;
  ownerId: number | null;
  devicePubkey: string | null;
}

/**
 * GET /gists/:id — fetch a channel-2 device-binding attestation gist (item 1).
 * Used to verify (gist owner + bound device pubkey) and detect revocation
 * (404 = the publisher deleted the gist). Parses `device_pubkey` out of the
 * first file's JSON body. Unauthenticated, like the other indexer fetches.
 */
export async function fetchGhGist(
  gistId: string, fetchImpl: FetchFn = fetch,
): Promise<GhGistInfo> {
  const url = `${GH_API}/gists/${encodeURIComponent(gistId)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'papercusp-cupboard-indexer' },
    });
  } catch {
    return { found: false, rate_limited: false, ownerId: null, devicePubkey: null };
  }
  if (res.status === 404) return { found: false, rate_limited: false, ownerId: null, devicePubkey: null };
  if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
    return { found: false, rate_limited: true, ownerId: null, devicePubkey: null };
  }
  if (!res.ok) return { found: false, rate_limited: false, ownerId: null, devicePubkey: null };
  const body = (await res.json()) as {
    owner?: { id?: number };
    files?: Record<string, { content?: string }>;
  };
  let devicePubkey: string | null = null;
  const file = Object.values(body.files ?? {})[0];
  if (file?.content) {
    try {
      const att = JSON.parse(file.content) as { device_pubkey?: unknown };
      if (typeof att.device_pubkey === 'string') devicePubkey = att.device_pubkey;
    } catch {
      // unparseable gist body — treated as a mismatch (devicePubkey stays null)
    }
  }
  return { found: true, rate_limited: false, ownerId: body.owner?.id ?? null, devicePubkey };
}

export interface IndexOneResult {
  harness_id: string;
  outcome: 'updated' | 'unlisted' | 'rate_limited' | 'skipped_error';
  detail?: string;
}

export async function indexOneHarness(
  env: Env,
  harness: HarnessRow,
  fetchImpl: FetchFn = fetch,
): Promise<IndexOneResult> {
  const { github_owner, github_name, id } = harness;
  const repo = await fetchGhRepo(github_owner, github_name, fetchImpl);
  if (repo.rate_limited) {
    return { harness_id: id, outcome: 'rate_limited' };
  }
  if (repo.not_found) {
    const now = Date.now();
    await markHarnessUnlisted(env.DB, id, 'by_indexer:gh_404', now);
    await audit(env.DB, now, 'indexer_unlisted', { harness_id: id, owner: github_owner, repo: github_name });
    return { harness_id: id, outcome: 'unlisted', detail: 'gh repo returned 404' };
  }
  if (repo.error_status != null) {
    return { harness_id: id, outcome: 'skipped_error', detail: `gh /repos returned ${repo.error_status}` };
  }
  const langs = await fetchGhLanguages(github_owner, github_name, fetchImpl);
  if (langs.rate_limited) {
    // We still have base stats from /repos — proceed with what we have.
  }
  const contrib = await fetchGhContributorCount(github_owner, github_name, fetchImpl);
  await updateHarnessStats(
    env.DB,
    id,
    {
      stars: repo.stars,
      contributor_count: contrib.count ?? 0,
      last_activity_at: repo.last_activity_at,
      languages: langs.languages ? JSON.stringify(langs.languages) : null,
    },
    Date.now(),
  );
  // Channel-2 attestation verify + revocation (item 1). If this listing
  // carries an attestation, confirm the gist still exists, is owned by the
  // publisher, and still binds the stored device pubkey; otherwise clear it
  // (gist deletion = revocation, per the substrate-revocation model). A
  // transient rate-limit leaves it untouched (re-checked next pass).
  if (harness.publisher_attestation_gist_id && harness.publisher_device_pubkey) {
    const gist = await fetchGhGist(harness.publisher_attestation_gist_id, fetchImpl);
    if (!gist.rate_limited) {
      const valid =
        gist.found &&
        gist.ownerId === harness.publisher_github_user_id &&
        gist.devicePubkey === harness.publisher_device_pubkey;
      if (!valid) {
        const clearedAt = Date.now();
        await clearHarnessAttestation(env.DB, id, clearedAt);
        await audit(env.DB, clearedAt, 'attestation_cleared', {
          harness_id: id,
          reason: gist.found ? 'mismatch' : 'gist_not_found',
        });
      }
    }
  }
  return { harness_id: id, outcome: 'updated' };
}

export interface IndexBatchResult {
  examined: number;
  updated: number;
  unlisted: number;
  rate_limited: number;
  errors: number;
  duration_ms: number;
}

/**
 * Run one batch — capped at env.INDEXER_BATCH_SIZE. Picks the
 * stalest harnesses first (oldest `stats_refreshed_at` or never-
 * indexed nulls first via the listing's default ORDER).
 *
 * Returns a summary. Audit row written inside.
 */
export async function indexBatch(
  env: Env,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<IndexBatchResult> {
  const started = Date.now();
  const limit = parseInt(env.INDEXER_BATCH_SIZE, 10) || 100;
  const rows = await listHarnesses(env.DB, { limit });
  const summary: IndexBatchResult = {
    examined: rows.length,
    updated: 0,
    unlisted: 0,
    rate_limited: 0,
    errors: 0,
    duration_ms: 0,
  };
  for (const row of rows) {
    const r = await indexOneHarness(env, row, opts.fetchImpl);
    if (r.outcome === 'updated') summary.updated++;
    else if (r.outcome === 'unlisted') summary.unlisted++;
    else if (r.outcome === 'rate_limited') summary.rate_limited++;
    else summary.errors++;
    // Early-exit if we're getting rate-limited — don't burn through
    // the rest of the batch.
    if (r.outcome === 'rate_limited') break;
  }
  summary.duration_ms = Date.now() - started;
  await audit(env.DB, Date.now(), 'indexer_batch', { ...summary });
  return summary;
}
