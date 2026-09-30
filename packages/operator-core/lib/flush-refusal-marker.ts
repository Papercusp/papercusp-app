/** Cross-worker refusal state for the P-016 flush gate.
 *
 * The operator is clustered, so two consecutive boundary requests can land on
 * different workers. A module Map therefore turns the bounded one-refusal
 * ladder into an unbounded refusal. Keep the tiny TTL marker in Postgres, the
 * same substrate used by carry-respawn-marker.ts for the identical bug class.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { GateBoundary } from './enforcement-gate';

export const REFUSAL_MARKER_TTL_MS = 10 * 60_000;

export async function wasRecentlyRefused(
  boundary: GateBoundary,
  ownerId: string,
  nowMs = Date.now(),
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const rows = await sql<Array<{ expires_at: Date }>>`
      SELECT expires_at
        FROM harness_shared.flush_gate_refusals
       WHERE boundary = ${boundary} AND owner_id = ${ownerId}`;
    const row = rows[0];
    if (!row) return false;
    return new Date(row.expires_at).getTime() >= nowMs;
  } catch {
    return false; // fail-open: marker trouble must never strand a boundary
  }
}

export async function markRefused(
  boundary: GateBoundary,
  ownerId: string,
  nowMs = Date.now(),
  opts: { sql?: Sql } = {},
): Promise<void> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const expiresAt = new Date(nowMs + REFUSAL_MARKER_TTL_MS);
    await sql`
      INSERT INTO harness_shared.flush_gate_refusals (boundary, owner_id, expires_at)
      VALUES (${boundary}, ${ownerId}, ${expiresAt})
      ON CONFLICT (boundary, owner_id) DO UPDATE
        SET expires_at = EXCLUDED.expires_at, created_at = now()`;
  } catch {
    // fail-open: the first refusal still protects the boundary; a retry proceeds
  }
}

export async function clearRefused(
  boundary: GateBoundary,
  ownerId: string,
  opts: { sql?: Sql } = {},
): Promise<void> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`DELETE FROM harness_shared.flush_gate_refusals
               WHERE boundary = ${boundary} AND owner_id = ${ownerId}`;
  } catch {
    // TTL bounds residue; never fail a boundary on cleanup
  }
}

export async function __resetRefusalMarkers(opts: { sql?: Sql } = {}): Promise<void> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`DELETE FROM harness_shared.flush_gate_refusals`;
  } catch { /* test cleanup / pre-migration host */ }
}
