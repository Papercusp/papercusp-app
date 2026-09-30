-- 871-lifecycle-bound-watches.sql
-- state-plane-interest-and-hardening-2026-08-21 P-013 / D-003.
--
-- Interest machinery may arm an await/predicate watch because an agent holds a
-- transient role or lane. Persist that justification so the lifecycle exit can
-- retire the machinery and every resulting wake can name why it existed.
-- Manual rows remain NULL and retain their existing caller-owned lifecycle.

ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS bound_to jsonb;

ALTER TABLE harness_shared.predicate_watches
  ADD COLUMN IF NOT EXISTS bound_to jsonb;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'event_awaits_bound_to_shape'
       AND conrelid = 'harness_shared.event_awaits'::regclass
  ) THEN
    ALTER TABLE harness_shared.event_awaits
      ADD CONSTRAINT event_awaits_bound_to_shape CHECK (
        bound_to IS NULL OR (
          jsonb_typeof(bound_to) = 'object'
          AND bound_to ?& ARRAY['kind', 'ref']
          AND bound_to - ARRAY['kind', 'ref'] = '{}'::jsonb
          AND jsonb_typeof(bound_to -> 'kind') = 'string'
          AND jsonb_typeof(bound_to -> 'ref') = 'string'
          AND length(btrim(bound_to ->> 'kind')) > 0
          AND length(btrim(bound_to ->> 'ref')) > 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'predicate_watches_bound_to_shape'
       AND conrelid = 'harness_shared.predicate_watches'::regclass
  ) THEN
    ALTER TABLE harness_shared.predicate_watches
      ADD CONSTRAINT predicate_watches_bound_to_shape CHECK (
        bound_to IS NULL OR (
          jsonb_typeof(bound_to) = 'object'
          AND bound_to ?& ARRAY['kind', 'ref']
          AND bound_to - ARRAY['kind', 'ref'] = '{}'::jsonb
          AND jsonb_typeof(bound_to -> 'kind') = 'string'
          AND jsonb_typeof(bound_to -> 'ref') = 'string'
          AND length(btrim(bound_to ->> 'kind')) > 0
          AND length(btrim(bound_to ->> 'ref')) > 0
        )
      );
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS event_awaits_bound_to_active
  ON harness_shared.event_awaits ((bound_to ->> 'kind'), (bound_to ->> 'ref'))
  WHERE bound_to IS NOT NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS predicate_watches_bound_to_active
  ON harness_shared.predicate_watches ((bound_to ->> 'kind'), (bound_to ->> 'ref'))
  WHERE bound_to IS NOT NULL AND active;
