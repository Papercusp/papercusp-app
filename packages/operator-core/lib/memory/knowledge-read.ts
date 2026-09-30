/**
 * knowledge-read.ts — the reads behind the Learning tab's "Knowledge" sub-view
 * (operator-learning-tab-2026-06-09 P-008 / learning-system-audit P-042).
 *
 * Two halves, both consumed by the `learning.knowledge` sync resolver:
 *
 *  1. **Insights snapshot** — count + the most-recently-touched runbooks from
 *     the agent-insights MDX library. Wraps the existing {@link readInsightsDir}
 *     reader (single source of truth with the session-start prelude) rather than
 *     re-parsing frontmatter; "recent" is file mtime because the frontmatter
 *     carries no date field. The Learning tab shows the recent five as a teaser
 *     and cross-links to the full Insights tab — it does NOT duplicate that tab.
 *
 *  2. **Memory health** — total canonical memories + feedback events in the last
 *     30 days. The old D-005 "memory unpopulated" exclusion is stale (the store
 *     has real rows now); a zero `feedback30d` against a populated store is
 *     exactly the signal P-050 ("turn the feedback loop on") needs the owner to
 *     see. Pure SQL over an injected `Sql` (mirrors iq-battery/benchmark-read);
 *     the caller supplies the org-PG handle so this module stays seam-testable.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Sql } from 'postgres';
import { readInsightsDir, type InsightEntry } from './insights-index';
import {
  readRecallHealth,
  readRecallHealthBySurface,
  readRecallQueryHealth,
  type RecallHealth,
  type RecallQueryHealth,
  type RecallSurfaceHealth,
} from './recall-stats';
import type { MemoryPrecisionSnapshot } from './bench/precision-read';
import { DOCS_CONTENT_ROOT } from '../agent-tools/docs/_repo-paths';
import { TtlMap } from '../ttl-map';

/** Canonical agent-insights MDX directory (the same tree docs:* serves). */
export const INSIGHTS_DIR = path.join(DOCS_CONTENT_ROOT, 'agent-insights');

export interface RecentInsight extends InsightEntry {
  /** ISO mtime of the .mdx file — the "recent" ordering proxy (frontmatter has no date). */
  modifiedAt: string | null;
}

export interface InsightsSnapshot {
  /** Visible (non-retired/superseded) runbooks in the library. */
  count: number;
  /** The newest few by file mtime, newest first. */
  recent: RecentInsight[];
}

/**
 * Count + recent-N over the insights library. Missing dir / unreadable files
 * degrade to an empty snapshot (readInsightsDir already swallows ENOENT).
 */
export async function readInsightsSnapshot(
  dir: string = INSIGHTS_DIR,
  recentLimit = 5,
): Promise<InsightsSnapshot> {
  const entries = await readInsightsDir(dir);
  const withMtime: RecentInsight[] = await Promise.all(
    entries.map(async (e) => {
      try {
        const st = await fs.stat(path.join(dir, `${e.slug}.mdx`));
        return { ...e, modifiedAt: st.mtime.toISOString() };
      } catch {
        return { ...e, modifiedAt: null };
      }
    }),
  );
  withMtime.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  return { count: entries.length, recent: withMtime.slice(0, Math.max(0, recentLimit)) };
}

export interface MemoryHealth extends RecallHealth {
  /**
   * REAL memories in harness_shared.memory_canonical. Excludes mem0's
   * entity-store rows (`row_kind = 'entity'`), which share the physical
   * table — pre-EI-366 this counted them too and read 2,170 when the
   * store held 341 actual facts. Entity rows outnumber memories ~7:1, so
   * this exclusion is load-bearing, not a detail: dropping it over-counts
   * by ~8x (D-013 — that over-count is how a 28k-row "debris class" was
   * hallucinated and nearly purged). `row_kind` is a GENERATED column
   * (migration 757) so it cannot drift from the payload it derives from.
   */
  totalMemories: number;
  /** Segregated mem0 entity-linking rows sharing the canonical table. */
  entityRows: number;
  /** memory_feedback events in the trailing 30 days — the loop's pulse. */
  feedback30d: number;
  /**
   * The memory-precision-bench trend (relight P-033) — latest FP@5 / R@10 /
   * precision + a short history. Populated by the `learning.knowledge` resolver
   * (it needs the workspace id `readMemoryHealth` doesn't take); `null`/absent
   * when the bench has never run or migration 312 isn't applied yet.
   */
  precision?: MemoryPrecisionSnapshot | null;
  /**
   * Per-surface slice of the recall aggregate (orient-recall-quality P-006):
   * each entry point (search / orient / initialize / turn-start / claim / …)
   * stamps its own surface, so a single-surface regression — orient's zero-hit
   * rate spiking while chat search stays healthy — is visible instead of
   * blended away. Empty when telemetry is unavailable.
   */
  recallBySurface: RecallSurfaceHealth[];
  /**
   * Per-surface shape of what was ASKED (P-041 / migration 706) — the other
   * half of the call. Every other field here measures what recall RETURNED,
   * and that side cannot answer whether the QUERY was any good: the push
   * path's top_score is an RRF rank, identical for a precise question and for
   * the word "continue" (D-015).
   *
   * Empty when unavailable (pre-706 database) or when nothing in the window
   * recorded a query. Unlike a zeroed rate, an absent row reads as NO ANSWER
   * rather than as a healthy one, so it needs no companion to the
   * `recallTelemetryOk` flag below — a present row with `recalls: 0` is the
   * meaningful zero.
   */
  queryBySurface: RecallQueryHealth[];
  /**
   * Did the recall-telemetry read SUCCEED? (EI-10625.) The aggregate degrades to
   * all-zeros on failure — and a zeroed aggregate is `zeroHitRate7d = 0`, i.e.
   * "no recall ever missed", the healthiest reading there is. Without this flag a
   * consumer cannot tell a perfect store from an unreadable one, so an alarm built
   * on the rate alone goes GREEN exactly when the telemetry dies. Callers that
   * gate on recall quality MUST check it.
   */
  recallTelemetryOk: boolean;
}

