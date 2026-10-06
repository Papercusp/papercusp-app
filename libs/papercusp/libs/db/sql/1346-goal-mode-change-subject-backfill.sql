-- 1346-goal-mode-change-subject-backfill.sql — WI-10005573 (replaced goal holders stay goal agents)
--
-- agent_mode_changes.subject (added by 1331) is how the goal holder reaper finds
-- the FORMER holders of a goal: an owner with a GOAL transition for that goal and
-- no live GOAL row. That selection is only as complete as the subject column, and
-- it was not complete. Measured 2026-10-02 on goal 60d3a8: of the 11 superseded
-- holders retired at 18:12Z, three (su-6aab097a, su-2e6fb313, su-e1774015) became
-- holders before 1331 and every one of the 11 retire rows was written with a NULL
-- subject, because setMode's disable path did not pass the deleted row's subject
-- to its audit. su-2e6fb313 kept a pending plan:acceptance await for the goal that
-- the reaper could not attribute.
--
-- The disable path now records the subject (packages/operator-core/lib/modes/store.ts).
-- This migration repairs the rows already written. Every GOAL transition writer
-- names the goal in its reason with one of five fixed shapes; a row is backfilled
-- only when the extracted id is a goal that exists in the same workspace, so a
-- free-text reason that merely mentions a goal-like slug is left NULL.
--
-- Data-only and idempotent (it touches NULL subjects only). It cannot change a
-- holder election: the epoch high-water reads rows with a non-NULL
-- goal_lease_epoch, and none of the rows written without a subject carries one.

WITH extracted AS (
  SELECT c.id,
         c.workspace_id,
         COALESCE(
           substring(c.reason from '^GOAL lease ''([a-z0-9-]+)'' superseded'),
           substring(c.reason from 'recovered lost holder for ([a-z0-9-]+)'),
           substring(c.reason from '^(?:owns|activated) goal ([a-z0-9-]+) '),
           substring(c.reason from '^goal ([a-z0-9-]+) reached a terminal status')
         ) AS goal_id
    FROM harness_shared.agent_mode_changes c
   WHERE c.axis_key = 'overlay:goal'
     AND c.subject IS NULL
)
UPDATE harness_shared.agent_mode_changes c
   SET subject = e.goal_id
  FROM extracted e
 WHERE c.id = e.id
   AND e.goal_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM harness_shared.goals g
      WHERE g.workspace_id = e.workspace_id
        AND g.id = e.goal_id);
