-- 927-goal-io-schemas.sql
--
-- work-on-everything-goal-2026-08-23 P-021. Gives a GOAL an argument list and a
-- return value, mirroring what 714 + 908 gave plans.
--
-- Migration 714 turned a plan from a parameterless procedure into one that can
-- be CALLED with arguments (`harness_plans.input_schema` + `plan_runs.inputs`);
-- 908 added the symmetric half, a RETURN VALUE (`harness_plans.output_schema` +
-- `plan_runs.outputs`). Goals had neither: a goal package (P-006) that wants to
-- collect a budget window or a scope at start has nowhere to declare those
-- fields, a package CONSTRUCTOR (P-022) has no typed inputs to be a pure
-- function OF, and an achieved goal's product exists only as prose in the
-- wind-down report — unreadable by any downstream consumer.
--
-- Four columns close that, all on `harness_shared.goals`. Plans split their
-- pair across TWO tables because a plan is a TEMPLATE and a plan_run is an
-- INSTANCE ("what did last Monday's fire run with" outlives the template's
-- values). A goal has no such split: the goals row IS the single running
-- instance (the template half of a goal's lifecycle is the Cupboard PACKAGE,
-- P-006, which carries the schema in its package format and stamps it onto the
-- row at install/start). So schema and values live side by side on the one row:
--
--   goals.input_schema  — the goal's own JSON Schema for its start-time inputs,
--     validated ajv-compilable at declare time (goals:set-input-schema, or the
--     start door args) for 714's fail-loud reason: a schema that cannot compile
--     could not have its required fields checked at start, and the start gate
--     must never render "could not check" as "nothing was required". Unlike
--     plans there is NO competing code-registry `template:` source for a goal's
--     arguments, so 714's mutual-exclusion rule has no analogue here.
--
--   goals.inputs — the arguments this goal was actually STARTED with, after
--     validation against input_schema. Per-instance provenance: the package's
--     defaults may move on; what THIS goal was started with stays answerable.
--
--   goals.output_schema — the goal's own JSON Schema for what it PRODUCES,
--     ajv-compilable at declare time, same as 908. NULL = the goal declares no
--     outputs, which is a valid outcome-only goal and the default for the
--     whole existing corpus.
--
--   goals.outputs — the values reported at wind-down. Disposition 'achieved'
--     with a declared output_schema REQUIRES them (a declared-but-unfilled
--     output fails the achieve loudly rather than chaining undefined
--     downstream — 908's completion rule); 'killed' tolerates their absence
--     (an abandoned goal need not have produced), and 'handoff' leaves the
--     goal active so nothing is recorded yet.
--
-- OPTIONAL BY CONSTRUCTION, exactly like 714/908: all four columns are
-- nullable and default NULL, so every existing goal is unchanged — no
-- backfill, no flag. A goal that declares no schemas has no required inputs
-- and no promised outputs, and every gate reading these columns is a no-op
-- for the entire existing corpus.
--
-- Expand-only: four ADD COLUMN IF NOT EXISTS on nullable columns. No
-- destructive DDL, so no FORWARD-COMPAT acknowledgment is required — the
-- currently-deployed release simply never selects these columns.

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS input_schema jsonb;

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS inputs jsonb;

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS output_schema jsonb;

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS outputs jsonb;

COMMENT ON COLUMN harness_shared.goals.input_schema IS
  'P-021 (work-on-everything-goal-2026-08-23): the goal''s own JSON Schema for its start-time inputs (goals:set-input-schema / the start door), validated ajv-compilable at declare time. No code-registry template source competes (unlike harness_plans.input_schema). NULL = the goal takes no declared inputs.';

COMMENT ON COLUMN harness_shared.goals.inputs IS
  'P-021: the arguments this goal was actually STARTED with, validated against input_schema at the start door. Per-instance provenance — the package''s defaults may change after this goal starts. NULL = started with no declared inputs.';

COMMENT ON COLUMN harness_shared.goals.output_schema IS
  'P-021: the goal''s own JSON Schema for what it PRODUCES (goals:set-output-schema), validated ajv-compilable at declare time. NULL = the goal declares no outputs, which is a valid outcome-only goal and the default for the whole existing corpus.';

COMMENT ON COLUMN harness_shared.goals.outputs IS
  'P-021: the values reported at wind-down, validated against output_schema. Disposition ''achieved'' with a declared schema requires them (fails loudly if unfilled); ''killed'' tolerates absence. NULL = no outputs declared, or none reported yet.';
