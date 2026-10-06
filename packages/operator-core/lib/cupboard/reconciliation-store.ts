/**
 * Postgres persistence for reconciliation (agent-economy-flywheel-2026-08-30
 * P-043, D-025; schema: migration 1291).
 *
 *   - pgReconciliationStore: the engine's ReconciliationStore. A break episode
 *     is one reconciliation_breaks row; a partial unique index allows at most one
 *     OPEN row per (workspace, invariant), so `openBreak` loses a concurrent
 *     insert cleanly (`false`) and the losing run files no second work item.
 *   - readReconciliationStatus: the latest runs and the open breaks, for the
 *     cupboard:reconciliation tool.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  RECONCILIATION_INVARIANTS,
  type InvariantVerdict,
  type OpenBreak,
  type ReconciliationInvariant,
  type ReconciliationRunRecord,
  type ReconciliationStore,
} from './reconciliation';

/** The column's CHECK bound; a longer detail is cut, never refused. */
const DETAIL_MAX = 4000;

function clipDetail(detail: string): string {
  return detail.length <= DETAIL_MAX ? detail : `${detail.slice(0, DETAIL_MAX - 1)}…`;
}

function toMs(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`reconciliation store: unreadable timestamp ${String(value)}`);
  return ms;
}

function asInvariant(value: string): ReconciliationInvariant {
  if (!(RECONCILIATION_INVARIANTS as readonly string[]).includes(value)) {
    throw new Error(`reconciliation store: unknown invariant ${value}`);
  }
  return value as ReconciliationInvariant;
}

interface BreakRow {
  invariant: string;
  work_item_id: string | null;
  opened_at: Date | string;
  opened_by_run: string;
}

