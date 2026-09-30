/**
 * pr-host/pr-check-status-cache-types — LOCAL row shape for
 * `pr_check_status_cache` per papercusp-dogfood-v5 line 598 + 696.
 *
 * Types-only and PURE. No PG, no Octokit.
 *
 * Twenty-second module in the dogfood-arc types-only spine.
 *
 * Per v5:
 *   "PR check status detail cache — per-engineer cache of GitHub
 *    check-run details fetched on click."
 *
 * Populated lazily on user click in the PRs tab (§9.3 P-043). The
 * summary `checks_status` already lives on `harness_feature_prs`
 * (HYPERBEE); this LOCAL cache holds the per-check-run detail
 * (name, conclusion, URL) so a re-open of the same PR doesn't
 * re-fetch from GitHub.
 *
 * Per v5 line 692: detail comes from
 *   GET /repos/{owner}/{repo}/commits/{head.sha}/check-runs
 */

/**
 * Check-run conclusion vocabulary per GitHub's check-runs API.
 *
 *   success | failure | neutral | cancelled | timed_out | action_required
 *   | skipped | stale | null (in-progress)
 *
 * `null` (the JSON null) represents "still running" — the run
 * hasn't reached a terminal state yet. Cache rows preserve this
 * so the UI can render a spinner.
 */
export const CHECK_RUN_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'skipped',
  'stale',
] as const;
export type CheckRunConclusion = (typeof CHECK_RUN_CONCLUSIONS)[number];

/**
 * Check-run status vocabulary per GitHub's check-runs API.
 *
 *   queued | in_progress | completed
 */
export const CHECK_RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];

/**
 * Single check-run entry. Mirrors the subset of GitHub's check-run
 * shape that the UI surfaces.
 */
export interface CheckRunEntry {
  /** GitHub-assigned check-run id. */
  id: number;
  /** Check-run name (e.g. "build", "test:unit"). */
  name: string;
  status: CheckRunStatus;
  /** null when status is queued/in_progress. */
  conclusion: CheckRunConclusion | null;
  /** Detail URL on GitHub. */
  details_url: string | null;
  /** Epoch ms when the check started (GitHub-reported). */
  started_at: number | null;
  /** Epoch ms when the check completed. null while in-progress. */
  completed_at: number | null;
}

/**
 * The LOCAL cache row. One per (workspace, harness, head_sha).
 * Multiple runs for the same head SHA are aggregated under one
 * row — the cache is keyed by (workspace, harness, head_sha)
 * rather than per-PR-number so that fetching for one PR also
 * primes the cache for any sibling PR pointing at the same head.
 */
export interface PrCheckStatusCacheRow {
  workspace_id: string;
  harness_slug: string;
  /** Head commit SHA the checks were run on. SHA-1 (40) or
   * SHA-256 (64) lowercase hex. */
  head_sha: string;
  /** All check-run entries for this head SHA. */
  check_runs: CheckRunEntry[];
  /** Epoch ms when the cache row was last populated from GitHub. */
  fetched_at: number;
  /** Cache TTL hint — re-fetch if older than now() - TTL. Same
   * cadence as the poll daemon (60s) per v5 §8.4. */
  schema_version: 1;
}

export const CHECK_RUN_CACHE_TTL_MS = 60 * 1000;
export const CHECK_RUN_CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Structural predicate for a single CheckRunEntry.
 */
export function isCheckRunEntry(input: unknown): input is CheckRunEntry {
  if (input === null || typeof input !== 'object') return false;
  const e = input as Record<string, unknown>;
  return (
    typeof e.id === 'number' &&
    Number.isInteger(e.id) &&
    e.id > 0 &&
    typeof e.name === 'string' &&
    e.name.length > 0 &&
    typeof e.status === 'string' &&
    (CHECK_RUN_STATUSES as readonly string[]).includes(e.status) &&
    (e.conclusion === null ||
      (typeof e.conclusion === 'string' &&
        (CHECK_RUN_CONCLUSIONS as readonly string[]).includes(e.conclusion))) &&
    (e.details_url === null || typeof e.details_url === 'string') &&
    (e.started_at === null || (typeof e.started_at === 'number' && Number.isFinite(e.started_at))) &&
    (e.completed_at === null || (typeof e.completed_at === 'number' && Number.isFinite(e.completed_at)))
  );
}

