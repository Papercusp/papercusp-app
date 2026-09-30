-- 897-code-recipe-contract.sql.DRAFT
-- P-015 of orchestration-runtime-unification-and-safe-output-2026-08-22.
--
-- Extend the existing recipe row with the two versioned, declarative inputs to
-- admission and revisioning.  NULL/NULL is the explicit legacy shape: old
-- recipes remain foreground-compatible through a derived manifest, while new
-- captures can persist one recipe-script representation plus its contract.
--
-- This file stays a DRAFT until the TypeScript store/runtime consumers and the
-- focused migration coverage are green.  Rename it to .sql only when arming the
-- migration; the reserved migration number must not be reused.

ALTER TABLE harness_shared.code_recipes
  ADD COLUMN IF NOT EXISTS binding_schema JSONB,
  ADD COLUMN IF NOT EXISTS capability_manifest JSONB;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'code_recipes_binding_schema_v1_ck'
       AND conrelid = 'harness_shared.code_recipes'::regclass
  ) THEN
    ALTER TABLE harness_shared.code_recipes
      ADD CONSTRAINT code_recipes_binding_schema_v1_ck
      CHECK (
        binding_schema IS NULL
        OR (
          jsonb_typeof(binding_schema) = 'object'
          AND binding_schema @> '{"version":1,"additionalProperties":false}'::jsonb
          AND jsonb_typeof(binding_schema -> 'properties') = 'object'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'code_recipes_capability_manifest_v1_ck'
       AND conrelid = 'harness_shared.code_recipes'::regclass
  ) THEN
    ALTER TABLE harness_shared.code_recipes
      ADD CONSTRAINT code_recipes_capability_manifest_v1_ck
      CHECK (
        capability_manifest IS NULL
        OR (
          jsonb_typeof(capability_manifest) = 'object'
          AND capability_manifest @> '{"version":1,"representation":"recipe-script"}'::jsonb
          AND capability_manifest #> '{topology,premises}' = '["host:same"]'::jsonb
          AND jsonb_typeof(capability_manifest -> 'requirements') = 'array'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'code_recipes_binding_schema_requires_manifest_ck'
       AND conrelid = 'harness_shared.code_recipes'::regclass
  ) THEN
    ALTER TABLE harness_shared.code_recipes
      ADD CONSTRAINT code_recipes_binding_schema_requires_manifest_ck
      CHECK (binding_schema IS NULL OR capability_manifest IS NOT NULL);
  END IF;
END
$constraints$;

COMMENT ON COLUMN harness_shared.code_recipes.binding_schema IS
  'Versioned typed input contract for the recipe-script revision (P-015); NULL on legacy recipes.';
COMMENT ON COLUMN harness_shared.code_recipes.capability_manifest IS
  'Versioned logical capability/topology/lifecycle/replay contract for the recipe-script revision (P-015); never an authorization grant.';

