/**
 * Calibration-markets STORE (P-041 / FB-13) — SQL over migration 253
 * (harness_shared.calibration_predictions). Helpers take an injected `Sql`
 * (control-plane style, mirrors learning-governor/store.ts) so the capture
 * seam, the resolution sweep, the ranker feature, and tests share one core;
 * SQL is covered by store.integration.test.ts.
 *
 * Provenance discipline (frontier D-002): every read here defaults to
 * organic-only; drill/replay/shadow rows are reachable only via an explicit
 * `origins` opt-in.
 *
 * Timestamp params are ISO STRINGS throughout — getOrgPg's live client
 * rejects JS Date params (agent-insights/db-org-client-rejects-js-date-params).
 */
import type { Sql } from 'postgres';
import { ORGANIC_ONLY, type SignalOrigin } from '../harness/improvements/provenance';
import { calibrationWeight } from './scoring';
import type { CalibrationScore, PredictionRow } from './types';

type Row = Record<string, unknown>;
const ts = (v: unknown): number => new Date(v as string | Date).getTime();
const tsOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ts(v));

function mapRow(r: Row): PredictionRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    predictor: String(r.predictor),
    domain: String(r.domain),
    subjectKind: String(r.subject_kind),
    subjectId: String(r.subject_id),
    claim: String(r.claim),
    probability: Number(r.probability),
    stated: r.stated === true || r.stated === 't',
    origin: String(r.signal_origin) as SignalOrigin,
    watchdogKey: r.watchdog_key === null || r.watchdog_key === undefined ? null : String(r.watchdog_key),
    horizonTs: ts(r.horizon_ts),
    createdAt: ts(r.created_at),
    resolvedAt: tsOrNull(r.resolved_at),
    outcome: r.outcome === null || r.outcome === undefined ? null : r.outcome === true || r.outcome === 't',
    resolutionNote: r.resolution_note === null || r.resolution_note === undefined ? null : String(r.resolution_note),
    potSlug: r.pot_slug === null || r.pot_slug === undefined ? null : String(r.pot_slug),
  };
}

const COLS = `id, workspace_id, predictor, domain, subject_kind, subject_id, claim, probability,
  stated, signal_origin, watchdog_key, horizon_ts, created_at, resolved_at, outcome, resolution_note,
  pot_slug`;

export interface InsertPredictionInput {
  workspaceId: string;
  predictor: string;
  domain: string;
  subjectKind: string;
  subjectId: string;
  claim: string;
  probability: number;
  stated: boolean;
  origin: SignalOrigin;
  watchdogKey?: string | null;
  /** ISO timestamp the bet matures at. */
  horizonTs: string;
  /**
   * The pot the predictor works under (P-002 pot-scope-all-learnings) — resolve
   * via resolveLearningPotSlug at the capture seam. Required so no writer forgets
   * the scope; explicit null = genuinely context-less (D-002).
   */
  potSlug: string | null;
}

/**
 * Record one bet. Idempotent per open lane: a second open bet by the same
 * predictor on the same domain × subject no-ops (the 253 partial unique
 * index) — re-resolving an item re-records cheaply without double-counting.
 */
export async function insertPrediction(
  sql: Sql,
  q: InsertPredictionInput,
): Promise<{ created: boolean; id: string | null }> {
  const rows = await sql`
    INSERT INTO harness_shared.calibration_predictions
      (workspace_id, predictor, domain, subject_kind, subject_id, claim, probability, stated,
       signal_origin, watchdog_key, horizon_ts, pot_slug)
    VALUES (${q.workspaceId}, ${q.predictor}, ${q.domain}, ${q.subjectKind}, ${q.subjectId},
      ${q.claim}, ${q.probability}, ${q.stated}, ${q.origin}, ${q.watchdogKey ?? null}, ${q.horizonTs},
      ${q.potSlug})
    ON CONFLICT (workspace_id, predictor, domain, subject_kind, subject_id)
      WHERE resolved_at IS NULL DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? { created: true, id: String(rows[0].id) } : { created: false, id: null };
}

/** Open bets whose horizon has passed — the sweep's work list (oldest first). */
export async function listMaturedUnresolved(
  sql: Sql,
  q: { workspaceId: string; nowIso: string; limit?: number },
): Promise<PredictionRow[]> {
  const rows = await sql.unsafe(
    `SELECT ${COLS} FROM harness_shared.calibration_predictions
      WHERE workspace_id = $1 AND resolved_at IS NULL AND horizon_ts <= $2
      ORDER BY horizon_ts ASC
      LIMIT $3`,
    [q.workspaceId, q.nowIso, q.limit ?? 200],
  );
  return rows.map(mapRow);
}

/** Score a matured bet. Only flips OPEN rows (resolution is once). */
export async function resolvePrediction(
  sql: Sql,
  q: { id: string; outcome: boolean; note?: string; nowIso: string },
): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.calibration_predictions
       SET resolved_at = ${q.nowIso}, outcome = ${q.outcome}, resolution_note = ${q.note ?? null}
     WHERE id = ${q.id} AND resolved_at IS NULL
     RETURNING id
  `;
  return rows.length > 0;
}

