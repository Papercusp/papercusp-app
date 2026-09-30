-- P-016 / D-020: an external trigger may target a registered blueprint
-- operation without acquiring a second target column or a second receipt.
-- The operation reference lives in the existing action vocabulary; the
-- trigger_run remains the durable event receipt and outbox row.
--
-- FORWARD-COMPAT: the currently deployed release writes only the legacy plan,
-- goal, and direct-work-item target shapes, all of which remain valid under the
-- expanded constraint while the new action shape is ignored until code deploys.

ALTER TABLE harness_shared.trigger_bindings
  DROP CONSTRAINT IF EXISTS trigger_bindings_blueprint_operation_action_check;

ALTER TABLE harness_shared.trigger_bindings
  ADD CONSTRAINT trigger_bindings_blueprint_operation_action_check
  CHECK (
    (action ->> 'type') IS DISTINCT FROM 'blueprint-operation'
    OR ((
      jsonb_typeof(action -> 'operationHarnessSlug') = 'string'
      AND btrim(action ->> 'operationHarnessSlug') <> ''
      AND jsonb_typeof(action -> 'operationId') = 'string'
      AND btrim(action ->> 'operationId') <> ''
      AND (
        NOT (action ? 'input')
        OR jsonb_typeof(action -> 'input') = 'object'
      )
    ) IS TRUE)
  );

ALTER TABLE harness_shared.trigger_bindings
  DROP CONSTRAINT IF EXISTS trigger_bindings_exactly_one_target;

ALTER TABLE harness_shared.trigger_bindings
  ADD CONSTRAINT trigger_bindings_exactly_one_target
  CHECK (
    ((plan_slug IS NOT NULL)::integer
      + (goal_id IS NOT NULL)::integer
      + (work_item_kind IS NOT NULL)::integer
      + COALESCE(((action ->> 'type') = 'blueprint-operation')::integer, 0)) = 1
  );
