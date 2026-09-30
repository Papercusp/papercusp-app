/**
 * precision-read.ts — the LIGHT read/write path for the memory-precision trend
 * (relight-self-learning-edges-2026-06-14 P-033).
 *
 * Split deliberately from `precision-monitor.ts` (the HEAVY bench runner that
 * pulls the bench host, mem0 client, embedder + a bench PG schema): the sync
 * resolver and the learning-efficacy read only need the small SQL below, so the
 * Learning tab's read never drags the bench engine into its import graph.
 *
 * Storage is harness_shared.memory_precision_bench (migration 312), one row per
 * `memory-precision` learning-singleton run. SQL is injected (postgres-js `Sql`),
 * mirroring knowledge-read.ts / recall-stats.ts, so this stays seam-testable.
 */
import type { Sql } from 'postgres';

/**
 * Ceiling on one isolated bench worker run (precision-monitor.ts kills it past this).
 * Lives here, in the light module, so the learning-loop health read can size its
 * since-fire grace from it without importing the heavy runner (WI-10004117).
 */
export const PRECISION_BENCH_WORKER_TIMEOUT_MS = 30 * 60 * 1_000;

/** One recorded memory-precision-bench run (newest-first in a trend). */
export interface MemoryPrecisionRun {
  ranAt: string;
  backend: string;
  /** Hard-negative false-positive rate at top-5 (the discipline number). */
  fpAt5: number | null;
  /** Positives-only recall@10. */
  rAt10: number | null;
  /** Positives-only precision@5. */
  pAt5: number | null;
  mrr: number | null;
  medianTopScore: number | null;
  floorCosine: number;
  floorLex: number;
  corpusN: number;
  goldN: number;
  latencyP50Ms: number | null;
  /**
   * WI-7215: the ADMISSION SHAPE this run was measured under, verbatim from the
   * row's `notes` (e.g. `"fusionMode:cosine-gated"`). Optional because it is
   * additive to a shape this snapshot's other consumers already construct.
   *
   * `null` is meaningful, not missing: every row recorded before WI-7179 is
   * untagged and was measured under `floored-union`. r@10 is only comparable
   * across runs sharing this value — see `evaluateRecallDrop`.
   */
  notes?: string | null;
  /**
   * The Jev operating point this run was gated by (plan
   * jev-decision-model-integration-2026-09-29, P-008), parsed from `notes`; null
   * for a floor-only run. `model` is the id the provider says answered, so a
   * served-model change is visible on the Learning tab.
   */
  jevGate?: JevGateShape | null;
}

export interface JevGateShape {
  readonly model: string;
  readonly encoding: string;
  readonly threshold: number;
}

/**
 * Parse the `;jev:<model>/<encoding>@<threshold>` segment precision-monitor's
 * `jevGatedShape` writes. Anything else, including every pre-P-008 row, is null.
 */
export function parseJevGateShape(notes: string | null | undefined): JevGateShape | null {
  if (!notes) return null;
  const m = /(?:^|;)jev:([^/;]+)\/([^@;]+)@([0-9.]+)(?:;|$)/.exec(notes);
  if (!m) return null;
  const threshold = Number(m[3]);
  return Number.isFinite(threshold) ? { model: m[1], encoding: m[2], threshold } : null;
}

/** The Learning-tab snapshot: the latest run + a short trend + the headline delta. */
export interface MemoryPrecisionSnapshot {
  latest: MemoryPrecisionRun | null;
  /** Newest-first, capped — for a tiny trend / sparkline. */
  trend: MemoryPrecisionRun[];
  /**
   * fp@5 of the latest run minus the most recent EARLIER run measured under the
   * same admission shape (negative = improving). Null when there is none: a
   * Jev-gated run and a floor-only run measure different systems, so their
   * difference is a switch flip, not drift.
   */
  fpAt5Delta: number | null;
  /** Total recorded runs for this workspace (not just the capped trend). */
  runCount: number;
}

/** The never-benchmarked / table-missing state — the card renders its empty state. */
export const EMPTY_PRECISION_SNAPSHOT: MemoryPrecisionSnapshot = {
  latest: null,
  trend: [],
  fpAt5Delta: null,
  runCount: 0,
};

