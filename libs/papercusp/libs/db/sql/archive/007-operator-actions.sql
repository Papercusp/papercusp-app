-- Operator-initiated mutations log. Pairs with audit.action_executions but
-- pivots on the operator (the human + dashboard) rather than the plugin.
--
-- Every operator-token-gated mutating endpoint in marketplace-api writes one
-- row here. Read paths don't write (avoid log spam on dashboard polls).

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.operator_actions (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Free-form action verb e.g. 'webhook.create', 'grant.revoke', 'plugin.retract'.
  action          TEXT NOT NULL,
  -- Optional resource the action targeted, e.g. a plugin slug, webhook id, etc.
  target          TEXT,
  -- Compact JSON describing what happened — full request body or a digest.
  details_json    JSONB,
  -- HTTP method + path so we can correlate with reverse-proxy logs if needed.
  http_method     TEXT,
  http_path       TEXT,
  -- Best-effort source attribution (currently always 'operator' since
  -- operator-token auth doesn't carry an identity; future: extend with
  -- per-operator tokens).
  actor           TEXT NOT NULL DEFAULT 'operator',
  -- HTTP status returned to the caller.
  status_code     INTEGER NOT NULL,
  -- IP / hostname is operationally useful but not strictly required.
  source_ip       TEXT
);

CREATE INDEX IF NOT EXISTS operator_actions_ts_idx        ON audit.operator_actions(ts DESC);
CREATE INDEX IF NOT EXISTS operator_actions_action_idx    ON audit.operator_actions(action, ts DESC);
CREATE INDEX IF NOT EXISTS operator_actions_target_idx    ON audit.operator_actions(target, ts DESC) WHERE target IS NOT NULL;

GRANT USAGE ON SCHEMA audit TO harness_app, harness_admin;
GRANT SELECT, INSERT, DELETE ON audit.operator_actions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE audit.operator_actions_id_seq TO harness_app, harness_admin;
