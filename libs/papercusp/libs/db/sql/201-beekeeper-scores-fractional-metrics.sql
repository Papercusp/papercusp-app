-- 201-beekeeper-scores-fractional-metrics.sql
-- harness_shared.beekeeper_scores (migration 180) typed three FRACTIONAL metrics as INTEGER:
--   * time_to_green_secs — wall-clock seconds, fractional (e.g. a 90.377s build-spec bee)
--   * recall_hit         — Jaccard similarity in [0,1]
--   * tokens_per_task    — tokens / solved-count, can be fractional
-- A gen-0 baseline run errored with `invalid input syntax for type integer: "90.377"` when the
-- judge tried to persist a build-spec score. The sibling table iq_battery_metrics (migration 179)
-- already types these as numeric; this widens beekeeper_scores to match. recurrence stays INTEGER
-- (it is COUNT(*) of historical attempts — a genuine integer).
ALTER TABLE harness_shared.beekeeper_scores
  ALTER COLUMN time_to_green_secs TYPE numeric USING time_to_green_secs::numeric,
  ALTER COLUMN recall_hit         TYPE numeric USING recall_hit::numeric,
  ALTER COLUMN tokens_per_task    TYPE numeric USING tokens_per_task::numeric;
