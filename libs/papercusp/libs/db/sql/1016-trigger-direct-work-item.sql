-- 1016-trigger-direct-work-item.sql — P-018 / D-014
--
-- Add a first-class direct work-item target to the external-trigger binding
-- substrate.  Existing plan and goal bindings remain valid; a binding still
-- has exactly one target.  The target kind is resolved through the workspace
-- datatype registry by the canonical work_items writer, so this migration does
-- not duplicate a datatype foreign key that cannot be represented as a single
-- global relation.
-- FORWARD-COMPAT: the currently deployed release writes only the existing
-- plan/goal target columns.  The new direct-work-item columns are nullable, and
-- the replacement exactly-one check preserves the legacy plan/goal cases under
-- the runner-owned transaction while adding the third target form.

ALTER TABLE harness_shared.trigger_bindings
  ADD COLUMN IF NOT EXISTS work_item_harness_slug text,
  ADD COLUMN IF NOT EXISTS work_item_kind text;

COMMENT ON COLUMN harness_shared.trigger_bindings.work_item_harness_slug IS
  'Direct work-item target harness. Paired with work_item_kind; resolved by the canonical work_items writer.';
COMMENT ON COLUMN harness_shared.trigger_bindings.work_item_kind IS
  'Direct work-item target kind (for example email-draft-proposal). Paired with work_item_harness_slug and validated against the workspace datatype registry at dispatch.';

DO $$
BEGIN
  -- Migration 921 installed the plan/goal-only check. Replace it with the
  -- three-way target check while preserving the same constraint name for
  -- callers that inspect it.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_bindings'::regclass
       AND conname = 'trigger_bindings_exactly_one_target'
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      DROP CONSTRAINT trigger_bindings_exactly_one_target;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_bindings'::regclass
       AND conname = 'trigger_bindings_direct_work_item_cols_paired'
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      ADD CONSTRAINT trigger_bindings_direct_work_item_cols_paired
      CHECK ((work_item_kind IS NULL) = (work_item_harness_slug IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_bindings'::regclass
       AND conname = 'trigger_bindings_direct_work_item_nonempty'
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      ADD CONSTRAINT trigger_bindings_direct_work_item_nonempty
      CHECK (
        (work_item_kind IS NULL OR btrim(work_item_kind) <> '')
        AND (work_item_harness_slug IS NULL OR btrim(work_item_harness_slug) <> '')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_bindings'::regclass
       AND conname = 'trigger_bindings_exactly_one_target'
  ) THEN
    ALTER TABLE harness_shared.trigger_bindings
      ADD CONSTRAINT trigger_bindings_exactly_one_target
      CHECK (
        ((plan_slug IS NOT NULL)::int)
        + ((goal_id IS NOT NULL)::int)
        + ((work_item_kind IS NOT NULL)::int) = 1
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS trigger_bindings_ws_work_item_idx
  ON harness_shared.trigger_bindings (workspace_id, work_item_harness_slug, work_item_kind)
  WHERE work_item_kind IS NOT NULL AND detached_at IS NULL;
