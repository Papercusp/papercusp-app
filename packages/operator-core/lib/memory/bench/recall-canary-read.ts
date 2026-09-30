/**
 * recall-canary-read.ts — the LIGHT read/write path for the memory recall
 * canary (EI-10047).
 *
 * Split from `recall-canary.ts` (the runner that pulls the live backend +
 * org PG) the same way precision-read.ts is split from precision-monitor.ts:
 * a future panel read needs only the small SQL below. Storage is
 * harness_shared.memory_live_recall_canary_set / _run (migration 580), SQL
 * injected (postgres-js `Sql`) so this stays seam-testable.
 *
 * What the canary is (vs the precision bench): precision-monitor replays a
 * FIXTURE gold set in an ISOLATED bench schema — it watches the CODE PATH.
 * The canary replays known-item queries against the LIVE store through the
 * LIVE backend config, read-only — it watches the DEPLOYMENT (schema drift,
 * embedder misconfig, index corruption: the 2026-07-12 42703 class, where
 * search silently returned garbage while every suite stayed green).
 */
import type { Sql } from 'postgres';

/** One frozen known-item probe: `query` must retrieve `memoryId` in `scope`. */
export interface RecallCanaryPair {
  memoryId: string;
  scope: string;
  query: string;
  style: 'fragment' | 'keyword';
}

/** A frozen canary set: pairs + the baseline they scored at seed time. */
export interface RecallCanarySet {
  id: number;
  version: number;
  /** Backend name the set was seeded against — a flip invalidates the set. */
  backend: string;
  pairs: RecallCanaryPair[];
  baselineRAt10: number;
  createdAt: string;
}

export type RecallCanaryStatus = 'ok' | 'degraded' | 'decayed' | 'seeded';

/** Metrics one canary run produces — the write shape (recall-canary builds it). */
export interface RecallCanaryRunMetrics {
  setVersion: number;
  backend: string;
  pairsTotal: number;
  /** Pairs whose target memory still exists and were actually searched. */
  pairsScored: number;
  /** Pairs whose target memory no longer exists (natural forget — not scored). */
  pairsMissing: number;
  hits: number;
  rAt10: number | null;
  baselineRAt10: number | null;
  delta: number | null;
  /**
   * EI-10666 — measured AT THE CONSUMER: the fraction of scored queries after which an agent
   * would have received NOTHING (retrieval empty, OR the consumer-admission gates discarded
   * every hit). This is the number the alarm reads. It used to mean "the backend returned
   * nothing", which scored a HIT whenever a gate ate a healthy retrieval — the canary would
   * have reported GREEN straight through EI-10372.
   */
  zeroHitRate: number | null;
  /**
   * DIAGNOSTIC (EI-10666): the fraction of scored queries where the BACKEND returned nothing.
   * Compare with `zeroHitRate` to locate the blackout: equal ⇒ the store went dark (the
   * swallowed-PG-error smell); `retrievalZeroHitRate` much LOWER ⇒ the store was fine and the
   * consumer-side gates discarded everything. You cannot tell those apart from one number.
   */
  retrievalZeroHitRate: number | null;
  /** DIAGNOSTIC: recall@10 against the RAW backend rows, before the consumer's gates. */
  retrievalRAt10: number | null;
  latencyP50Ms: number | null;
  status: RecallCanaryStatus;
  notes?: string | null;
}

/** One recorded run (newest-first in a trend). */
export interface RecallCanaryRun extends RecallCanaryRunMetrics {
  ranAt: string;
}

export interface RecallCanarySnapshot {
  latest: RecallCanaryRun | null;
  /** Newest-first, capped. */
  trend: RecallCanaryRun[];
  runCount: number;
}

export const EMPTY_RECALL_CANARY_SNAPSHOT: RecallCanarySnapshot = {
  latest: null,
  trend: [],
  runCount: 0,
};

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function mapRun(r: Record<string, unknown>): RecallCanaryRun {
  return {
    ranAt: r.ran_at instanceof Date ? r.ran_at.toISOString() : String(r.ran_at ?? ''),
    setVersion: Number(r.set_version ?? 0),
    backend: String(r.backend ?? ''),
    pairsTotal: Number(r.pairs_total ?? 0),
    pairsScored: Number(r.pairs_scored ?? 0),
    pairsMissing: Number(r.pairs_missing ?? 0),
    hits: Number(r.hits ?? 0),
    rAt10: num(r.r_at_10),
    baselineRAt10: num(r.baseline_r_at_10),
    delta: num(r.delta),
    zeroHitRate: num(r.zero_hit_rate),
    // NULL on any run recorded before migration 590 (and on 'decayed' runs, which score nothing).
    retrievalZeroHitRate: num(r.retrieval_zero_hit_rate),
    retrievalRAt10: num(r.retrieval_r_at_10),
    latencyP50Ms: num(r.latency_p50_ms),
    status: String(r.status ?? 'ok') as RecallCanaryStatus,
    notes: r.notes == null ? null : String(r.notes),
  };
}

