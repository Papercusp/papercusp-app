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

/**
 * One memory-precision monitor fire's outcome (WI-10004133, migration 1259). A bench row
 * exists only for `recorded`; this is the durable answer to "why did the last fire produce
 * no row", which the journal and dbos.workflow_status forget within about three days.
 */
export type MemoryPrecisionAttemptOutcome = 'recorded' | 'failed' | 'flag-off';
export type MemoryPrecisionAttemptStage = 'bench' | 'record';

export interface MemoryPrecisionAttempt {
  attemptedAt: string;
  outcome: MemoryPrecisionAttemptOutcome;
  /** `failed` only: which step threw. */
  stage: MemoryPrecisionAttemptStage | null;
  /** `failed` only: the error message, clipped to {@link PRECISION_ATTEMPT_ERROR_MAX_CHARS}. */
  error: string | null;
  /** `recorded` only: the memory_precision_bench row this fire wrote. */
  rowId: number | null;
  /** Whether this fire measured the Jev-gated push path. */
  jevGate: boolean;
}

/** The write shape for one attempt row. */
export type MemoryPrecisionAttemptInput =
  | { outcome: 'recorded'; rowId: number; jevGate: boolean }
  | { outcome: 'failed'; stage: MemoryPrecisionAttemptStage; error: string; jevGate: boolean }
  | { outcome: 'flag-off' };

/** Errors are stored for diagnosis, not as logs: a long stack is clipped to this. */
export const PRECISION_ATTEMPT_ERROR_MAX_CHARS = 2_000;

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
  /**
   * The newest monitor fire's outcome, or null when none is recorded (never fired, or
   * migration 1259 not applied yet). When it is `failed` or `flag-off` and newer than
   * `latest`, it says why the trend did not move.
   */
  lastAttempt: MemoryPrecisionAttempt | null;
}

/** The never-benchmarked / table-missing state — the card renders its empty state. */
export const EMPTY_PRECISION_SNAPSHOT: MemoryPrecisionSnapshot = {
  latest: null,
  trend: [],
  fpAt5Delta: null,
  runCount: 0,
  lastAttempt: null,
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

  const lastAttempt = await readLatestPrecisionAttempt(sql, workspaceId);
  return { latest, trend, fpAt5Delta, runCount, lastAttempt };
}

const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set(['recorded', 'failed', 'flag-off']);
const ATTEMPT_STAGES: ReadonlySet<string> = new Set(['bench', 'record']);

/** Map one attempts row; anything that is not a well-formed attempt maps to null. */
function mapAttempt(r: Record<string, unknown> | undefined): MemoryPrecisionAttempt | null {
  if (!r || typeof r.outcome !== 'string' || !ATTEMPT_OUTCOMES.has(r.outcome)) return null;
  const at = r.attempted_at instanceof Date ? r.attempted_at.toISOString() : String(r.attempted_at ?? '');
  if (!at) return null;
  const stage = typeof r.stage === 'string' && ATTEMPT_STAGES.has(r.stage) ? (r.stage as MemoryPrecisionAttemptStage) : null;
  return {
    attemptedAt: at,
    outcome: r.outcome as MemoryPrecisionAttemptOutcome,
    stage,
    error: r.error == null ? null : String(r.error),
    rowId: r.row_id == null ? null : Number(r.row_id),
    jevGate: r.jev_gate === true,
  };
}

/**
 * The newest monitor fire's outcome for one workspace. A missing table (migration 1259
 * not applied) or any read failure is null: the caller then knows only what the bench
 * trend says, which is exactly the pre-1259 behaviour.
 */
export async function readLatestPrecisionAttempt(
  sql: Sql,
  workspaceId: string,
): Promise<MemoryPrecisionAttempt | null> {
  try {
    const rows = (await sql`
      SELECT attempted_at, outcome, stage, error, row_id, jev_gate
        FROM harness_shared.memory_precision_bench_attempts
       WHERE workspace_id = ${workspaceId}
       ORDER BY attempted_at DESC, id DESC
       LIMIT 1
    `) as Array<Record<string, unknown>>;
    return mapAttempt(rows[0]);
  } catch {
    return null;
  }
}

/**
 * One line for a health verdict: what the latest recorded fire did. Null when no attempt
 * is recorded, which since migration 1259 means the monitor never ran or its process died
 * before it could record an outcome.
 */
export function describePrecisionAttempt(a: MemoryPrecisionAttempt | null): string | null {
  if (!a) return null;
  if (a.outcome === 'failed') return `last attempt ${a.attemptedAt} failed at ${a.stage ?? 'unknown stage'}: ${a.error ?? '(no error text)'}`;
  if (a.outcome === 'flag-off') return `last attempt ${a.attemptedAt} skipped: the memory-precision bench flag was off`;
  return `last attempt ${a.attemptedAt} recorded bench row #${a.rowId ?? '?'}`;
}

/** Record one monitor fire's outcome. Returns the new attempt id. */
export async function recordMemoryPrecisionAttempt(
  sql: Sql,
  workspaceId: string,
  a: MemoryPrecisionAttemptInput,
): Promise<number> {
  const stage = a.outcome === 'failed' ? a.stage : null;
  const error = a.outcome === 'failed' ? a.error.slice(0, PRECISION_ATTEMPT_ERROR_MAX_CHARS) || '(empty error)' : null;
  const rowId = a.outcome === 'recorded' ? a.rowId : null;
  const jevGate = a.outcome === 'flag-off' ? false : a.jevGate;
  const rows = (await sql`
    INSERT INTO harness_shared.memory_precision_bench_attempts
      (workspace_id, outcome, stage, error, row_id, jev_gate)
    VALUES (${workspaceId}, ${a.outcome}, ${stage}, ${error}, ${rowId}, ${jevGate})
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(rows[0]?.id ?? 0);
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
