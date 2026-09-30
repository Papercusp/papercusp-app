/**
 * shared-presence-reaper.ts — TTL + per-device-cap reaper for the FEDERATED
 * presence tables (cross-machine-coord-parity-and-trust-2026-07-01 P-057 / M8;
 * audit D-013).
 *
 * `shared_presence` (grain: user×machine) and `shared_session_presence` (grain:
 * session) are GOSSIP-published liveness beats — a device appends its OWN rows
 * via presence-announce.ts (`announceLocalPresence → handle.append`), NOT via a
 * PG capture trigger / the append-only peer-log (see capture-coverage.ts). Readers
 * already treat a row as absent once its `last_seen_at` ages past their staleness
 * window (session-presence-store.listLiveSessionPresence, PRESENCE_STALE_MS×4 =
 * 40m). But NOTHING ever deleted stale rows, so:
 *   • a crashed device's rows are IMMORTAL; and
 *   • `machine_label` / `owner_id` are SENDER-CONTROLLED, so an admitted member
 *     can ROTATE the label every frame and keep inserting fresh rows forever —
 *     the writer's full-set-replace prune only covers a device's CURRENT label
 *     set, so a rotation leaks 128 rows/rotation, unbounded (D-013 growth
 *     amplifier).
 *
 * This reaper is the retention floor, in two passes:
 *   1. TTL delete — drop any row whose `last_seen_at` is older than `ttlMs`
 *      (default 4h, chosen WELL beyond every reader's 40m staleness window so it
 *      never removes a row a reader would still surface).
 *   2. Per-device cap — keep only the `maxRowsPerDevice` most-recent rows per
 *      (workspace, device_pubkey); delete the overflow. This bounds the total
 *      rows one SIGNING DEVICE can hold no matter how fast it rotates the
 *      sender-controlled machine_label / owner_id — the TTL alone can't catch a
 *      fast rotator whose every row stays fresh.
 *
 * PURELY LOCAL hygiene: neither table has a capture trigger, so a DELETE here is
 * NOT enqueued to substrate_outbox and does NOT federate — it can never evict a
 * peer's rows (each machine reaps its own local projection). Best-effort: a throw
 * propagates to the periodic tick, which catches + retries next interval.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { readCoordLivenessConfig, COORD_LIVENESS_DEFAULTS } from '../../coord-liveness-config';

export interface SharedPresenceReapResult {
  /** shared_presence rows deleted by the TTL pass. */
  presenceTtlReaped: number;
  /** shared_session_presence rows deleted by the TTL pass. */
  sessionTtlReaped: number;
  /** shared_presence rows deleted by the per-device cap pass. */
  presenceCapReaped: number;
  /** shared_session_presence rows deleted by the per-device cap pass. */
  sessionCapReaped: number;
}

export interface ReapSharedPresenceOpts {
  /** TTL for the staleness delete (ms). Omitted ⇒ coord-liveness-config override
   *  or the baked 4h default. */
  ttlMs?: number;
  /** Max rows retained per (workspace, device_pubkey). Omitted ⇒ config override
   *  or the baked 128 default. */
  maxRowsPerDevice?: number;
  /** Clock seam for the TTL floor (tests). */
  nowMs?: number;
  /** Test/multi-peer seam — reap on THIS client instead of the process-global. */
  sql?: postgres.Sql;
}

/**
 * Reap both federated presence tables: TTL delete, then a per-(workspace,device)
 * cap. Reads its TTL + cap from coord-liveness-config when not overridden by opts
 * (the scheduled tick passes nothing). Returns the per-pass, per-table counts.
 */
export async function reapStaleSharedPresence(
  opts: ReapSharedPresenceOpts = {},
): Promise<SharedPresenceReapResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  let ttlMs = opts.ttlMs;
  let cap = opts.maxRowsPerDevice;
  if (ttlMs == null || cap == null) {
    const cfg = await readCoordLivenessConfig();
    ttlMs ??= cfg.sharedPresenceReaperTtlMs ?? COORD_LIVENESS_DEFAULTS.sharedPresenceReaperTtlMs;
    cap ??= cfg.sharedPresenceMaxRowsPerDevice ?? COORD_LIVENESS_DEFAULTS.sharedPresenceMaxRowsPerDevice;
  }
  // ISO string + explicit cast, NOT a Date object: the org PG client (`getOrgPg`)
  // rejects a raw Date bind param ("The string argument must be … Received an
  // instance of Date") — see the `org-pg-client-rejects-raw-date` memory / EI-2549.
  const floorIso = new Date((opts.nowMs ?? Date.now()) - ttlMs).toISOString();

  // 1. TTL — a row older than the reaper TTL is well past every reader's window.
  const pTtl = await sql`
    DELETE FROM harness_shared.shared_presence WHERE last_seen_at < ${floorIso}::timestamptz
  `;
  const sTtl = await sql`
    DELETE FROM harness_shared.shared_session_presence WHERE last_seen_at < ${floorIso}::timestamptz
  `;

  // 2. Per-device cap — keep the `cap` most-recent rows per (workspace, device),
  //    delete the overflow. ctid is the stable within-scan row id; the tiebreak on
  //    ctid keeps the ranking deterministic when last_seen_at ties.
  const pCap = await sql`
    DELETE FROM harness_shared.shared_presence sp
    USING (
      SELECT ctid, row_number() OVER (
        PARTITION BY workspace_id, device_pubkey
        ORDER BY last_seen_at DESC, ctid DESC
      ) AS rn
      FROM harness_shared.shared_presence
    ) ranked
    WHERE sp.ctid = ranked.ctid AND ranked.rn > ${cap}
  `;
  const sCap = await sql`
    DELETE FROM harness_shared.shared_session_presence ssp
    USING (
      SELECT ctid, row_number() OVER (
        PARTITION BY workspace_id, device_pubkey
        ORDER BY last_seen_at DESC, ctid DESC
      ) AS rn
      FROM harness_shared.shared_session_presence
    ) ranked
    WHERE ssp.ctid = ranked.ctid AND ranked.rn > ${cap}
  `;

  return {
    presenceTtlReaped: pTtl.count,
    sessionTtlReaped: sTtl.count,
    presenceCapReaped: pCap.count,
    sessionCapReaped: sCap.count,
  };
}
