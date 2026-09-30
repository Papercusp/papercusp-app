-- 216-operator-flag-overrides.sql
--
-- PG-backed runtime feature-flag overrides (audit P-070, EI-76).
--
-- One row per workspace, JSONB payload `{ "<flag-key>": boolean, ... }`,
-- read/written through operator-state-pg.ts like the other operator_* state
-- tables (020-022 shape). /api/flags/set writes here when PostHog is not
-- configured, so a dev box can flip flags at runtime without a :3070 restart
-- (previously only PAPERCUSP_FLAG_* env vars worked, which require one).
-- Migration runner provides the transaction — no BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS harness_shared.operator_flag_overrides (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