/**
 * Health read over the canonical memory tables + recall telemetry.
 * The recall aggregate degrades to zeros independently (e.g. migration
 * 240 not applied yet) so the store counts never vanish with it.
 */
/** The three store counts — the only part of memory-health that is workspace-INVARIANT. */
interface StoreCounts {
  totalMemories: number;
  entityRows: number;
  feedback30d: number;
}

/**
 * TTL >= the system-health tick interval (30s, `dbos/in-process-periodic.ts`), so
 * consecutive ticks HIT rather than straddling an expiry. 60s of staleness on a
 * "how many memories exist" panel number is not observable.
 */
export const STORE_COUNTS_TTL_MS = 60_000;

/**
 * WI-9137. These counts cost 12.97 HOURS of cumulative DB time over 24.5 days
 * (1,292,711 calls, 8.7B buffer hits, rank #26 by exec time / #19 by buffers),
 * because the health tick recomputes them every 30s PER WORKSPACE in EVERY
 * operator-shaped process — measured live at 0.68 calls/s.
 *
 * ⚠ Read this whole note before "optimising the query" — most of it has been tried
 * and refuted. Three fixes were measured against the JSONB predicate and all failed:
 *   1. expression index on `(payload ? 'entityType')` — planner does not use it
 *      (cost 2552.51 -> 2553.55, still two Seq Scans);
 *   2. partial index `(id) WHERE payload ? 'entityType'` — not used either, and
 *      the planner is RIGHT: the predicate matches 29,715/33,820 rows (88%), so a
 *      full scan genuinely is cheaper than an index scan over 88% of the table;
 *   3. a single-scan `count(*) FILTER (...)` rewrite — fewer buffers (7,435 vs
 *      9,537) but SLOWER (61.8ms vs 57.7ms), because FILTER must materialise the
 *      wide jsonb payload (width=277) where the separate counts scan at width=0.
 * There is also no I/O to remove (shared_blks_read = 0 — already fully cached).
 *
 * WHAT CHANGED (P-020 / WI-9355, migration 757). Finding 2 above is about the
 * ENTITY side, which is 88% of the table — there the planner's refusal is correct
 * and nothing has changed. But the MEMORY side is its mirror image (4,108 of 33,897
 * rows, 12.1%), and nobody had measured THAT direction. Migration 757 adds a
 * GENERATED STORED `row_kind` column plus a partial index on the minority side, and
 * the totalMemories leg is no longer irreducible:
 *   The canonical steady-state measurement is recorded in migration 757:
 *   BEFORE  count(*) WHERE NOT (payload ? 'entityType')
 *           Seq Scan          32.05 / 34.29 / 30.98 ms    buffers hit=4440
 *   AFTER   count(*) WHERE row_kind = 'memory'
 *           Bitmap Heap Scan   8.97 / 10.06 /  9.07 ms   buffers hit=1154
 * ~3.4x faster and ~3.8x fewer buffers. The entity leg stays a Seq Scan on purpose.
 * An earlier rolled-back transactional probe claimed 70.9ms -> 5.0ms (~14x), but
 * those figures did not survive the live post-ANALYZE steady state; do not quote them.
 *
 * The cache below is still worth keeping: it addresses the CALL RATE, which is an
 * independent lever from the per-call cost and was the larger factor.
 *
 * Keyed GLOBALLY, not per workspace: the SQL carries no workspace_id predicate,
 * so every workspace was independently recomputing the identical global number.
 * That redundancy is the actual defect — this removes it rather than hiding it.
 *
 * Caches the PROMISE, so concurrent ticks single-flight onto one query instead of
 * each missing the cache and issuing its own. A rejection is evicted immediately,
 * never cached: the counts leg deliberately has no `.catch` (see readMemoryHealth)
 * and must keep failing loudly.
 */
