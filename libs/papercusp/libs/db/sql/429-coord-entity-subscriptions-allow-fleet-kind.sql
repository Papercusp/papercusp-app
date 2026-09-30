-- 429-coord-entity-subscriptions-allow-fleet-kind.sql
--
-- fleet-messaging-integrate-and-land-2026-06-30 (finishes P-004/P-008): the
-- fleet:delivery feature stores a member's per-fleet delivery override as a row in
-- harness_shared.coord_entity_subscriptions with target_kind='fleet'
-- (FLEET_DELIVERY_KIND — see coordination/fleet-delivery.ts). But the original
-- kind check (123-coordination-substrate.sql) only allowed 'topic' | 'object', so
-- every digest/muted override INSERT failed at runtime with
--   coord_entity_subscriptions_kind_check violation
-- (mode='full' appeared to work only because it DELETEs the row, never inserting).
-- The enabling migration was never written when the feature landed. Allow 'fleet'.
--
-- Idempotent: drop + re-add the constraint.

ALTER TABLE harness_shared.coord_entity_subscriptions
  DROP CONSTRAINT IF EXISTS coord_entity_subscriptions_kind_check;

ALTER TABLE harness_shared.coord_entity_subscriptions
  ADD CONSTRAINT coord_entity_subscriptions_kind_check
    CHECK ((target_kind = ANY (ARRAY['topic'::text, 'object'::text, 'fleet'::text])));
