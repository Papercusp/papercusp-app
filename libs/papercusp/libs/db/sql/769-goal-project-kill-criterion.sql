-- 769-goal-project-kill-criterion.sql
--
-- GOAL mode's contract (clause 4) requires a kill criterion for every PROJECT,
-- not only for the goal — an agent that cannot say what would make it stop
-- working on a project will not stop working on it. Migration 765 gave the
-- criterion a home on `goals`; this gives it one on the goal ↔ project edge.
--
-- WHY ON THE EDGE, not on the harness. A project can serve several goals
-- (D-021), and the criterion is a statement about THIS project's role in THIS
-- goal: the same shared payments library can be worth keeping for "ship a paid
-- app" and worth dropping from "cut checkout abandonment". Putting it on the
-- harness would force those two goals to share one answer, and the goal that
-- lost the argument would silently inherit a criterion that is wrong for it.
--
-- Purely additive: a nullable column and nothing else, so nothing currently
-- deployed can break on it and no FORWARD-COMPAT acknowledgment is required.
-- A NULL means "no per-project criterion recorded", which the GUI renders as an
-- explicit prompt rather than as silence — an unstated criterion is exactly the
-- thing this is meant to surface.

ALTER TABLE harness_shared.goal_projects
  ADD COLUMN IF NOT EXISTS kill_criterion text;

COMMENT ON COLUMN harness_shared.goal_projects.kill_criterion IS
  'What would make this goal stop pursuing THIS project (GOAL contract clause 4). Lives on the edge, not the harness, because a shared project can warrant different criteria per goal. NULL = not yet stated.';