/** Latest frozen set for a workspace, or null (none yet / table missing 42P01). */
export async function loadLatestRecallCanarySet(
  sql: Sql,
  workspaceId: string,
): Promise<RecallCanarySet | null> {
  try {
    const rows = (await sql`
      SELECT id, version, backend, pairs, baseline_r_at_10, created_at
        FROM harness_shared.memory_live_recall_canary_set
       WHERE workspace_id = ${workspaceId}
       ORDER BY version DESC
       LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const r = rows[0];
    const rawPairs = typeof r.pairs === 'string' ? JSON.parse(r.pairs) : r.pairs;
    return {
      id: Number(r.id),
      version: Number(r.version),
      backend: String(r.backend ?? ''),
      pairs: (Array.isArray(rawPairs) ? rawPairs : []) as RecallCanaryPair[],
      baselineRAt10: Number(r.baseline_r_at_10 ?? 0),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
    };
  } catch {
    return null; // migration 580 not applied yet → runner will report 'failed' on save instead
  }
}

/** Freeze a new set as version = latest+1. Returns {id, version}. */
export async function saveRecallCanarySet(
  sql: Sql,
  workspaceId: string,
  input: { backend: string; pairs: RecallCanaryPair[]; baselineRAt10: number },
): Promise<{ id: number; version: number }> {
  const rows = (await sql`
    INSERT INTO harness_shared.memory_live_recall_canary_set
      (workspace_id, version, backend, pairs, pairs_n, baseline_r_at_10)
    VALUES
      (${workspaceId},
       COALESCE((SELECT max(version) FROM harness_shared.memory_live_recall_canary_set
                  WHERE workspace_id = ${workspaceId}), 0) + 1,
       ${input.backend},
       ${JSON.stringify(input.pairs)}::text::jsonb,
       ${input.pairs.length},
       ${input.baselineRAt10})
    RETURNING id, version
  `) as Array<{ id: number; version: number }>;
  return { id: Number(rows[0]?.id ?? 0), version: Number(rows[0]?.version ?? 0) };
}

/** Insert one canary run. Returns the new row id. */
export async function recordRecallCanaryRun(
  sql: Sql,
  workspaceId: string,
  m: RecallCanaryRunMetrics,
): Promise<number> {
  const rows = (await sql`
    INSERT INTO harness_shared.memory_live_recall_canary_run
      (workspace_id, set_version, backend, pairs_total, pairs_scored, pairs_missing,
       hits, r_at_10, baseline_r_at_10, delta, zero_hit_rate,
       retrieval_zero_hit_rate, retrieval_r_at_10, latency_p50_ms, status, notes)
    VALUES
      (${workspaceId}, ${m.setVersion}, ${m.backend}, ${m.pairsTotal}, ${m.pairsScored},
       ${m.pairsMissing}, ${m.hits}, ${m.rAt10}, ${m.baselineRAt10}, ${m.delta},
       ${m.zeroHitRate}, ${m.retrievalZeroHitRate ?? null}, ${m.retrievalRAt10 ?? null},
       ${m.latencyP50Ms}, ${m.status}, ${m.notes ?? null})
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(rows[0]?.id ?? 0);
}

/**
 * The recall-canary trend for one workspace. A missing table (migration 580
 * not applied, 42P01) or any read failure degrades to the empty snapshot.
 */
export async function readRecallCanary(
  sql: Sql,
  workspaceId: string,
  trendLimit = 8,
): Promise<RecallCanarySnapshot> {
  try {
    const rows = (await sql`
      SELECT ran_at, set_version, backend, pairs_total, pairs_scored, pairs_missing,
             hits, r_at_10, baseline_r_at_10, delta, zero_hit_rate, latency_p50_ms,
             status, notes
        FROM harness_shared.memory_live_recall_canary_run
       WHERE workspace_id = ${workspaceId}
       ORDER BY ran_at DESC
       LIMIT ${Math.max(1, trendLimit)}
    `) as Array<Record<string, unknown>>;
    const trend = rows.map(mapRun);
    let runCount = trend.length;
    try {
      const c = (await sql`
        SELECT count(*)::int AS n FROM harness_shared.memory_live_recall_canary_run
         WHERE workspace_id = ${workspaceId}
      `) as Array<{ n: number }>;
      runCount = Number(c[0]?.n ?? trend.length);
    } catch {
      // fall back to the capped trend length
    }
    return { latest: trend[0] ?? null, trend, runCount };
  } catch {
    return EMPTY_RECALL_CANARY_SNAPSHOT;
  }
}
