-- 948-design-compare-artifact-kinds.sql
--
-- Plan: ratified-mockup-implementation-validation-2026-08-24 (P-003, P-006).
--
-- Allow two new artifact kinds on the EXISTING harness_design_artifacts table:
--
--   ratified_reference — an approved design image ratified as an immutable
--                        comparison target, with its provenance, reference
--                        class, reference revision and required capture
--                        environment.
--   compare_result     — one normalized comparison between a ratified
--                        reference and a captured implementation render.
--
-- D-003 requires reusing existing surfaces rather than standing up a parallel
-- design store, and this table already carries (harness_slug, feature_id, kind,
-- payload, metadata) with the indexes these reads need — including hda_kind_idx
-- on (harness_slug, feature_id, kind), which is exactly the lookup the gate
-- performs. So the minimal correct change is to widen the kind vocabulary, not
-- to add a table.
--
-- FORWARD-COMPAT: this only WIDENS hda_kind_chk — every kind the constraint
-- previously allowed is still allowed, and the two added kinds are written by
-- no code in the currently-deployed release, so the running :3070 checkout
-- cannot observe a row it fails to understand and cannot write a row this
-- constraint would now reject. The DROP is unavoidable because PostgreSQL has
-- no ALTER CONSTRAINT for a CHECK expression. Keep the drop + replacement in ONE
-- ALTER TABLE statement: PostgreSQL applies that statement atomically, so there
-- is no window in which the column is unconstrained and no migration-owned
-- BEGIN/COMMIT wrapper that can conflict with the migrator's transaction policy.

ALTER TABLE harness_shared.harness_design_artifacts
  DROP CONSTRAINT IF EXISTS hda_kind_chk,
  ADD CONSTRAINT hda_kind_chk CHECK (
    kind = ANY (ARRAY[
      'spec'::text,
      'sketch'::text,
      'screenshot'::text,
      'annotation'::text,
      'rejected_candidate'::text,
      'review'::text,
      'ratified_reference'::text,
      'compare_result'::text
    ])
  );

COMMENT ON CONSTRAINT hda_kind_chk ON harness_shared.harness_design_artifacts IS
  'Artifact kinds. ratified_reference and compare_result were added by migration 948 for the mockup-to-implementation validation contract; widen here rather than adding a parallel table (plan ratified-mockup-implementation-validation-2026-08-24, D-003).';
