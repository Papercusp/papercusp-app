-- 921: trigger bindings may target a GOAL (work-on-everything-goal-2026-08-23 P-020, D-006).
-- EXPAND-only migration: the plan columns become nullable (a widening — currently-deployed
-- code always writes both, which still satisfies every constraint below), and goal_id is
-- added. Existing rows are untouched: they carry both plan cols and a NULL goal_id, so they
-- satisfy the exactly-one-target CHECK as plan-targeted bindings.

ALTER TABLE harness_shared.trigger_bindings
  ALTER COLUMN plan_harness_slug DROP NOT NULL,
  ALTER COLUMN plan_slug DROP NOT NULL;

ALTER TABLE harness_shared.trigger_bindings
  ADD COLUMN goal_id text REFERENCES harness_shared.goals(id) ON DELETE RESTRICT;

COMMENT ON COLUMN harness_shared.trigger_bindings.goal_id IS
  'When set, this binding ACTIVATES a goal (action type start-goal, dispatched through the one goal-activation primitive startGoalById — D-006) instead of launching a plan. Exactly one of {plan target, goal target} per binding; ON DELETE RESTRICT mirrors the plan FK so run history stays addressable.';

ALTER TABLE harness_shared.trigger_bindings
  ADD CONSTRAINT trigger_bindings_plan_cols_paired
    CHECK ((plan_slug IS NULL) = (plan_harness_slug IS NULL)),
  ADD CONSTRAINT trigger_bindings_exactly_one_target
    CHECK (((plan_slug IS NOT NULL))::int + ((goal_id IS NOT NULL))::int = 1);

CREATE INDEX trigger_bindings_ws_goal_idx
  ON harness_shared.trigger_bindings (workspace_id, goal_id)
  WHERE goal_id IS NOT NULL;
