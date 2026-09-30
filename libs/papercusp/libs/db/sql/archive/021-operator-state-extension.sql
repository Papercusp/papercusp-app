-- 021-operator-state-extension.sql
--
-- Extends migration 020's operator-state tables with 4 more single-row
-- per-workspace state files (Category B from the round-2 file-IO audit):
--
--   agent/config.json                         → operator_agent_config
--   system/operator/scanner-session.json      → operator_scanner_session
--   system/operator/first-run.json            → operator_first_run
--   ~/.papercusp/profile.json                 → operator_user_profile
--
-- All 4 publish to Zero (no security concern). Same shape as 020:
-- workspace_id PK + jsonb payload + updated_at.

CREATE TABLE IF NOT EXISTS harness_shared.operator_agent_config (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_scanner_session (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_first_run (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- user_profile is per-user-per-workspace; using workspace_id as PK matches
-- the single-user-per-workspace assumption that holds today. Multi-user
-- per workspace would need composite (workspace_id, user_id).
CREATE TABLE IF NOT EXISTS harness_shared.operator_user_profile (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
