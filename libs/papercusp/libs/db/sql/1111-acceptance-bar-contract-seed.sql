-- 1111 — requirements-with-teeth: durable BAR cohort + hash-pinned spec projections.
--
-- Existing rows remain historical (NULL cohort). A BEFORE INSERT trigger stamps new
-- non-rubric plans independently of the activation seeder, so a failed/rolled-back
-- seed cannot make a zero-BAR post-epoch plan look historical. The canonical BAR
-- remains the acceptance rubric criterion; these columns are only lifecycle/pin
-- metadata on the existing plan and plan_spec_clause revision spines.

\set ON_ERROR_STOP on
-- The migration runner supplies the transaction and ON_ERROR_STOP behavior.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS acceptance_bar_epoch integer,
  ADD COLUMN IF NOT EXISTS acceptance_bar_cohort text,
  ADD COLUMN IF NOT EXISTS acceptance_bar_set_hash text,
  ADD COLUMN IF NOT EXISTS acceptance_bar_rubric_slug text,
  ADD COLUMN IF NOT EXISTS acceptance_bar_rubric_revision bigint,
  ADD COLUMN IF NOT EXISTS acceptance_bar_seeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS acceptance_bar_seeded_by text;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.harness_plans
    ADD CONSTRAINT harness_plans_acceptance_bar_epoch_positive
    CHECK (acceptance_bar_epoch IS NULL OR acceptance_bar_epoch > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.harness_plans
    ADD CONSTRAINT harness_plans_acceptance_bar_cohort_valid
    CHECK (acceptance_bar_cohort IS NULL OR acceptance_bar_cohort IN ('post-epoch', 'legacy-backfilled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.harness_plans
    ADD CONSTRAINT harness_plans_acceptance_bar_marker_complete
    CHECK ((acceptance_bar_epoch IS NULL) = (acceptance_bar_cohort IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.harness_plans
    ADD CONSTRAINT harness_plans_acceptance_bar_seed_pin_complete
    CHECK (
      (acceptance_bar_set_hash IS NULL
       AND acceptance_bar_rubric_slug IS NULL
       AND acceptance_bar_rubric_revision IS NULL
       AND acceptance_bar_seeded_at IS NULL
       AND acceptance_bar_seeded_by IS NULL)
      OR
      (acceptance_bar_set_hash ~ '^[0-9a-f]{64}$'
       AND length(btrim(acceptance_bar_rubric_slug)) > 0
       AND acceptance_bar_rubric_revision > 0
       AND acceptance_bar_seeded_at IS NOT NULL
       AND length(btrim(acceptance_bar_seeded_by)) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

CREATE OR REPLACE FUNCTION harness_shared.stamp_acceptance_bar_epoch()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- A rubric is the BAR authority for another plan, never a subject-plan cohort.
  -- Existing plans are intentionally untouched; P-010 owns their explicit cohort
  -- migration. New ordinary/template-backed plans are strict from creation.
  IF NEW.template IS DISTINCT FROM 'rubric' AND NEW.acceptance_bar_epoch IS NULL THEN
    NEW.acceptance_bar_epoch := 1;
    NEW.acceptance_bar_cohort := 'post-epoch';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS harness_plans_stamp_acceptance_bar_epoch
  ON harness_shared.harness_plans;
CREATE TRIGGER harness_plans_stamp_acceptance_bar_epoch
  BEFORE INSERT ON harness_shared.harness_plans
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_acceptance_bar_epoch();

CREATE INDEX IF NOT EXISTS harness_plans_acceptance_bar_unseeded
  ON harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
  WHERE acceptance_bar_epoch IS NOT NULL AND acceptance_bar_set_hash IS NULL;

ALTER TABLE harness_shared.plan_spec_clause_revisions
  ADD COLUMN IF NOT EXISTS source_bar_key text,
  ADD COLUMN IF NOT EXISTS source_bar_hash text,
  ADD COLUMN IF NOT EXISTS source_bar_set_hash text,
  ADD COLUMN IF NOT EXISTS source_rubric_slug text,
  ADD COLUMN IF NOT EXISTS source_rubric_revision bigint,
  ADD COLUMN IF NOT EXISTS evidence_plane text;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.plan_spec_clause_revisions
    ADD CONSTRAINT plan_spec_clause_revisions_bar_pin_complete
    CHECK (
      (source_bar_key IS NULL
       AND source_bar_hash IS NULL
       AND source_bar_set_hash IS NULL
       AND source_rubric_slug IS NULL
       AND source_rubric_revision IS NULL
       AND evidence_plane IS NULL)
      OR
      (length(btrim(source_bar_key)) > 0
       AND source_bar_hash ~ '^[0-9a-f]{64}$'
       AND source_bar_set_hash ~ '^[0-9a-f]{64}$'
       AND length(btrim(source_rubric_slug)) > 0
       AND source_rubric_revision > 0
       AND evidence_plane IN ('tree', 'deployed', 'live'))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;

CREATE INDEX IF NOT EXISTS plan_spec_clause_revisions_by_bar
  ON harness_shared.plan_spec_clause_revisions
    (workspace_id, harness_slug, plan_slug, source_bar_key, plan_item_id, revision DESC)
  WHERE source_bar_key IS NOT NULL;

COMMENT ON COLUMN harness_shared.harness_plans.acceptance_bar_epoch IS
  'Server-owned BAR contract epoch. NULL is the historical cohort; presence never depends on successful seeding.';
COMMENT ON COLUMN harness_shared.harness_plans.acceptance_bar_set_hash IS
  'Exact sorted (barKey,barHash) set pinned by the last successful transactional seed/amendment.';
COMMENT ON COLUMN harness_shared.plan_spec_clause_revisions.source_bar_hash IS
  'Immutable canonical acceptance BAR hash that this spec-clause projection was derived from.';