/** Metrics a single bench run produces — the write shape (precision-monitor builds it). */
export interface MemoryPrecisionMetrics {
  backend: string;
  corpusVersion: string;
  goldVersion: string;
  corpusN: number;
  goldN: number;
  floorCosine: number;
  floorLex: number;
  fpAt5: number | null;
  rAt10: number | null;
  pAt5: number | null;
  mrr: number | null;
  medianTopScore: number | null;
  latencyP50Ms: number | null;
  byClass: Record<string, unknown>;
  costUsd: number | null;
  notes?: string | null;
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function mapRow(r: Record<string, unknown>): MemoryPrecisionRun {
  return {
    ranAt: r.ran_at instanceof Date ? r.ran_at.toISOString() : String(r.ran_at ?? ''),
    backend: String(r.backend ?? 'hybrid'),
    fpAt5: num(r.fp_at_5),
    rAt10: num(r.r_at_10),
    pAt5: num(r.p_at_5),
    mrr: num(r.mrr),
    medianTopScore: num(r.median_top_score),
    floorCosine: Number(r.floor_cosine ?? 0),
    floorLex: Number(r.floor_lex ?? 0),
    corpusN: Number(r.corpus_n ?? 0),
    goldN: Number(r.gold_n ?? 0),
    latencyP50Ms: num(r.latency_p50_ms),
    // Normalize absent/empty to null so an untagged legacy row and a row whose
    // tag was never written compare EQUAL as one shape (both are floored-union).
    notes: r.notes == null || String(r.notes) === '' ? null : String(r.notes),
    jevGate: parseJevGateShape(r.notes == null ? null : String(r.notes)),
  };
}

/**
 * The memory-precision trend for one workspace. A missing table (migration 312
 * not applied yet, code 42P01) or any read failure degrades to the empty
 * snapshot — the panel renders its nothing-benchmarked state, never a 500.
 */
export async function readMemoryPrecision(
  sql: Sql,
  workspaceId: string,
  trendLimit = 8,
): Promise<MemoryPrecisionSnapshot> {
  const rows = (await sql`
    SELECT ran_at, backend, fp_at_5, r_at_10, p_at_5, mrr, median_top_score,
           floor_cosine, floor_lex, corpus_n, gold_n, latency_p50_ms, notes
      FROM harness_shared.memory_precision_bench
     WHERE workspace_id = ${workspaceId}
     ORDER BY ran_at DESC
     LIMIT ${Math.max(1, trendLimit)}
  `) as Array<Record<string, unknown>>;
  const trend = rows.map(mapRow);
  const latest = trend[0] ?? null;
  const prev = latest ? (trend.slice(1).find((r) => (r.notes ?? null) === (latest.notes ?? null)) ?? null) : null;
  const fpAt5Delta =
    latest?.fpAt5 != null && prev?.fpAt5 != null ? latest.fpAt5 - prev.fpAt5 : null;

  let runCount = trend.length;
  try {
    const c = (await sql`
      SELECT count(*)::int AS n FROM harness_shared.memory_precision_bench
       WHERE workspace_id = ${workspaceId}
    `) as Array<{ n: number }>;
    runCount = Number(c[0]?.n ?? trend.length);
  } catch {
    // fall back to the capped trend length
  }

  return { latest, trend, fpAt5Delta, runCount };
}

/** Insert one bench run. Returns the new row id. */
export async function recordMemoryPrecisionRun(
  sql: Sql,
  workspaceId: string,
  m: MemoryPrecisionMetrics,
): Promise<number> {
  const rows = (await sql`
    INSERT INTO harness_shared.memory_precision_bench
      (workspace_id, backend, corpus_version, gold_version, corpus_n, gold_n,
       floor_cosine, floor_lex, fp_at_5, r_at_10, p_at_5, mrr, median_top_score,
       latency_p50_ms, by_class, cost_usd, notes)
    VALUES
      (${workspaceId}, ${m.backend}, ${m.corpusVersion}, ${m.goldVersion}, ${m.corpusN}, ${m.goldN},
       ${m.floorCosine}, ${m.floorLex}, ${m.fpAt5}, ${m.rAt10}, ${m.pAt5}, ${m.mrr}, ${m.medianTopScore},
       ${m.latencyP50Ms}, ${JSON.stringify(m.byClass)}::text::jsonb, ${m.costUsd ?? null}, ${m.notes ?? null})
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(rows[0]?.id ?? 0);
}
