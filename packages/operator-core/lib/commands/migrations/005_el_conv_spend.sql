-- ElevenLabs Conv AI minute tracking. Per /docs/agents/operator-persona §0
-- and the cost discussion: EL bills per-minute of session connection,
-- not per-LLM-call. Without this we have no upper bound on monthly burn.
--
-- One row per concluded conversation, populated by the post-call webhook.
-- Aggregated by month for the cap check; recorded with conversation_id
-- so duplicates from webhook retries can dedupe.

CREATE TABLE IF NOT EXISTS harness_shared.el_conv_calls (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT NOT NULL UNIQUE,
  agent_id        TEXT,
  workspace       TEXT,
  duration_secs   INT NOT NULL DEFAULT 0,
  -- Computed at insert time for cheap monthly aggregation queries.
  ym              TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM')
);

CREATE INDEX IF NOT EXISTS el_conv_calls_ym_idx
  ON harness_shared.el_conv_calls (ym);

GRANT SELECT, INSERT ON harness_shared.el_conv_calls TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.el_conv_calls_id_seq TO harness_app;
