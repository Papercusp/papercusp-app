-- 1394: data_sources.participant_backfill_at — once-per-grant marker for the participant backfill
-- (crm-agent-sales-onboarding-apps-2026-10-06 P-003, decision D-018; refines D-017 point 2).
--
-- The relationship graph learns an interaction's participants live, as each interaction arrives,
-- but only from a source granting `person -> record` (D-013 point 4). Interactions stored BEFORE
-- the grant are projected once by the participant backfill
-- (packages/operator-core/lib/relationship-graph/participant-backfill.ts runPendingParticipantBackfills),
-- which the system:connector-sync routine runs for every granted source whose marker is NULL.
--
-- NULL = not yet backfilled for the current grant. The trigger clears the marker whenever an UPDATE
-- makes a source newly grant person -> record, so a revoked-then-regranted source is backfilled
-- again. INSERT needs no trigger: a new row starts NULL.
--
-- Additive only: a nullable column and a trigger; no existing column changes.

ALTER TABLE harness_shared.data_sources
  ADD COLUMN IF NOT EXISTS participant_backfill_at timestamptz;

COMMENT ON COLUMN harness_shared.data_sources.participant_backfill_at IS
  'D-018: when the relationship-graph participant backfill last completed for this source''s current person->record grant; NULL = pending (cleared when the grant is newly added).';

CREATE OR REPLACE FUNCTION harness_shared.data_sources_reset_participant_backfill()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(NEW.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb
     AND NOT (coalesce(OLD.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb) THEN
    NEW.participant_backfill_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS data_sources_reset_participant_backfill ON harness_shared.data_sources;
CREATE TRIGGER data_sources_reset_participant_backfill
  BEFORE UPDATE OF destination_policy ON harness_shared.data_sources
  FOR EACH ROW
  WHEN (OLD.destination_policy IS DISTINCT FROM NEW.destination_policy)
  EXECUTE FUNCTION harness_shared.data_sources_reset_participant_backfill();
