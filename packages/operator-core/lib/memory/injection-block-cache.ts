/**
 * injection-block-cache — bound the pre-turn memory injection's prompt-build
 * cost on the converse path (papercup-chat-release-grade-loop-2026-07-16
 * P-010, evidence EI-13232 / plan decision D-004).
 *
 * buildMemoryContextBlock is internally deadline-capped (MEMORY_INJECT_TIMEOUT_MS
 * = 5s per op) but the converse prompt AWAITED it inline — so on a loaded box a
 * typed turn paid the full 5s cap on every search miss (pass-7 drill: searchMs
 * 5001–5114, the dominant prompt-build phase once P-009 took the sentinel
 * gather off the critical path) and then injected NOTHING (timeout ⇒ null ⇒
 * the 60s degraded latch). Worst of both: full latency, zero memory.
 *
 * Same treatment as sentinel-block-cache — the RENDERED block sits behind the
 * operator SWR cache and the caller's wait is capped via getOrSetBounded —
 * with one deliberate difference: **soft TTL = 0**. The block depends on the
 * turn's queryContext (the last user messages), so a cached block is ALWAYS
 * treated as stale: every read serves the previous build instantly and
 * revalidates with the CURRENT turn's query in the background. Under load the
 * chat gets memory with one-turn lag instead of a 5s stall; on a fast box a
 * cold miss usually completes under the deadline and behavior matches the
 * unbounded path. The per-turn build cost is unchanged — it just runs off the
 * blocking path.
 *
 * Composition with the existing memory hygiene layers (all inside the build):
 *   - the 2-minute surfaced watermark / session-epoch dedup means consecutive
 *     background rebuilds return mostly-new facts, so a stale-served block is
 *     not re-paid context — it is the SAME text the model already saw;
 *   - a build that times out internally returns null; null is cached
 *     (cacheEmpty) and the degraded latch quiets the background rebuilds, so a
 *     sustained memory outage costs each turn ~0ms, not a 5s probe.
 */

import { getOrSetBounded, type Cache } from '@papercusp/cache';
import { getOperatorCache } from '../cache/instance';

/** Always serve-stale + revalidate: the block is query-dependent, so a cached
 *  build is by definition one turn behind — never "fresh". */
export const MEMORY_BLOCK_SOFT_TTL_MS = 0;
/** Drop a stale block after this long — a resumed-after-idle conversation
 *  should race a fresh build rather than inject minutes-old recall. */
export const MEMORY_BLOCK_HARD_TTL_MS = 5 * 60_000;
/** Max time a typed turn's prompt build may BLOCK on a cold memory build. */
export const MEMORY_BLOCK_COLD_DEADLINE_MS = 2_000;

/** Invalidation tag — bump via the cache ECA for an eager refresh. */
export const MEMORY_BLOCK_CACHE_TAG = 'memory-inject-block';

export interface MemoryBlockBoundedOpts {
  /** Override the cold-miss wait cap (sentinel_scan turns have no human waiting). */
  deadlineMs?: number;
  /** Cache instance override (tests). Default: the operator singleton. */
  cache?: Cache;
  softTtlMs?: number;
  hardTtlMs?: number;
}

export type MemoryBlockBoundedResult =
  | { status: 'ready'; block: string | null }
  | { status: 'deadline'; block: null }
  | { status: 'error'; block: null };

/**
 * Get the rendered memory-injection block for (workspaceId, scopeKey), building
 * with `build` (a closure over THIS turn's queryContext). Never rejects: a
 * failed or over-deadline build resolves null (the caller omits the section).
 * `scopeKey` must isolate conversations — stale recall must never bleed across
 * a different role/user/conversation.
 */
export async function getMemoryBlockBoundedResult(
  workspaceId: string,
  scopeKey: string,
  build: () => Promise<string | null>,
  opts: MemoryBlockBoundedOpts = {},
): Promise<MemoryBlockBoundedResult> {
  const cache = opts.cache ?? getOperatorCache();
  const deadlineMs = opts.deadlineMs ?? MEMORY_BLOCK_COLD_DEADLINE_MS;

  const res = await getOrSetBounded<string | null>(
    cache,
    workspaceId,
    `memory-inject-block:${scopeKey}`,
    build,
    {
      deadlineMs,
      softTtlMs: opts.softTtlMs ?? MEMORY_BLOCK_SOFT_TTL_MS,
      hardTtlMs: opts.hardTtlMs ?? MEMORY_BLOCK_HARD_TTL_MS,
      tags: [MEMORY_BLOCK_CACHE_TAG],
      // A null block (no hits / degraded store) is a completed build — cache it
      // so a quiet or degraded store isn't re-probed on the blocking path.
      cacheEmpty: true,
    },
  );
  if (res.ok) return { status: 'ready', block: res.value };
  if (res.reason === 'deadline') {
    // The single-flight build keeps running and will serve the NEXT turn;
    // this turn proceeds without the section.
    console.warn(
      `[memory-injection] block build exceeded the ${deadlineMs}ms prompt-build deadline — ` +
        'omitting the section this turn; the in-flight build will serve the next one (P-010).',
    );
    return { status: 'deadline', block: null };
  }
  console.warn(
    '[memory-injection] block build failed (omitting the section):',
    res.error instanceof Error ? res.error.message : String(res.error),
  );
  return { status: 'error', block: null };
}

/**
 * Compatibility surface for callers that only render the block. Delivery
 * instrumentation should use `getMemoryBlockBoundedResult`: a completed
 * no-hit build and a deadline both render as null, but they are not the same
 * reading and must never share a healthy `no-recall` metric.
 */
export async function getMemoryBlockBounded(
  workspaceId: string,
  scopeKey: string,
  build: () => Promise<string | null>,
  opts: MemoryBlockBoundedOpts = {},
): Promise<string | null> {
  return (await getMemoryBlockBoundedResult(workspaceId, scopeKey, build, opts)).block;
}
