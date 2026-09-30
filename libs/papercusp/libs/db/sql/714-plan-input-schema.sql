-- 714-plan-input-schema.sql
--
-- plan-structured-inputs-2026-08-01 P-001. Gives a plan an ARGUMENT LIST.
--
-- Until now a plan behaved like a procedure with no parameters. `template_data`
-- (migration 329) could hold structured data ABOUT a plan, validated on write
-- against a code-registry zod schema, but nothing could declare which of those
-- fields were MANDATORY and nothing on the execution path ever read them:
-- context-bundle.ts assembles plan markdown + a revision digest only, and
-- plan-run-action.ts's instance-plan INSERT omits the column outright. So every
-- fire of a scheduled plan was necessarily byte-identical, which forced N
-- near-duplicate plans where one parameterized plan belongs.
--
-- Two columns close that:
--
--   harness_plans.input_schema  — the plan's own JSON Schema for its inputs,
--     authored at runtime via plans:set-input-schema. This is the second of two
--     schema SOURCES: a plan declares EITHER a code-registry `template:` type
--     (zod, in-tree, e.g. `rubric`) OR this, never both (D-002/D-008 Q3), and
--     both dispatch through one validation seam. A runtime-authored schema is
--     required because agents author plans while the operator is running and
--     cannot ship code to add a registry type.
--
--     JSON Schema rather than a bespoke field-list DSL because `required: [...]`
--     already expresses exactly the required/optional marking this feature needs,
--     and because ajv is already this codebase's validator for the identical
--     problem one layer over (datatypes.payload_schema, migration 605) — so the
--     two become callers of one seam instead of two hand-rolled grammars.
--
--   plan_runs.inputs — the ARGUMENTS one run was actually fired with, after the
--     template's stored defaults are merged with any per-invocation override and
--     validated. Kept on the run rather than only on the instance plan so that
--     "what did last Monday's fire actually run with" stays answerable even after
--     the template's own values move on.
--
-- Both are nullable and default NULL: a plan that declares no schema has no
-- required fields, so the start gate reading these columns is a no-op for the
-- entire existing plan corpus. No backfill, no flag.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS input_schema jsonb;

ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS inputs jsonb;

COMMENT ON COLUMN harness_shared.harness_plans.input_schema IS
  'P-001: the plan''s own JSON Schema for its inputs (plans:set-input-schema), validated ajv-compilable at declare time. Mutually exclusive with the code-registry `template` type; the values it constrains live in template_data. NULL = the plan takes no declared inputs.';

COMMENT ON COLUMN harness_shared.plan_runs.inputs IS
  'P-001: the resolved arguments this run was fired with (template defaults shallow-merged with any per-invocation override, post-validation). Per-run provenance for a scheduled plan whose template values later change.';
