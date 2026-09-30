-- 612-collision-hysteresis.sql — ambient-semantic-push-2026-07-14 P-004 (collision matcher, live leg).
--
-- collision_hysteresis — the per-session carried state of the sustained-collision
-- detector (collision-hysteresis.ts collisionHysteresisTick). One row per SELF
-- session = the CollisionState[] it carries tick-to-tick, plus the monotonic tick
-- counter. This state is REQUIRED for the matcher to work at all: the hysteresis
-- only ENTERs a sustained collision after the overlap holds ≥ enterThreshold for
-- enterDwell (default 3) CONSECUTIVE ticks. A tick is one turn-end cursor rebuild
-- (journal:record-turn), and an agent's transcript does not carry the streak
-- across turns — so without this row every tick would restart the streak at 0 and
-- a real convergence could never reach the enter edge. Keyed by session_id: the
-- upsert REPLACES the row each tick (the latest state IS the state, not a log),
-- exactly like 609 session_cursor.
--
-- `states` is the JSON-serialized CollisionState[] (colliding flag + enter/exit
-- streaks + ticksSinceSeen + lastScore + lastSharedTerms per peer). The pure fold
-- bounds it (maxTrackedPeers, default 16), so the row stays small.
--
-- Owner-keyed alongside session_id for pruning/debugging (owner_id nullable — a
-- transcript-driven turn can carry no coord identity). No RLS, mirrors 605/609/610.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.collision_hysteresis (
  session_id  TEXT        PRIMARY KEY,                   -- the SELF session whose collision state this is
  owner_id    TEXT,                                      -- coord identity (nullable; for pruning/debug only)
  tick        BIGINT      NOT NULL DEFAULT 0,            -- monotonic tick counter (recorded as enteredAtTick)
  states      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- CollisionState[] carried across ticks
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention prune scans by staleness (drop state for sessions gone quiet).
CREATE INDEX IF NOT EXISTS collision_hysteresis_updated_idx
  ON harness_shared.collision_hysteresis (updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.collision_hysteresis TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.collision_hysteresis TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
