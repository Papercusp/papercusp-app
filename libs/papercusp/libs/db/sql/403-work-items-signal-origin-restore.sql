-- 403-work-items-signal-origin-restore.sql
-- Restore signal-provenance correctness on the work-item families (mig-374 follow-up).
--
-- TWO regressions mig-374 (work-items-unify) introduced for the issue family, both caught by
-- provenance.integration.test.ts:
--
-- 1) WRONG DEFAULT — the engineer_issues compat view reads
--      COALESCE(payload->'_ei'->>'signal_origin', 'local')
--    but 'local' is NOT a provenance vocabulary value (organic|drill|replay|shadow), and the
--    SYSTEM default is 'organic' (provenance.ts DEFAULT_SIGNAL_ORIGIN; the pre-374 column
--    DEFAULT was 'organic'). createIssue() returns 'organic' for an unset origin (its JS
--    default), but the VIEW returned 'local', so the loop's organic read
--    (listIssues … signal_origin = ANY('organic')) SILENTLY DROPPED every organic-default
--    improvement — the self-improvement loop stopped seeing its own friction signals. Fix the
--    view's COALESCE default to 'organic' so the stored-absent case reads as the real default.
--    ('local' was a copy of the SEPARATE federation `origin` column's default — different concept.)
--
-- 2) DROPPED VALIDATION — the old engineer_issues TABLE carried
--    engineer_issues_signal_origin_chk (mig-241) rejecting junk origins at the SQL layer. When
--    374 made engineer_issues a VIEW over work_items (signal_origin now lives in
--    payload->'_ei'->>'signal_origin'), that CHECK was lost — every OTHER provenance table
--    (learning_spend_events, replay_runs, transfer_lessons, calibration_predictions,
--    experiment_runs) still keeps its vocabulary CHECK, so this was an oversight, not a relaxation.
--    Re-attach it on the base table over the JSON path. NOT VALID: enforce on all new writes
--    (the guard) without a full-table re-scan that could trip on a stray legacy value at deploy.

-- 1) View default: 'local' -> 'organic'. CREATE OR REPLACE keeps the exact column list/order
--    (only line for signal_origin changes), so dependents + the INSTEAD OF DML triggers are
--    untouched.
CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT
    workspace_id,
    feature_id AS issue_id,
    COALESCE(payload->'_ei'->>'scope',
             CASE WHEN harness_slug = '' THEN 'operator' ELSE 'harness:' || harness_slug END) AS scope,
    title,
    COALESCE(summary, '') AS body,
    COALESCE(payload->'_ei'->>'severity', 'minor') AS severity,
    COALESCE(payload->'_ei'->>'source', 'engineer') AS source,
    status AS state,
    taken_by AS assignee,
    payload->'_ei'->>'found_during' AS found_during,
    payload->'_ei'->>'linked_feature_id' AS linked_feature_id,
    payload->'_ei'->>'created_by' AS created_by,
    to_timestamp(created_ts / 1000.0) AS created_at,
    to_timestamp(updated_ts / 1000.0) AS updated_at,
    author_pubkey, origin, _search,
    item_kind AS kind,
    (payload - '_ei') AS payload,
    payload->'_ei'->>'assigned_by' AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank, rank_writer, rank_updated_at, fed_ts,
    COALESCE(payload->'_ei'->>'signal_origin', 'organic') AS signal_origin,
    fed_hlc
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');

-- 2) Re-attach the signal_origin vocabulary CHECK on the base table, over the issue-family
--    JSON path. Feature rows carry no payload->'_ei', so the IS NULL leg passes them. Idempotent.
DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'work_items_signal_origin_chk'
       AND conrelid = 'harness_shared.work_items'::regclass
  ) THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_signal_origin_chk
      CHECK (
        payload->'_ei'->>'signal_origin' IS NULL
        OR payload->'_ei'->>'signal_origin' = ANY (ARRAY['organic','drill','replay','shadow'])
      ) NOT VALID;
  END IF;
END
$body$;
