-- 1258 — harness_plans.acceptance_bar_verified_revision (WI-10004146, endgame D-093 option B)
--
-- A subject plan's acceptance-BAR pin is `rubric.barContract.subjectPlanRevision`,
-- which is the AUTHOR node's local plan `version`. `version` is a machine-local CAS
-- counter (a remote insert lands at 0 and every remote apply bumps it), so on a
-- federated receiver that pin can never equal the local plan revision and the
-- contract snapshot refuses launch with bar_snapshot_rubric_revision_mismatch.
--
-- This machine-local column records the LOCAL plan version at which a federated
-- receiver re-derived its BAR state and proved the federated rubric rebuilds
-- byte-identically from the local plan body. When it is non-null the snapshot
-- compares it (not the author's pin) against the local plan version; any later
-- change to the local plan bumps the version and re-opens the mismatch until the
-- receiver seed verifies again. Author-side writers leave it NULL, so the author
-- keeps today's rubric-pin comparison. It is not federated (re-derived on apply).
--
-- Additive and nullable: no forward-compat acknowledgement is needed.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS acceptance_bar_verified_revision bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'harness_plans_acceptance_bar_verified_revision_nonneg'
       AND conrelid = 'harness_shared.harness_plans'::regclass
  ) THEN
    ALTER TABLE harness_shared.harness_plans
      ADD CONSTRAINT harness_plans_acceptance_bar_verified_revision_nonneg
      CHECK (acceptance_bar_verified_revision IS NULL OR acceptance_bar_verified_revision >= 0);
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.harness_plans.acceptance_bar_verified_revision IS
  'Machine-local, not federated. The local plan version at which a federated receiver '
  'verified its acceptance-BAR state against the federated rubric (WI-10004146). When '
  'non-null the contract snapshot compares it, not rubric.barContract.subjectPlanRevision, '
  'with the local plan version. NULL on the authoring node.';
