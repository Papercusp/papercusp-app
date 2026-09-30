-- 701-test-runs-scratch-config-flag.sql
--
-- EI-18767688096795873: the red-test watchdog aggregates `harness_shared.test_runs`
-- rows purely by file_path + status, so a test file whose ONLY recent failures came
-- from a deliberate, throwaway harness — a mutation-testing run that intentionally
-- breaks the module under test via a `--config /tmp/.../vitest.mutant.config.ts`
-- resolve.alias override — is indistinguishable from a genuine repeated regression.
-- The mutant config's test FILE PATH is identical to the real one, so it aggregates
-- straight into the same row and the watchdog confidently files a major bug against
-- code that has never actually broken.
--
-- Fix: the vitest reporter (admin-test-runs-reporter.ts) now stamps whether the
-- RESOLVED config file it ran under lives inside the repo working tree at all — a
-- canonical `vitest.config.ts` always does; a throwaway config synthesized under
-- /tmp (or anywhere outside the tree) never does, REGARDLESS of what tool produced
-- it, so this needs no cooperation from the mutation harness (or any future one).
-- The red-test collector then excludes `is_scratch_config = true` rows from its
-- repeated-failure aggregation.
--
-- DEFAULT false: every existing row, and every insertion path that doesn't set this
-- explicitly (the non-vitest `testing-run-store.ts` fallback path, harness-scoped
-- ingestion), is assumed canonical — this column only ever SUPPRESSES a false
-- positive, never manufactures one, so an unknown case must not become invisible to
-- the watchdog.
--
-- Idempotent: safe to re-run. Applied by the runner (`db:migrate`), never a raw
-- psql -f.

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS is_scratch_config boolean NOT NULL DEFAULT false;
