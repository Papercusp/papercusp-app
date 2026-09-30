/**
 * sentinel-block-cache — bound the papercup sentinel read-context's prompt-build
 * cost (papercup-chat-release-grade-loop-2026-07-16 P-009, evidence EI-13193).
 *
 * The sentinel read-context gather (gatherSentinelContext: curation feed +
 * overwatch brief + state-of-pot digest + fleet + delegations) measured
 * ~6.5–10.8s per turn in the pass-6 drill — and unlike the memory injection
 * (MEMORY_INJECT_TIMEOUT_MS = 5s) it had NO deadline and NO cache, so every
 * papercup turn paid it in full. It became the dominant prompt-build phase the
 * moment WI-5094 killed the memory-embed cost.
 *
 * This wrapper puts the RENDERED block behind the operator's shared SWR cache
 * (@papercusp/cache via getOperatorCache — L1 + single-flight + serve-stale-
 * and-revalidate) and bounds the only remaining blocking case:
 *
 *   - fresh hit (< soft TTL)  → served instantly, no gather;
 *   - stale hit (< hard TTL)  → served instantly, gather refreshes in background;
 *   - cold miss (first turn)  → the gather runs, but the WAIT is capped at
 *     `deadlineMs`: past it the turn proceeds WITHOUT the sentinel section
 *     (the block's existing fail-soft degradation) while the single-flight
 *     build keeps running and lands in cache for the next turn.
 *
 * A build failure degrades to null (section omitted) — same contract as the
 * pre-existing try/catch at the converse-prompt call site.
 */

import { getOrSetBounded, type Cache } from '@papercusp/cache';
import { getOperatorCache } from '../cache/instance';

/** Serve-stale-and-revalidate after this long — one sentinel_scan cadence. */
export const SENTINEL_BLOCK_SOFT_TTL_MS = 45_000;
/** Force a blocking rebuild (still deadline-capped) after this long. */
export const SENTINEL_BLOCK_HARD_TTL_MS = 10 * 60_000;
/** Max time a turn's prompt build may BLOCK on a cold sentinel gather. */
export const SENTINEL_BLOCK_COLD_DEADLINE_MS = 2_000;

/** Invalidation tag — bump via the cache ECA if a writer wants an eager refresh. */
export const SENTINEL_BLOCK_CACHE_TAG = 'sentinel-context';

export interface SentinelBlockBoundedOpts {
  /** Override the cold-miss wait cap (tests / callers with no human waiting). */
  deadlineMs?: number;
  /** Cache instance override (tests). Default: the operator singleton. */
  cache?: Cache;
  softTtlMs?: number;
  hardTtlMs?: number;
}

/**
 * Get the rendered sentinel context block for (workspaceId, scopeKey), building
 * it with `build` on a miss. Never rejects: a failed or over-deadline build
 * resolves null (the caller omits the section). `scopeKey` must capture what
 * changes the rendered bytes (the primary hive / addressing scope).
 */
export async function getSentinelBlockBounded(
  workspaceId: string,
  scopeKey: string,
  build: () => Promise<string | null>,
  opts: SentinelBlockBoundedOpts = {},
): Promise<string | null> {
  const cache = opts.cache ?? getOperatorCache();
  const deadlineMs = opts.deadlineMs ?? SENTINEL_BLOCK_COLD_DEADLINE_MS;

  const res = await getOrSetBounded<string | null>(
    cache,
    workspaceId,
    `sentinel-block:${scopeKey}`,
    build,
    {
      deadlineMs,
      softTtlMs: opts.softTtlMs ?? SENTINEL_BLOCK_SOFT_TTL_MS,
      hardTtlMs: opts.hardTtlMs ?? SENTINEL_BLOCK_HARD_TTL_MS,
      tags: [SENTINEL_BLOCK_CACHE_TAG],
      // An empty/null block is still a completed gather — cache it so a quiet
      // system doesn't re-pay the full gather every turn.
      cacheEmpty: true,
    },
  );
  if (res.ok) return res.value;
  if (res.reason === 'deadline') {
    // The single-flight build keeps running and will serve the NEXT turn;
    // this turn proceeds without the section.
    console.warn(
      `[sentinel-context] gather exceeded the ${deadlineMs}ms prompt-build deadline — ` +
        'omitting the section this turn; the in-flight build will serve the next one (P-009).',
    );
    return null;
  }
  console.warn(
    '[sentinel-context] block build failed (omitting the section):',
    res.error instanceof Error ? res.error.message : String(res.error),
  );
  return null;
}