/** `harness_shared.reconciliation_breaks` + `harness_shared.reconciliation_runs` (migration 1291). */
export function pgReconciliationStore(sql?: Sql): ReconciliationStore {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async listOpenBreaks(workspaceId) {
      // The opening run's mode comes from its run row, which is recorded at the
      // end of the run: a break whose opener died first has no mode (provisional).
      const rows = (await db().unsafe(
        `SELECT b.invariant, b.work_item_id, b.opened_at, b.opened_by_run, r.mode AS opened_mode
           FROM harness_shared.reconciliation_breaks b
           LEFT JOIN harness_shared.reconciliation_runs r ON r.run_id = b.opened_by_run
          WHERE b.workspace_id = $1 AND b.resolved_at IS NULL
          ORDER BY b.opened_at ASC, b.invariant ASC`,
        [workspaceId],
      )) as unknown as Array<BreakRow & { opened_mode: 'provisional' | 'final' | null }>;
      return rows.map(
        (row): OpenBreak => ({
          invariant: asInvariant(row.invariant),
          workItemId: row.work_item_id,
          openedAtMs: toMs(row.opened_at),
          openedByRunId: row.opened_by_run,
          ...(row.opened_mode ? { openedMode: row.opened_mode } : {}),
        }),
      );
    },

    async openBreak(workspaceId, b, detail) {
      const rows = (await db().unsafe(
        `INSERT INTO harness_shared.reconciliation_breaks
           (workspace_id, invariant, work_item_id, opened_at, opened_by_run, last_run_id, detail)
         VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), $5, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [workspaceId, b.invariant, b.workItemId, b.openedAtMs, b.openedByRunId, clipDetail(detail)],
      )) as unknown as Array<{ id: string | number }>;
      return rows.length === 1;
    },

    async setBreakWorkItem(workspaceId, invariant, workItemId) {
      await db().unsafe(
        `UPDATE harness_shared.reconciliation_breaks
            SET work_item_id = $3, updated_at = now()
          WHERE workspace_id = $1 AND invariant = $2 AND resolved_at IS NULL`,
        [workspaceId, invariant, workItemId],
      );
    },

    async touchBreak(workspaceId, invariant, runId, detail) {
      await db().unsafe(
        `UPDATE harness_shared.reconciliation_breaks
            SET last_run_id = $3, detail = $4, updated_at = now()
          WHERE workspace_id = $1 AND invariant = $2 AND resolved_at IS NULL`,
        [workspaceId, invariant, runId, clipDetail(detail)],
      );
    },

    async resolveBreak(workspaceId, invariant, runId, atMs) {
      await db().unsafe(
        `UPDATE harness_shared.reconciliation_breaks
            SET resolved_at = GREATEST(opened_at, to_timestamp($4::double precision / 1000)),
                resolved_by_run = $3, last_run_id = $3, updated_at = now()
          WHERE workspace_id = $1 AND invariant = $2 AND resolved_at IS NULL`,
        [workspaceId, invariant, runId, atMs],
      );
    },

    async recordRun(run: ReconciliationRunRecord) {
      // A retried workflow step re-records the same run id: idempotent, first write wins.
      await db().unsafe(
        `INSERT INTO harness_shared.reconciliation_runs
           (workspace_id, run_id, mode, month, period_from, period_until, started_at, finished_at,
            verdicts, opened, resolved, gate_open, gate, gate_publish)
         VALUES ($1, $2, $3, $4,
                 to_timestamp($5::double precision / 1000), to_timestamp($6::double precision / 1000),
                 to_timestamp($7::double precision / 1000), to_timestamp($8::double precision / 1000),
                 $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14::jsonb)
         ON CONFLICT (workspace_id, run_id) DO NOTHING`,
        [
          run.workspaceId,
          run.runId,
          run.period.mode,
          run.period.month,
          run.period.fromMs,
          run.period.untilMs,
          run.startedAtMs,
          run.finishedAtMs,
          JSON.stringify(run.verdicts),
          JSON.stringify(run.opened),
          JSON.stringify(run.resolved),
          run.gate.open,
          JSON.stringify(run.gate),
          JSON.stringify(run.gatePublish),
        ],
      );
    },
  };
}

export interface ReconciliationRunSummary {
  readonly runId: string;
  readonly mode: 'provisional' | 'final';
  readonly month: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly gateOpen: boolean;
  readonly gateReasons: readonly string[];
  readonly gatePublished: boolean;
  readonly gatePublishDetail: string | null;
  readonly verdicts: readonly InvariantVerdict[];
  readonly opened: readonly string[];
  readonly resolved: readonly string[];
}

export interface OpenBreakDetail {
  readonly invariant: ReconciliationInvariant;
  readonly workItemId: string | null;
  readonly openedAt: string;
  readonly openedByRunId: string;
  readonly lastRunId: string;
  readonly detail: string;
}

export interface ReconciliationStatus {
  readonly workspaceId: string;
  readonly latest: ReconciliationRunSummary | null;
  readonly latestFinal: ReconciliationRunSummary | null;
  readonly recent: readonly ReconciliationRunSummary[];
  readonly openBreaks: readonly OpenBreakDetail[];
}

interface RunRow {
  run_id: string;
  mode: 'provisional' | 'final';
  month: string;
  started_at: Date | string;
  finished_at: Date | string;
  gate_open: boolean;
  gate: { reasons?: unknown } | null;
  gate_publish: { published?: unknown; detail?: unknown } | null;
  verdicts: unknown;
  opened: unknown;
  resolved: unknown;
}

const iso = (value: Date | string): string => new Date(toMs(value)).toISOString();

function summarize(row: RunRow): ReconciliationRunSummary {
  const reasons = Array.isArray(row.gate?.reasons) ? row.gate.reasons.map(String) : [];
  const published = row.gate_publish?.published === true;
  return {
    runId: row.run_id,
    mode: row.mode,
    month: row.month,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    gateOpen: row.gate_open,
    gateReasons: reasons,
    gatePublished: published,
    gatePublishDetail: published ? null : typeof row.gate_publish?.detail === 'string' ? row.gate_publish.detail : null,
    verdicts: Array.isArray(row.verdicts) ? (row.verdicts as InvariantVerdict[]) : [],
    opened: Array.isArray(row.opened) ? row.opened.map(String) : [],
    resolved: Array.isArray(row.resolved) ? row.resolved.map(String) : [],
  };
}

/** The latest runs (newest first, at most `limit`), the latest final run, and every open break. */
export async function readReconciliationStatus(
  workspaceId: string,
  opts: { limit?: number; sql?: Sql } = {},
): Promise<ReconciliationStatus> {
  const db = opts.sql ?? getOrgPg().sql;
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const runCols = `run_id, mode, month, started_at, finished_at, gate_open, gate, gate_publish, verdicts, opened, resolved`;
  const [recent, finals, breaks] = await Promise.all([
    db.unsafe(
      `SELECT ${runCols} FROM harness_shared.reconciliation_runs
        WHERE workspace_id = $1 ORDER BY finished_at DESC, run_id DESC LIMIT $2`,
      [workspaceId, limit],
    ) as unknown as Promise<RunRow[]>,
    db.unsafe(
      `SELECT ${runCols} FROM harness_shared.reconciliation_runs
        WHERE workspace_id = $1 AND mode = 'final' ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
      [workspaceId],
    ) as unknown as Promise<RunRow[]>,
    db.unsafe(
      `SELECT invariant, work_item_id, opened_at, opened_by_run, last_run_id, detail
         FROM harness_shared.reconciliation_breaks
        WHERE workspace_id = $1 AND resolved_at IS NULL
        ORDER BY opened_at ASC, invariant ASC`,
      [workspaceId],
    ) as unknown as Promise<Array<BreakRow & { last_run_id: string; detail: string }>>,
  ]);
  const summaries = recent.map(summarize);
  return {
    workspaceId,
    latest: summaries[0] ?? null,
    latestFinal: finals[0] ? summarize(finals[0]) : null,
    recent: summaries,
    openBreaks: breaks.map((row) => ({
      invariant: asInvariant(row.invariant),
      workItemId: row.work_item_id,
      openedAt: iso(row.opened_at),
      openedByRunId: row.opened_by_run,
      lastRunId: row.last_run_id,
      detail: row.detail,
    })),
  };
}
