-- EI-22769481909225877: a detached run's file status cannot prove that its
-- assertions executed without skips or collection errors. Keep that measured
-- detail on the existing scoped ledger row, not in a foreground temp report.
-- NULL deliberately means unknown for historical and non-Vitest producers.
ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS execution_details jsonb;
