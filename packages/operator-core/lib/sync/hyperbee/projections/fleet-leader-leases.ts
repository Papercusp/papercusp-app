/**
 * Hyperbee -> PG projection for `harness_shared.p2p_fleet_leader_leases`.
 *
 * The lease is a federated liveness hint consumed by the deterministic election
 * service. It is not an authorization grant, so the wire row is intentionally a
 * small unsigned subset ordered by the standard PG-fed LWW columns.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface FleetLeaderLeaseWireRow {
  /** The Hive home slug. */
  harness_slug: string;
  owner_github_user_id: number;
  fleet_slug: string;
  device_pubkey: string;
  leader_github_user_id: number;
  since_ms: number;
  roster_epoch: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function isFleetLeaderLeaseWireRow(input: unknown): input is FleetLeaderLeaseWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isPositiveInt(r.owner_github_user_id)) return false;
  if (!isString(r.fleet_slug) || r.fleet_slug.length === 0) return false;
  if (!isString(r.device_pubkey) || r.device_pubkey.length === 0) return false;
  if (!isPositiveInt(r.leader_github_user_id)) return false;
  if (!isNonNegativeInt(r.since_ms)) return false;
  if (!isNonNegativeInt(r.roster_epoch)) return false;
  return true;
}

export interface FleetLeaderLeaseProjectionOpts {
  workspaceId: string;
  /** The Hive HOME slug (register-all binds this projection to the hive-home). */
  harnessSlug: string;
  sql?: postgres.Sql;
}

function composeKey(row: FleetLeaderLeaseWireRow): string {
  return `${row.owner_github_user_id}/${row.fleet_slug}`;
}

function decodeValue(raw: unknown): FleetLeaderLeaseWireRow | null {
  return isFleetLeaderLeaseWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FleetLeaderLeaseProjectionOpts,
  row: FleetLeaderLeaseWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.p2p_fleet_leader_leases
      (workspace_id, harness_slug, owner_github_user_id, fleet_slug,
       device_pubkey, leader_github_user_id, since_ms, roster_epoch,
       author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.owner_github_user_id}, ${row.fleet_slug},
       ${row.device_pubkey}, ${row.leader_github_user_id}, ${row.since_ms}, ${row.roster_epoch},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, owner_github_user_id, fleet_slug) DO UPDATE SET
      device_pubkey          = EXCLUDED.device_pubkey,
      leader_github_user_id = EXCLUDED.leader_github_user_id,
      since_ms               = EXCLUDED.since_ms,
      roster_epoch           = EXCLUDED.roster_epoch,
      author_pubkey          = EXCLUDED.author_pubkey,
      origin                 = EXCLUDED.origin,
      fed_ts                 = EXCLUDED.fed_ts,
      fed_hlc                = EXCLUDED.fed_hlc,
      updated_at             = ${now}
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.device_pubkey, EXCLUDED.leader_github_user_id::text,
                          EXCLUDED.since_ms::text, EXCLUDED.roster_epoch::text)),
            harness_shared.p2p_fleet_leader_leases.fed_hlc, harness_shared.p2p_fleet_leader_leases.fed_ts,
            harness_shared.p2p_fleet_leader_leases.author_pubkey,
            md5(concat_ws('|', harness_shared.p2p_fleet_leader_leases.device_pubkey,
                          harness_shared.p2p_fleet_leader_leases.leader_github_user_id::text,
                          harness_shared.p2p_fleet_leader_leases.since_ms::text,
                          harness_shared.p2p_fleet_leader_leases.roster_epoch::text)))
  `;
}

async function deleteFromPg(
  opts: FleetLeaderLeaseProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const slash = key.indexOf('/');
  if (slash <= 0) return;
  const owner = Number(key.slice(0, slash));
  const fleetSlug = key.slice(slash + 1);
  if (!Number.isSafeInteger(owner) || owner <= 0 || fleetSlug.length === 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.p2p_fleet_leader_leases
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND owner_github_user_id = ${owner}
      AND fleet_slug = ${fleetSlug}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildFleetLeaderLeaseProjection(
  opts: FleetLeaderLeaseProjectionOpts,
): TableProjection<FleetLeaderLeaseWireRow> {
  return {
    tableTag: 'p2p-fleet-leader-leases',
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFleetLeaderLeaseWireRow,
};
