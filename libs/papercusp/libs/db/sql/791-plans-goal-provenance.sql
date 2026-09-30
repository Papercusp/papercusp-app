-- 791 — harness_plans.goal_id: a plan's DIRECT link to the goal it was created under.
--
-- WHY (owner-reported 2026-08-10): the goal popup showed the goal's work item but NOT
-- the plan its agent had just created and started. That is not a rendering bug — the
-- rail could not know. A plan reached a goal by exactly one derivation (D-010):
--
--   plan serves goal  IFF  a work item stamped with that goal has source_plan_slug = plan
--
-- which is honest but cannot see the case that matters most on a young goal: the plan the
-- goal's OWN agent authored. Measured on goal make-a-website-displaying-images-of-pandas:
-- one work item carried the stamp, its source_plan_slug was NULL, and the plan the agent
-- had started minutes earlier was invisible. Every new goal starts in exactly that state,
-- so the rail was empty precisely while the owner was watching to see if the agent worked.
--
-- The rejected alternative stays rejected: "every plan in a pot linked to this goal" would
-- render a whole plan directory (papercusp holds thousands) under a one-day-old goal. This
-- column is the narrow, provenance-stamped third leg instead — the SAME rule work_items
-- already use (migration 785 / work_items.goal_id), written from the creator's RESOLVED
-- goal context (modes/goal-context.ts resolveGoalContext), never from an argument, so a
-- plan cannot self-report its way onto a goal.
--
-- EXPAND-only: a nullable column plus one partial index. Nothing reads it until the code
-- that does is deployed, and the pre-existing derivation keeps working untouched, so the
-- currently-deployed release is unaffected. No FORWARD-COMPAT line is required (no
-- destructive DDL).

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS goal_id text;

COMMENT ON COLUMN harness_shared.harness_plans.goal_id IS
  'The goal this plan was created under, stamped at plan-create from the creator''s resolved GOAL-mode context (never an argument). NULL for plans created outside a goal — the common case. Read as a UNION with the work-item-derived association, never as a replacement for it: a plan can serve a goal by carrying its stamped work items without ever having been created under it.';

-- Partial: the overwhelming majority of plans are not created under a goal, and the only
-- query shape is "the plans for THIS goal", so indexing the NULLs would be dead weight.
CREATE INDEX IF NOT EXISTS harness_plans_goal_id_idx
  ON harness_shared.harness_plans (workspace_id, goal_id)
  WHERE goal_id IS NOT NULL;
