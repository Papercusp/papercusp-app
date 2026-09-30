/**
 * dbos-workflow-gc — prune old TERMINAL DBOS system rows
 * (infra-self-healing-supervision-2026-06-19, R4-5; EI-1607 defense-in-depth).
 *
 * `dbos.workflow_status` grew to 325k+ rows (operation_outputs 484k) with NO retention —
 * every completed workflow accrues forever, bloating the system DB and slowing the
 * scheduler/recovery scans that walk it (a contributor to routinesTick latency). DBOS
 * 4.18 ships no built-in GC, so this mirrors the codebase's existing hand-rolled GC
 * workflows (coordNotifyGc, outboxBackstopGc): delete workflows in a TERMINAL status
 * older than a generous retention window, plus their operation_outputs.
 *
 * SAFETY: only the terminal statuses are ever matched — PENDING / ENQUEUED (in-flight)
 * rows are NEVER touched, so DBOS recovery (which resumes only non-terminal workflows)
 * is unaffected. operation_outputs are deleted FIRST (FK order). Batched (LIMIT) to
 * bound the transaction/lock. DEFAULT-ON + 2d retention (owner durable-stability
 * directive, 2026-06-19): VALIDATED live on 2026-06-19 — this GC drained workflow_status
 * 253MB→3MB and immediately un-froze the routine engine. It MUST run recurring or the
 * table re-bloats; disable only with PAPERCUSP_DBOS_WORKFLOW_GC=0. Retention is env-tunable
 * (PAPERCUSP_DBOS_WORKFLOW_GC_DAYS, default 2 — small enough that a daily run holds the
 * table far under the ~300k freeze threshold).
 *
 * ROOT CAUSE (corrected 2026-06-19): the freeze WAS the workflow_status bloat — 328k rows
 * (325k terminal SUCCESS) made every DBOS executor dequeue scan 253MB, starving routinesTick
 * → hive-wake never fired → Queen frozen. The bloat SOURCE is ~8 ephemeral high-freq checks
 * persisted as durable DBOS workflows (~200k rows/day); the SOURCE fix (run them as in-process
 * intervals) is EI-1622 — this GC is the BACKSTOP. NOTE on the EI-1607 "bounded catch-up"
 * half: DBOS `skip-missed` did NOT prevent a missed-cron PENDING pile (~2380 stale scheduled
 * instances observed re-piling mid-incident), so singleton-routinesTick (an EI-1622 sibling)
 * is the real catch-up source-fix; bounded-catch-up is the maintenance backstop.
 */
import { getOrgPg } from '@papercusp/db-org';

export const DBOS_TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  'CANCELLED',
] as const;

const DEFAULT_RETENTION_DAYS = 2; // keep ~2d of terminal history — small enough that a daily GC holds workflow_status far under the ~300k freeze threshold (re-bloat prevention; owner durable-stability directive 2026-06-19). Tune via PAPERCUSP_DBOS_WORKFLOW_GC_DAYS.
const DEFAULT_BATCH_LIMIT = 5000;
/**
 * Per-invocation maintenance budget. This is a liveness policy, not a
 * productive-capacity ceiling: each DELETE remains a small committed batch,
 * and a later routine tick resumes where this one stopped.  The old
 * MAX_BATCHES constant encoded an arbitrary 10M-row throughput ceiling and
 * silently left terminal rows behind once it was reached.
 */
const DEFAULT_TIME_BUDGET_MS = 30_000;

export function dbosWorkflowGcEnabled(): boolean {
  // DEFAULT-ON (owner durable-stability directive, 2026-06-19): the GC MUST run
  // recurring or workflow_status re-bloats (325k SUCCESS → DBOS scheduler scans
  // saturate the loop → routine-engine freeze — the live incident). Validated live
  // tonight (253MB→3MB, terminal-only, cascade-clean). Disable with
  // PAPERCUSP_DBOS_WORKFLOW_GC=0.
  return process.env.PAPERCUSP_DBOS_WORKFLOW_GC !== '0';
}

export function dbosWorkflowGcRetentionDays(): number {
  const d = Number(process.env.PAPERCUSP_DBOS_WORKFLOW_GC_DAYS);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_RETENTION_DAYS;
}

