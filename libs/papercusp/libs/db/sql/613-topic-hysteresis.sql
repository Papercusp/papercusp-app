-- 613-topic-hysteresis.sql — ambient-semantic-push-2026-07-14 P-008 (topic auto-subscribe matcher, live leg).
--
-- topic_hysteresis — the per-session carried state of the topic auto-subscribe/
-- auto-unsubscribe machine (topic-hysteresis.ts hysteresisTick, plan D-009). One
-- row per SELF session = the TopicSubscription[] it carries tick-to-tick (enter/
-- exit streaks, staleness clocks, provenance flags), plus the monotonic tick
-- counter. This state is REQUIRED for the matcher to work at all: the machine
-- only SUBSCRIBES after cursor↔topic relevance holds ≥ enterThreshold for
-- enterDwell CONSECUTIVE ticks (and only UNSUBSCRIBES after a longer exit dwell).
-- A tick is one turn-end cursor rebuild (journal:record-turn), and an agent's
-- transcript does not carry the streak across turns — so without this row every
-- tick would restart the streaks at 0 and no auto-subscription could ever happen.
-- Keyed by session_id: the upsert REPLACES the row each tick (the latest state IS
-- the state, not a log), exactly like 612 collision_hysteresis / 609 session_cursor.
--
-- `subscriptions` is the JSON-serialized TopicSubscription[] (provenance auto vs
-- manual + subscribed flag + streaks + ticksSinceHit + lastRelevance per topic).
-- The pure machine prunes dead auto candidates and caps the auto set
-- (maxAutoSubscriptions, default 8), so the row stays small.
--
-- Owner-keyed alongside session_id for pruning/debugging (owner_id nullable — a
-- transcript-driven turn can carry no coord identity). No RLS, mirrors 609/610/612.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.topic_hysteresis (
  session_id     TEXT        PRIMARY KEY,                   -- the SELF session whose subscription state this is
  owner_id       TEXT,                                      -- coord identity (nullable; for pruning/debug only)
  tick           BIGINT      NOT NULL DEFAULT 0,            -- monotonic tick counter
  subscriptions  JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- TopicSubscription[] carried across ticks
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention prune scans by staleness (drop state for sessions gone quiet).
CREATE INDEX IF NOT EXISTS topic_hysteresis_updated_idx
  ON harness_shared.topic_hysteresis (updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.topic_hysteresis TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.topic_hysteresis TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
