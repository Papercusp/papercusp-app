/**
 * Ledger adapter for {@link scanDurableEscalations} (EI-19339499404613652).
 *
 * Kept SEPARATE from `durable-escalation-orphan-scan.ts` on purpose: the scan
 * is pure classification with no imports, so its guard suite runs without a
 * database and cannot be weakened into "the query returned nothing, so we are
 * clean". This file is the only part that touches Postgres.
 *
 * ## Read-only, and deliberately so
 *
 * There is no close path here and none should be added. Silence past an
 * emitter's own resolve norm means "recovered" OR "no longer observed", and
 * only the first would justify resolving — see the scan module's header and
 * the orphan-sweep docs' warning against blanket time-based closes. The output
 * is a triage list.
 *
 * ## Scope predicates are not optional
 *
 * `harness_shared.engineer_issues` is multi-tenant and keyed by
 * `workspace_id`; its `scope` column is the view's `harness:<slug>` form and
 * has NO counterpart on the underlying table. A query that drops the workspace
 * predicate reads another tenant's rows as this one's — which for a detector
 * whose whole output is counts would surface as a confident wrong number
 * rather than an error.
 */
import { getOrgPg } from '@papercusp/db-org';

import { ALL_TERMINAL_STATUSES } from './work-item-blocking';
import {
  scanDurableEscalations,
  type EscalationRow,
  type ScanOptions,
  type ScanReport,
} from './durable-escalation-orphan-scan';
import type { OrgSql } from './work-items';

/** Emitters this sweep considers. Machine filers only — an agent-authored
 *  backlog row has no automatic resolve path, so its age says nothing about
 *  the bug class and would only add noise. */
export const MACHINE_EMITTER_PREFIX = 'system:';

export type SweepArgs = {
  workspaceId: string;
  /**
   * How far back to read. Bounds the scan; note it also bounds the CLOSE
   * SAMPLE each emitter is calibrated against, so a very short window can push
   * a healthy emitter into `insufficient-close-sample` — which reports as
   * undetermined, never as clean, which is the safe direction.
   */
  lookbackDays?: number;
  nowMs?: number;
  scanOptions?: Omit<ScanOptions, 'nowMs'>;
};

export const DEFAULT_LOOKBACK_DAYS = 90;

type LedgerRow = {
  emitter: string | null;
  id: string | null;
  created_at_ms: string | number | null;
  closed_at_ms: string | number | null;
  is_open: boolean;
};

function toMs(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the durable escalation ledger and classify every machine emitter
 * against its own close-time distribution.
 *
 * The returned {@link ScanReport} carries `rowsScanned` / `emittersScanned`, so
 * a caller can always distinguish "measured the ledger and found nothing" from
 * "measured nothing" — an empty `findings` alone cannot.
 */
export async function sweepDurableEscalations(
  args: SweepArgs,
  sqlOverride?: OrgSql,
): Promise<ScanReport> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const nowMs = args.nowMs ?? Date.now();
  const lookbackDays = args.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const terminal = [...ALL_TERMINAL_STATUSES];

  const rows = (await sql`
    SELECT created_by                                        AS emitter,
           issue_id                                          AS id,
           (extract(epoch FROM created_at) * 1000)::bigint   AS created_at_ms,
           closed_ts                                         AS closed_at_ms,
           (state IS NULL OR state NOT IN ${sql(terminal)})  AS is_open
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${args.workspaceId}
       AND created_by LIKE ${`${MACHINE_EMITTER_PREFIX}%`}
       AND created_at >= now() - make_interval(days => ${lookbackDays})
       AND (state IS NULL OR state NOT IN ${sql(terminal)} OR closed_ts IS NOT NULL)
  `) as LedgerRow[];

  const escalations: EscalationRow[] = [];
  for (const row of rows) {
    const createdAtMs = toMs(row.created_at_ms);
    if (!row.emitter || !row.id || createdAtMs === null) continue;
    const closedAtMs = row.is_open ? null : toMs(row.closed_at_ms);
    // A TERMINAL row whose close time was never recorded contributes nothing:
    // it is not an accusation (it is closed) and it is not a usable
    // calibration sample (no duration). It must be dropped rather than passed
    // through, because the scan reads `closedAtMs === null` as OPEN — so
    // keeping it would silently inflate the open population with closed rows.
    if (!row.is_open && closedAtMs === null) continue;
    escalations.push({ emitter: row.emitter, id: row.id, createdAtMs, closedAtMs });
  }

  return scanDurableEscalations(escalations, { ...args.scanOptions, nowMs });
}