/**
 * Structural predicate for the full cache row.
 */
export function isPrCheckStatusCacheRow(input: unknown): input is PrCheckStatusCacheRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.workspace_id !== 'string') return false;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.head_sha !== 'string') return false;
  if (r.head_sha.length !== 40 && r.head_sha.length !== 64) return false;
  if (!/^[0-9a-f]+$/.test(r.head_sha)) return false;
  if (!Array.isArray(r.check_runs)) return false;
  if (typeof r.fetched_at !== 'number' || !Number.isFinite(r.fetched_at)) return false;
  if (r.schema_version !== CHECK_RUN_CACHE_SCHEMA_VERSION) return false;
  return true;
}

/**
 * Predicate: is the cache row stale enough to trigger a re-fetch?
 * Pure — caller passes `now`. Uses CHECK_RUN_CACHE_TTL_MS as the
 * default TTL, overrideable per call.
 */
export function isCacheStale(
  row: PrCheckStatusCacheRow,
  now: number,
  ttlMs: number = CHECK_RUN_CACHE_TTL_MS,
): boolean {
  return now - row.fetched_at > ttlMs;
}

/**
 * Predicate: is the check-run entry definitively done (any
 * terminal conclusion)? Used by the UI to decide whether to keep
 * polling for updates.
 */
export function isCheckRunComplete(entry: CheckRunEntry): boolean {
  return entry.status === 'completed';
}

/**
 * Pure helper: aggregate per-check conclusions into a single
 * summary state matching `PrChecksState` from pr-host/types.
 *
 *   - Any check in-progress → 'pending'
 *   - All complete + all success → 'success'
 *   - Any failure → 'failure'
 *   - Any error/cancelled → 'error' / 'cancelled'
 *   - Empty array → 'unknown'
 */
export function summarizeCheckRuns(
  entries: ReadonlyArray<CheckRunEntry>,
): 'unknown' | 'pending' | 'success' | 'failure' | 'error' | 'cancelled' {
  if (entries.length === 0) return 'unknown';
  let anyInProgress = false;
  let anyFailure = false;
  let anyCancelled = false;
  let anyTimedOut = false;
  let anyActionRequired = false;
  for (const e of entries) {
    if (e.status !== 'completed') {
      anyInProgress = true;
    } else {
      switch (e.conclusion) {
        case 'failure':
          anyFailure = true;
          break;
        case 'cancelled':
          anyCancelled = true;
          break;
        case 'timed_out':
          anyTimedOut = true;
          break;
        case 'action_required':
          anyActionRequired = true;
          break;
      }
    }
  }
  if (anyFailure) return 'failure';
  if (anyTimedOut || anyActionRequired) return 'error';
  if (anyCancelled) return 'cancelled';
  if (anyInProgress) return 'pending';
  return 'success';
}

/**
 * Compose a cache key for diagnostic logging. Format:
 *
 *   <workspace_id>:<harness_slug>@<head-sha-first-7>
 */
export function composeCacheKey(row: Pick<PrCheckStatusCacheRow, 'workspace_id' | 'harness_slug' | 'head_sha'>): string {
  return row.workspace_id + ':' + row.harness_slug + '@' + row.head_sha.slice(0, 7);
}

/**
 * Build a fresh cache row from a GitHub check-runs response. The
 * runtime caller maps Octokit's response into `CheckRunEntry[]`
 * and passes it here.
 */
export function buildPrCheckStatusCacheRow(args: {
  workspace_id: string;
  harness_slug: string;
  head_sha: string;
  check_runs: CheckRunEntry[];
  now: number;
}): PrCheckStatusCacheRow {
  if (!args.harness_slug) throw new TypeError('harness_slug required');
  if (!/^[0-9a-f]+$/.test(args.head_sha) || (args.head_sha.length !== 40 && args.head_sha.length !== 64)) {
    throw new TypeError('head_sha must be 40 or 64 char lowercase hex');
  }
  return {
    workspace_id: args.workspace_id,
    harness_slug: args.harness_slug,
    head_sha: args.head_sha,
    check_runs: args.check_runs.slice(),
    fetched_at: args.now,
    schema_version: CHECK_RUN_CACHE_SCHEMA_VERSION,
  };
}
