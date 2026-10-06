-- 1280: stamp estimated usage cost with the price-table version it was computed under
-- (WI-10004517; agent-economy-flywheel-2026-08-30 D-018).
--
-- agent_usage_samples.cost_usd for cost_source='estimated' is a list-price computation from
-- @papercusp/model-pricing. It used to be computed once at write time and never revisited, so a
-- month mixed every price regime the table passed through, and a row whose model was unpriced
-- when written stayed NULL after the model gained a price.
--
-- price_table_version is the model-pricing PRICE_TABLE_VERSION (a content hash of the table) the
-- row's cost_usd/cost_source were last derived under. Writers stamp it on every row that does
-- not carry provider-reported cost; the repricer (operator-core
-- lib/interactive-usage/reprice-usage-samples.ts) re-derives every such row whose stamp differs
-- from the running table and stamps it. NULL means "never derived under a known table" (all
-- pre-1280 rows), which the repricer treats as stale. Provider-reported rows keep NULL: they are
-- observations, not estimates, and are never re-priced.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS price_table_version text;

COMMENT ON COLUMN harness_shared.agent_usage_samples.price_table_version IS
  'model-pricing PRICE_TABLE_VERSION that cost_usd/cost_source were last derived under (WI-10004517). NULL on provider-reported rows and on rows never derived under a known table; the repricer re-derives any non-provider row whose value differs from the running table.';

-- The stale-scan index is migration 1281, a separate file on purpose: the runner wraps each
-- file in one transaction, so building it here would hold this ALTER's ACCESS EXCLUSIVE lock
-- for the whole build (measured 19s on 1.27M rows under load), blocking every reader too.
