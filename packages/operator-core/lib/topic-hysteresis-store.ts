/**
 * topic-hysteresis-store.ts — the Postgres layer for the P-008 topic matcher's
 * per-session carried state (ambient-semantic-push-2026-07-14; table: migration
 * 613 harness_shared.topic_hysteresis). Pure SQL binding — the subscribe/
 * unsubscribe machine lives in topic-hysteresis.ts (pure core, where its tests
 * are); the live composition (cursor → centroids → tick → actuate) lives in
 * topic-matcher-io.ts.
 *
 * One row per SELF session = the {@link TopicSubscription}[] its auto-subscribe
 * machine carries tick-to-tick, plus the monotonic tick counter. The upsert
 * REPLACES the row each tick (the latest state IS the state — not a log), keyed
 * by session_id, mirroring 612 collision_hysteresis. This state is load-bearing:
 * the enter/exit dwell streaks ONLY reach a subscribe/unsubscribe edge if they
 * survive across turn-end ticks, which an agent's transcript does not do.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { TopicSubscription } from './topic-hysteresis';

/** The carried state for one self session: the tick counter + the per-topic
 *  TopicSubscription[] (empty + tick 0 when the session has never ticked). */
export interface TopicStateCarry {
  tick: number;
  subscriptions: TopicSubscription[];
}

/**
 * Load one self session's carried topic-subscription state. Returns
 * { tick:0, subscriptions:[] } when there is no row yet (a first tick seeds
 * fresh state). postgres-js returns the `tick` BIGINT column as a STRING
 * (precision-safe) — coerce it to a number so the next tick's `tick + 1` is
 * arithmetic, not string concat. The `subscriptions` JSONB rehydrates as a
 * parsed array; guard a non-array defensively.
 */
export async function loadTopicState(sessionId: string): Promise<TopicStateCarry> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ tick: number; subscriptions: TopicSubscription[] }>>`
    SELECT tick, subscriptions
    FROM harness_shared.topic_hysteresis
    WHERE session_id = ${sessionId}
  `;
  const row = rows[0];
  if (!row) return { tick: 0, subscriptions: [] };
  return {
    tick: Number(row.tick) || 0,
    subscriptions: Array.isArray(row.subscriptions) ? row.subscriptions : [],
  };
}

export interface SaveTopicStateInput {
  sessionId: string;
  ownerId: string | null;
  tick: number;
  subscriptions: TopicSubscription[];
}

/**
 * Upsert one self session's carried topic state (keyed by session_id — a later
 * tick REPLACES the row). `subscriptions` goes over as `::text::jsonb` (NOT bare
 * `::jsonb`) — postgres-js JSON-encodes the string param first, so a bare cast
 * would double-encode into a jsonb string scalar instead of the queryable array
 * (session-cursor-store / collision-hysteresis-store gotcha).
 */
export async function saveTopicState(input: SaveTopicStateInput): Promise<void> {
  const { sql } = getOrgPg();
  const subsJson = JSON.stringify(input.subscriptions ?? []);
  await sql`
    INSERT INTO harness_shared.topic_hysteresis
      (session_id, owner_id, tick, subscriptions, updated_at)
    VALUES (
      ${input.sessionId}, ${input.ownerId}, ${input.tick},
      ${subsJson}::text::jsonb, now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      owner_id      = EXCLUDED.owner_id,
      tick          = EXCLUDED.tick,
      subscriptions = EXCLUDED.subscriptions,
      updated_at    = now()
  `;
}

/** Retention prune: drop carried state for sessions not ticked since `olderThan`.
 *  Returns the count removed. A stale row just re-seeds from empty on the next
 *  tick, so this table is a bounded working set, not an archive. */
export async function pruneTopicState(olderThan: Date | string): Promise<number> {
  const { sql } = getOrgPg();
  const iso = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
  const rows = await sql<Array<{ session_id: string }>>`
    DELETE FROM harness_shared.topic_hysteresis
    WHERE updated_at < ${iso}::timestamptz
    RETURNING session_id
  `;
  return rows.length;
}
