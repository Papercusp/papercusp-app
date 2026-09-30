-- 632-event-key-fire-latch.sql — EI-13705 (a gate fired via a bare events:emit
-- left NO durable trace it ever fired: events:status reported the key
-- 'undeclared', so later readers concluded "never emitted" and a real 7-day
-- stall on P-401/P-403 resulted).
--
-- Root cause: `events:status`'s current_state was derived ONLY from the
-- 'announce'-policy rows in event_awaits. A bare emit (no announce:true) only
-- ever touches event_awaits rows that already existed at fire time (an
-- UPDATE, never an INSERT) and event_wake_deliveries rows for whoever was
-- actually woken — so a key with no active announcement and no still-visible
-- waiter/delivery evidence (the common case days later, once those rows have
-- long since fired/expired/been superseded) looks IDENTICAL to a key that
-- never fired at all.
--
-- Fix: every real fire (emitAwaitedEvent, the non-announce path) now also
-- upserts ONE small latch row per key — independent of whether anyone was
-- listening, and independent of the announce/waiter machinery — so
-- "did this key ever genuinely fire, and when" is answered from a single
-- cheap point lookup forever, not reconstructed from decaying evidence.

CREATE TABLE IF NOT EXISTS harness_shared.event_key_fires (
  workspace_id     TEXT        NOT NULL DEFAULT 'default',
  event_key        TEXT        NOT NULL,
  first_fired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_by    TEXT,
  last_payload     JSONB,
  fire_count       BIGINT      NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, event_key)
);

COMMENT ON TABLE harness_shared.event_key_fires IS
  'EI-13705: an unconditional per-key "did this ever fire" latch, upserted on every emitAwaitedEvent (non-announce) call regardless of waiters/announcement — so events:status can distinguish a key that genuinely fired (fired_undeclared) from one that truly never has (undeclared), independent of how much time has passed or whether anyone was listening at fire time.';
