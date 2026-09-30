-- Agent Action Registry — audit tables.
-- See /docs/agents/action-registry §6 for the full design.
--
-- Two tables: commands (full) + queries (sampled).
-- Pruning is done by a nightly cron, not by this migration.

CREATE TABLE IF NOT EXISTS harness_shared.agent_actions (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent       TEXT NOT NULL,            -- 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut'
  command_id  TEXT NOT NULL,            -- 'panel.toggle' etc.
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL,            -- 'ok' | 'err'
  error_code  TEXT,                     -- error.code from CommandErrorPayload, NULL if ok
  duration_ms INT,
  workspace   TEXT,
  session_id  TEXT,
  request_id  TEXT
);

CREATE INDEX IF NOT EXISTS agent_actions_ts_idx        ON harness_shared.agent_actions (ts DESC);
CREATE INDEX IF NOT EXISTS agent_actions_agent_ts_idx  ON harness_shared.agent_actions (agent, ts DESC);
CREATE INDEX IF NOT EXISTS agent_actions_id_ts_idx     ON harness_shared.agent_actions (command_id, ts DESC);
CREATE INDEX IF NOT EXISTS agent_actions_ws_ts_idx     ON harness_shared.agent_actions (workspace, ts DESC);

CREATE TABLE IF NOT EXISTS harness_shared.agent_queries (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent         TEXT NOT NULL,
  query_id      TEXT NOT NULL,
  args_compact  JSONB,                  -- only kept for audit:'full' defs
  workspace     TEXT,
  request_id    TEXT
);

CREATE INDEX IF NOT EXISTS agent_queries_ts_idx       ON harness_shared.agent_queries (ts DESC);
CREATE INDEX IF NOT EXISTS agent_queries_agent_id_ts  ON harness_shared.agent_queries (agent, query_id, ts DESC);

GRANT SELECT, INSERT ON harness_shared.agent_actions TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.agent_actions_id_seq TO harness_app;
GRANT SELECT, INSERT ON harness_shared.agent_queries TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.agent_queries_id_seq TO harness_app;
