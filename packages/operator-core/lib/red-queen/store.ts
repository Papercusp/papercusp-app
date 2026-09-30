/**
 * store.ts — red_queen_drills persistence (migration 255)
 * (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * One row per drill, updated in place along the lifecycle:
 * planted → detected → triaged → resolved (| failed | expired). The read side
 * (`readDrillOutcomes`) is the FB-23 contract surface — gym judging signals
 * consume these rows as ground truth — and feeds the MTTSH vital sign
 * (computeMttshVitals → learning.redQueen resolver).
 *
 * PG idioms (insights jsonb-params-text-cast-across-pg-clients +
 * db-org-client-rejects-js-date-params): jsonb params travel as
 * `${JSON.stringify(x)}::text::jsonb`, timestamps as ISO strings — never
 * sql.json()/Date objects, which diverge across the live and test clients.
 */

import type { Sql } from 'postgres';
import type { TriageDecision } from '../harness/improvements/triage';
import {
  SANDBOX_WORKSPACE_ID,
  type DrillGroundTruth,
  type DrillOutcome,
  type DrillStatus,
  type LeakCheckResult,
  type MttshSegments,
} from './types';

interface DrillRowDb {
  id: string;
  workspace_id: string;
  drill_class: string;
  collector_family: string;
  status: DrillStatus;
  planted_at: string | Date;
  detected_at: string | Date | null;
  triaged_at: string | Date | null;
  resolved_at: string | Date | null;
  expected_watchdog_key: string;
  expected_kind: 'bug' | 'change';
  expected_severity: string;
  expected_decision: string | null;
  detected_watchdog_key: string | null;
  detected_kind: string | null;
  triaged_decision: string | null;
  triaged_idea_type: string | null;
  resolved_with_evidence: boolean;
  issue_id: string | null;
  mttsh_detect_ms: string | number | null;
  mttsh_triage_ms: string | number | null;
  mttsh_fix_ms: string | number | null;
  mttsh_total_ms: string | number | null;
  leak_check_passed: boolean | null;
}

const DRILL_COLS = `id, workspace_id, drill_class, collector_family, status, planted_at, detected_at,
  triaged_at, resolved_at, expected_watchdog_key, expected_kind, expected_severity, expected_decision,
  detected_watchdog_key, detected_kind, triaged_decision, triaged_idea_type, resolved_with_evidence,
  issue_id, mttsh_detect_ms, mttsh_triage_ms, mttsh_fix_ms, mttsh_total_ms, leak_check_passed`;

const iso = (v: string | Date | null): string | undefined =>
  v == null ? undefined : v instanceof Date ? v.toISOString() : String(v);

const num = (v: string | number | null): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function toOutcome(r: DrillRowDb): DrillOutcome {
  const mttsh: MttshSegments = {};
  const d = num(r.mttsh_detect_ms);
  const t = num(r.mttsh_triage_ms);
  const f = num(r.mttsh_fix_ms);
  const tot = num(r.mttsh_total_ms);
  if (d !== undefined) mttsh.detectMs = d;
  if (t !== undefined) mttsh.triageMs = t;
  if (f !== undefined) mttsh.fixMs = f;
  if (tot !== undefined) mttsh.totalMs = tot;
  return {
    drillId: r.id,
    drillClass: r.drill_class,
    collectorFamily: r.collector_family,
    plantedAt: iso(r.planted_at)!,
    detectedAt: iso(r.detected_at),
    triagedAt: iso(r.triaged_at),
    resolvedAt: iso(r.resolved_at),
    expectedWatchdogKey: r.expected_watchdog_key,
    expectedKind: r.expected_kind,
    expectedSeverity: r.expected_severity,
    expectedDecision: (r.expected_decision ?? undefined) as TriageDecision | undefined,
    detectedWatchdogKey: r.detected_watchdog_key ?? undefined,
    detectedKind: r.detected_kind ?? undefined,
    triagedDecision: r.triaged_decision ?? undefined,
    triagedIdeaType: r.triaged_idea_type ?? undefined,
    resolvedWithEvidence: r.resolved_with_evidence,
    issueId: r.issue_id ?? undefined,
    ...(Object.keys(mttsh).length ? { mttsh } : {}),
    ...(r.leak_check_passed == null ? {} : { leakCheckPassed: r.leak_check_passed }),
    status: r.status,
    origin: 'drill',
  };
}

