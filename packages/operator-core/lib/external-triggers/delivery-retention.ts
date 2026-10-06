/**
 * delivery-retention.ts — payload retention for harness_shared.trigger_deliveries
 * (WI-10004921, migration 1306).
 *
 * The table is a per-sink delivery LEDGER: one row per (event, sink) holding the
 * outcome and the dedupe identity. It also used to hold the full event payload on
 * every sink's row — four copies of each event, never pruned (7.4 GB / ~400k rows,
 * 6.8 GB of it TOAST, measured 2026-10-01).
 *
 * What this sweep removes is the PAYLOAD, never the row:
 *   • A non-event-bus row that was delivered has no reader at all (a retry re-delivers
 *     the in-memory event; the run-detail view reads the event-bus row), so its payload
 *     is stripped on the next sweep. New rows no longer store one (claimDelivery); this
 *     drains the legacy copies.
 *   • Any finished row past the replay horizon (`TRIGGER_DELIVERY_PAYLOAD_RETENTION_DAYS`)
 *     loses its payload too. The run-detail view then falls back to trigger_runs.payload.
 *   • A `pending` row is never touched: it is an in-flight claim.
 *
 * The ROW stays because (source_id, dedupe_key, sink_kind, sink_ref) is each sink's
 * dedupe identity: deleting it would let a provider resync re-deliver an old event to
 * every sink. How long that identity must outlive a provider's resync window is a
 * separate decision and is NOT made here.
 *
 * BATCH-LIMITED (like decision-ledger-gc): a long backlog drains over several ticks
 * instead of one long-running UPDATE on a table ingestion writes to constantly.
 * Stripping frees TOAST for reuse once vacuumed; returning that disk to the OS still
 * takes a VACUUM FULL.
 */

import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PAYLOAD_BEARING_SINK_KIND } from './ingestion';

/** How long a finished event-bus row keeps its payload for display and diagnosis. */
export const TRIGGER_DELIVERY_PAYLOAD_RETENTION_DAYS = 30;

/** Max rows stripped per sweep. */
export const TRIGGER_DELIVERY_PAYLOAD_BATCH_LIMIT = 10_000;

export interface DeliveryPayloadPruneResult {
  stripped: number;
  /** True when the batch filled, i.e. more eligible rows are probably waiting. */
  batchFull: boolean;
}

export async function pruneTriggerDeliveryPayloads(
  opts: {
    sql?: postgres.Sql;
    retentionDays?: number;
    batchLimit?: number;
  } = {},
): Promise<DeliveryPayloadPruneResult> {
  const retentionDays = opts.retentionDays ?? TRIGGER_DELIVERY_PAYLOAD_RETENTION_DAYS;
  const batchLimit = opts.batchLimit ?? TRIGGER_DELIVERY_PAYLOAD_BATCH_LIMIT;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`trigger-delivery-retention: retentionDays must be a positive integer, got ${retentionDays}`);
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1) {
    throw new Error(`trigger-delivery-retention: batchLimit must be a positive integer, got ${batchLimit}`);
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ n: number }>>`
    WITH victims AS (
      SELECT workspace_id, id
        FROM harness_shared.trigger_deliveries
       WHERE payload IS NOT NULL
         AND outcome <> 'pending'
         AND (
           (sink_kind <> ${PAYLOAD_BEARING_SINK_KIND} AND outcome = 'delivered')
           OR completed_at < now() - make_interval(days => ${retentionDays})
         )
       ORDER BY completed_at NULLS LAST
       LIMIT ${batchLimit}
    ),
    stripped AS (
      UPDATE harness_shared.trigger_deliveries d
         SET payload = NULL,
             payload_pruned_at = now()
        FROM victims v
       WHERE d.workspace_id = v.workspace_id
         AND d.id = v.id
         AND d.outcome <> 'pending'
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM stripped
  `;
  const stripped = rows[0]?.n ?? 0;
  return { stripped, batchFull: stripped >= batchLimit };
}
