-- 614-adjacency-state.sql — ambient-semantic-push-2026-07-14 P-013 (adjacency cross-feed, live leg).
--
-- adjacency_state — the per-session carried state of the sustained-ADJACENCY
-- detector (adjacency-cross-feed.ts adjacencyTick): the band BELOW P-004's
-- collision, where two cursors stay similar without being duplicates. One row
-- per SELF session = the AdjacencyState[] it carries tick-to-tick + the
-- monotonic tick counter, exactly like 612 collision_hysteresis (same dwell
-- rationale: the enter edge needs the in-band streak to survive across
-- turn-end ticks, which an agent's transcript does not do).
--
-- `topics` is the live leg's OWN bookkeeping the pure fold does not carry:
-- { [peerSessionId]: { topic, terms, peerOwnerId } } recorded on each
-- adjacency-enter edge. It exists because the pure fold re-derives the topic
-- name from the CURRENT shared terms at notice time — which drift tick to
-- tick — so an exit's re-derived name can differ from the slug actually
-- subscribed at enter. Unsubscribe must target the RECORDED slug; the terms
-- keep the cross-feed's on-topic test stable; peerOwnerId is the cross-feed
-- delivery axis for ticks where the peer is absent from the snapshot.
--
-- Owner-keyed alongside session_id for pruning/debugging (owner_id nullable).
-- No RLS, mirrors 605/609/610/612/613.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.adjacency_state (
  session_id  TEXT        PRIMARY KEY,                   -- the SELF session whose adjacency state this is
  owner_id    TEXT,                                      -- coord identity (nullable; for pruning/debug only)
  tick        BIGINT      NOT NULL DEFAULT 0,            -- monotonic tick counter (recorded as enteredAtTick)
  states      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- AdjacencyState[] carried across ticks
  topics      JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { [peerSessionId]: { topic, terms, peerOwnerId } }
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention prune scans by staleness (drop state for sessions gone quiet).
CREATE INDEX IF NOT EXISTS adjacency_state_updated_idx
  ON harness_shared.adjacency_state (updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.adjacency_state TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.adjacency_state TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
