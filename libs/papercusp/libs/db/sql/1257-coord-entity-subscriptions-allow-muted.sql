-- 1257-coord-entity-subscriptions-allow-muted.sql
--
-- portable-identity-packages-2026-09-26 P-018 (D-027 §2, D-029 §1): a worn
-- asynchronous identity rule subscribes to its catalogued event key as a
-- coord_entity_subscriptions row with delivery_mode='muted'. The emit's notify
-- fan-out (events/await/engine.ts emitAwaitedEvent) already excludes 'muted' as
-- "never live-deliver", so the row is an index of interest for the durable
-- reaction enqueue, never a coord message. But the original mode check
-- (123-coordination-substrate.sql) only allows 'full' | 'digest' | 'mention', so
-- no row could carry 'muted' and that filter was unreachable.
--
-- The same value is what fleet:delivery writes for a member's 'muted' per-fleet
-- override (coordination/fleet-delivery.ts: delivery_mode ∈ {digest, muted}); 429
-- admitted its target_kind='fleet' but left this check, so that INSERT is refused
-- here too.
--
-- FORWARD-COMPAT: widening a CHECK admits a superset; the currently deployed release never writes 'muted' through a path that succeeds today, and every existing row already satisfies the new check.
--
-- Idempotent: drop + re-add the constraint.

ALTER TABLE harness_shared.coord_entity_subscriptions
  DROP CONSTRAINT IF EXISTS coord_entity_subscriptions_mode_check;

ALTER TABLE harness_shared.coord_entity_subscriptions
  ADD CONSTRAINT coord_entity_subscriptions_mode_check
    CHECK ((delivery_mode = ANY (ARRAY['full'::text, 'digest'::text, 'mention'::text, 'muted'::text])));