const storeCountsCache = new TtlMap<Promise<StoreCounts>>({
  ttlMs: STORE_COUNTS_TTL_MS,
  maxEntries: 1,
});
const STORE_COUNTS_KEY = 'global';

/** Test seam — drop the memo so a test observes a real query. */
export function __resetStoreCountsCache(): void {
  storeCountsCache.clear();
}

/**
 * THE canonical "how many memories do we have" read. Exported so the P-020
 * recurrence guard (memory-entity-discriminator.integration.test.ts) can drive
 * this exact function instead of re-typing its SQL — a guard that re-declares
 * the query it guards goes green while production drifts away from it.
 */
export function readStoreCounts(sql: Sql): Promise<StoreCounts> {
  const hit = storeCountsCache.get(STORE_COUNTS_KEY);
  if (hit) return hit;
  const pending = (async (): Promise<StoreCounts> => {
    const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM harness_shared.memory_canonical
        WHERE row_kind = 'memory')                                AS total_memories,
      (SELECT count(*)::int FROM harness_shared.memory_canonical
        WHERE row_kind = 'entity')                                AS entity_rows,
      (SELECT count(*)::int FROM harness_shared.memory_feedback
        WHERE created_at >= now() - interval '30 days')           AS feedback_30d
  `) as unknown as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    return {
      totalMemories: Number(r.total_memories ?? 0),
      entityRows: Number(r.entity_rows ?? 0),
      feedback30d: Number(r.feedback_30d ?? 0),
    };
  })().catch((err: unknown) => {
    storeCountsCache.delete(STORE_COUNTS_KEY);
    throw err;
  });
  storeCountsCache.set(STORE_COUNTS_KEY, pending);
  return pending;
}

export async function readMemoryHealth(sql: Sql): Promise<MemoryHealth> {
  // WI-7369: these FOUR reads are issued CONCURRENTLY, not sequentially. They are
  // fully independent — no one of them consumes another's result, and each already
  // degrades on its own (see the individual catches below, whose independence is
  // load-bearing: "the store counts never vanish with telemetry"). Awaiting them in
  // series bought nothing and cost the sum of their latencies.
  //
  // MEASURED (10 passes, arm order alternated, one warm-up discarded — see below for
  // why that method): this function was the dominant leg of the learning.knowledge
  // sync read at a 510ms median, against 155ms for its sibling readInsightsSnapshot
  // and 2ms for the precision read. Parallelising the resolver's three legs alone
  // only took the whole read 670 -> 520ms, still 3.5x the 150ms sync-read latency
  // budget, because THIS function is most of it — so the win has to come from here.
  //
  // ⚠ Each `.catch` is preserved EXACTLY as it was. `Promise.all` rejects on the
  // first rejection, so degrading inside each leg (rather than around the all()) is
  // what keeps one failed telemetry read from zeroing the store counts.
  const emptyRecall: RecallHealth = {
    recalls7d: 0,
    zeroHit7d: 0,
    zeroHitRate7d: 0,
    topScoreP50: null,
    topScoreP90: null,
    topScoreScale: null,
    topScoreSamples: 0,
    scaleMix: {},
    fragmentHits7d: 0,
  };
  let recallTelemetryOk = true;
  const [counts, recall, recallBySurface, queryBySurface] = await Promise.all([
    readStoreCounts(sql),
    readRecallHealth(sql).catch((err: unknown) => {
      // The aggregate stays all-zeros — which READS AS PERFECT (0% zero-hit).
      // Flag the failure so consumers can tell "nothing missed" from "nothing known".
      recallTelemetryOk = false;
      console.warn('[memory-health] recall-stats read failed (migration 240 applied?):', (err as Error).message);
      return emptyRecall;
    }),
    // P-006: the per-surface slice — same degrade-to-empty independence as the
    // blended aggregate above (the store counts never vanish with telemetry).
    readRecallHealthBySurface(sql).catch((): RecallSurfaceHealth[] => []),
    // P-041: the query-side slice, same degrade-to-empty independence.
    readRecallQueryHealth(sql).catch((): RecallQueryHealth[] => []),
  ]);
  return {
    ...recall,
    recallBySurface,
    queryBySurface,
    recallTelemetryOk,
    totalMemories: counts.totalMemories,
    entityRows: counts.entityRows,
    feedback30d: counts.feedback30d,
  };
}