/** Injectable query seams (sql-backed in production; faked in tests). */
export interface DbosGcDeps {
  /** Terminal workflow_uuids with updated_at < cutoff, up to `limit`. */
  selectTerminalVictims: (cutoffMs: number, limit: number) => Promise<string[]>;
  /** Delete operation_outputs for these workflow_uuids; returns rows deleted. */
  deleteOutputs: (ids: string[]) => Promise<number>;
  /** Delete workflow_status for these workflow_uuids; returns rows deleted. */
  deleteWorkflows: (ids: string[]) => Promise<number>;
}

export interface DbosWorkflowGcResult {
  skipped: boolean;
  deletedWorkflows: number;
  deletedOutputs: number;
  cutoffMs: number | null;
  batches: number;
  budgetExhausted?: boolean;
}

type SqlLike = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** Build the production sql-backed query seams. */
function sqlDeps(sql: SqlLike): DbosGcDeps {
  const statuses = [...DBOS_TERMINAL_STATUSES];
  return {
    selectTerminalVictims: async (cutoffMs, limit) => {
      const rows = await sql<Array<{ workflow_uuid: string }>>`
        SELECT workflow_uuid FROM dbos.workflow_status
         WHERE status = ANY(${statuses})
           AND updated_at < ${cutoffMs}
         LIMIT ${limit}`;
      return rows.map((r) => r.workflow_uuid);
    },
    deleteOutputs: async (ids) => {
      if (ids.length === 0) return 0;
      const rows = await sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.operation_outputs WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return rows[0]?.n ?? 0;
    },
    deleteWorkflows: async (ids) => {
      if (ids.length === 0) return 0;
      const rows = await sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.workflow_status WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return rows[0]?.n ?? 0;
    },
  };
}

/**
 * Prune old terminal DBOS rows. No-op (skipped) unless armed. Batched to bound the
 * lock; deletes operation_outputs before workflow_status; never matches in-flight rows.
 */
export async function runDbosWorkflowGcOnce(
  opts: {
    enabled?: boolean;
    retentionDays?: number;
    batchLimit?: number;
    timeBudgetMs?: number;
    nowMs?: number;
    nowClockMs?: () => number;
    deps?: DbosGcDeps;
  } = {},
): Promise<DbosWorkflowGcResult> {
  const enabled = opts.enabled ?? dbosWorkflowGcEnabled();
  if (!enabled) return { skipped: true, deletedWorkflows: 0, deletedOutputs: 0, cutoffMs: null, batches: 0 };

  const days = opts.retentionDays ?? dbosWorkflowGcRetentionDays();
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const nowMs = opts.nowMs ?? Date.now();
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const nowClockMs = opts.nowClockMs ?? Date.now;
  const startedAtMs = nowClockMs();
  const cutoffMs = nowMs - days * 86_400_000;
  const deps = opts.deps ?? sqlDeps(getOrgPg().sql as SqlLike);

  let deletedWorkflows = 0;
  let deletedOutputs = 0;
  let batches = 0;
  let budgetExhausted = false;
  while (true) {
    if (nowClockMs() - startedAtMs >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    const ids = await deps.selectTerminalVictims(cutoffMs, batchLimit);
    // A victim query itself can consume the remaining budget. Do not start a
    // DELETE once that happens: leave the selected ids for the next routine
    // tick rather than claiming a third batch after the liveness window.
    if (nowClockMs() - startedAtMs >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    if (ids.length === 0) break;
    batches += 1;
    // operation_outputs first (FK order), then the workflow rows.
    deletedOutputs += await deps.deleteOutputs(ids);
    deletedWorkflows += await deps.deleteWorkflows(ids);
    // Check again after the committed batch. A query/delete can consume the
    // entire liveness budget; checking only at the top of the loop would start
    // one extra batch after the budget has already elapsed (and make the
    // budget a soft throughput ceiling rather than an honest per-invocation
    // liveness bound).
    if (nowClockMs() - startedAtMs >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    if (ids.length < batchLimit) break;
  }
  return { skipped: false, deletedWorkflows, deletedOutputs, cutoffMs, batches, budgetExhausted };
}
