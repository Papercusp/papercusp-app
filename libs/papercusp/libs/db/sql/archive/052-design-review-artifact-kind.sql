-- Migration 052 — add 'review' to harness_design_artifacts.kind enum.
--
-- Plan §4.2: after implementation ships, a reviewer agent compares the
-- rendered surface to the accepted spec and records a verdict
-- (approved / rejected / changes-requested). Reviews persist as artifacts
-- so the spec → review history is queryable on the feature.
--
-- Idempotent.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_design_artifacts
  DROP CONSTRAINT IF EXISTS hda_kind_chk;

ALTER TABLE harness_shared.harness_design_artifacts
  ADD CONSTRAINT hda_kind_chk CHECK (
    kind IN ('spec', 'sketch', 'screenshot', 'annotation', 'rejected_candidate', 'review')
  );

COMMIT;
