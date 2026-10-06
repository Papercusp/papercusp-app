-- 1281: index for the repricer's stale scan (WI-10004517; agent-economy-flywheel-2026-08-30 D-018).
--
-- The repricer (operator-core lib/interactive-usage/reprice-usage-samples.ts) runs after every
-- interactive-usage-ingest tick and looks for non-provider rows whose price_table_version
-- (migration 1280) is NULL or differs from the running table. Once a pass completes that set is
-- empty, and without this index each tick would answer "nothing to do" by reading the whole
-- 1.27M-row table. Rows are matched as (IS NULL OR < v OR > v), which the planner can answer
-- from this index with range scans.
--
-- Separate from 1280 so the build holds only CREATE INDEX's SHARE lock (writes wait, reads do
-- not). Measured 19s on the live table under load (load1 ~190) in a rolled-back transaction.
-- The runner wraps each file in a transaction, so CONCURRENTLY is not available (same tradeoff
-- as migration 792).

CREATE INDEX IF NOT EXISTS agent_usage_samples_price_version_idx
  ON harness_shared.agent_usage_samples (price_table_version, id)
  WHERE cost_source IS DISTINCT FROM 'provider';
