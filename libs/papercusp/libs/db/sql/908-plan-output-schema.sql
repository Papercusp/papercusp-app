-- 908-plan-output-schema.sql
--
-- external-triggers-gmail-slack-2026-08-22 P-026 / D-017. Gives a plan a RETURN
-- VALUE.
--
-- Migration 714 gave a plan an argument list (`harness_plans.input_schema` +
-- `plan_runs.inputs`), turning it from a procedure with no parameters into one
-- that can be called with arguments. This is the symmetric half: until now a plan
-- could be CALLED but could not RETURN. Nothing in the plan substrate expressed
-- "this plan produces a brief / a draft / a set of filed ids" in a way another
-- step could consume — a completing run left its product only in prose, and any
-- consumer had to re-derive it by reading the plan's output with an agent.
--
-- That gap is what blocks workflow CHAINING (D-015, event-stitched): a chain is N
-- single-target bindings wired by internal-event edges, and the edge carries the
-- upstream step's product to the downstream step's declared inputs. With no
-- declared outputs the only carriable thing is the raw payload, which is exactly
-- the rung that a DETERMINISTIC target (a recipe, or a one-step tool call) is not
-- allowed to rely on — no agent interprets for it. So without this column a chain
-- may only ever end in a plan, never pass THROUGH one.
--
-- Two columns close that, mirroring 714 exactly:
--
--   harness_plans.output_schema — the plan's own JSON Schema for what it
--     PRODUCES, authored at runtime via plans:set-output-schema and validated
--     ajv-compilable at declare time, for the same fail-loud reason 714 gives for
--     inputs: a schema that cannot compile could not have its fields checked at
--     completion, and the completion gate must never render "could not check" as
--     "nothing was promised".
--
--     Note this is NOT mutually exclusive with the code-registry `template:` type
--     the way input_schema is. That exclusion exists because `template` and
--     `input_schema` are two SOURCES for one thing — the shape of a plan's
--     arguments (see 714's comment). `template` says nothing about a plan's
--     product, so there is no second source to arbitrate and no conflict to
--     refuse.
--
--   plan_runs.outputs — the values one run actually PUBLISHED at completion,
--     kept on the run for the same reason 714 keeps `inputs` there: "what did last
--     Monday's fire actually produce" must stay answerable after the plan's
--     template moves on, and a chained consumer reads the run it was triggered by,
--     not the plan's latest definition.
--
-- OPTIONAL BY CONSTRUCTION (D-017: "outputs should be optional"). Both columns are
-- nullable and default NULL, so a plan that declares no outputs is unchanged and
-- the entire existing plan corpus needs no backfill and no flag. Optionality
-- composes with the mapping-rigor rule across a chain edge (D-015): a plan with no
-- declared outputs can still chain into a PLAN target, which may take the loose
-- redacted payload as agent context; a DETERMINISTIC next step requires the
-- upstream plan to have declared outputs. The absence of a schema is therefore a
-- meaningful, readable state — not a missing configuration.
--
-- Expand-only: two ADD COLUMN IF NOT EXISTS on nullable columns. No destructive
-- DDL, so no FORWARD-COMPAT acknowledgment is required — the currently-deployed
-- release simply never selects these columns.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS output_schema jsonb;

ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS outputs jsonb;

COMMENT ON COLUMN harness_shared.harness_plans.output_schema IS
  'P-026/D-017: the plan''s own JSON Schema for what it PRODUCES (plans:set-output-schema), validated ajv-compilable at declare time. Unlike input_schema this does NOT conflict with a code-registry `template` type — that type describes arguments, not product. NULL = the plan declares no outputs, which is a valid terminal-only plan and the default for the whole existing corpus.';

COMMENT ON COLUMN harness_shared.plan_runs.outputs IS
  'P-026/D-017: the values this run PUBLISHED at completion, validated against the plan''s output_schema. A declared-but-unfilled output fails the run loudly rather than chaining undefined downstream. NULL = the plan declared no outputs, or the run has not completed.';
