/**
 * Stranded `admission_runs` reaper (WI-10004726; plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-008).
 *
 * A producer opens an `admission_runs` row with `detail.status='running'` and
 * settles it when the run ends. When the process dies mid-run, nothing settles
 * it, and the row reads as live work forever: the ledger then overstates
 * in-flight work and understates failures. Measured 2026-10-01: five
 * `promoter-tick` rows (oldest 2026-09-08) and one `durable-park-audit` row
 * (2026-09-15) were still 'running'.
 *
 * `bulk-stage` / `census` already have a lease reaper
 * (`reapStaleRunningAdmissionRuns` in work-items-admission-bulk-dedup.ts), but it
 * fires only when a bulk stage STARTS — and no stage had started since
 * 2026-09-05, so it never reached these rows. This reaper therefore runs from
 * the fail-open tick, the one admission action that fires every tick,
 * workspace-wide, independent of model spend.
 *
 * Each reapable kind has its own threshold, set well above that kind's measured
 * worst legitimate latency (2026-10-01, papercusp: promoter-tick p99 981s;
 * durable-park-audit max 15s; delta-sweep max 3135s; daily-digest max 1326s).
 * `bulk-stage` and `census` are deliberately NOT reapable here: they legitimately
 * resume an expired lease across ticks, and the lease reaper owns them.
 */
import type { OrgSql } from './work-items';

export const REAPABLE_ADMISSION_RUN_KINDS = [
  'promoter-tick',
  'durable-park-audit',
  'delta-sweep',
  'daily-digest',
] as const;

export type ReapableAdmissionRunKind = (typeof REAPABLE_ADMISSION_RUN_KINDS)[number];

const MINUTE_MS = 60_000;

/** A run still 'running' this long after it started is stranded, per kind. */
export const ADMISSION_RUN_STRANDED_AFTER_MS: Readonly<Record<ReapableAdmissionRunKind, number>> = {
  'promoter-tick': 120 * MINUTE_MS,
  'durable-park-audit': 60 * MINUTE_MS,
  'delta-sweep': 180 * MINUTE_MS,
  'daily-digest': 180 * MINUTE_MS,
};

/** The `detail.outcome.failureReason` a reaped row carries. */
export const STRANDED_ADMISSION_RUN_REASON = 'stranded';

export interface ReapedAdmissionRun {
  id: string;
  harnessSlug: string;
  runKind: string;
  startedAt: string;
}

/**
 * Settle every stranded run in the workspace as failed with reason `stranded`.
 * Rows of every harness are covered — the fail-open tick is workspace-wide, and
 * a per-harness reaper would leave the other harnesses' rows stranded. The
 * caller's own run id is never reaped.
 */
export async function reapStrandedAdmissionRuns(
  sql: OrgSql,
  input: {
    workspaceId: string;
    reaperRunId: string;
    nowMs: number;
    strandedAfterMs?: Partial<Record<ReapableAdmissionRunKind, number>>;
  },
): Promise<ReapedAdmissionRun[]> {
  const kinds: string[] = [];
  const thresholds: string[] = [];
  for (const kind of REAPABLE_ADMISSION_RUN_KINDS) {
    const ms = input.strandedAfterMs?.[kind] ?? ADMISSION_RUN_STRANDED_AFTER_MS[kind];
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`reapStrandedAdmissionRuns: stranded threshold for ${kind} must be a positive number of ms (got ${ms})`);
    }
    kinds.push(kind);
    thresholds.push(String(Math.round(ms)));
  }
  const nowIso = new Date(input.nowMs).toISOString();
  const rows = await sql<Array<{ id: string; harness_slug: string; run_kind: string; started_at: Date | string }>>`
    UPDATE harness_shared.admission_runs ar
       SET finished_at = clock_timestamp(),
           detail = jsonb_set(
             COALESCE(ar.detail, '{}'::jsonb) || jsonb_build_object(
               'status', 'failed',
               'error', 'reaped: still running past the ' || k.kind || ' stranded threshold with no finish (process died mid-run)',
               'reapedBy', ${input.reaperRunId}::text,
               'reapedAt', ${nowIso}::text,
               'strandedAfterMs', k.ms::bigint
             ),
             '{outcome,failureReason}',
             to_jsonb(${STRANDED_ADMISSION_RUN_REASON}::text),
             true
           )
      FROM unnest(${kinds}::text[], ${thresholds}::text[]) AS k(kind, ms)
     WHERE ar.workspace_id = ${input.workspaceId}
       AND ar.run_kind = k.kind
       AND ar.finished_at IS NULL
       AND ar.detail->>'status' = 'running'
       AND ar.started_at < ${nowIso}::timestamptz - (k.ms::bigint * interval '1 millisecond')
       AND ar.id <> ${input.reaperRunId}
     RETURNING ar.id, ar.harness_slug, ar.run_kind, ar.started_at`;
  return rows
    .map((row) => ({
      id: row.id,
      harnessSlug: row.harness_slug,
      runKind: row.run_kind,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}
