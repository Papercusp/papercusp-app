-- 522-engineer-issues-operator-scope-empty-slug-cleanup.sql
--
-- EI-7808: issue-family self-select could appear to hand out an already-terminal
-- item because duplicate physical work_items rows existed for one logical EI id:
-- a stale empty harness_slug='' twin beside the canonical operator:<workspace> or
-- harness-scoped row. The claim query selected the canonical open row, then the
-- engineer_issues view re-read by (workspace_id, issue_id) could return the stale
-- resolved empty-slug twin. The active re-introducer was the Hyperbee
-- engineer-issues projection, which wrote operator-scope remote rows directly to
-- work_items with harness_slug=''; the app fix now writes operator:<workspace>.
--
-- This migration repairs the live data/view contract:
--   1. drop stale empty-slug issue twins when a non-empty sibling exists;
--   2. re-home any remaining empty-slug issue rows to operator:<workspace>;
--   3. restore the engineer_issues view to derive scope from harness_slug, not
--      payload._ei.scope, while preserving base_harness_slug/base_origin for exact DML.

DELETE FROM harness_shared.work_items a
 WHERE a.item_kind IN ('bug', 'change', 'task')
   AND a.harness_slug = ''
   AND EXISTS (
     SELECT 1
       FROM harness_shared.work_items b
      WHERE b.workspace_id = a.workspace_id
        AND b.feature_id = a.feature_id
        AND b.item_kind IN ('bug', 'change', 'task')
        AND b.harness_slug <> ''
   );

UPDATE harness_shared.work_items
   SET harness_slug = 'operator:' || COALESCE(NULLIF(workspace_id, ''), 'default')
 WHERE item_kind IN ('bug', 'change', 'task')
   AND harness_slug = '';

CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT workspace_id,
     feature_id AS issue_id,
     CASE WHEN harness_slug LIKE 'operator:%' OR harness_slug = '' THEN 'operator'
          ELSE 'harness:' || harness_slug END AS scope,
     title,
     COALESCE(summary, '') AS body,
     COALESCE((payload -> '_ei') ->> 'severity', 'minor') AS severity,
     COALESCE((payload -> '_ei') ->> 'source', 'engineer') AS source,
     status AS state,
     taken_by AS assignee,
     (payload -> '_ei') ->> 'found_during' AS found_during,
     (payload -> '_ei') ->> 'linked_feature_id' AS linked_feature_id,
     (payload -> '_ei') ->> 'created_by' AS created_by,
     to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
     to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
     author_pubkey,
     origin,
     _search,
     item_kind AS kind,
     payload - '_ei' AS payload,
     (payload -> '_ei') ->> 'assigned_by' AS assigned_by,
     taken_at AS assigned_at,
     assignee_rank,
     rank_writer,
     rank_updated_at,
     fed_ts,
     COALESCE((payload -> '_ei') ->> 'signal_origin', 'organic') AS signal_origin,
     fed_hlc,
     terminal_owner,
     terminal_completion_ref,
     last_progress_at,
     harness_slug AS base_harness_slug,
     origin AS base_origin
    FROM harness_shared.work_items
   WHERE item_kind = ANY (ARRAY['bug', 'change', 'task']);
