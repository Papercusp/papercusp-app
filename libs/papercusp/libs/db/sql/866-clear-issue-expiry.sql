-- 866-clear-issue-expiry.sql
--
-- EI-19459583086141815 — issue-family work-items inherited a 7-day expiry from
-- the compatibility-view INSERT trigger even though that expiry is not a live
-- lease and no code enforces it.  The result was a populated, unenforced
-- `expires_at` column that looked like a cleanup policy and could destroy real
-- work if a future reaper trusted it.
--
-- The issue-family compatibility trigger is amended by many later migrations.
-- Patch the installed definition rather than restating a stale full function,
-- then clear the historical issue-family values. Feature-family leases remain
-- untouched: they are real checkout state and still use `expires_at`.

DO $mig866_dml$
DECLARE
  v_def          text;
  v_patched      text;
  v_column_hits  integer;
  v_value_hits   integer;
  v_insert_cols  constant text := '       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,';
  v_insert_value constant text := '       CASE WHEN NEW.assigned_at IS NOT NULL THEN NEW.assigned_at + INTERVAL ''7 days'' ELSE NULL END,';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '866: harness_shared.engineer_issues_view_dml() not found — expected the issue compatibility view trigger to exist first';
  END IF;

  -- Idempotent: a replay sees neither half of the old writer.  If only one
  -- anchor remains, fail closed rather than silently installing a mis-bound
  -- INSERT column/value list.
  IF position(v_insert_cols IN v_def) = 0
     AND position(v_insert_value IN v_def) = 0 THEN
    RAISE NOTICE '866: engineer_issues_view_dml already omits issue expiry — no-op';
  ELSE
    v_column_hits := (length(v_def) - length(replace(v_def, v_insert_cols, ''))) / length(v_insert_cols);
    v_value_hits := (length(v_def) - length(replace(v_def, v_insert_value, ''))) / length(v_insert_value);
    IF v_column_hits <> 1 OR v_value_hits <> 1 THEN
      RAISE EXCEPTION
        '866: expected exactly one issue-expiry INSERT column anchor and one value anchor, found columns=% values=% — trigger shape changed; re-derive the surgery',
        v_column_hits, v_value_hits;
    END IF;

    v_patched := replace(v_def, v_insert_cols, '       item_kind, origin, author_pubkey, assignee_rank, rank_writer,');
    v_patched := replace(v_patched, v_insert_value, '');
    IF v_patched = v_def THEN
      RAISE EXCEPTION '866: engineer_issues_view_dml surgery produced no change';
    END IF;
    EXECUTE v_patched;

    -- Verify the catalog definition, not the local patch string.
    SELECT pg_get_functiondef(p.oid)
      INTO v_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'harness_shared'
       AND p.proname = 'engineer_issues_view_dml';
    IF position(v_insert_cols IN v_def) > 0
       OR position(v_insert_value IN v_def) > 0 THEN
      RAISE EXCEPTION
        '866: post-condition failed — engineer_issues_view_dml still contains the issue expiry writer';
    END IF;
  END IF;
END
$mig866_dml$;

DO $mig866_data$
DECLARE
  v_cleared   integer;
  v_remaining integer;
BEGIN
  -- The unified work_items table is the physical write surface.  Scope this
  -- repair to the issue family so feature/research/chunk checkout leases are
  -- not altered.
  UPDATE harness_shared.work_items
     SET expires_at = NULL
   WHERE item_kind IN ('bug', 'change', 'task')
     AND expires_at IS NOT NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  SELECT count(*)::integer
    INTO v_remaining
    FROM harness_shared.work_items
   WHERE item_kind IN ('bug', 'change', 'task')
     AND expires_at IS NOT NULL;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      '866: issue-family expiry cleanup left % non-NULL row(s)', v_remaining;
  END IF;

  RAISE NOTICE '866: cleared expires_at on % issue-family row(s); feature-family leases preserved', v_cleared;
END
$mig866_data$;