/** Close a matured bet as unscorable (probe undeterminable past grace) — outcome stays NULL, never scored. */
export async function voidPrediction(
  sql: Sql,
  q: { id: string; note: string; nowIso: string },
): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.calibration_predictions
       SET resolved_at = ${q.nowIso}, resolution_note = ${q.note}
     WHERE id = ${q.id} AND resolved_at IS NULL
     RETURNING id
  `;
  return rows.length > 0;
}

/** Open bets on the given subjects (the ranker feature's lookup). */
export async function openBetsForSubjects(
  sql: Sql,
  q: { workspaceId: string; subjectIds: readonly string[]; origins?: readonly SignalOrigin[] },
): Promise<PredictionRow[]> {
  if (q.subjectIds.length === 0) return [];
  const origins = [...(q.origins ?? ORGANIC_ONLY)];
  const rows = await sql.unsafe(
    `SELECT ${COLS} FROM harness_shared.calibration_predictions
      WHERE workspace_id = $1 AND resolved_at IS NULL
        AND subject_id = ANY($2::text[]) AND signal_origin = ANY($3::text[])`,
    [q.workspaceId, [...q.subjectIds], origins],
  );
  return rows.map(mapRow);
}

/**
 * Per-subject count of FAILED fix-survival bets — "this fix bounced before",
 * the strongest single attention signal calibration carries.
 */
export async function bouncedFixCounts(
  sql: Sql,
  q: { workspaceId: string; subjectIds: readonly string[]; origins?: readonly SignalOrigin[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (q.subjectIds.length === 0) return out;
  const origins = [...(q.origins ?? ORGANIC_ONLY)];
  const rows = await sql`
    SELECT subject_id, count(*)::int AS bounced
      FROM harness_shared.calibration_predictions
     WHERE workspace_id = ${q.workspaceId} AND domain = 'fix-survival' AND outcome = false
       AND subject_id = ANY(${[...q.subjectIds]}::text[])
       AND signal_origin = ANY(${origins}::text[])
     GROUP BY subject_id
  `;
  for (const r of rows) out.set(String(r.subject_id), Number(r.bounced));
  return out;
}

/** Open-bet rollup by domain (the calibration:summary read). */
export async function openBetCounts(
  sql: Sql,
  q: { workspaceId: string; origins?: readonly SignalOrigin[] },
): Promise<Array<{ domain: string; open: number; matured: number }>> {
  const origins = [...(q.origins ?? ORGANIC_ONLY)];
  const rows = await sql`
    SELECT domain, count(*)::int AS open,
           count(*) FILTER (WHERE horizon_ts <= now())::int AS matured
      FROM harness_shared.calibration_predictions
     WHERE workspace_id = ${q.workspaceId} AND resolved_at IS NULL
       AND signal_origin = ANY(${origins}::text[])
     GROUP BY domain ORDER BY domain
  `;
  return rows.map((r) => ({ domain: String(r.domain), open: Number(r.open), matured: Number(r.matured) }));
}

/**
 * Per-persona per-domain Brier aggregate over SCORED organic bets (voided
 * rows excluded), weight attached via scoring.calibrationWeight.
 */
export async function calibrationScores(
  sql: Sql,
  q: { workspaceId: string; domain?: string; predictor?: string; origins?: readonly SignalOrigin[] },
): Promise<CalibrationScore[]> {
  const origins = [...(q.origins ?? ORGANIC_ONLY)];
  const rows = await sql`
    SELECT predictor, domain, count(*)::int AS n,
           avg(power(probability - (CASE WHEN outcome THEN 1.0 ELSE 0.0 END), 2)) AS brier,
           avg(CASE WHEN outcome THEN 1.0 ELSE 0.0 END) AS base_rate
      FROM harness_shared.calibration_predictions
     WHERE workspace_id = ${q.workspaceId} AND outcome IS NOT NULL
       AND signal_origin = ANY(${origins}::text[])
       AND ${q.domain ? sql`domain = ${q.domain}` : sql`TRUE`}
       AND ${q.predictor ? sql`predictor = ${q.predictor}` : sql`TRUE`}
     GROUP BY predictor, domain
     ORDER BY predictor, domain
  `;
  return rows.map((r) => {
    const n = Number(r.n);
    const brier = Number(r.brier);
    return {
      predictor: String(r.predictor),
      domain: String(r.domain),
      n,
      brier,
      baseRate: Number(r.base_rate),
      weight: calibrationWeight(brier, n),
    };
  });
}
