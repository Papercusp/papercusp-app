-- Cache efficiency P-001/P-002: source parser state belongs to the byte watermark.
-- FORWARD-COMPAT: these are additive columns; the running release omits them and
-- continues to use the existing byte watermark and aggregate write-token column.
ALTER TABLE harness_shared.interactive_usage_files
  ADD COLUMN IF NOT EXISTS parser_state jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS cache_creation_5m_tokens bigint,
  ADD COLUMN IF NOT EXISTS cache_creation_1h_tokens bigint;

COMMENT ON COLUMN harness_shared.interactive_usage_files.parser_state IS
  'Observed model and cumulative usage identity committed atomically with byte_offset; empty means unavailable, never an assumed model.';
COMMENT ON COLUMN harness_shared.agent_usage_samples.cache_creation_5m_tokens IS
  'Provider-reported five-minute cache-write tokens; NULL means the source did not report a reconciled tier split.';
COMMENT ON COLUMN harness_shared.agent_usage_samples.cache_creation_1h_tokens IS
  'Provider-reported one-hour cache-write tokens; NULL means the source did not report a reconciled tier split.';
