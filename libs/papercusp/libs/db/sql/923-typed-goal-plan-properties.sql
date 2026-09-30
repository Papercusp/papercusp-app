-- Typed, user-editable properties for goals and plans
-- (work-on-everything-goal-2026-08-23 P-023 / WI-41047).
--
-- A property declaration lives on its owning object (`property_schema`). Runtime
-- values and their per-property CAS/provenance envelope live together in the ONE
-- `properties` jsonb document. This deliberately extends the existing goal/plan
-- rows instead of introducing a parallel property table or event channel.

BEGIN;

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS property_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS properties jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS property_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS properties jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.goals'::regclass
       AND conname = 'goals_property_schema_object'
  ) THEN
    ALTER TABLE harness_shared.goals
      ADD CONSTRAINT goals_property_schema_object
      CHECK (jsonb_typeof(property_schema) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.goals'::regclass
       AND conname = 'goals_properties_object'
  ) THEN
    ALTER TABLE harness_shared.goals
      ADD CONSTRAINT goals_properties_object
      CHECK (jsonb_typeof(properties) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.harness_plans'::regclass
       AND conname = 'harness_plans_property_schema_object'
  ) THEN
    ALTER TABLE harness_shared.harness_plans
      ADD CONSTRAINT harness_plans_property_schema_object
      CHECK (jsonb_typeof(property_schema) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.harness_plans'::regclass
       AND conname = 'harness_plans_properties_object'
  ) THEN
    ALTER TABLE harness_shared.harness_plans
      ADD CONSTRAINT harness_plans_properties_object
      CHECK (jsonb_typeof(properties) = 'object');
  END IF;
END
$$;

COMMENT ON COLUMN harness_shared.goals.property_schema IS
  'Typed property declarations: name -> { datatype, default?, editable_by }. Datatype ids resolve through datatype_registry.';
COMMENT ON COLUMN harness_shared.goals.properties IS
  'Typed property values with per-property version + edit provenance. Written only through goals:set-property.';
COMMENT ON COLUMN harness_shared.harness_plans.property_schema IS
  'Typed property declarations: name -> { datatype, default?, editable_by }. Datatype ids resolve through datatype_registry.';
COMMENT ON COLUMN harness_shared.harness_plans.properties IS
  'Typed property values with per-property version + edit provenance. Written only through plans:set-property.';

COMMIT;
