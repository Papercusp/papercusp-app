-- P-008 / EI-20285203560232981
-- Keep measured negative SQL-routing decisions on the census row that records
-- the observation. The decision itself is authored beside SQL_READ_PAIRS in the
-- operator source; these columns preserve the state/ref/baseline at write time.

ALTER TABLE harness_shared.sql_read_census
  ADD COLUMN IF NOT EXISTS deliberately_unpaired boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deliberate_decision_ref text NULL,
  ADD COLUMN IF NOT EXISTS deliberate_baseline_window_days integer NULL,
  ADD COLUMN IF NOT EXISTS deliberate_baseline_calls integer NULL,
  ADD COLUMN IF NOT EXISTS deliberate_baseline_atoms integer NULL,
  ADD COLUMN IF NOT EXISTS deliberate_baseline_distinct_agents integer NULL;

COMMENT ON COLUMN harness_shared.sql_read_census.deliberately_unpaired IS
  'True when the NULL-intent cluster is covered by a measured registry-backed deliberate no-pair decision.';

COMMENT ON COLUMN harness_shared.sql_read_census.deliberate_decision_ref IS
  'Plan/decision reference for a deliberate no-pair classification, for example sql-escape-tool-routing-2026-08-12#D-007.';

COMMENT ON COLUMN harness_shared.sql_read_census.deliberate_baseline_distinct_agents IS
  'Independent-agent baseline captured when the deliberate no-pair decision was made; used for drift re-raises.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'sql_read_census_deliberate_no_pair_fields_check'
       AND conrelid = 'harness_shared.sql_read_census'::regclass
  ) THEN
    ALTER TABLE harness_shared.sql_read_census
      ADD CONSTRAINT sql_read_census_deliberate_no_pair_fields_check
      CHECK (
        (deliberately_unpaired = false AND deliberate_decision_ref IS NULL)
        OR
        (deliberately_unpaired = true
         AND intent_label IS NULL
         AND relation_has_pairs = false
         AND deliberate_decision_ref IS NOT NULL
         AND deliberate_baseline_window_days IS NOT NULL
         AND deliberate_baseline_calls IS NOT NULL
         AND deliberate_baseline_atoms IS NOT NULL
         AND deliberate_baseline_distinct_agents IS NOT NULL)
      );
  END IF;
END
$$;
