/**
 * collision-hysteresis-store.ts — the Postgres layer for the P-004 collision
 * matcher's per-session carried state (ambient-semantic-push-2026-07-14; table:
 * migration 612 harness_shared.collision_hysteresis). Pure SQL binding — the
 * hysteresis fold lives in collision-hysteresis.ts (pure core, where its tests
 * are); the live composition (read peers → snapshot → tick → enqueue) lives in
 * collision-matcher-io.ts.
 *
 * One row per SELF session = the {@link CollisionState}[] its sustained-collision
 * detector carries tick-to-tick, plus the monotonic tick counter. The upsert
 * REPLACES the row each tick (the latest state IS the state — not a log), keyed
 * by session_id, mirroring 609 session_cursor. This state is load-bearing: the
 * enter/exit dwell counters ONLY reach the enter edge if they survive across
 * turn-end ticks, which an agent's transcript does not do.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { CollisionState } from './collision-hysteresis';

export interface CollisionHysteresisRow {
  session_id: string;
  owner_id: string | null;
  tick: number;
  states: CollisionState[];
  updated_at: string;
}

/** The carried state for one self session: the tick counter + the per-peer
 *  CollisionState[] (empty + tick 0 when the session has never ticked). */
export interface CollisionStateCarry {
  tick: number;
  states: CollisionState[];
}

/**
 * Load one self session's carried collision state. Returns { tick:0, states:[] }
 * when there is no row yet (a first tick seeds fresh state). postgres-js returns
 * the `tick` BIGINT column as a STRING (precision-safe) — coerce it to a number
 * so the next tick's `tick + 1` is arithmetic, not string concat. The `states`
 * JSONB rehydrates as a parsed array; guard a non-array defensively.
 */
export async function loadCollisionState(sessionId: string): Promise<CollisionStateCarry> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ tick: number; states: CollisionState[] }>>`
    SELECT tick, states
    FROM harness_shared.collision_hysteresis
    WHERE session_id = ${sessionId}
  `;
  const row = rows[0];
  if (!row) return { tick: 0, states: [] };
  return {
    tick: Number(row.tick) || 0,
    states: Array.isArray(row.states) ? row.states : [],
  };
}

export interface SaveCollisionStateInput {
  sessionId: string;
  ownerId: string | null;
  tick: number;
  states: CollisionState[];
}

/**
 * Upsert one self session's carried collision state (keyed by session_id — a
 * later tick REPLACES the row). `states` goes over as `::text::jsonb` (NOT bare
 * `::jsonb`) — postgres-js JSON-encodes the string param first, so a bare cast
 * would double-encode into a jsonb string scalar instead of the queryable array
 * (session-cursor-store / push-delivery-store gotcha).
 */
export async function saveCollisionState(input: SaveCollisionStateInput): Promise<void> {
  const { sql } = getOrgPg();
  const statesJson = JSON.stringify(input.states ?? []);
  await sql`
    INSERT INTO harness_shared.collision_hysteresis
      (session_id, owner_id, tick, states, updated_at)
    VALUES (
      ${input.sessionId}, ${input.ownerId}, ${input.tick},
      ${statesJson}::text::jsonb, now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      owner_id   = EXCLUDED.owner_id,
      tick       = EXCLUDED.tick,
      states     = EXCLUDED.states,
      updated_at = now()
  `;
}

/** Retention prune: drop carried state for sessions not ticked since `olderThan`.
 *  Returns the count removed. A stale row just re-seeds from empty on the next
 *  tick, so this table is a bounded working set, not an archive. */
export async function pruneCollisionState(olderThan: Date | string): Promise<number> {
  const { sql } = getOrgPg();
  const iso = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
  const rows = await sql<Array<{ session_id: string }>>`
    DELETE FROM harness_shared.collision_hysteresis
    WHERE updated_at < ${iso}::timestamptz
    RETURNING session_id
  `;
  return rows.length;
}
