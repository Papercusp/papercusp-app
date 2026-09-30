-- Verified against the real PostgreSQL request-ingestion suite before arming.
-- Additive: legacy producers and samples retain NULL provenance. No historical
-- rows are rewritten here. Per-request identity extends the existing ledger.
-- FORWARD-COMPAT: deployed writers omit usage_event_key, leaving it NULL; the
-- partial unique index excludes every legacy row and does not constrain them.
ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS usage_event_key text,
  ADD COLUMN IF NOT EXISTS event_ts bigint,
  ADD COLUMN IF NOT EXISTS ingested_at bigint,
  ADD COLUMN IF NOT EXISTS usage_provenance jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS agent_usage_samples_ws_event_key_idx
  ON harness_shared.agent_usage_samples (workspace_id, usage_event_key)
  WHERE usage_event_key IS NOT NULL;

COMMENT ON COLUMN harness_shared.agent_usage_samples.event_ts IS
  'Timestamp reported by the source usage event in Unix milliseconds; NULL means unavailable, never inferred from ingestion time.';
COMMENT ON COLUMN harness_shared.agent_usage_samples.ingested_at IS
  'Last ingestion time in Unix milliseconds, separate from source event time.';
COMMENT ON COLUMN harness_shared.agent_usage_samples.usage_event_key IS
  'Parser-versioned source request identity scoped by workspace; streaming updates max-merge into one ledger row.';
COMMENT ON COLUMN harness_shared.agent_usage_samples.usage_provenance IS
  'Source file, adapter, byte offset, parser version and observed lineage. Missing serving account/model/trigger remain explicit unknowns.';
