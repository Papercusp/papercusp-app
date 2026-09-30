/**
 * decision-ledger-gc.ts — physical retention GC for harness_shared.decision_ledger
 * (WI-417, follow-up from WI-406).
 *
 * decision_ledger is an append-mostly governed-action + Queen-disposition ledger
 * (~1 row per governed non-SU action + per Queen decision) with NO natural cap —
 * unlike its GC'd siblings (escalation-log-gc.ts, notify-gc.ts, message-log-gc.ts,
 * revisions-gc.ts), it had no scheduled retention at all, so it grows forever
 * (778k rows / 528MB and climbing at filing time). WI-406 tuned autovacuum
 * (migration 365) so DEAD tuples get reclaimed, but autovacuum never caps total
 * SIZE — only a retention DELETE does that.
 *
 * SAFETY:
 *   • FLAT delete-by-age. Unlike escalations (folded read-time state keyed by a
 *     family of raise+resolution rows), a decision_ledger row is a standalone,
 *     immutable fact — there is no cross-row fold to corrupt by deleting one.
 *   • WINDOW FLOOR (WI-417's own constraint): the retention window MUST stay
 *     ≥ the queen-autonomy graduation lookback (autonomy:graduation_status
 *     `lookbackDays`, default 90d) — that surface reads clean-auto-pass streaks
 *     from this ledger, and a shorter window would silently destroy graduation
 *     evidence. DECISION_LEDGER_GC_RETENTION_DAYS defaults to 150d (a 60-day
 *     margin over the 90d floor); assertRetentionAboveGraduationFloor throws
 *     rather than silently under-retaining if a caller ever passes less.
 *   • NEVER FEDERATES. decision_ledger is registered `federation: 'local-diagnostic'`
 *     (storage/categories.ts) — a plain per-workspace-agnostic DELETE never fires a
 *     cross-peer federation trigger (unlike harness-scoped coord_event_log rows).
 *   • BATCH-LIMITED, like escalation-log-gc's family cap — bounds the lock/row
 *     count a pathological first run (or a long-paused routine) can take on the
 *     hot ledger table; steady-state daily volume is far below this, and any
 *     backlog drains over a few ticks.
 *
 * Returns the number of rows deleted. Best-effort caller (the tick) tolerates errors.
 */

import { getOrgPg } from '@papercusp/db-org';

/** The queen-autonomy graduation lookback floor (autonomy:graduation_status
 *  `lookbackDays` default) — the retention window must never go below this or
 *  graduation evidence is silently destroyed (WI-417's explicit constraint). */
export const DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS = 90;

/** Default retention — a 60-day margin over the 90d graduation floor, in the
 *  120-180d range WI-417 itself recommended. */
export const DECISION_LEDGER_GC_RETENTION_DAYS = 150;

/** Max rows deleted per run (mirrors ESCALATION_GC_FAMILY_LIMIT's safety bound). */
export const DECISION_LEDGER_GC_BATCH_LIMIT = 20000;

function assertRetentionAboveGraduationFloor(retentionDays: number): void {
  if (retentionDays < DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS) {
    throw new Error(
      `decision-ledger-gc: refusing retentionDays=${retentionDays} — below the ` +
        `${DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS}d queen-autonomy graduation lookback floor ` +
        '(would silently destroy graduation evidence). Raise it or lower the graduation ' +
        'lookback deliberately first.',
    );
  }
}

export async function gcOldDecisionLedgerRows(
  retentionDays = DECISION_LEDGER_GC_RETENTION_DAYS,
  batchLimit = DECISION_LEDGER_GC_BATCH_LIMIT,
): Promise<number> {
  assertRetentionAboveGraduationFloor(retentionDays);
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH victims AS (
      SELECT id FROM harness_shared.decision_ledger
       WHERE ts < now() - make_interval(days => ${retentionDays})
       ORDER BY ts
       LIMIT ${batchLimit}
    ),
    d AS (
      DELETE FROM harness_shared.decision_ledger
       WHERE id IN (SELECT id FROM victims)
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