export interface InsertDrillInput extends DrillGroundTruth {
  workspaceId: string;
  drillClass: string;
  collectorFamily: string;
  artifacts: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

/**
 * Open a drill row at plant time. The partial unique index (one OPEN drill per
 * class per workspace) rejects a plant over an in-flight drill — callers treat
 * the 23505 as "skip this class this tick", never an error to swallow blindly.
 */
export async function insertDrillRow(sql: Sql, input: InsertDrillInput): Promise<{ drillId: string; plantedAt: string }> {
  const rows = await sql<{ id: string; planted_at: string | Date }[]>`
    INSERT INTO harness_shared.red_queen_drills
      (workspace_id, drill_class, collector_family, status,
       expected_watchdog_key, expected_kind, expected_severity, expected_decision,
       planted_artifacts, payload)
    VALUES (${input.workspaceId}, ${input.drillClass}, ${input.collectorFamily}, 'planted',
            ${input.expectedWatchdogKey}, ${input.expectedKind}, ${input.expectedSeverity},
            ${input.expectedDecision ?? null},
            ${JSON.stringify(input.artifacts)}::text::jsonb,
            ${input.payload ? JSON.stringify(input.payload) : null}::text::jsonb)
    RETURNING id, planted_at`;
  return { drillId: rows[0].id, plantedAt: iso(rows[0].planted_at)! };
}

export async function updateDrillDetected(
  sql: Sql,
  drillId: string,
  d: { detectedAt: string; detectedWatchdogKey: string; detectedKind?: string; issueId: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.red_queen_drills
       SET status = 'detected', detected_at = ${d.detectedAt},
           detected_watchdog_key = ${d.detectedWatchdogKey},
           detected_kind = ${d.detectedKind ?? null}, issue_id = ${d.issueId}, updated_at = now()
     WHERE id = ${drillId}`;
}

export async function updateDrillTriaged(
  sql: Sql,
  drillId: string,
  d: { triagedAt: string; triagedDecision: string; triagedIdeaType?: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.red_queen_drills
       SET status = 'triaged', triaged_at = ${d.triagedAt},
           triaged_decision = ${d.triagedDecision},
           triaged_idea_type = ${d.triagedIdeaType ?? null}, updated_at = now()
     WHERE id = ${drillId}`;
}

export async function updateDrillResolved(
  sql: Sql,
  drillId: string,
  d: { resolvedAt: string; resolvedWithEvidence: boolean; mttsh: MttshSegments; leakCheck: LeakCheckResult },
): Promise<void> {
  await sql`
    UPDATE harness_shared.red_queen_drills
       SET status = 'resolved', resolved_at = ${d.resolvedAt},
           resolved_with_evidence = ${d.resolvedWithEvidence},
           mttsh_detect_ms = ${d.mttsh.detectMs ?? null},
           mttsh_triage_ms = ${d.mttsh.triageMs ?? null},
           mttsh_fix_ms = ${d.mttsh.fixMs ?? null},
           mttsh_total_ms = ${d.mttsh.totalMs ?? null},
           leak_check_passed = ${d.leakCheck.passed},
           leak_check = ${JSON.stringify(d.leakCheck)}::text::jsonb,
           updated_at = now()
     WHERE id = ${drillId}`;
}

export async function markDrillFailed(sql: Sql, drillId: string, error: string, leakCheck?: LeakCheckResult): Promise<void> {
  await sql`
    UPDATE harness_shared.red_queen_drills
       SET status = 'failed', error = ${error.slice(0, 2000)},
           leak_check_passed = ${leakCheck ? leakCheck.passed : null},
           leak_check = ${leakCheck ? JSON.stringify(leakCheck) : null}::text::jsonb,
           updated_at = now()
     WHERE id = ${drillId}`;
}

/** Hygiene: any OPEN drill older than the deadline flips 'expired' (count returned). */
export async function expireStaleDrills(sql: Sql, workspaceId: string, olderThanHours = 24): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.red_queen_drills
       SET status = 'expired', updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND status IN ('planted', 'detected', 'triaged')
       AND planted_at < now() - make_interval(hours => ${olderThanHours})
     RETURNING id`;
  return rows.length;
}

export interface ReadDrillOutcomesOpts {
  workspaceId?: string;
  classId?: string;
  sinceTs?: string;
  limit?: number;
}

/**
 * The Learning tab's vital-sign snapshot (learning.redQueen resolver): the
 * MTTSH vitals computed over the sandbox's recent drill outcomes.
 */
export async function readMttshVitalsSnapshot(
  sql: Sql,
  workspaceId: string = SANDBOX_WORKSPACE_ID,
): Promise<import('./mttsh').MttshVitals> {
  const { computeMttshVitals } = await import('./mttsh');
  const outcomes = await readDrillOutcomes(sql, { workspaceId, limit: 500 });
  return computeMttshVitals(outcomes);
}

/** The FB-23 read contract: outcome rows, newest first. */
export async function readDrillOutcomes(sql: Sql, opts: ReadDrillOutcomesOpts = {}): Promise<DrillOutcome[]> {
  const rows = await sql<DrillRowDb[]>`
    SELECT ${sql.unsafe(DRILL_COLS)}
      FROM harness_shared.red_queen_drills
     WHERE ${opts.workspaceId ? sql`workspace_id = ${opts.workspaceId}` : sql`TRUE`}
       AND ${opts.classId ? sql`drill_class = ${opts.classId}` : sql`TRUE`}
       AND ${opts.sinceTs ? sql`planted_at >= ${opts.sinceTs}` : sql`TRUE`}
     ORDER BY planted_at DESC
     LIMIT ${Math.min(Math.max(1, opts.limit ?? 200), 2000)}`;
  return rows.map(toOutcome);
}
