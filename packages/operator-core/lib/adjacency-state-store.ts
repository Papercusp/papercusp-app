/**
 * adjacency-state-store.ts — the Postgres layer for the P-013 adjacency
 * cross-feed's per-session carried state (ambient-semantic-push-2026-07-14;
 * table: migration 614 harness_shared.adjacency_state). Pure SQL binding —
 * the banded hysteresis fold lives in adjacency-cross-feed.ts (pure core,
 * where its tests are); the live composition (shared snapshot → tick →
 * subscribe/unsubscribe → cross-feed) lives in adjacency-cross-feed-io.ts.
 *
 * One row per SELF session = the {@link AdjacencyState}[] its detector carries
 * tick-to-tick, the monotonic tick counter, AND the live leg's own
 * topics-by-peer bookkeeping ({@link AdjacencyPeerTopic}): the topic slug +
 * terms subscribed on each enter edge, and the peer's owner id. The pure fold
 * re-derives topic names from CURRENT shared terms — which drift — so exits
 * must unsubscribe the RECORDED slug, and the cross-feed's on-topic test must
 * use the RECORDED terms. The upsert REPLACES the row each tick, keyed by
 * session_id, mirroring 612 collision_hysteresis.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AdjacencyState } from './adjacency-cross-feed';

/** What the live leg remembers about one adjacent peer's shared topic. */
export interface AdjacencyPeerTopic {
  /** The slug actually subscribed on the enter edge (exits unsubscribe THIS). */
  topic: string;
  /** The shared terms the topic was entered on (the cross-feed on-topic test). */
  terms: string[];
  /** The peer's coord identity at enter (the cross-feed delivery axis). */
  peerOwnerId: string | null;
}

/** The carried state for one self session (empty + tick 0 before a first tick). */
export interface AdjacencyStateCarry {
  tick: number;
  states: AdjacencyState[];
  topics: Record<string, AdjacencyPeerTopic>;
}

/**
 * Load one self session's carried adjacency state. Returns the empty carry when
 * there is no row yet. postgres-js returns the `tick` BIGINT column as a STRING
 * (precision-safe) — coerce it so `tick + 1` is arithmetic, not string concat.
 * The JSONB columns rehydrate parsed; guard non-array/non-object defensively.
 */
export async function loadAdjacencyState(sessionId: string): Promise<AdjacencyStateCarry> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ tick: number; states: AdjacencyState[]; topics: Record<string, AdjacencyPeerTopic> }>>`
    SELECT tick, states, topics
    FROM harness_shared.adjacency_state
    WHERE session_id = ${sessionId}
  `;
  const row = rows[0];
  if (!row) return { tick: 0, states: [], topics: {} };
  return {
    tick: Number(row.tick) || 0,
    states: Array.isArray(row.states) ? row.states : [],
    topics: row.topics && typeof row.topics === 'object' && !Array.isArray(row.topics) ? row.topics : {},
  };
}

export interface SaveAdjacencyStateInput {
  sessionId: string;
  ownerId: string | null;
  tick: number;
  states: AdjacencyState[];
  topics: Record<string, AdjacencyPeerTopic>;
}

/**
 * Upsert one self session's carried adjacency state (keyed by session_id — a
 * later tick REPLACES the row). JSON params go over as `::text::jsonb` (NOT bare
 * `::jsonb`) — postgres-js JSON-encodes the string param first, so a bare cast
 * would double-encode into a jsonb string scalar (the 609/610/612 gotcha).
 */
export async function saveAdjacencyState(input: SaveAdjacencyStateInput): Promise<void> {
  const { sql } = getOrgPg();
  const statesJson = JSON.stringify(input.states ?? []);
  const topicsJson = JSON.stringify(input.topics ?? {});
  await sql`
    INSERT INTO harness_shared.adjacency_state
      (session_id, owner_id, tick, states, topics, updated_at)
    VALUES (
      ${input.sessionId}, ${input.ownerId}, ${input.tick},
      ${statesJson}::text::jsonb, ${topicsJson}::text::jsonb, now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      owner_id   = EXCLUDED.owner_id,
      tick       = EXCLUDED.tick,
      states     = EXCLUDED.states,
      topics     = EXCLUDED.topics,
      updated_at = now()
  `;
}

/** Retention prune: drop carried state for sessions not ticked since `olderThan`.
 *  Returns the count removed. A stale row re-seeds from empty on the next tick,
 *  so this table is a bounded working set, not an archive. */
export async function pruneAdjacencyState(olderThan: Date | string): Promise<number> {
  const { sql } = getOrgPg();
  const iso = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
  const rows = await sql<Array<{ session_id: string }>>`
    DELETE FROM harness_shared.adjacency_state
    WHERE updated_at < ${iso}::timestamptz
    RETURNING session_id
  `;
  return rows.length;
}
