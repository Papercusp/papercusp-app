-- EI-3034: add /adv UI perf SLO snapshot columns.
-- Additive + nullable: existing regression-rig ticks keep working until an app-side
-- sampler supplies these values.

ALTER TABLE harness_shared.perf_regression_snapshots
  ADD COLUMN IF NOT EXISTS adv_tab_switch_median_ms double precision,
  ADD COLUMN IF NOT EXISTS adv_fcp_ms double precision;
