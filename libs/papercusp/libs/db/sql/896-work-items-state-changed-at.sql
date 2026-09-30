-- 896 — EI-21200252620921832: preserve the age of the current work-item state.
--
-- `updated_ts` is a last-write clock, not a state-age clock: topic/tag metadata,
-- stale-claim sweeps, and other background writers can advance it without moving
-- an item between states.  A prospective parked-item SLA built on that value is
-- therefore newest-write biased and can make chronic rows look fresh.
--
-- `state_changed_at` is maintained at the unified base-table boundary so the
-- invariant covers direct writes, both compatibility views, federation, and
-- future writers.  Existing rows are intentionally left NULL: their historical
-- transition time is not recoverable from `updated_ts` without laundering the
-- defect this migration fixes.

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz;

COMMENT ON COLUMN harness_shared.work_items.state_changed_at IS
  'Timestamp when the row entered its current status. Maintained only by '
  'harness_shared.stamp_work_item_state_changed_at(); metadata-only writes are '
  'frozen, status transitions are stamped, and supplied origin timestamps are '
  'honoured. NULL means the row predates migration 896 and has no trustworthy '
  'historical state-transition time.';

CREATE OR REPLACE FUNCTION harness_shared.stamp_work_item_state_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A caller carrying an origin timestamp (for example, a federated insert)
    -- wins.  Otherwise use created_ts when available; it is the only honest
    -- origin-time signal on a new local row.  Existing rows are not backfilled.
    NEW.state_changed_at := COALESCE(
      NEW.state_changed_at,
      CASE
        WHEN NEW.created_ts IS NOT NULL
          THEN to_timestamp(NEW.created_ts::numeric / 1000.0)
        ELSE clock_timestamp()
      END
    );
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- An omitted column arrives in NEW with OLD's value.  Treat that unchanged
    -- value as omission and stamp the real transition; a distinct value is an
    -- explicit origin timestamp and must survive the local write unchanged.
    IF NEW.state_changed_at IS NOT DISTINCT FROM OLD.state_changed_at THEN
      NEW.state_changed_at := clock_timestamp();
    END IF;
  ELSE
    -- Metadata-only writes must not move the state-age clock, even if a caller
    -- tries to write the column alongside the metadata.
    NEW.state_changed_at := OLD.state_changed_at;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION harness_shared.stamp_work_item_state_changed_at() IS
  'EI-21200252620921832: maintain state_changed_at at the work_items base-table '
  'boundary. Initial rows use supplied origin/created_ts/clock time; genuine '
  'status transitions stamp or preserve a supplied origin time; metadata-only '
  'writes are frozen; historical rows remain NULL until a real transition.';

DROP TRIGGER IF EXISTS stamp_work_item_state_changed_at_trg ON harness_shared.work_items;
CREATE TRIGGER stamp_work_item_state_changed_at_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_state_changed_at();

-- The issue-family compatibility view is the read surface used by the issue
-- queue and must expose the clock.  Patch only the structural tail anchor so a
-- concurrent trailing-column addition is not silently reverted.  CREATE OR
-- REPLACE preserves the existing INSTEAD OF DML trigger and dependents.
DO $mig896$
DECLARE
  def         text;
  patched     text;
  anchor      CONSTANT text := E'\n   FROM harness_shared.work_items';
  replacement CONSTANT text := E',\n    state_changed_at\n   FROM harness_shared.work_items';
  hits        integer;
BEGIN
  SELECT pg_get_viewdef(c.oid)
    INTO def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared'
     AND c.relname = 'engineer_issues';

  IF def IS NULL THEN
    RAISE EXCEPTION
      '896: harness_shared.engineer_issues not found — expected it before this migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'engineer_issues'
       AND column_name = 'state_changed_at'
  ) THEN
    RAISE NOTICE '896: engineer_issues already exposes state_changed_at — no-op';
    RETURN;
  END IF;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '896: expected exactly one work_items view tail anchor, found %; re-derive the view patch instead of forcing it',
      hits;
  END IF;

  patched := replace(def, anchor, replacement);
  EXECUTE format('CREATE OR REPLACE VIEW harness_shared.engineer_issues AS %s', patched);

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'engineer_issues'
       AND column_name = 'state_changed_at'
  ) THEN
    RAISE EXCEPTION
      '896: post-condition failed — engineer_issues still lacks state_changed_at';
  END IF;
END
$mig896$;

DO $mig896_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'work_items'
       AND t.tgname = 'stamp_work_item_state_changed_at_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      '896: post-condition failed — state_changed_at trigger is not installed';
  END IF;

  RAISE NOTICE '896: state_changed_at installed on work_items and engineer_issues';
END
$mig896_check$;
