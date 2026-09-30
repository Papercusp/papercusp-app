/**
 * ekg-read.ts — the read behind the Learning tab's Fleet EKG panel
 * (self-learning-frontier-2026-06-12 P-030 / FB-10; `learning.ekg` resolver).
 *
 * Snapshot of fleet_ekg_shifts + session-vector vitals for one workspace:
 * recent shift reports newest first, plus the header rollups. Pure projection
 * over fetched rows (snapshot shape unit-tested without PG);
 * readEkgSnapshot is the thin SQL leg the resolver wires.
 */

import type { Sql } from 'postgres';
import type { LedgerCandidate } from './drift';

export interface EkgShiftEntry {
  id: number;
  windowDate: string;
  feature: string;
  kind: string;
  score: number;
  severity: string;
  direction: string | null;
  baselineSummary: number | null;
  windowSummary: number | null;
  windowSessions: number;
  baselineSessions: number;
  attributed: boolean;
  ledgerCandidates: LedgerCandidate[];
  notifiedAt: string | null;
}

export interface EkgSnapshot {
  shifts: EkgShiftEntry[];
  /** All shift rows for the workspace (not just the page returned). */
  totalShifts: number;
  /** Shift rows with no ledger candidate — the D-003 alarm class. */
  unattributedShifts: number;
  /** Embedded session vectors, total / trailing 7 days. */
  sessionsEmbedded: number;
  sessions7d: number;
  /** Newest vector write — when the EKG last embedded (null = never ran). */
  scannedAt: string | null;
}

export interface EkgShiftRow {
  id: number;
  window_date: string | Date;
  feature: string;
  kind: string;
  score: number;
  severity: string;
  direction: string | null;
  baseline_summary: number | null;
  window_summary: number | null;
  window_sessions: number;
  baseline_sessions: number;
  attributed: boolean;
  ledger_candidates: LedgerCandidate[] | null;
  notified_at: string | Date | null;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: string | Date): string => iso(v).slice(0, 10);

/** Pure: shift rows + vitals → panel snapshot (newest `limit` shifts). */
export function ekgSnapshotFromRows(
  rows: EkgShiftRow[],
  vitals: { sessionsEmbedded: number; sessions7d: number; scannedAt: string | null },
  limit = 30,
): EkgSnapshot {
  const sorted = [...rows].sort((a, b) => dateOnly(b.window_date).localeCompare(dateOnly(a.window_date)) || b.score - a.score);
  return {
    shifts: sorted.slice(0, limit).map((r) => ({
      id: Number(r.id),
      windowDate: dateOnly(r.window_date),
      feature: r.feature,
      kind: r.kind,
      score: Number(r.score),
      severity: r.severity,
      direction: r.direction,
      baselineSummary: r.baseline_summary === null ? null : Number(r.baseline_summary),
      windowSummary: r.window_summary === null ? null : Number(r.window_summary),
      windowSessions: r.window_sessions,
      baselineSessions: r.baseline_sessions,
      attributed: r.attributed,
      ledgerCandidates: Array.isArray(r.ledger_candidates) ? r.ledger_candidates : [],
      notifiedAt: r.notified_at == null ? null : iso(r.notified_at),
    })),
    totalShifts: rows.length,
    unattributedShifts: rows.filter((r) => !r.attributed).length,
    sessionsEmbedded: vitals.sessionsEmbedded,
    sessions7d: vitals.sessions7d,
    scannedAt: vitals.scannedAt,
  };
}

export async function readEkgSnapshot(sql: Sql, workspaceId: string, limit = 30): Promise<EkgSnapshot> {
  const rows = await sql<EkgShiftRow[]>`
    SELECT id, window_date, feature, kind, score, severity, direction,
           baseline_summary, window_summary, window_sessions, baseline_sessions,
           attributed, ledger_candidates, notified_at
      FROM harness_shared.fleet_ekg_shifts
     WHERE workspace_id = ${workspaceId}`;
  const vitals = await sql<{ total: number; recent: number; scanned_at: string | Date | null }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ended_at > now() - interval '7 days')::int AS recent,
           max(computed_at) AS scanned_at
      FROM harness_shared.fleet_ekg_sessions
     WHERE workspace_id = ${workspaceId}`;
  const v = vitals[0];
  return ekgSnapshotFromRows(
    rows,
    {
      sessionsEmbedded: v?.total ?? 0,
      sessions7d: v?.recent ?? 0,
      scannedAt: v?.scanned_at == null ? null : iso(v.scanned_at),
    },
    limit,
  );
}

export const EMPTY_EKG_SNAPSHOT: EkgSnapshot = {
  shifts: [],
  totalShifts: 0,
  unattributedShifts: 0,
  sessionsEmbedded: 0,
  sessions7d: 0,
  scannedAt: null,
};
