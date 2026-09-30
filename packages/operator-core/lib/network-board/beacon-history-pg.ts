/**
 * beacon-history-pg — PG read/write for the cross_hive_beacon_history table
 * (hive-network-surface-2026-06-11 P-014, item 2, migration 236).
 *
 * Each accepted directory announce that carries a C-2 beacon appends one row,
 * so the tier-4 dossier can show how a foreign hive's status has evolved.
 * Write-path is best-effort (a capture failure must NEVER reject the announce).
 * Read-path is the dossier query `network.hive.beacons`.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { HiveStatusBeacon } from '../hive-beacon';
import { trackDetached } from '../detached-imports';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

export interface BeaconSnapshot {
  id: string;
  potId: string;
  hivePubkey: string | null;
  beacon: HiveStatusBeacon;
  capturedAt: string;
}

interface BeaconRow {
  id: string;
  // NOTE (WI-3953, 2026-07-10): the live migration 557 renamed the TABLE
  // (cross_hive_beacon_history -> cross_pot_beacon_history) but did NOT rename
  // these two columns — verified against the live schema post-apply. Do not
  // "fix" these to pot_id/pot_pubkey without a follow-up migration first.
  hive_id: string;
  hive_pubkey: string | null;
  beacon: unknown;
  captured_at: Date | string;
}

function rowToSnapshot(r: BeaconRow): BeaconSnapshot {
  return {
    id: r.id,
    potId: r.hive_id,
    hivePubkey: r.hive_pubkey ?? null,
    beacon: r.beacon as HiveStatusBeacon,
    capturedAt: r.captured_at instanceof Date ? r.captured_at.toISOString() : new Date(r.captured_at).toISOString(),
  };
}

/**
 * Append a beacon snapshot when an announce is accepted. Best-effort — caller
 * catches and warns; the announce is never rejected on a PG error here.
 * Pushes the dossier + board queries after the write (lazy fire-and-forget so
 * the PG seam never statically depends on the SSE layer; a missing bus is a no-op).
 */
export async function captureBeaconSnapshot(
  potId: string,
  hivePubkey: string | null,
  beacon: HiveStatusBeacon,
  sql?: Sql,
): Promise<void> {
  // WAVE-5 AF (beacon-capture bug, found live by dc9db: `[hive-directory] beacon
  // capture failed … The "string" argument must be of type string. Received an
  // instance of Object`). The old form bound the raw beacon OBJECT — which THROWS
  // under the live `getOrgPg` postgres-js client (and `sql.json(obj)` throws the SAME
  // way; the testcontainer client behaves OPPOSITELY, so integration tests can't catch
  // it — see agent-insights/postgres-js-jsonb-binding). The canonical fix that stores a
  // real jsonb OBJECT under BOTH clients is `${JSON.stringify(v)}::text::jsonb`: the
  // explicit `::text` binds it as a plain text param, parsed ONCE server-side
  // (text→jsonb), so it neither throws (live) nor double-encodes (testcontainer).
  const sqlc = pg(sql);
  await sqlc`
    INSERT INTO harness_shared.cross_pot_beacon_history (hive_id, hive_pubkey, beacon)
    VALUES (${potId}, ${hivePubkey ?? null}, ${JSON.stringify(beacon)}::text::jsonb)
  `;
  void trackDetached(import('../sync-sse'))
    .then((m) => {
      void m.notifySyncInvalidate('network.hive.beacons').catch(() => {});
      void m.notifySyncInvalidate('network.board').catch(() => {});
      // P-009 (data-sync-push-completion): a beacon is an accepted directory
      // announce — push the directory browse + federation-status panels too so the
      // desktop's WorkbenchPotDirectoryPanel / PotFederationStatus converge off
      // their old polls. Workspace-singleton, no-arg consumers.
      void m.notifySyncInvalidate('network.hiveDirectory').catch(() => {});
      void m.notifySyncInvalidate('network.federationStatus').catch(() => {});
    })
    .catch(() => {});
}

/**
 * Read the most-recent beacon snapshots for a hive, newest-first. `hiveKey`
 * accepts either the DiscoveredHive.potId or its pubkey-b64 — i.e. the C-3
 * tier-4 row key (`pubkey || potId`), so the drill-in dossier can query with
 * the only identity it holds. Returns [] on error (best-effort — the dossier
 * panel renders empty).
 */
export async function listBeaconHistory(
  hiveKey: string,
  limit = 50,
  sql?: Sql,
): Promise<BeaconSnapshot[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT id, hive_id, hive_pubkey, beacon, captured_at
       FROM harness_shared.cross_pot_beacon_history
      WHERE hive_id = $1 OR hive_pubkey = $1
      ORDER BY captured_at DESC
      LIMIT $2`,
    [hiveKey, Math.min(Math.max(1, limit), 500)],
  )) as unknown as BeaconRow[];
  return rows.map(rowToSnapshot);
}
