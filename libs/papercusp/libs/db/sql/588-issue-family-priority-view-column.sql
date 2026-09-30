-- 588-issue-family-priority-view-column.sql
--
-- EI-10421: `engineer_issues` never exposed `feature_order` — the column
-- `setWorkItemPriority` writes directly on the `harness_shared.work_items` base row
-- for issue-family (bug/change/task) items (P-007 / EI-7407, SCHEDULER_ISSUES_CLAIMABLE
-- joined issues into the SAME dispatched backlog as features), and the column
-- `claimNextIssueWorkItem`'s tier-3 claim ORDER BY already reads unconditionally
-- (work-items.ts's EI-7407 comment). Both the WRITE and the CLAIM-ORDER read go
-- straight to the base table and were already correct.
--
-- The READ path was NOT: `issueToWorkItem` (work-items.ts) hardcoded `priority: null`
-- for every issue-family item with the comment "issue-family isn't the dispatched
-- backlog — no feature_order" — true before P-007/EI-7407, stale after. It stayed
-- hardcoded because the `engineer_issues` VIEW itself never selected `feature_order`
-- from the base table, so there was no column to read even after the app-layer fix.
-- Net effect: a caller who wrote priority via `work_items:set_priority` (written:true,
-- confirmed landed) then read it back via `work_items:get` / `work_items:list` always
-- saw `priority: null` — indistinguishable from "the write silently no-op'd" — even
-- though the write AND the claim ordering were both already correct.
--
-- Fix: expose `feature_order` on the view (byte-identical column list otherwise).
-- The companion app-layer fix (ISSUE_COLS + issueToWorkItem) lands alongside this.

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
     origin AS base_origin,
     feature_order
    FROM harness_shared.work_items
   WHERE item_kind = ANY (ARRAY['bug', 'change', 'task']);
