-- 512-engineer-issues-signal-origin-default.sql — EI-7490 follow-up
--
-- Migration 510 made `engineer_issues_view_dml()` target the physical row
-- represented by OLD. Live verification then exposed an adjacent view-shape bug:
-- the `engineer_issues` view defaulted a missing `_ei.signal_origin` to `local`,
-- but `work_items_signal_origin_chk` accepts only the learning-signal vocabulary
-- (`organic`, `drill`, `replay`, `shadow`) or NULL. Any view UPDATE on a row whose
-- payload omitted `_ei.signal_origin` therefore tried to write invalid payload
-- JSON and failed before the duplicate-key fix could be exercised.
--
-- Durable fix: default the compat-view signal_origin to `organic`, matching
-- packages/operator-core/lib/issues-engineer.ts DEFAULT_SIGNAL_ORIGIN.
-- The 510 trigger already consumes NEW.signal_origin, so replacing the view is
-- sufficient and preserves 510's `base_harness_slug` row identity column.

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
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');
