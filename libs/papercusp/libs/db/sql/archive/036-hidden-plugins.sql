\set ON_ERROR_STOP on
BEGIN;

-- Migration 036 — hidden plugins. Operator preference for which marketplace
-- plugins are filtered out of catalog UIs (AddPluginButton, /marketplace/plugins,
-- /installed/plugins). Was previously a hardcoded HIDDEN_PLUGIN_BASENAMES set
-- in apps/operator/app/api/marketplace/catalog/route.ts.

CREATE TABLE IF NOT EXISTS harness_shared.hidden_plugins (
  -- Match by unscoped basename so '@papercupai/<x>' and a future rename
  -- don't slip through. e.g. 'jira-sync' hides '@papercupai/jira-sync'.
  basename     TEXT NOT NULL,
  reason       TEXT,
  hidden_at    BIGINT NOT NULL DEFAULT 0,
  hidden_by    TEXT,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, basename)
);
CREATE INDEX IF NOT EXISTS hidden_plugins_basename_idx
  ON harness_shared.hidden_plugins (basename);

-- Seed with the values that were previously hardcoded.
INSERT INTO harness_shared.hidden_plugins (basename, reason, hidden_at, hidden_by, workspace_id) VALUES
  ('notion-export',  'not ready for users',          0, 'system', ''),
  ('slack-notifier', 'not ready for users',          0, 'system', ''),
  ('vscode-server',  'replaced by @papercupai/pi-coding', 0, 'system', ''),
  ('jira-sync',      'not ready for users',          0, 'system', '')
ON CONFLICT (workspace_id, basename) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hidden_plugins TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.hidden_plugins IS
  'Plugin basenames hidden from marketplace UIs. workspace_id="" is the global default; per-workspace rows override.';

COMMIT;
