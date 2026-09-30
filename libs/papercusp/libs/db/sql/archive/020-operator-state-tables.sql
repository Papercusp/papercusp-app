-- 020-operator-state-tables.sql
--
-- Migrate 8 operator-process state files from
-- <ws>/.papercusp/system/operator/*.json (and similar) to PG.
--
-- Source files being replaced:
--   budget.json                  → operator_budget
--   last-scan.json               → operator_last_scan
--   standing-candidates.json     → operator_standing_candidates
--   idle-snapshot.json           → operator_idle_snapshot
--   tts-spend.json               → operator_tts_spend
--   stt-spend.json               → operator_stt_spend
--   voice-prefs.json             → operator_voice_prefs
--   credentials.json             → operator_credentials  (PG-only, NO Zero)
--
-- Why move: these are operator-process state with no human/CLI consumer.
-- The JSON read-modify-write pattern races on multi-tab open. PG gives
-- atomic update + cross-tab/cross-machine sync. 7/8 tables also publish
-- to Zero so consumers stream live; credentials stays PG-only via REST
-- (security: no broadcast over WS).
--
-- All tables use (workspace_id) as PK so each workspace gets one row.
-- payload JSONB stores the existing shape verbatim — keeps migration
-- thin and lets the modules continue to use their existing types.

CREATE TABLE IF NOT EXISTS harness_shared.operator_budget (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_last_scan (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_standing_candidates (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_idle_snapshot (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_tts_spend (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_stt_spend (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_voice_prefs (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- Credentials PG-only (NOT exposed via Zero publication — accessed via REST
-- with auth check). Stored as JSONB but should never leave the server
-- unencrypted; encryption-at-rest can layer on later (consider pgcrypto).
CREATE TABLE IF NOT EXISTS harness_shared.operator_credentials (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
