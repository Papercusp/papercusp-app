-- 895-code-recipe-execution-traces.sql
-- P-013 of orchestration-runtime-unification-and-safe-output-2026-08-22.
--
-- `code_recipe_runs` is the existing per-execution recipe ledger. Extend that
-- rail for normalized script traces rather than introducing a second run store.
-- A failed, dry-run, or capture-disabled code:run has no recipe row to point at,
-- so recipe_id becomes nullable for a TRACE-ONLY execution row. Existing recipe
-- usage rows remain valid and need no backfill.

ALTER TABLE harness_shared.code_recipe_runs
  ALTER COLUMN recipe_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS execution_trace JSONB,
  ADD COLUMN IF NOT EXISTS structural_fingerprint TEXT;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'code_recipe_runs_recipe_or_trace_ck'
       AND conrelid = 'harness_shared.code_recipe_runs'::regclass
  ) THEN
    ALTER TABLE harness_shared.code_recipe_runs
      ADD CONSTRAINT code_recipe_runs_recipe_or_trace_ck
      CHECK (recipe_id IS NOT NULL OR execution_trace IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'code_recipe_runs_trace_fingerprint_ck'
       AND conrelid = 'harness_shared.code_recipe_runs'::regclass
  ) THEN
    ALTER TABLE harness_shared.code_recipe_runs
      ADD CONSTRAINT code_recipe_runs_trace_fingerprint_ck
      CHECK (
        (execution_trace IS NULL AND structural_fingerprint IS NULL)
        OR (
          jsonb_typeof(execution_trace) = 'object'
          AND structural_fingerprint ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS code_recipe_runs_fingerprint_idx
  ON harness_shared.code_recipe_runs (structural_fingerprint, ts DESC)
  WHERE structural_fingerprint IS NOT NULL;

COMMENT ON COLUMN harness_shared.code_recipe_runs.recipe_id IS
  'Recipe id when this execution came from/captured a recipe; NULL only for a trace-only script execution.';
COMMENT ON COLUMN harness_shared.code_recipe_runs.execution_trace IS
  'Secret-free normalized execution trace (P-013); NULL on pre-895 usage rows.';
COMMENT ON COLUMN harness_shared.code_recipe_runs.structural_fingerprint IS
  'Backend/outcome/binding-value-independent SHA-256 fingerprint from execution_trace.';
