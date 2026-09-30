-- 599: causal generations + inspection metadata for announced events
-- (agent-operability-improvements-implementation-2026-07-13 P-018).
--
-- Reuse event_awaits: policy='announce' is already the durable declaration
-- and latch row.  A declaration now owns a monotonic generation per exact
-- event key.  Re-declaring supersedes (but does not erase) the prior row, so
-- events:status can explain stale wakes and consumers can resync to one
-- authoritative generation.

ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS causal_generation bigint,
  ADD COLUMN IF NOT EXISTS expected_condition jsonb,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS fired_by text,
  ADD COLUMN IF NOT EXISTS fired_payload jsonb;

-- Give pre-migration declarations deterministic generations in declaration
-- order.  Ordinary await rows deliberately keep causal_generation NULL.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id, event_key
           ORDER BY created_at, id
         )::bigint AS generation,
         row_number() OVER (
           PARTITION BY workspace_id, event_key
           ORDER BY created_at DESC, id DESC
         ) AS newest_rank
    FROM harness_shared.event_awaits
   WHERE policy = 'announce'
), updated AS (
  UPDATE harness_shared.event_awaits a
     SET causal_generation = r.generation
    FROM ranked r
   WHERE a.id = r.id
  RETURNING a.id
)
UPDATE harness_shared.event_awaits a
   SET superseded_at = COALESCE(a.fired_at, a.cancelled_at, a.created_at)
  FROM ranked r
 WHERE a.id = r.id
   AND r.newest_rank > 1
   AND a.superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS event_awaits_announce_generation_unique
  ON harness_shared.event_awaits (workspace_id, event_key, causal_generation)
  WHERE policy = 'announce' AND causal_generation IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_awaits_announce_current
  ON harness_shared.event_awaits (workspace_id, event_key, causal_generation DESC)
  WHERE policy = 'announce' AND superseded_at IS NULL;

COMMENT ON COLUMN harness_shared.event_awaits.causal_generation IS
  'Monotonic declaration generation for policy=announce rows, scoped by exact event_key. NULL on ordinary waiter rows.';

COMMENT ON COLUMN harness_shared.event_awaits.expected_condition IS
  'Optional declared completion condition: {kind:sha,sha:<hex>} or {kind:predicate,predicate:<DataCondition>}.';

COMMENT ON COLUMN harness_shared.event_awaits.superseded_at IS
  'A newer declaration generation replaced this row. History is retained for exact-key inspection and stale-generation resync.';

COMMENT ON COLUMN harness_shared.event_awaits.fired_by IS
  'Emitter owner/source that fired the current announced generation, when known.';

COMMENT ON COLUMN harness_shared.event_awaits.fired_payload IS
  'Payload captured when the announced generation latched; used to verify its declared expected SHA/predicate.';
