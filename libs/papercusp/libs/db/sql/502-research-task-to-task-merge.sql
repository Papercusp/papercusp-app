-- 502-research-task-to-task-merge.sql
-- WI-2874 (2026-07-05): the `research-task` kind was MERGED INTO `task`. Research is
-- non-code work, which is what `task` now means.
--
-- STRUCTURE: `harness_shared.work_items` is a single unified BASE TABLE (mig 374, PK
-- (harness_slug, feature_id)); `harness_features_consolidated` and `engineer_issues`
-- are VIEWS over it, routed by the `item_kind` discriminator column. So reclassifying
-- research-task -> task is an IN-PLACE `UPDATE item_kind` — NOT a cross-table move.
-- After the update the row simply surfaces through the engineer_issues (issue-family)
-- view instead of the features view; the code side (work-items.ts FEATURE_FAMILY_KINDS,
-- claim floors, sentinel deep-delegate, plan executor) has dropped research-task.
--
-- The base `status` column holds all lifecycle values. Non-terminal research-task rows
-- carry valid issue statuses already (todo/blocked/open); the two FEATURE-only terminal
-- statuses are remapped to the equivalent ISSUE terminal states so every reclassified
-- row is a well-formed task: passed -> resolved, deprecated -> closed.
--
-- Idempotent: no research-task rows remain afterward, so a re-run updates 0 rows.
UPDATE harness_shared.work_items
   SET item_kind = 'task',
       status = CASE status
                  WHEN 'passed'     THEN 'resolved'
                  WHEN 'deprecated' THEN 'closed'
                  ELSE status
                END
 WHERE item_kind = 'research-task';
