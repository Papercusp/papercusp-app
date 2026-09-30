-- 022-operator-state-extension-2.sql
--
-- Extends 020+021 with Categories C+D from the round-2 file-IO audit:
--
--   system/operator/prompt-user.md     → operator_prompt_user
--   system/operator/preferences.md     → operator_preferences
--   ~/.papercusp/publish-credentials.json → operator_publish_credentials  (NO Zero)
--
-- The two markdown files store their content as a string in the JSONB
-- payload (`{ content: "..." }`). All parsing logic in
-- lib/operator-preferences.ts continues to operate on the raw markdown
-- text — the only change is the storage layer.

CREATE TABLE IF NOT EXISTS harness_shared.operator_prompt_user (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.operator_preferences (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- Sensitive — NOT in zero_harness publication.
CREATE TABLE IF NOT EXISTS harness_shared.operator_publish_credentials (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
