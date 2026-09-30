-- 568-coord-entity-subscriptions-allow-event-kind.sql
--
-- p2p-parity-closeout-lanes-2026-07-10 (WI-4014, linking-system Part 2): a standing
-- EVENT-KEY inject subscription (watch:create { pattern:<eventKey>, wake:false,
-- targetKind:'event' }) stores a row in harness_shared.coord_entity_subscriptions
-- with target_kind='event' — but the original kind check (123-coordination-substrate.sql,
-- widened once already by 429-coord-entity-subscriptions-allow-fleet-kind.sql for
-- 'fleet') only allows 'topic' | 'object' | 'fleet'. Every event-key subscribe would
-- fail at runtime with a coord_entity_subscriptions_kind_check violation. Allow 'event'.
--
-- Idempotent: drop + re-add the constraint (same pattern as migration 429).

ALTER TABLE harness_shared.coord_entity_subscriptions
  DROP CONSTRAINT IF EXISTS coord_entity_subscriptions_kind_check;

ALTER TABLE harness_shared.coord_entity_subscriptions
  ADD CONSTRAINT coord_entity_subscriptions_kind_check
    CHECK ((target_kind = ANY (ARRAY['topic'::text, 'object'::text, 'fleet'::text, 'event'::text])));
