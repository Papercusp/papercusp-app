-- Retain measured evidence before the temporary Gym database is destroyed.
-- NULL means no measurement/parameters were recorded; legacy rows are not backfilled.
ALTER TABLE harness_gym_durable.gym_runs
  ADD COLUMN IF NOT EXISTS run_evidence jsonb,
  ADD COLUMN IF NOT EXISTS run_params jsonb;

COMMENT ON COLUMN harness_gym_durable.gym_runs.run_evidence IS
  'Snapshot of the actual gym_runs row, including oracle pre/post measurements and original references; referenced file retention is verified separately.';
COMMENT ON COLUMN harness_gym_durable.gym_runs.run_params IS
  'Snapshot of the recorded gym_runs_params row; declared commits are not complete runtime identity.';
